const prepared = require('./project-prompt-catalog.test-support.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ProjectPromptCatalogService } = require('./project-prompt-catalog');

function fixture() {
  const roots = ['/catalog/Prompts', '/other/Prompts'];
  const directories = new Map();
  const bindings = new Map();
  const projects = new Map([['P', { id: 'P', name: 'Project 2', icon: 'p-icon' }],
    ['Q', { id: 'Q', name: 'Project 10', icon: 'q-icon' }]]);
  const counts = { readdir: new Map(), stat: new Map(), realpath: new Map(), projects: new Map(), bindings: new Map() };
  const count = (kind, key) => counts[kind].set(key, (counts[kind].get(key) || 0) + 1);
  const addRoot = root => {
    directories.set(root, [{ name: 'docs', directory: true }]);
    directories.set(path.join(root, 'docs'), ['10.prompt.md', '2.prompt.md'].map(name => ({ name, directory: false })));
  };
  roots.forEach(addRoot);
  const fsImpl = {
    statSync: value => { count('stat', value); if (!directories.has(value)) throw new Error('missing'); return { isDirectory: () => true }; },
    readdirSync: value => { count('readdir', value); if (!directories.has(value)) throw new Error('missing');
      return directories.get(value).map(item => ({ name: item.name, isDirectory: () => item.directory, isSymbolicLink: () => false })); },
    realpathSync: value => { count('realpath', value); return value; },
  };
  const source = (rootPath = roots[0], projectId = 'P', extra = {}) => ({ rootPath, projectId, rootId: rootPath,
    id: rootPath, enabled: true, position: 0, ...extra });
  const registry = { read:()=>({roots:[]}),
    listSourceScopes: () => [...bindings.keys()].map(tabId => ({ tabId, name: tabId })),
    sourcesForTab: tabId => { count('bindings', tabId); return bindings.get(tabId).map(value => ({ ...value })); },
  };
  const db = { getProjectById: id => { count('projects', id); return projects.get(id) || null; } };
  const layoutStore = { get: () => ({ layout: {} }) };
  const stat=async value=>{
    const dir=directories.has(value), parent=path.dirname(value), file=directories.get(parent)?.some(r=>path.join(parent,r.name)===value && !r.directory);
    if(!dir&&!file)throw Object.assign(Error('missing'),{code:'ENOENT'});
    return {dev:1,ino:1,mtimeMs:0,ctimeMs:0,isDirectory:()=>dir,isFile:()=>!!file,isSymbolicLink:()=>false};
  };
  const asyncFs={stat,lstat:stat,realpath:async value=>fsImpl.realpathSync(value),opendir:async value=>{
    const rows=fsImpl.readdirSync(value);let at=0;return {read:async()=>rows[at++]||null,close:async()=>{}};
  }};
  const service = new ProjectPromptCatalogService({ db, rootRegistry: registry, fsImpl, asyncFs,
    authorityFence:prepared.controlledFence(db,()=>JSON.stringify([...bindings])),layoutStore,watch:false });
  return { service, roots, directories, bindings, source, counts, projects, layoutStore, fsImpl, asyncFs, addRoot, db };
}

const total = map => [...map.values()].reduce((a, b) => a + b, 0);

test('one prepared source serves open/archive namespaces with fresh independent projections', async t => {
  const f=fixture();t.after(()=>f.service.close());
  for(let i=0;i<80;i++)f.bindings.set(i?`archive-${i}`:'open',[f.source()]);
  f.bindings.set('foreign-namespace',[f.source(f.roots[0],'Q')]);
  const usages=await prepared.usage(f.service,'/');
  assert.equal(usages.length,2);assert.deepEqual(usages.map(v=>path.basename(v.path)),['2.prompt.md','10.prompt.md']);
  assert.equal(usages[0].tabs.length,81);assert.deepEqual(usages[0].projects.map(v=>v.name),['Project 2','Project 10']);
  assert.equal(f.counts.readdir.get(path.join(f.roots[0],'docs')),1,'namespace/label changes never duplicate source discovery');
  const a=await f.service.listTab('open'),b=await f.service.listTab('archive-1'),q=await f.service.listTab('foreign-namespace');
  assert.deepEqual(a.prompts,b.prompts);assert.notEqual(a.prompts[0],b.prompts[0]);assert.notEqual(a.prompts[0].file_paths,b.prompts[0].file_paths);assert.notEqual(a.prompts[0].id,q.prompts[0].id);
  f.projects.set('P',{id:'P',name:'Renamed project',icon:'new-icon'});
  assert.deepEqual((await f.service.usageForRoot('/'))[0].projects.find(p=>p.id==='P'),{id:'P',name:'Renamed project',icon:'new-icon'});
});
test('all-source labels and exact layout spelling project from source metadata without tab caches', async t => {
  const f=fixture();t.after(()=>f.service.close());f.bindings.set('single',[f.source()]);f.bindings.set('duplicate-basename',[f.source(),f.source(f.roots[1])]);f.bindings.set('other-namespace',[f.source(f.roots[0],'Q')]);
  await prepared.usage(f.service,'/');const single=await f.service.listTab('single'),duplicate=await f.service.listTab('duplicate-basename');
  assert.equal(single.prompts[0].sourceName,'Prompts');assert.equal(duplicate.prompts[0].sourceName,'Prompts · /catalog');assert.equal(duplicate.prompts[2].sourceName,'Prompts · /other');
  const docs=path.join(f.roots[0],'docs');f.layoutStore.get=()=>({revision:2,layout:{orderByParent:{[docs]:[path.join(docs,'10.prompt.md')]}}});
  assert.deepEqual((await prepared.tab(f.service,'single')).prompts.map(v=>v.title),['10','2']);assert.equal(f.service.tabCache.size,0);
});
test('fresh authority/root facts plus events replace TTL; elapsed time alone never rescans', async t => {
  const f=fixture();t.after(()=>f.service.close());let now=10000;t.mock.method(Date,'now',()=>now);f.bindings.set('a',[f.source()]);f.bindings.set('b',[f.source()]);
  await prepared.usage(f.service,'/');const scans=total(f.counts.readdir);now+=1501;await f.service.usageForRoot('/');assert.equal(total(f.counts.readdir),scans);
  f.bindings.set('a',[f.source(f.roots[1])]);assert.equal((await prepared.tab(f.service,'a')).prompts[0].sourceRoot,f.roots[1]);
  const docs=path.join(f.roots[0],'docs');f.directories.delete(docs);assert.deepEqual((await prepared.tab(f.service,'b')).prompts,[]);
  f.addRoot(f.roots[0]);assert.equal((await prepared.tab(f.service,'b')).prompts.length,2);
  f.directories.get(docs).push({name:'new.prompt.md',directory:false});f.service.invalidateTabs(['b']);assert.equal((await prepared.tab(f.service,'b')).prompts.length,3);
  f.directories.get(docs).push({name:'later.prompt.md',directory:false});now+=1501;assert.equal((await f.service.listTab('b')).prompts.length,3,'no TTL discovery');
  f.service.invalidateTabs(['b'],'explicit-refresh');assert.equal((await prepared.tab(f.service,'b')).prompts.length,4);
});
test('disabled/empty bindings are ready-empty; legacy grouping and namespaces survive', async t => {
  const f=fixture();t.after(()=>f.service.close());f.bindings.set('empty',[]);f.bindings.set('disabled',[f.source(f.roots[0],'P',{enabled:false})]);
  assert.deepEqual(await f.service.usageForRoot('/'),[]);assert.equal(total(f.counts.readdir),0);
  const db={...f.db,getProjectsWithPromptSources:()=>[...f.projects.values()],getProjectPromptSources:id=>[f.source(f.roots[0],id)]};
  const service=new ProjectPromptCatalogService({db,fsImpl:f.fsImpl,asyncFs:f.asyncFs,watch:false,authorityFence:prepared.controlledFence(db)});t.after(()=>service.close());
  const usage=await prepared.usage(service,'/');assert.equal(usage.length,2);assert.deepEqual(usage[0].projects.map(v=>v.id),['P','Q']);assert.equal('tabs' in usage[0],false);
});
test('configured aliases retain independent layout/IDs; every request rechecks canonical leaves/retarget', async t => {
  const f=fixture();t.after(()=>f.service.close());const original=f.roots[0],alias='/alias/Prompts';f.addRoot(alias);
  const realpath=f.fsImpl.realpathSync;f.fsImpl.realpathSync=v=>realpath(v.startsWith(alias)?original+v.slice(alias.length):v);
  f.bindings.set('original',[f.source()]);f.bindings.set('alias',[f.source(alias)]);const docs=path.join(alias,'docs');
  f.layoutStore.get=root=>({layout:root===alias?{orderByParent:{[docs]:[path.join(docs,'10.prompt.md')]}}:{}});
  assert.equal((await prepared.usage(f.service,original)).length,4);const a=await f.service.listTab('original'),b=await f.service.listTab('alias');
  assert.deepEqual(a.prompts.map(v=>v.title),['2','10']);assert.deepEqual(b.prompts.map(v=>v.title),['10','2']);assert.notEqual(a.prompts[0].id,b.prompts[1].id);
  assert.ok(b.prompts.every(p=>p.path.startsWith(alias+'/')));assert.equal(total(f.counts.readdir),2);
  f.fsImpl.realpathSync=v=>v.startsWith(alias)?'/moved'+v.slice(alias.length):v;assert.equal((await prepared.usage(f.service,original)).length,2);
});

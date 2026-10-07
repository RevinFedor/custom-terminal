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
  const registry = {
    listSourceScopes: () => [...bindings.keys()].map(tabId => ({ tabId, name: tabId })),
    sourcesForTab: tabId => { count('bindings', tabId); return bindings.get(tabId).map(value => ({ ...value })); },
  };
  const db = { getProjectById: id => { count('projects', id); return projects.get(id) || null; } };
  const layoutStore = { get: () => ({ layout: {} }) };
  const service = new ProjectPromptCatalogService({ db, rootRegistry: registry, fsImpl, layoutStore, watch: false });
  return { service, roots, directories, bindings, source, counts, projects, layoutStore, fsImpl, addRoot, db };
}

const total = map => [...map.values()].reduce((a, b) => a + b, 0);

test('one usage read scans identical bindings once while preserving every open/archive tab and project', () => {
  const f = fixture();
  for (let i = 0; i < 80; i++) f.bindings.set(i ? `archive-${i}` : 'open', [f.source()]);
  f.bindings.set('foreign-namespace', [f.source(f.roots[0], 'Q')]);
  const usages = f.service.usageForRoot('/');
  assert.equal(usages.length, 2);
  assert.deepEqual(usages.map(value => path.basename(value.path)), ['2.prompt.md', '10.prompt.md']);
  assert.equal(usages[0].tabs.length, 81);
  assert.deepEqual(usages[0].projects.map(value => value.name), ['Project 2', 'Project 10']);
  assert.equal(f.counts.readdir.get(path.join(f.roots[0], 'docs')), 2, 'one scan per namespace');
  assert.equal(total(f.counts.stat), 2, 'one source/docs state per request');
  assert.equal(total(f.counts.realpath), 3, 'request root and two unique prompt paths');
  assert.deepEqual([...f.counts.projects.values()], [1, 1], 'one metadata read per project');
  assert.equal(total(f.counts.bindings), 81, 'each exact binding remains authoritative');
  const a = f.service.tabCache.get('open').value, b = f.service.tabCache.get('archive-1').value;
  assert.deepEqual(a.prompts, b.prompts);
  assert.notEqual(a.prompts[0], b.prompts[0]);
  assert.notEqual(a.prompts[0].file_paths, b.prompts[0].file_paths);
  assert.notEqual(a.prompts[0].id, f.service.tabCache.get('foreign-namespace').value.prompts[0].id);
  f.projects.set('P', { id: 'P', name: 'Renamed project', icon: 'new-icon' });
  const renamed = f.service.usageForRoot('/')[0].projects.find(value => value.id === 'P');
  assert.deepEqual(renamed, { id: 'P', name: 'Renamed project', icon: 'new-icon' }, 'project metadata refreshes even with warm tab catalogs');
});

test('source labels, exact configured paths and manual layouts cannot share an incorrect scan', () => {
  const f = fixture();
  f.bindings.set('single', [f.source()]);
  f.bindings.set('duplicate-basename', [f.source(), f.source(f.roots[1])]);
  f.bindings.set('other-namespace', [f.source(f.roots[0], 'Q')]);
  f.service.usageForRoot('/');
  const single = f.service.tabCache.get('single').value;
  const duplicate = f.service.tabCache.get('duplicate-basename').value;
  assert.equal(single.prompts[0].sourceName, 'Prompts');
  assert.equal(duplicate.prompts[0].sourceName, 'Prompts · /catalog');
  assert.equal(duplicate.prompts[2].sourceName, 'Prompts · /other');
  assert.equal(f.counts.readdir.get(path.join(f.roots[0], 'docs')), 3, 'label and namespace both separate');

  f.service.tabCache.clear();
  f.bindings.clear();
  f.bindings.set('layout-a', [f.source()]); f.bindings.set('layout-b', [f.source()]);
  let reads = 0;
  const docs = path.join(f.roots[0], 'docs');
  f.layoutStore.get = () => ({ layout: ++reads === 1 ? {} : { orderByParent: { [docs]: [path.join(docs, '10.prompt.md')] } } });
  f.service.usageForRoot('/');
  assert.deepEqual(f.service.tabCache.get('layout-a').value.prompts.map(v => v.title), ['2', '10']);
  assert.deepEqual(f.service.tabCache.get('layout-b').value.prompts.map(v => v.title), ['10', '2']);
});

test('request reuse expires at return; exact binding, root reappearance, invalidation and existing TTL still refresh', t => {
  const f = fixture();
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  f.bindings.set('a', [f.source()]); f.bindings.set('b', [f.source()]);
  f.service.usageForRoot('/');
  const first = f.service.tabCache.get('a').value;
  f.service.usageForRoot('/');
  assert.equal(f.service.tabCache.get('a').value, first, 'normal warm cache retained');
  assert.equal(total(f.counts.stat), 4, 'new request rechecks the shared root');
  assert.equal(f.counts.projects.get('P'), 2, 'project metadata is not persisted in request cache');

  f.bindings.set('a', [f.source(f.roots[1])]);
  f.service.usageForRoot('/');
  assert.equal(f.service.tabCache.get('a').value.prompts[0].sourceRoot, f.roots[1], 'exact signature changes before TTL');
  const docs = path.join(f.roots[0], 'docs');
  f.directories.delete(docs);
  f.service.usageForRoot('/');
  assert.deepEqual(f.service.tabCache.get('b').value.prompts, []);
  f.addRoot(f.roots[0]);
  f.service.usageForRoot('/');
  assert.equal(f.service.tabCache.get('b').value.prompts.length, 2, 'reappearing root changes signature');

  f.directories.get(docs).push({ name: 'new.prompt.md', directory: false });
  f.service.invalidateTabs(['b']);
  f.service.usageForRoot('/');
  assert.equal(f.service.tabCache.get('b').value.prompts.length, 3);
  f.directories.get(docs).push({ name: 'later.prompt.md', directory: false });
  now += 1501;
  f.service.usageForRoot('/');
  assert.equal(f.service.tabCache.get('b').value.prompts.length, 4, 'original 1500ms TTL unchanged');
});

test('disabled/empty bindings stay empty; legacy project catalogs retain their original grouping', () => {
  const f = fixture();
  f.bindings.set('empty', []); f.bindings.set('disabled', [f.source(f.roots[0], 'P', { enabled: false })]);
  assert.deepEqual(f.service.usageForRoot('/'), []);
  assert.equal(total(f.counts.readdir), 0);
  const projects = [...f.projects.values()];
  const db = { ...f.db, getProjectsWithPromptSources: () => projects,
    getProjectPromptSources: projectId => [f.source(f.roots[0], projectId)] };
  const service = new ProjectPromptCatalogService({ db, fsImpl: f.fsImpl, watch: false });
  const legacy = service.usageForRoot('/');
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy[0].projects.map(value => value.id), ['P', 'Q']);
  assert.equal('tabs' in legacy[0], false);
});

test('two configured paths to the same canonical root retain their own layout, IDs and usage paths', () => {
  const f = fixture();
  const original = f.roots[0], alias = '/alias/Prompts';
  f.addRoot(alias);
  const realpath = f.fsImpl.realpathSync;
  f.fsImpl.realpathSync = value => realpath(value.startsWith(alias) ? original + value.slice(alias.length) : value);
  f.bindings.set('original', [f.source()]); f.bindings.set('alias', [f.source(alias)]);
  const aliasDocs = path.join(alias, 'docs');
  f.layoutStore.get = root => ({ layout: root === alias
    ? { orderByParent: { [aliasDocs]: [path.join(aliasDocs, '10.prompt.md')] } } : {} });
  const usages = f.service.usageForRoot(original);
  assert.equal(usages.length, 4, 'canonical containment preserves both configured paths');
  const a = f.service.tabCache.get('original').value, b = f.service.tabCache.get('alias').value;
  assert.deepEqual(a.prompts.map(v => v.title), ['2', '10']);
  assert.deepEqual(b.prompts.map(v => v.title), ['10', '2']);
  assert.notEqual(a.prompts[0].id, b.prompts[1].id);
  assert.ok(b.prompts.every(v => v.path.startsWith(alias + '/')));
  assert.equal(total(f.counts.readdir), 2);
  f.fsImpl.realpathSync = value => value.startsWith(alias) ? '/moved' + value.slice(alias.length) : value;
  assert.equal(f.service.usageForRoot(original).length, 2, 'a changed canonical target is rechecked by the next request');
});

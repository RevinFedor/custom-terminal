const prepared = require('./project-prompt-catalog.test-support.cjs');
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {scanSource, ProjectPromptCatalogService} = require('./project-prompt-catalog');
const {buildPromptMenuTemplate} = require('./prompt-menu-template');

function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/noted-prompt-discovery-');
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, text);
    return file;
  };
  const ordinary = Array.from({length:10}, (_,i) => write(
    `docs/${i<5?'prompts':'tmp'}/topic${i}/same.prompt.md`, `user ${i}`));
  const dependencies = [];
  for (let copy=0;copy<10;copy++) for (const kind of ['plan','generate','coverage','heal']) {
    dependencies.push(write(`docs/tmp/job${copy}/${copy%2?'output':'snapshot'}/repo/node_modules/playwright/lib/agents/playwright-test-${kind}.prompt.md`, kind));
  }
  write('docs/ignored.md','not a prompt');
  write('outside.prompt.md','outside docs');
  const reads = [];
  const fsImpl = {...fs,readdirSync:(directory,options) => {
    reads.push(directory);return fs.readdirSync(directory,options);
  }};
  const source = {rootPath:root,rootId:'source',id:'source',projectId:'N',enabled:true};
  const registry = {
    sourcesForTab:()=>[source],
    listSourceScopes:()=>[{tabId:'open'},{tabId:'archive'}],
  };
  const db = {getProjectById:()=>({id:'N',name:'Legacy',path:root}),
    getProjectPromptSources:()=>[source],getProjectsWithPromptSources:()=>[{id:'N'}]};
  const layout = {orderByParent:{[path.join(root,'docs','prompts','topic0')]:[ordinary[0]],
    [path.join(root,'docs','tmp')]:[path.join(root,'docs','tmp','job0'),path.join(root,'docs','tmp','topic9')]}};
  const service = new ProjectPromptCatalogService({db,rootRegistry:registry,fsImpl,asyncFs:{...fs.promises,opendir:async(p,...a)=>{reads.push(p);return fs.promises.opendir(p,...a);}},authorityFence:prepared.controlledFence(registry),watch:false,
    layoutStore:{get:()=>({layout})}});
  t.after(()=>service.close());
  return {root,write,ordinary,dependencies,reads,fsImpl,service,layout};
}

test('four dependency templates copied ten times are excluded without losing same-title user prompts or reading dependency directories',t=>{
  const f=fixture(t);
  const catalog=scanSource({projectId:'N',rootPath:f.root,layout:f.layout,fsImpl:f.fsImpl});
  assert.deepEqual(catalog.prompts.map(p=>p.path).sort(), [...f.ordinary].sort());
  assert.equal(new Set(catalog.prompts.map(p=>p.id)).size, f.ordinary.length);
  assert.ok(catalog.prompts.every(p=>p.title==='same'));
  assert.ok(f.reads.every(p=>!p.split(path.sep).includes('node_modules')), 'no recursive read inside excluded dependencies');
  for(const prompt of catalog.prompts) {
    assert.equal(prompt.id, `project-prompt:N:${crypto.createHash('sha1').update(prompt.path).digest('hex').slice(0,16)}`);
    assert.deepEqual(prompt.file_paths,[prompt.path]);
    assert.equal(prompt.content,'');
  }
  assert.ok(catalog.prompts.findIndex(p=>p.path===f.ordinary[9]) < catalog.prompts.findIndex(p=>p.path===f.ordinary[5]), 'manual tmp order retained');
  assert.ok(f.dependencies.every(p=>fs.existsSync(p)), 'discovery does not delete snapshot files');
});

test('tab picker, legacy project, usage and context menu share the discovery boundary',async t=>{
  const f=fixture(t),tab=await prepared.tab(f.service,'open'),legacy=await prepared.project(f.service,'N');
  const expected=[...f.ordinary].sort();
  assert.deepEqual(tab.prompts.map(p=>p.path).sort(),expected);
  assert.deepEqual(legacy.prompts.map(p=>p.path).sort(),expected);
  const usage=await prepared.usage(f.service,f.root);
  assert.deepEqual(usage.map(p=>p.path).sort(),expected);
  assert.ok(usage.every(p=>p.tabs.map(t=>t.id).join(',')==='open,archive'));
  const picked=[],menu=buildPromptMenuTemplate({projectCatalog:tab,onPick:p=>picked.push(p.path)});
  const rows=menu[0].submenu.filter(row=>typeof row.click==='function');
  assert.equal(rows.length,f.ordinary.length);
  rows.forEach(row=>row.click());
  assert.deepEqual(picked.sort(),expected);
  assert.ok(f.reads.every(p=>!p.split(path.sep).includes('node_modules')));
});

test('only the exact dependency directory is excluded; ordinary tmp, uppercase suffix and configured root aliases keep their paths',t=>{
  const f=fixture(t),named=f.write('docs/node_modules.prompt.md','ordinary filename');
  const sibling=f.write('docs/node_modules-notes/user.PROMPT.MD','ordinary directory');
  const hidden=f.write('docs/.hidden/private.prompt.md','hidden');
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(f.root,'docs','escape'),'dir');
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias,'dir');
  const result=scanSource({projectId:'N',rootPath:alias,fsImpl:f.fsImpl});
  const paths=result.prompts.map(p=>p.path);
  assert.ok(paths.includes(path.join(alias,path.relative(f.root,named))));
  assert.ok(paths.includes(path.join(alias,path.relative(f.root,sibling))));
  assert.ok(!paths.includes(path.join(alias,path.relative(f.root,hidden))));
  assert.equal(paths.length,f.ordinary.length+2);
  assert.ok(paths.every(p=>p.startsWith(alias+path.sep)));
});

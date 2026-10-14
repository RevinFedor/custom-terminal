'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {execFileSync} = require('node:child_process');

// Execute the actual module and expose one existing function in memory only.
const filename = path.join(__dirname, 'git.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.statusReadControl = getStatusForRoot;', filename);
const readStatus = loaded.exports.statusReadControl;

function git(root, args) {
  return execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','gc.auto=0',
    '-c','maintenance.auto=false', ...args], {cwd:root,encoding:'utf8',env:{...process.env,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-status-readonly-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  git(root,['-c','init.templateDir=','init','--quiet']);
  git(root,['config','user.name','Private test']);git(root,['config','user.email','fixture@example.invalid']);
  git(root,['config','gc.auto','0']);git(root,['config','maintenance.auto','false']);
  fs.writeFileSync(path.join(root,'tracked.txt'),'original\n');
  git(root,['add','tracked.txt']);git(root,['commit','--quiet','-m','private fixture']);
  return root;
}
function replaceSameContent(root) {
  const file=path.join(root,'tracked.txt'), replacement=path.join(root,'replacement.tmp');
  fs.writeFileSync(replacement,fs.readFileSync(file));fs.renameSync(replacement,file);
}

for(const detail of ['summary','full']) test(detail+' status reports fresh changes without refreshing the watched Git index',async t=>{
  const root=fixture(t);replaceSameContent(root);
  const index=path.join(root,'.git','index'), before=fs.readFileSync(index);
  const clean=await readStatus(root,detail);
  assert.equal(clean.changedCount,0);
  assert.deepEqual(fs.readFileSync(index),before,'a status read must not rewrite index stat metadata');
  fs.writeFileSync(path.join(root,'tracked.txt'),'changed\n');
  fs.writeFileSync(path.join(root,'untracked.txt'),'new\n');
  const changed=await readStatus(root,detail);
  assert.equal(changed.changedCount,2,'fresh unstaged and untracked changes remain visible');
  assert.deepEqual(fs.readFileSync(index),before);
  git(root,['add','tracked.txt']);
  assert.notDeepEqual(fs.readFileSync(index),before,'explicit staging still writes the index');
  const staged=await readStatus(root,'full');
  assert.equal(staged.files.find(f=>f.path==='tracked.txt').staged,true);
  assert.equal(staged.files.find(f=>f.path==='untracked.txt').xy,'??');
});

test('ordinary Git refresh changes the stale index, distinguishing the control',t=>{
  const root=fixture(t);replaceSameContent(root);
  const index=path.join(root,'.git','index'),before=fs.readFileSync(index);
  git(root,['-c','core.quotepath=false','status','--porcelain=v1','-b']);
  assert.notDeepEqual(fs.readFileSync(index),before);
});

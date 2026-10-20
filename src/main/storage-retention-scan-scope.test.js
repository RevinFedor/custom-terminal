'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StorageCleanupService } = require('./storage-cleanup-service');
const { scanStorageInventory } = require('./storage-inventory');
const { publishTestRun } = require('./storage-test-runs');
const quiet = { log() {}, warn() {}, error() {} };
const HOUR = 3_600_000;

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-scan-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(file, value = 'synthetic fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}
function inventory(items = [], now = Date.now()) {
  return { success: true, generation: 'fixture-generation', scannedAt: now,
    settings: { enabled: true, gracePeriodHours: 24, retentionDays: {} }, items };
}

test('retention and full accounting keep real sessions/protection; only full includes builds/Test runs', async t => {
  const root = rootFor(t), codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude');
  const appDataDir = path.join(root, 'app'), projectRoot = path.join(root, 'checkout');
  put(path.join(codexHome, 'sessions', 'open.jsonl'), JSON.stringify({type:'session_meta',payload:{id:'open',cwd:root}})+'\n');
  put(path.join(claudeHome, 'projects', '-fixture', 'closed.jsonl'), JSON.stringify({type:'user',sessionId:'closed',cwd:root,message:{content:'synthetic only'}})+'\n');
  put(path.join(appDataDir, 'noted-terminal.db'), 'not a real DB: accounting must stat only');
  put(path.join(appDataDir, 'noted-terminal.db.backup-old'));
  put(path.join(appDataDir, 'Cache', 'synthetic.bin'));
  put(path.join(projectRoot, 'release', 'synthetic.bundle'));
  const runRoot = path.join(root, 'profiles', 'noted-synthetic-run');
  const userDataDir = path.join(runRoot, 'data', 'user-data');
  put(path.join(userDataDir, 'noted-terminal.db'), 'synthetic size fixture, never opened as SQLite');
  await publishTestRun({runRoot,userDataDir,title:'owned fixture'});
  const phases = [];
  const options = {codexHome,claudeHome,appDataDir,projectRoot,testRunRoots:[path.join(root,'profiles')],
    runtimeProtectedSessionIds:['open'],logger:{...quiet,log:message=>phases.push(message)}};
  const narrow = await scanStorageInventory({...options,scope:'retention'});
  assert.equal(narrow.scanScope,'retention');
  assert.deepEqual(new Set(narrow.items.map(x=>x.section)),new Set(['sessions','app']));
  assert.equal(narrow.items.find(x=>x.sessionId==='open').protected,true);
  assert.ok(narrow.items.some(x=>x.sessionId==='closed'));
  assert.ok(narrow.items.some(x=>x.group==='app-backup'));
  assert.equal(narrow.items.some(x=>x.group==='app-active' || x.group==='app-cache'),false);
  assert.equal(narrow.testRuns.skipped,'retention-scope');
  assert.equal(narrow.testRuns.complete,false);
  const phaseRows = phases.filter(x=>x.startsWith('[StorageInventory:Phase] ')).map(x=>JSON.parse(x.slice('[StorageInventory:Phase] '.length)));
  assert.ok(phaseRows.some(x=>x.phase==='sessions' && x.state==='completed'));
  assert.equal(phaseRows.some(x=>x.phase==='test-runs' || x.phase==='builds'),false);
  const full = await scanStorageInventory({...options,scope:'full'});
  assert.ok(full.items.some(x=>x.section==='builds'));
  assert.ok(full.items.some(x=>x.section==='test-runs'));
  assert.ok(full.items.some(x=>x.group==='app-active'));
  assert.ok(full.items.some(x=>x.group==='app-cache'));
  assert.equal(full.testRuns.complete,true);
  assert.deepEqual(full.items.filter(x=>x.section==='sessions').map(x=>[x.id,x.protected]).sort(),
    narrow.items.filter(x=>x.section==='sessions').map(x=>[x.id,x.protected]).sort());
});

test('retention does not join a held full-accounting flight or replace its Home cache', async t => {
  const root = rootFor(t), calls = [];
  let releaseFull;
  const held = new Promise(resolve => { releaseFull = resolve; });
  const fullItem = {id:'test-profile',section:'test-runs',group:'test-run',sizeBytes:42,protected:true,deletable:false};
  const service = new StorageCleanupService({appDataDir:root,logger:quiet,
    scanInventory: options => {calls.push(options.scope);return options.scope==='full' ? held : Promise.resolve(inventory());}});
  const full = service.scan({force:true});
  const narrow = service.runRetentionSweep({dryRun:true});
  try {
    // Deterministic call-boundary assertion; no timer is used to prove progress.
    assert.deepEqual(calls,['full','retention']);
    const result = await narrow;
    assert.equal(result.success,true);
    assert.deepEqual(result.sessions,[]);
    assert.equal(service.cached,null);
    assert.ok(service.scanInflight);
    assert.equal(service.retentionScanInflight,null);
  } finally { releaseFull(inventory([fullItem])); }
  const complete = await full;
  assert.equal(service.cached,complete);
  assert.equal((await service.scan()).items[0].section,'test-runs');
  assert.deepEqual(calls,['full','retention']);
});

test('a full read held across cleanup retries once instead of resurrecting removed rows/clocks', async t => {
  const root = rootFor(t), calls = [];
  let releaseFull, fullReads=0;
  const held=new Promise(resolve=>{releaseFull=resolve;});
  const stale={id:'removed',section:'sessions',group:'outside',provider:'claude',sessionId:'removed',
    path:path.join(root,'removed.jsonl'),sizeBytes:1,protected:false,deletable:true,deleteAfter:1};
  const service=new StorageCleanupService({appDataDir:root,logger:quiet,scanInventory:options=>{
    calls.push(options.scope);
    if(options.scope==='full' && ++fullReads===1)return held;
    return Promise.resolve(inventory());
  }});
  const full=service.scan({force:true});
  const result=await service.runRetentionSweep();
  assert.equal(result.success,true);
  releaseFull(inventory([stale]));
  const complete=await full;
  assert.deepEqual(calls,['full','retention','full']);
  assert.deepEqual(complete.items,[]);
  assert.equal(service._getGraceStore().get('removed'),undefined);
  assert.equal(service.cached,complete);
  assert.equal(service.scanInflight,null);
});

test('both retention selection and final deletion scan stay narrow and preserve a protected source', async t => {
  const root = rootFor(t), calls = [];
  const target = put(path.join(root,'claude','projects','old.jsonl'),'synthetic closed conversation');
  const source = put(path.join(root,'claude','projects','open.jsonl'),'synthetic protected conversation');
  const stat = fs.statSync(target);
  const items = [
    {id:'old',section:'sessions',group:'outside',provider:'claude',sessionId:'old',path:target,
      sizeBytes:stat.size,modifiedAt:stat.mtimeMs,fileIdentity:`${stat.dev}:${stat.ino}`,protected:false,deletable:true,eligible:true,deleteAfter:1},
    {id:'open',section:'sessions',group:'open',provider:'claude',sessionId:'open',path:source,
      sizeBytes:fs.statSync(source).size,protected:true,deletable:false,eligible:false},
  ];
  let now = Date.now();
  const service = new StorageCleanupService({appDataDir:root,claudeHome:path.join(root,'claude'),logger:quiet,now:()=>now,
    getRuntimeProtectedSessionIds:()=>['open'],audit:{record:async()=>{}},
    scanInventory:async options=>{calls.push(options.scope);assert.equal(options.scope,'retention');return inventory(items,now);}});
  await service.scan({scope:'retention',force:true});
  now += 24*HOUR+1_000;
  const result = await service.runRetentionSweep();
  assert.equal(result.success,true);
  assert.deepEqual(result.removed,['old']);
  assert.deepEqual(calls,['retention','retention','retention']);
  assert.equal(fs.existsSync(target),false);
  assert.equal(fs.existsSync(source),true);
  assert.equal(service.cached,null);
});


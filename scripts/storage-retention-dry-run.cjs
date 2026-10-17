'use strict';

// Bounded run/dry-run verification. Never opens a user's application database,
// launches an app/provider, sends a prompt, or contacts another session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('../src/main/database');
const { ClosedTabRetention } = require('../src/main/storage-closed-tabs');
const { normalizeStorageRetentionSettings } = require('../src/main/storage-inventory');
const { publishTestRun, scanTestRuns, ownsPrivateTestProfile } = require('../src/main/storage-test-runs');
const { pruneSnapshotBatch, startSnapshotPrune } = require('../src/main/workflow-snapshot-prune');
const { reconcileStorageGrace } = require('../src/main/storage-retention-grace');
const { createWorkflowOrganizationApi } = require('../src/main/workflow-organization-api');
const { StorageCleanupService, canOwnAutomaticStorageRetention } = require('../src/main/storage-cleanup-service');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { CodexStorageDeletionProvider } = require('../src/main/codex-storage-deletion-provider');
const { createStorageMaintenance } = require('../src/main/storage-maintenance-api');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-retention-dry-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  const manager = new DatabaseManager({ existingConnection: db });
  const checks = [];
  try {
    manager.initTables();
    db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P', root, 'fixture');
    const now = Date.now(), old = Math.floor((now - 3 * 86400_000) / 1000);
    const settings = normalizeStorageRetentionSettings({ gracePeriodHours: 24 });
    const add = db.prepare('INSERT INTO tab_history(project_id,tab_id,name,cwd,closed_at,codex_session_id,notes) VALUES(?,?,?,?,?,?,?)');
    const addHistory = (tabId, sessionId = null, at = old) => Number(add.run('P', tabId, tabId, root, at, sessionId, 'old restore note').lastInsertRowid);
    const expired = addHistory('expired');
    const young = addHistory('young', null, Math.floor(now / 1000));
    const stopped = addHistory('stopped', 'saved-current');
    const runtime = addHistory('runtime', 'live');
    const restore = addHistory('restore-race');
    const missing = addHistory('missing', 'already-deleted');
    const present = addHistory('present', 'still-on-disk');
    const ancestor = addHistory('ancestor', 'needed-source');
    const member = addHistory('reserve-in-other-workflow');
    db.exec(`CREATE TABLE workflow_org_workflows(workflow_id TEXT PRIMARY KEY,deleted_generation INTEGER);
      CREATE TABLE workflow_org_memberships(tab_id TEXT PRIMARY KEY,workflow_id TEXT);
      INSERT INTO workflow_org_workflows VALUES('other-workflow',NULL);
      INSERT INTO workflow_org_memberships VALUES('reserve-in-other-workflow','other-workflow')`);
    db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,codex_session_id) VALUES(?,?,?,?,?)').run('P', 'stopped', 'stopped', root, 'saved-current');
    db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd) VALUES(?,?,?,?)').run('P', 'reserve-in-other-workflow', 'reserve', root);
    db.exec('CREATE TABLE rag_fixture(history_id INTEGER REFERENCES tab_history(id) ON DELETE CASCADE, content BLOB)');
    db.prepare('INSERT INTO rag_fixture VALUES(?,?)').run(expired, Buffer.from('precious RAG, do not delete'));
    let restoreInProgress = false;
    const auditEvents = [];
    const retention = new ClosedTabRetention({ db, now: () => now, getSettings: () => settings,
      getRuntimeSessionIds: () => ['live'], getRuntimeTabIds: () => ['runtime'], isRestoreInProgress: id => restoreInProgress && id === restore,
      audit: { record: async event => { auditEvents.push(event); if (event.historyId === restore) restoreInProgress = true; } }, logger: { log() {} } });
    const inventory = { settings, sessionCoverage: { codex: true, claude: true }, items: [
      { section: 'sessions', provider: 'codex', sessionId: 'still-on-disk', protected: false, group: 'regular' },
      { section: 'sessions', provider: 'codex', sessionId: 'needed-source', protected: true, group: 'open' },
    ] };
    const plan = await retention.run({ inventory, dryRun: true });
    assert.deepEqual(plan.candidates.map(row => row.historyId), [expired, restore, missing, present, ancestor]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM storage_expired_tab_history').get().n, 0);
    assert.equal(auditEvents.length, 0); checks.push('dry-run selects only mature fully closed tabs, no mutation');
    const result = await retention.run({ inventory });
    assert.deepEqual(result.expiredHistoryIds, [expired, missing, present, ancestor]);
    for (const id of [young, stopped, runtime, restore, member]) assert.ok(manager.getTabHistoryEntry(id, 'P'));
    assert.equal(manager.getTabHistoryEntry(expired, 'P'), undefined);
    assert.equal(manager.getTabHistory('P').some(row => row.id === expired), false);
    assert.equal(db.prepare('SELECT content FROM rag_fixture').get().content.toString(), 'precious RAG, do not delete');
    assert.equal(db.prepare('SELECT notes FROM tab_history WHERE id=?').get(expired).notes, null);
    checks.push('expiration consumes archive/restore metadata and preserves exact RAG bytes');
    assert.equal(result.failures[0].error, 'archive-changed-or-restored');
    assert.equal(auditEvents.find(event => event.historyId === expired).status, 'attempt');
    checks.push('restore during audit await wins; stopped/reserve and live sessions are protected');
    const neverSettings = normalizeStorageRetentionSettings({ retentionDays: { regular: null } });
    assert.equal(retention.plan({ ...inventory, settings: neverSettings }).candidates.length, 0);
    addHistory('unknown-file', 'unknown');
    const unknown = retention.plan({ ...inventory, sessionCoverage: {} }).candidates.find(row => row.tabId === 'unknown-file');
    assert.equal(unknown.conversationsPending.length, 1);
    checks.push('Never is respected; unavailable provider files remain explicit pending work, never raw-unlinked');

    db.exec(`CREATE TABLE workflow_org_generations(generation INTEGER PRIMARY KEY, snapshot_json TEXT);
      CREATE TABLE receipt_fixture(id TEXT PRIMARY KEY, body TEXT); INSERT INTO receipt_fixture VALUES('unknown-receipt','do not consume')`);
    const insert = db.prepare('INSERT INTO workflow_org_generations VALUES(?,?)');
    for (let i = 1; i <= 30; i++) insert.run(i, 'x'.repeat(64 * 1024));
    assert.equal(pruneSnapshotBatch(db, { dryRun: true }).count, 27);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_org_generations').get().n, 30);
    while (pruneSnapshotBatch(db).removed) {}
    assert.deepEqual(db.prepare('SELECT generation FROM workflow_org_generations ORDER BY generation').all().map(r => r.generation), [1,29,30]);
    assert.equal(db.prepare('SELECT body FROM receipt_fixture').get().body, 'do not consume');
    checks.push('snapshot pruning keeps migration/current snapshots, does not consume receipts');
    const workerPath = path.join(root, 'own-worker.db');
    const workerDb = new Database(workerPath);
    workerDb.exec('CREATE TABLE workflow_org_generations(generation INTEGER PRIMARY KEY,snapshot_json TEXT)');
    for (let i = 1; i <= 12; i++) workerDb.prepare('INSERT INTO workflow_org_generations VALUES(?,?)').run(i, 'x'.repeat(4096));
    workerDb.close();
    const worker = startSnapshotPrune(workerPath, {log(){},warn(){}}); worker.ref();
    assert.equal((await once(worker, 'exit'))[0], 0);
    const afterWorker = new Database(workerPath);
    assert.equal(afterWorker.prepare('SELECT COUNT(*) n FROM workflow_org_generations').get().n, 3); afterWorker.close();
    checks.push('real maintenance worker prunes its own SQLite fixture, then exits');

    // Use actual V2 archive/catalog/protection, not the simplified membership
    // fixture above. Closing keeps a provenance membership; it must not keep
    // the conversation falsely classified as Open now.
    const native = new Database(':memory:');
    try {
      const nativeManager = new DatabaseManager({existingConnection:native}); nativeManager.initTables();
      const api = createWorkflowOrganizationApi({database:nativeManager});
      api.bootstrap({workspace:{activeSpaceId:'w',spaces:[{id:'w',name:'Work',projectIds:[],layout:{splitPanes:[]}}]},migrationId:'fixture-migration',mutationId:'fixture-publish'});
      api.createTab({mutationId:'fixture-create',tabId:'native-closed',workflowId:'w',cwd:root,record:{name:'closed',commandType:'codex',codexSessionId:'closed-sid'}});
      const owner = api.execution('native-closed').scope;
      nativeManager.archiveTab(owner.executionNamespace,{tabId:'native-closed',name:'closed'}, {sourceTabId:'native-closed',codexWriterSessionId:'closed-sid'});
      const catalog = await api.readCatalog();
      assert.equal(catalog.rows['native-closed'], undefined);
      assert.ok(api.service.getMembership('native-closed'), 'provenance membership deliberately survives close');
      const codexRoot = path.join(root, 'native-codex'); fs.mkdirSync(path.join(codexRoot, 'sessions'), {recursive:true});
      const rollout = path.join(codexRoot, 'sessions', 'closed-sid.jsonl');
      fs.writeFileSync(rollout, JSON.stringify({type:'session_meta',payload:{id:'closed-sid',cwd:root}})+'\n');
      let nativeNow = Date.now();
      const cleanup = new StorageCleanupService({sqlite:native,dbManager:nativeManager,
        appDataDir:path.join(root,'native-data'),codexHome:codexRoot,claudeHome:path.join(root,'native-claude'),
        now:()=>nativeNow,logger:{log(){},warn(){}},audit:{record:async()=>{}},
        deleteCodexSession:async(_id,item)=>{assert.equal(item.path,rollout);fs.unlinkSync(item.path);}});
      const first = await cleanup.scan({force:true});
      assert.equal(first.items.find(item=>item.sessionId==='closed-sid').protected,false);
      nativeNow += 26*3600_000;
      assert.equal((await cleanup.runRetentionSweep({dryRun:true})).sessions.length,1);
      const cleaned = await cleanup.runRetentionSweep();
      assert.equal(cleaned.success,true);assert.equal(fs.existsSync(rollout),false);
      assert.equal(cleaned.expiredHistoryIds.length,1);
      assert.equal(api.archive.read().history.length,0);
      checks.push('real V2 close/provenance is not Open now; own-file deletion then History expiration uses one pipeline (provider substituted)');
    } finally {native.close();}

    const proven = {id:'committed-close',section:'sessions',provider:'codex',sessionId:'sid',group:'regular',path:'/fixture',
      fileIdentity:'1:1',sizeBytes:1,createdAt:now-5*86400_000,modifiedAt:now-4*86400_000,
      closedAt:now-3*86400_000,deleteAfter:now-2*86400_000,deletable:true,protected:false};
    const firstObserved = reconcileStorageGrace([proven],settings,now);
    assert.equal(firstObserved.items[0].eligible,false);
    assert.equal(reconcileStorageGrace([proven],settings,now+24*3600_000,firstObserved.clocks).items[0].eligible,true);
    assert.equal(reconcileStorageGrace([{...proven,createdAt:now}],settings,now).items[0].eligible,false);
    assert.equal(reconcileStorageGrace([{...proven,modifiedAt:now}],settings,now).items[0].eligible,false);
    checks.push('physical files retain their proven full wait; old timestamps never backdate a new/recovered file');

    const runRoot = path.join(root, 'noted-synthetic-run');
    const userData = path.join(runRoot, 'data', 'user-data');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'noted-terminal.db'), Buffer.alloc(8192));
    const codex = path.join(runRoot, 'data', 'codex');
    fs.mkdirSync(path.join(codex, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'sessions', 'fixture.jsonl'), '{}\n');
    const claude = path.join(runRoot,'data','claude');fs.mkdirSync(claude);
    const profile = await publishTestRun({ runRoot, userDataDir: userData, codexHome: codex, claudeHome: claude });
    const privateOwner = {profile,userDataDir:userData,codexHome:codex,claudeHome:claude,e2e:true};
    assert.equal(ownsPrivateTestProfile(privateOwner),true);
    assert.equal(ownsPrivateTestProfile({...privateOwner,codexHome:root}),false);
    assert.equal(canOwnAutomaticStorageRetention({isPackaged:true,e2e:true}),false);
    assert.equal(canOwnAutomaticStorageRetention({isPackaged:false,e2e:true,isolatedTest:ownsPrivateTestProfile(privateOwner)}),true);
    assert.equal(canOwnAutomaticStorageRetention({isPackaged:true,e2e:false,canonicalProduction:false}),false);
    // Outside dependencies/originals are never followed by accounting.
    fs.symlinkSync(path.dirname(root), path.join(runRoot, 'external-source'));
    const scan = await scanTestRuns({ roots: [root] });
    assert.equal(scan.complete, true);
    assert.equal(scan.items.filter(item => item.component === 'database').length, 1);
    assert.equal(scan.items.filter(item => item.component === 'conversations').length, 1);
    assert.ok(scan.items.every(item => item.section === 'test-runs' && item.protected && !item.deletable));
    checks.push('Test runs identifies an exact private profile, separates DB/conversations and skips symlinks');
    const client = new EventEmitter(); let providerDeletes = 0;
    client.start = async()=>{};client.close=()=>{};
    client.request = async(method,request)=>{
      if(method==='thread/list')return {data:[],nextCursor:null};
      if(method==='thread/read')return {thread:{id:request.threadId,path:path.join(userData,'noted-terminal.db')}};
      if(method==='thread/delete'){providerDeletes++;return {};}
      throw Error('unexpected fake provider method');
    };
    const privateProvider = new CodexStorageDeletionProvider({codexHome:codex,allowedRoot:codex,clientFactory:()=>client});
    await assert.rejects(privateProvider.inspectDeleteClosure('stale-copied-path'),{code:'storage_test_provider_path_outside_scope'});
    assert.equal(providerDeletes,0);privateProvider.close();
    checks.push('copied provider state pointing outside private CODEX_HOME fails before delete (protocol client substituted)');
    let cleanupCalls = 0, finishCleanup;
    const maintenance = createStorageMaintenance({database:manager,getService:()=>({runRetentionSweep:()=>{
      cleanupCalls++;return new Promise(resolve=>{finishCleanup=resolve;});}})});
    const firstCleanup = maintenance.cleanup({operationId:'fixture-cleanup-001'});
    assert.equal((await maintenance.cleanup({operationId:'fixture-cleanup-001'})).state,'started');
    assert.equal(cleanupCalls,1);
    finishCleanup({success:true,removed:[],expiredHistoryIds:[]});
    assert.equal((await firstCleanup).state,'completed');
    assert.equal((await maintenance.cleanup({operationId:'fixture-cleanup-001'})).state,'completed');
    assert.equal(cleanupCalls,1);
    await assert.rejects(maintenance.cleanup({operationId:'fixture-cleanup-001',maxItems:1}),/storage_operation_id_conflict/);
    checks.push('maintenance API receipt does not replay a started/completed cleanup; changed request conflicts (executor substituted)');
    const output = JSON.stringify({ success: true, checks, currentTabsChanged: 0, applicationsLaunched: 0, productionReadOrWritten: false }, null, 2);
    const outputIndex = process.argv.indexOf('--output');
    if(outputIndex>=0)fs.writeFileSync(process.argv[outputIndex+1],output+'\n',{flag:'wx',mode:0o600});
    console.log(output);
  } finally {
    db.close();
    // Only our freshly created exact fixture. No symlink traversal.
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

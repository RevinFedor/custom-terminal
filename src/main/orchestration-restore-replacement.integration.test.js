'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createWorkflowOrganizationApi } = require('./workflow-organization-api');
const { TabHistoryRestoreLeases } = require('./tab-history-restore-leases');
const { OrchestrationRunStore, isTerminalStatus } = require('./orchestration-runs');
const { runSingleFlight } = require('./agent-tab-restore');
const { TabWorkContext } = require('./tab-work-context');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const parse = (name, kind) => ts.createSourceFile(name, fs.readFileSync(path.join(__dirname, name), 'utf8'), ts.ScriptTarget.Latest, true, kind);
const app = parse('../renderer/App.tsx', ts.ScriptKind.TSX);
const web = parse('web-server.js', ts.ScriptKind.JS);
const renderer = parse('../renderer/store/useWorkspaceStore.ts', ts.ScriptKind.TS);
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}
function declaration(source, name) {
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(source);
}

async function fixture(t, { oldEquality = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-restore-replacement-'));
  const dbPath = path.join(root, 'private.sqlite');
  let db = new Database(dbPath);
  let database = new DatabaseManager({ existingConnection: db });
  database.initTables();
  db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P', root, 'P');
  db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,codex_session_id) VALUES(?,?,?,?,?,?)')
    .run('P', 'old', 'Luna', root, 'codex', 'S');
  let api = createWorkflowOrganizationApi({ database });
  api.bootstrap({ workspace: { activeSpaceId: 'a', spaces: [{ id: 'a', name: 'A', projectIds: ['P'], layout: { splitPanes: [] } }] }, migrationId: 'm', mutationId: 'a' });
  const historyId = database.archiveTab('P', { tabId: 'old', name: 'Luna', cwd: root, commandType: 'codex' }, { sourceTabId: 'old', codexWriterSessionId: 'S' });
  db.prepare('DELETE FROM tabs WHERE tab_id=?').run('old');
  const bind = () => api.archive.bindLeases(new TabHistoryRestoreLeases({ getLatest: ns => database.getLatestTabHistory(ns),
    getById: (id, ns) => database.getTabHistoryEntry(id, ns), deleteById: id => database.deleteTabHistoryEntry(id), token: () => require('node:crypto').randomUUID() }));
  bind();
  const { archiveRestoreLeaseAddress } = await import('../renderer/utils/workflowOrganizationClient.mjs');
  const { findOpenTabOwner } = await import('../renderer/utils/tabLinkNavigation.mjs');
  const workspace = { projectPath: root, tabs: new Map(), tabGroups: [] };
  let createCalls = 0;
  const state = { openProjects: new Map([['P', workspace]]), organizationReady: false,
    refreshOrganizationCatalog: async () => {},
    createTab: async (_project, name, cwd, options) => {
      createCalls++;
      const tab = { ...options, id: options.restoreId, name, cwd };
      workspace.tabs.set(tab.id, tab);
      database.saveTabs('P', [...workspace.tabs.values()].map(value => ({ ...value, tabId: value.id })), true);
      return tab.id;
    } };
  const restore = find(renderer, node => ts.isPropertyAssignment(node) && node.name.getText(renderer) === 'restoreTabHistoryEntry');
  const branch = find(app, node => ts.isIfStatement(node) && node.expression.getText(app) === "action === 'restoreClosedAgentTab'");
  assert.ok(restore && branch);
  const context = vm.createContext({ console, Map, Set, Date, Number, JSON,
    get: () => state, set: patch => Object.assign(state, patch), state,
    archiveRestoreLeaseAddress, findOpenTabOwner, archiveRestoreOwners: new Map(),
    readTabRestorePlacement: () => null, resolveExistingTabGroupId: () => null,
    resolveHistoryRestoreCwd: async () => ({ cwd: root }), normalizeComparablePath: value => value,
    parseHistoryTaskPlan: () => undefined, buildHistoryPendingAction: (_entry, policy) => { assert.equal(policy, 'never'); },
    notifyProjectLayoutChanged() {}, restoreArchivedTabWindow: () => null,
    saveTabs: async (_project, tabs) => database.saveTabs('P', [...tabs.values()].map(tab => ({ ...tab, tabId: tab.id })), true),
    isDurableSaveTabsAck: result => result?.success === true,
    formatHistoryRestoreError: (_entry, error) => error.message,
    ipcRenderer: { invoke: async (channel, payload) => {
      if (channel === 'project:begin-tab-history-restore') return api.archive.beginRestore(payload);
      if (channel === 'project:finish-tab-history-restore') return api.archive.finishRestore(payload);
      if (channel === 'project:restore-file-links') return api.archive.restoreFiles(payload);
      throw new Error('unexpected IPC ' + channel);
    } },
    useWorkspaceStore: { getState: () => state }, ensureProjectWorkspace: async () => workspace,
    reply: (ok, data, error) => { if (!ok) throw Object.assign(new Error(error), { bridgeData: data }); return data; },
  });
  let bridgeCode=branch.thenStatement.getText(app);
  if(oldEquality) {
    const previous=bridgeCode;
    bridgeCode=bridgeCode.replace('!restored.tabId || restored.historyDeleteFailed || restored.tabId !== expectedTabId && !exactReplacement',
      '!restored.tabId || restored.tabId !== expectedTabId');
    assert.notEqual(bridgeCode,previous);
  }
  vm.runInContext(ts.transpileModule(`globalThis.restore = ${restore.initializer.getText(renderer)}; globalThis.bridge = async payload => ${bridgeCode}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  state.restoreTabHistoryEntry = context.restore;
  const descriptor = id => {
    const row = db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(id);
    return row ? { tabId: id, projectId: 'P', projectName: 'P', projectPath: root, cwd: row.cwd,
      toolType: row.command_type, sessionId: row.codex_session_id, tabName: row.name } : null;
  };
  const resolution = { ok: true, tabId: 'old', historyId, projectId: 'P', cwd: root, toolType: 'codex', sessionId: 'S' };
  const main = vm.createContext({ console, Date, runSingleFlight, closedAgentRestoreInflight: new Map(),
    isTerminalStatus, getOrchestrationRunStore:()=>store, tabWorkContext:null,emitOrchestrationRun() {},
    dispatchDeferredOrchestrationRun:async runId=>{main.deliveryWakes=(main.deliveryWakes || []).concat(runId);},
    findOrchestrationTabDescriptor: descriptor, findRestorableAgentTabDescriptor: () => resolution,
    explicitAgentTargetError: value => Object.assign(new Error(value.error), { code: value.code }),
    bridgeRequest: async (_action, payload) => context.bridge(payload),
    require: name => { assert.equal(name, './project-manager'); return { db: database, workflowOrganization: api }; },
  });
  vm.runInContext(['ensureExplicitAgentTabOpen','adoptRestoredOrchestrationTarget','recoverMissingOrchestrationTarget']
    .map(name=>declaration(web,name)).join('\n'), main);
  let store = new OrchestrationRunStore(path.join(root, 'runs.json'));
  const h = { root, historyId, state, main, context, resolution, descriptor,
    get db() { return db; }, get api() { return api; }, get database() { return database; }, get store() { return store; },
    get createCalls() { return createCalls; },
    reopen: () => { db.close(); db = new Database(dbPath); database = new DatabaseManager({ existingConnection: db }); api = createWorkflowOrganizationApi({ database }); bind(); },
    restartStore: async () => { await store.flush(); store = new OrchestrationRunStore(path.join(root, 'runs.json')); await store.initialize(); },
  };
  t.after(async () => { await store.flush(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('actual renderer restore/App/Main accepts committed legacy replacement without reusing the old runtime ID', async t => {
  const f = await fixture(t);
  const restored = await f.main.ensureExplicitAgentTabOpen('old', f.resolution, { acceptRestoredTarget: true });
  assert.match(restored.descriptor.tabId, /^restored-/);
  assert.notEqual(restored.descriptor.tabId, 'old');
  assert.equal(restored.descriptor.sessionId, 'S');
  assert.equal(restored.restoration.sourceTabId, 'old');
  assert.equal(f.createCalls, 1);
  assert.equal(f.database.getTabHistoryEntry(f.historyId, 'P'), undefined);
  assert.equal([...f.state.openProjects.get('P').tabs.values()][0].pendingAction, undefined);
  f.reopen();
  assert.equal(f.api.archive.readCommittedRestoration(restored.restoration).targetTabId, restored.descriptor.tabId);
});

test('old equality reproduces failure after the same real SQLite restore committed', async t => {
  const f=await fixture(t,{oldEquality:true});
  await assert.rejects(f.main.ensureExplicitAgentTabOpen('old',f.resolution,{acceptRestoredTarget:true}),/closed tab restore failed/);
  assert.equal(f.createCalls,1);
  assert.equal(f.database.getTabHistoryEntry(f.historyId,'P'),undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM workflow_archive_finish_receipts').get().n,1);
});

test('simultaneous restores share one materialization and one committed proof', async t => {
  const f=await fixture(t);
  const [a,b]=await Promise.all([1,2].map(()=>f.main.ensureExplicitAgentTabOpen('old',f.resolution,{acceptRestoredTarget:true})));
  assert.equal(a.descriptor.tabId,b.descriptor.tabId);
  assert.equal(a.restoration.leaseToken,b.restoration.leaseToken);
  assert.equal(f.createCalls,1);
});

test('restart gap adopts only an already committed restore, without another renderer/launch operation', async t => {
  const f=await fixture(t);
  const targetRestoreAddress={namespace:'P',historyId:f.historyId,sourceTabId:'old',
    archiveIdentity:f.api.archive.identity(f.database.getTabHistoryEntry(f.historyId,'P'))};
  await f.store.reserveOrGet({runId:'gap',sourceTabId:'source',targetTabId:'old',targetProjectId:'P',targetToolType:'codex',
    targetCwd:f.root,targetRestoreAddress,targetRestoreSessionId:'S',requestFingerprint:'immutable',deliveryIntent:{prompt:'work'}});
  const restored=await f.main.ensureExplicitAgentTabOpen('old',f.resolution,{acceptRestoredTarget:true});
  await f.restartStore();
  const recovered=await f.main.recoverMissingOrchestrationTarget(await f.store.get('gap'),'startup');
  assert.equal(recovered.recovered,true);
  assert.equal(recovered.run.targetTabId,restored.descriptor.tabId);
  assert.equal(f.createCalls,1);
  assert.equal((await f.store.getInternal('gap')).requestFingerprint,'immutable');
  assert.equal(recovered.run.targetRestoration,undefined,'private lease proof is not public API data');
  assert.deepEqual([...f.main.deliveryWakes],['gap']);
  assert.equal(recovered.run.status,'queued');
});

for (const [field, value] of [['sourceTabId', 'other'], ['namespace', 'foreign'], ['historyId', 999], ['leaseToken', 'bad'], ['targetTabId', 'other']]) {
  test('durable restore proof rejects changed ' + field, async t => {
    const f = await fixture(t);
    const restored = await f.main.ensureExplicitAgentTabOpen('old', f.resolution, { acceptRestoredTarget: true });
    assert.throws(() => f.api.archive.readCommittedRestoration({ ...restored.restoration, [field]: value }), /archive_restore_/);
  });
}

for (const change of ['session', 'cwd', 'deleted', 'replacement']) {
  test('committed restore cannot authorize ' + change + ' owner', async t => {
    const f = await fixture(t);
    const restored = await f.main.ensureExplicitAgentTabOpen('old', f.resolution, { acceptRestoredTarget: true });
    const id = restored.descriptor.tabId;
    if (change === 'session') f.db.prepare('UPDATE tabs SET codex_session_id=? WHERE tab_id=?').run('other', id);
    if (change === 'cwd') f.db.prepare('UPDATE tabs SET cwd=? WHERE tab_id=?').run('/other', id);
    if (change === 'deleted' || change === 'replacement') {
      f.db.prepare('DELETE FROM tabs WHERE tab_id=?').run(id);
      if (change === 'replacement') f.db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd,command_type,codex_session_id) VALUES(?,?,?,?,?,?)').run('P', id, 'Luna', f.root, 'codex', 'S');
    }
    assert.throws(() => f.api.archive.readCommittedRestoration(restored.restoration), /archive_restore_/);
  });
}

test('new runtime adoption preserves immutable request and refuses old-target delivery proof after restart', async t => {
  const f = await fixture(t);
  const input = { runId: 'R', sourceTabId: 'source', targetTabId: 'old', targetProjectId: 'P',
    targetToolType: 'codex', targetCwd: f.root, requestFingerprint: 'immutable', deliveryIntent: { prompt: 'work' } };
  await f.store.reserveOrGet(input);
  const restored = await f.main.ensureExplicitAgentTabOpen('old', f.resolution, { acceptRestoredTarget: true });
  const adopted = await f.store.adoptRestoredTarget('R', restored);
  assert.equal(adopted.targetTabId, restored.descriptor.tabId);
  assert.equal(adopted.requestedTargetTabId, 'old');
  await f.restartStore();
  assert.equal((await f.store.reserveOrGet(input)).created, false);
  assert.equal((await f.store.getInternal('R')).requestFingerprint, 'immutable');
  assert.equal((await f.store.getInternal('R')).deliveryIntent.prompt, 'work');
  assert.equal((await f.store.reserveOrGet({ ...input, requestFingerprint: 'changed' })).conflict, true);
  const before = await f.store.get('R');
  const proof=await f.store.confirmTargetPromptDelivery('R', { targetTabId: 'old', handoffId: 'orchestration:R', source: 'orchestration:source',
    toolType: 'codex', sessionId: 'S', expectedHash: 'h', actualHash: 'h', expectedLen: 4, actualLen: 4 });
  assert.equal(proof.reason,'target-tab-mismatch');
  assert.deepEqual(await f.store.get('R'), before);
});

test('cancelled or already dispatched run cannot adopt a restored target', async t => {
  const f = await fixture(t);
  const restored = await f.main.ensureExplicitAgentTabOpen('old', f.resolution, { acceptRestoredTarget: true });
  for (const patch of [{ status: 'cancelled' }, { deliveryDispatchStartedAt: 1 }, { targetPromptProofAt: 1 }]) {
    await f.store.create({ runId: JSON.stringify(patch), sourceTabId: 'source', targetTabId: 'old', targetProjectId: 'P',
      targetToolType: 'codex', targetCwd: f.root, deliveryIntent: { prompt: 'work' } });
    const id = JSON.stringify(patch);
    await f.store.patch(id, patch);
    await assert.rejects(f.store.adoptRestoredTarget(id, restored), /orchestration_restore_/);
    assert.equal((await f.store.get(id)).targetTabId, 'old');
  }
});

test('prepared context follows only its frozen unsent handoff; current session guard remains effective', async t => {
  const f = await fixture(t);
  const restored = await f.main.ensureExplicitAgentTabOpen('old', f.resolution, { acceptRestoredTarget: true });
  const target = restored.descriptor.tabId;
  const context = new TabWorkContext({ db: f.db, listTabs: () => [{ tabId: target, commandType: 'codex', codexSessionId: 'S' }], onChanged() {} });
  f.db.prepare(`INSERT INTO tab_context_handoffs(tab_id,handoff_id,base_hash,prefix,prepared_prompt,payload_hash,update_ids,created_at,continuation_facts)
    VALUES(?,?,?,'',?,?,?,1,?)`).run('old', 'orchestration:R', 'base', 'work', promptAuditFingerprint('work'), '[]', JSON.stringify([JSON.stringify(['orchestration-completion-v1','done',1,'codex','S'])]));
  context.rebindPreparedHandoff('old', target, 'orchestration:R', 'work');
  assert.equal(context.hasHandoff('old', 'orchestration:R'), false);
  assert.equal(context.hasHandoff(target, 'orchestration:R'), true);
  context.assertContinuationScope(target, 'orchestration:R');
  context.resolveAttributionSource = () => ({ toolType: 'codex', sessionId: 'foreign' });
  assert.throws(() => context.assertContinuationScope(target, 'orchestration:R'), /Контекст/);
  assert.throws(() => context.rebindPreparedHandoff('old', target, 'orchestration:R', 'changed'), error=>error.code==='context_restore_handoff_changed');
});

test('actual orchestration replay preflight keeps the requested old target but resolves the committed runtime', async t => {
  const f=await fixture(t);
  const targetRestoreAddress={namespace:'P',historyId:f.historyId,sourceTabId:'old',
    archiveIdentity:f.api.archive.identity(f.database.getTabHistoryEntry(f.historyId,'P'))};
  const input={runId:'replay',sourceTabId:'source',targetTabId:'old',targetProjectId:'P',targetToolType:'codex',
    targetCwd:f.root,targetRestoreAddress,targetRestoreSessionId:'S',requestFingerprint:'original',deliveryIntent:{prompt:'work'}};
  await f.store.reserveOrGet(input);
  const restored=await f.main.ensureExplicitAgentTabOpen('old',f.resolution,{acceptRestoredTarget:true});
  await f.main.adoptRestoredOrchestrationTarget('replay',restored);
  const preflight=find(web,node=>ts.isIfStatement(node) && node.expression.getText(web)==='targetTabId && !target'
    && node.thenStatement.getText(web).includes('previous?.requestedTargetTabId'));
  assert.ok(preflight);
  const scope=vm.createContext({getOrchestrationRunStore:()=>f.store,findOrchestrationTabDescriptor:f.descriptor,
    requestedRunId:'replay',sourceTabId:'source',targetTabId:'old',requestedTargetTabId:'old',target:null});
  vm.runInContext(`globalThis.replay=async()=>{${preflight.getText(web)};return {targetTabId,requestedTargetTabId,target};}`,scope);
  const result=await scope.replay();
  assert.equal(result.targetTabId,restored.descriptor.tabId);
  assert.equal(result.requestedTargetTabId,'old');
  assert.equal((await f.store.reserveOrGet(input)).created,false);
  scope.sourceTabId='foreign';scope.targetTabId='old';scope.target=null;
  assert.equal((await scope.replay()).target,null);
  assert.equal(f.createCalls,1);
});

test('restored FIFO keeps the earlier same-target run and rejects a late old-runtime exit', async t => {
  const f=await fixture(t);
  for(const runId of ['first','second'])await f.store.create({runId,sourceTabId:'source',targetTabId:'old',targetProjectId:'P',
    targetToolType:'codex',targetCwd:f.root,deliveryIntent:{prompt:runId}});
  const restored=await f.main.ensureExplicitAgentTabOpen('old',f.resolution,{acceptRestoredTarget:true});
  await f.store.adoptRestoredTarget('second',restored);
  await f.store.adoptRestoredTarget('first',restored);
  assert.equal((await f.store.get('first')).predecessorRunId,null);
  assert.equal((await f.store.get('second')).predecessorRunId,'first');
  const before=await f.store.get('first');
  await f.store.handleTargetClosed('old');
  assert.deepEqual(await f.store.get('first'),before);
});

test('prepared update members move atomically, while a physical attempt forbids rebind', async t => {
  const f=await fixture(t);
  const context=new TabWorkContext({db:f.db,listTabs:()=>[],onChanged(){}});
  for(const [id,owner]of [['owned','old'],['foreign','other']])f.db.prepare(
    "INSERT INTO tab_context_updates(id,tab_id,title,text,kind,status,created_at) VALUES(?,?,'title','body','file','sending',1)").run(id,owner);
  const put=(id,members)=>f.db.prepare(`INSERT INTO tab_context_handoffs(tab_id,handoff_id,base_hash,prefix,prepared_prompt,payload_hash,update_ids,created_at)
    VALUES('old',?,'base','','work',?,?,1)`).run(id,promptAuditFingerprint('work'),JSON.stringify(members));
  put('good',['owned']);
  context.rebindPreparedHandoff('old','new','good','work');
  assert.equal(f.db.prepare('SELECT tab_id FROM tab_context_updates WHERE id=?').get('owned').tab_id,'new');
  put('mixed',['foreign']);
  assert.throws(()=>context.rebindPreparedHandoff('old','new','mixed','work'),error=>error.code==='context_restore_update_changed');
  assert.equal(context.hasHandoff('old','mixed'),true);
  put('entered',[]);
  context.readReceipts=()=>[{handoffId:'entered',attemptId:'physical'}];
  assert.throws(()=>context.rebindPreparedHandoff('old','new','entered','work'),error=>error.code==='context_restore_handoff_changed');
  assert.equal(context.hasHandoff('old','entered'),true);
});

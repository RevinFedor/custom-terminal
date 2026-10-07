'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');
const { TabWorkContext } = require('./tab-work-context');
const runtime = require('./codex-runtime-contract');
const { createProjectCardSignals } = require('./project-card-signals');
let fixtureRoot;
const electronPath = require.resolve('electron'), previousElectron = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => fixtureRoot } } };
const DatabaseManager = require('./database');
if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath];
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const mainTree = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const webTree = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
function declaration(tree, name) {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(tree);
}

async function harness(t) {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'card-signals-test-'));
  const root = fixtureRoot, manager = new DatabaseManager();
  const project = manager.createEmptyProject('Card signals private');
  const tab = { tabId: 'T', commandType: 'codex', tabType: 'terminal', name: 'Tab', cwd: root };
  manager.saveTabs(project.id, [tab, { tabId: 'F', name: 'File', tabType: 'file', cwd: root }], true);
  const timers = [], frames = [], physical = {}, state = { lifecycle: 'instance-A', run: 1 };
  const ctx = vm.createContext({ ...runtime, require, path, Date, JSON, console: { log() {}, warn() {}, error() {} },
    srcMainDir: __dirname, appRuntimeIdentity: { instanceId: 'private-epoch-A' },
    projectManager: { db: manager }, projectCardSignals: null,
    terminals: new Map([['T', physical]]), terminalCommandState: new Map([['T', { runSeq: 1, isRunning: true }]]),
    codexKnownSessions: new Map([['T', 'SID-A']]), codexWriterProofs: new Map([['T', { valid: true, sessionId: 'SID-A' }]]),
    codexPendingSettingsProofHandoffs: new Map(), codexTuiReadyTabs: new Set(['T']), codexTuiReadyMeta: new Map(),
    getTerminalLifecycleGeneration: () => state.lifecycle, resolveAiToolTypeForTab: () => 'codex',
    BrowserWindow: { getAllWindows: () => [] },
    projectLayoutChangedIds: new Set(), projectOrderChanged: false, projectActivityBroadcastTimer: null,
    setTimeout: fn => { timers.push(fn); return fn; },
  });
  const moduleRequire = ctx.require;
  ctx.require = name => name === path.join(__dirname, 'web-server')
    ? { broadcastProjectActivity: reason => frames.push({ reason, cardSignals: ctx.projectCardSignals.wake() }) }
    : moduleRequire(name);
  for (const name of ['getTaskStatusCatalog','getCodexWriterProofSnapshot','getCodexProvisionalSettingsSnapshot',
    'getCurrentCodexServiceTierProofIdentity','readMainCardFast','getProjectCardSignals',
    'noteProjectCardSignalsChanged','noteCardSignalSettingsChanged','scheduleProjectActivityBroadcast',
    'scheduleProjectLayoutBroadcast','broadcastTabTaskPlan']) vm.runInContext(declaration(mainTree, name), ctx);
  const context = new TabWorkContext({ db: manager.db,
    listTabs: () => manager.getProjectById(project.id).tabs.map(row => ({ ...row, projectId: project.id })),
    archivedTab: () => null, onChanged: value => ctx.noteProjectCardSignalsChanged(value.projectId, value.tabId),
  });
  ctx.tabWorkContext = context;
  const cards = ctx.getProjectCardSignals();
  const read = () => cards.snapshot(project.id, ['T', 'F']);
  const prove = (tier = 'priority') => {
    const proof = runtime.createCodexServiceTierProof({ ...ctx.getCurrentCodexServiceTierProofIdentity('T'),
      serviceTier: tier, proofAt: 12345, source: 'private-exact-tui' });
    assert.ok(proof); ctx.codexTuiReadyMeta.set('T', { serviceTierProof: proof });
    return proof;
  };
  const sideEffects = [];
  let bridgeHook = null;
  const webCtx = vm.createContext({
    projectManager: { db: manager }, projectCardSignals: cards,
    publicTabActivity: null, observeTabActivityStyle: () => {}, tabActivityProjection: () => ({}),
    workspaceSwitcherWake: () => ({ version: 1, epoch: 'private-switcher', revision: 0, available: false }),
    runAfterWake: () => ({ version: 1, epoch: null, sequence: 0, revalidate: true }),
    console: ctx.console, Map, Date, JSON,
    decId: decodeURIComponent, sdkSessions: new Map(),
    bridgeRequest: async action => {
      sideEffects.push(action); if (bridgeHook) await bridgeHook(action);
      if (action === 'getProjectCompletionNotifications') return { tabs: {} };
      if (action === 'getStatusMarkerConfig') return { shape: 'dot', sizePx: 8, statuses: [] };
      throw new Error('unexpected bridge action ' + action);
    },
    partitionProjectRuntimeTabs: tabs => ({ mainCodexTabs: tabs.filter(row => row.commandType === 'codex'), rendererTabIds: [] }),
    resolveCurrentPtyAgentOwner: row => ['claude', 'codex'].includes(row.commandType) && row.tabType !== 'file' ? row.commandType : null,
    resolveCodexRuntimeProjectionBatch: rows => Object.fromEntries(rows.map(row => [row.tabId, { sessionStatus: 'active', sessionId: 'SID-A', writerConfirmed: true }])),
    normalizePublicRuntimeStatus: value => value,
    stampPublicRuntimeSnapshot: (_id, value) => value,
    claudeMaterializationFor: () => { throw new Error('History read forbidden'); },
    sendJson: (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
    computeProjectActivity: () => ({ projects: [], cardSignals: cards.wake() }),
  });
  for (const name of ['projectCardsSnapshot', 'projectActivitySnapshot']) vm.runInContext(declaration(webTree, name), webCtx);
  const at = web.indexOf('  // Tabs of a project.'), end = web.indexOf('  // Create tab group', at);
  assert.ok(at > 0 && end > at);
  vm.runInContext('async function route(req,res,parsed) { let m;\n' + web.slice(at, end) + '\n}', webCtx);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    webCtx.route(req, res, { pathname: url.pathname, query: {} }).catch(error => res.writeHead(500).end(JSON.stringify({ error: error.stack })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    manager.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const get = async () => {
    const started = performance.now();
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/projects/' + encodeURIComponent(project.id) + '/tabs');
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text), bytes: Buffer.byteLength(text), ms: performance.now() - started };
  };
  return { manager, project, tab, ctx, webCtx, context, cards, read, prove, state, sideEffects, timers, frames, get,
    setBridgeHook: fn => { bridgeHook = fn; },
    flush: () => { for (const fn of timers.splice(0)) fn(); },
  };
}

test('actual public tabs handler exposes compact canonical plan/catalog/pending and exact Fast', async t => {
  const h = await harness(t); h.prove();
  h.manager.setAppState('noted-terminal-task-statuses', [{ id: 'ready', color: '#123456', label: 'Ready', description: 'SECRET DESCRIPTION' }]);
  h.manager.setAppState('noted-terminal-task-status-marker', { shape: 'square', sizePx: 11 });
  const result = h.manager.applyTabTaskPlanOperations('T', [
    { type: 'add_task', id: 'one', title: 'SECRET PLAN BODY', statusId: 'ready' },
    { type: 'add_task', id: 'two', title: 'SECRET SECOND' },
    { type: 'add_subtask', taskId: 'one', id: 'child', title: 'SECRET SUBTASK' },
  ], 'test');
  h.context.publish('T', { sourceTabId: 'peer', text: 'SECRET CONTEXT', title: 'Private', requestId: 'one' });
  const beforeChanges = h.manager.db.prepare('SELECT total_changes() AS n').get().n;
  const response = await h.get(); assert.equal(response.status, 200, JSON.stringify(response));
  const block = response.data.cardSignals, row = block.tabs.find(value => value.tabId === 'T');
  assert.equal(block.projectId, h.project.id); assert.equal(block.epoch, 'private-epoch-A');
  assert.equal(row.fast.known, true); assert.equal(row.fast.enabled, true);
  assert.equal(row.fast.owner.ownerId, 'SID-A'); assert.equal(row.fast.proof.source, 'private-exact-tui');
  assert.equal(row.plan.revision, result.document.revision);
  assert.deepEqual(row.plan.items, [{ id: 'one', statusId: 'ready', order: 0 }, { id: 'two', statusId: null, order: 1 }]);
  assert.equal(row.pendingContext.count, 1);
  assert.deepEqual(block.taskStatuses, [{ id: 'ready', color: '#123456', label: 'Ready' }]);
  assert.deepEqual(block.taskStatusMarker, { shape: 'square', sizePx: 11 });
  assert.ok(!JSON.stringify(response.data).includes('SECRET'));
  assert.deepEqual(h.sideEffects, ['getProjectCompletionNotifications', 'getStatusMarkerConfig']);
  assert.equal(h.manager.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
  assert.ok(Buffer.byteLength(JSON.stringify(block)) < 2000);
  console.log('[CardSignalsTest] rows=' + response.data.tabs.length + ' cardBytes=' + Buffer.byteLength(JSON.stringify(block)) + ' httpMs=' + response.ms.toFixed(2));
});

test('Fast follows exact session, launch, PTY generation and run; unknown is never false', async t => {
  const h = await harness(t);
  assert.equal(h.read().tabs[0].fast.enabled, null);
  h.prove('default'); assert.equal(h.read().tabs[0].fast.enabled, false);
  h.prove(); assert.equal(h.read().tabs[0].fast.enabled, true);
  h.ctx.codexKnownSessions.set('T', 'SID-B'); h.ctx.codexWriterProofs.set('T', { valid: true, sessionId: 'SID-B' });
  assert.equal(h.read().tabs[0].fast.known, false);
  h.prove(); assert.equal(h.read().tabs[0].fast.owner.ownerId, 'SID-B');
  h.state.lifecycle = 'instance-B'; assert.equal(h.read().tabs[0].fast.enabled, null);
  h.prove(); h.ctx.terminalCommandState.set('T', { runSeq: 2, isRunning: true });
  assert.equal(h.read().tabs[0].fast.enabled, null);
  h.prove(); h.ctx.terminalCommandState.set('T', { runSeq: 2, isRunning: false });
  assert.equal(h.read().tabs[0].fast.enabled, null);
  assert.equal(h.read().tabs.find(row => row.tabId === 'F').fast.known, false);
});

test('pending summary counts logical chips without returning bodies, including malformed legacy file rows', async t => {
  const h = await harness(t), db = h.manager.db;
  const insert = db.prepare(`INSERT INTO tab_context_updates
    (id,tab_id,title,text,kind,path,before_text,after_text,file_changes_json,status,created_at)
    VALUES (?, 'T', 'PRIVATE TITLE', 'PRIVATE BODY', ?, ?, ?, ?, ?, ?, 1)`);
  const valid = JSON.stringify([{ path: '/private/file', beforeText: 'SECRET OLD', afterText: 'SECRET NEW' }]);
  insert.run('file1', 'file-batch', null, null, null, valid, 'pending');
  insert.run('file2', 'file-batch', null, null, null, valid, 'pending');
  insert.run('legacy', 'file', '/old', 'old', 'new', '{bad', 'pending');
  insert.run('invalid', 'file', null, null, null, '[]', 'pending');
  insert.run('unicode', 'file-batch', null, null, null, JSON.stringify([{ path: '\u00a0', beforeText: '', afterText: '' }]), 'pending');
  insert.run('manual', 'manual', null, null, null, null, 'pending');
  insert.run('error', 'file-error', '/old', null, null, null, 'pending');
  insert.run('sending', 'manual', null, null, null, null, 'sending');
  insert.run('deleted', 'manual', null, null, null, null, 'deleted');
  insert.run('scalar-members', 'file-batch', null, null, null, '["not-json",123,null]', 'pending');
  const canonical = h.context.get('T').pendingCount;
  const summary = h.context.summaries(['T']);
  assert.equal(summary.T.count, canonical); assert.equal(canonical, 6);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
  assert.equal(h.read().tabs[0].pendingContext.count, canonical);
});

test('late bridge work cannot stamp an old plan/owner as the latest card snapshot', async t => {
  const h = await harness(t); h.prove();
  const first = (await h.get()).data.cardSignals;
  h.setBridgeHook(async action => {
    if (action !== 'getStatusMarkerConfig') return;
    h.manager.applyTabTaskPlanOperations('T', [{ type: 'add_task', id: 'new', title: 'new body' }], 'test');
    h.ctx.broadcastTabTaskPlan('T', h.manager.getTabTaskPlan('T'), 'test');
    h.ctx.codexKnownSessions.set('T', 'SID-B'); h.ctx.codexWriterProofs.set('T', { valid: true, sessionId: 'SID-B' });
    h.ctx.noteProjectCardSignalsChanged(h.project.id);
  });
  const next = (await h.get()).data.cardSignals;
  assert.ok(next.revision > first.revision);
  assert.equal(next.tabs[0].plan.items[0].id, 'new'); assert.equal(next.tabs[0].fast.enabled, null);
  assert.equal(next.tabs[0].fast.owner.ownerId, 'SID-B');
});

test('an actual older HTTP response arriving after a newer event/read keeps the older revision', async t => {
  const h = await harness(t); h.prove();
  let held, release;
  const captured = new Promise(resolve => { held = resolve; });
  const send = h.webCtx.sendJson;
  h.webCtx.sendJson = (res, status, data) => {
    h.webCtx.sendJson = send;
    release = () => send(res, status, data); held();
  };
  const oldRequest = h.get(); await captured;
  h.prove('default'); h.ctx.noteProjectCardSignalsChanged(h.project.id);
  const event = h.webCtx.projectActivitySnapshot('new-proof');
  const newest = await h.get(); release(); const old = await oldRequest;
  assert.equal(old.data.cardSignals.tabs[0].fast.enabled, true);
  assert.equal(newest.data.cardSignals.tabs[0].fast.enabled, false);
  assert.ok(old.data.cardSignals.revision < event.cardSignals.revision);
  assert.ok(newest.data.cardSignals.revision >= event.cardSignals.revision);
});

test('existing project activity scheduler coalesces plan/context/settings wakes without values', async t => {
  const h = await harness(t); const before = h.read(); h.flush(); h.frames.length = 0;
  h.ctx.broadcastTabTaskPlan('T', {}, 'test');
  h.context.publish('T', { sourceTabId: 'peer', text: 'SECRET', title: 'context', requestId: 'p' });
  h.ctx.noteCardSignalSettingsChanged('noted-terminal-task-status-marker');
  h.ctx.scheduleProjectLayoutBroadcast(h.project.id, 'layout');
  assert.equal(h.timers.length, 1); h.flush(); assert.equal(h.frames.length, 1);
  const wake = h.frames[0].cardSignals;
  assert.equal(wake.allProjects, true); assert.deepEqual([...wake.projectIds], [h.project.id]);
  assert.ok(wake.revision > before.revision); assert.equal(wake.tabs, undefined);
  assert.equal(h.cards.wake().projectIds.length, 0);
  const wire = h.webCtx.projectActivitySnapshot('private');
  assert.equal(wire.cardSignals.revision, wake.revision);
  assert.equal(wire.projects.length, 0, 'metadata wake does not create a fake busy project');
});

test('stable reads, captured old responses, another project and restart have explicit ordering', async t => {
  const h = await harness(t); h.prove();
  const a = h.read(), unchanged = h.read(); assert.equal(a.revision, unchanged.revision);
  h.context.publish('T', { sourceTabId: 'peer', text: 'new', title: 'new', requestId: 'new' });
  const wake = h.cards.wake(), b = h.read(); assert.ok(a.revision < wake.revision); assert.ok(b.revision >= wake.revision);
  assert.equal(a.tabs[0].pendingContext.count, 0, 'a captured older response is immutable');
  const foreign = h.cards.snapshot('foreign-project', ['T']);
  assert.equal(foreign.tabs[0].fast.known, false); assert.equal(foreign.tabs[0].plan.known, false);
  h.ctx.projectCardSignals = null; h.ctx.appRuntimeIdentity = { instanceId: 'private-epoch-B' };
  h.ctx.codexWriterProofs.clear(); h.ctx.codexKnownSessions.clear(); h.ctx.terminals.clear();
  const restarted = h.ctx.getProjectCardSignals().snapshot(h.project.id, ['T']);
  assert.notEqual(restarted.epoch, a.epoch); assert.equal(restarted.tabs[0].pendingContext.count, 1);
  assert.equal(restarted.tabs[0].fast.known, false);
});

test('provisional launch proof is current only for its exact launch, not a saved Fast choice', async t => {
  const h = await harness(t); h.ctx.codexWriterProofs.clear(); h.ctx.codexKnownSessions.clear();
  const pending = { generationMode: 'launch', launchId: 'L1', model: 'test-model', effort: 'high',
    terminalToken: h.ctx.terminals.get('T'), runSeq: 1, proofAt: 12, applicationProofSource: 'exact-picker-success' };
  h.ctx.codexPendingSettingsProofHandoffs.set('T', pending);
  h.prove(); const a = h.read(); assert.equal(a.tabs[0].fast.owner.ownerId, 'launch:L1');
  assert.equal(a.tabs[0].fast.known, true);
  h.ctx.codexPendingSettingsProofHandoffs.set('T', { ...pending, launchId: 'L2', fast: true });
  const b = h.read(); assert.equal(b.tabs[0].fast.enabled, null);
  assert.equal(b.tabs[0].fast.owner.launchId, 'L2'); assert.ok(b.revision > a.revision);
  h.prove('default'); assert.equal(h.read().tabs[0].fast.enabled, false);
  h.ctx.terminals.set('T', {}); assert.equal(h.read().tabs[0].fast.enabled, null);
});

test('current runtime owner wins over saved tab command metadata, and another provider cannot inherit Fast', async t => {
  const h = await harness(t); h.prove();
  h.manager.db.prepare('UPDATE tabs SET command_type=NULL WHERE tab_id=?').run('T');
  assert.equal(h.read().tabs[0].fast.enabled, true, 'an exact current Codex proof does not require stale saved commandType');
  h.ctx.resolveAiToolTypeForTab = () => 'claude';
  assert.equal(h.read().tabs[0].fast.known, false);
  assert.equal(h.read().tabs[0].fast.enabled, null);
});

test('saved inactive plans read with no launch/params/history or new linked-file watcher', async t => {
  const h = await harness(t);
  h.ctx.terminalCommandState.clear(); h.ctx.terminals.clear();
  h.manager.applyTabTaskPlanOperations('T', [{ type: 'add_task', id: 'saved', title: 'PRIVATE SAVED' }], 'test');
  const response = await h.get(); assert.equal(response.status, 200);
  assert.equal(response.data.cardSignals.tabs[0].plan.items[0].id, 'saved');
  assert.equal(response.data.cardSignals.tabs[0].fast.known, false);
  assert.equal(h.context.watchers.size, 0); assert.equal(h.context.subscriptions.size, 0);
  assert.ok(h.sideEffects.every(action => ['getProjectCompletionNotifications','getStatusMarkerConfig'].includes(action)));
});

test('card payload is bounded by root markers and excludes a large plan history and child texts', async t => {
  const h = await harness(t);
  const roots = Array.from({ length: 200 }, (_, i) => ({ id: 'task-' + i, title: 'SECRET-'.repeat(70),
    subtasks: [{ id: 'child-' + i, title: 'HIDDEN-'.repeat(70) }], statusId: i % 2 ? 'missing-status-kept' : undefined }));
  h.manager.setTabTaskPlan('T', { version: 1, revision: 77, items: roots, archivedItems: roots,
    history: { past: [{ items: roots }], future: [] } });
  const before = performance.now(), data = h.read(), elapsed = performance.now() - before;
  const raw = JSON.stringify(data), bytes = Buffer.byteLength(raw);
  assert.equal(data.tabs[0].plan.items.length, 200); assert.equal(data.tabs[0].plan.revision, 77);
  assert.ok(!raw.includes('SECRET') && !raw.includes('HIDDEN') && !raw.includes('archivedItems'));
  assert.equal(data.tabs[0].plan.items[1].statusId, 'missing-status-kept');
  assert.ok(bytes < 16000);
  console.log('[CardSignalsTest] roots=200 bytes=' + bytes + ' metadataMs=' + elapsed.toFixed(2));
});

test('the real capability producer is additive and absent without the injected owner', async t => {
  const h = await harness(t); let spread;
  const visit = node => {
    if (ts.isSpreadAssignment(node) && node.getText(webTree).includes('cardSignals: projectCardSignals.capability')) spread = node.expression.getText(webTree);
    ts.forEachChild(node, visit);
  };
  visit(webTree); assert.ok(spread);
  const enabled = vm.runInContext('(' + spread + ')', h.webCtx);
  assert.equal(enabled.cardSignals.version, 1); assert.equal(enabled.cardSignals.endpoint, '/api/projects/:id/tabs');
  h.webCtx.projectCardSignals = null;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('(' + spread + ')', h.webCtx))), {});
  assert.equal((await h.get()).data.cardSignals, undefined);
});

test('read failure is explicit and does not fabricate an empty current plan', async t => {
  const h = await harness(t);
  const original = h.manager.getProjectCardPlanSummaries;
  h.manager.getProjectCardPlanSummaries = () => { throw new Error('private store unavailable'); };
  t.after(() => { h.manager.getProjectCardPlanSummaries = original; });
  const response = await h.get();
  assert.equal(response.status, 200); assert.equal(response.data.cardSignals.unavailable, true);
  assert.equal(response.data.cardSignals.tabs, undefined);
  assert.equal(response.data.tabs.length, 2, 'existing tab/status/bell data remains independent');
});

test('malformed stored plan is unknown, while an empty canonical plan is known', async t => {
  const h = await harness(t);
  assert.equal(h.read().tabs[0].plan.known, true); assert.deepEqual([...h.read().tabs[0].plan.items], []);
  for (const value of ['{bad', JSON.stringify({ version: 1, revision: 4, items: [{ id: null }] }),
    JSON.stringify({ version: 1, revision: 4, items: [{ id: 'same' }, { id: 'same' }] })]) {
    h.manager.db.prepare('UPDATE tabs SET task_plan=? WHERE tab_id=?').run(value, 'T');
    assert.equal(h.read().tabs[0].plan.known, false);
    assert.equal(h.read().tabs[0].plan.revision, null);
  }
});

test('actual Main notification hooks use the existing metadata wake, without another scheduler', async t => {
  const h = await harness(t);
  const catalogKeys = ['noted-terminal-task-statuses','noted-terminal-task-status-marker',
    'noted-terminal-session-statuses','noted-terminal-status-marker'];
  for (const key of catalogKeys) h.ctx.noteCardSignalSettingsChanged(key);
  assert.equal(h.timers.length, 1); assert.equal(h.cards.wake().allProjects, true);
  const value = h.cards.wake().revision;
  h.ctx.noteCardSignalSettingsChanged('unrelated-setting'); assert.equal(h.cards.wake().revision, value);
  for (const name of ['clearCodexServiceTierProof', 'publishCodexServiceTierProof', '_webBroadcast']) {
    assert.ok(declaration(mainTree, name).includes('noteProjectCardSignalsChanged('), name);
  }
  for (const channel of ['app:setState', 'app:setStateSync', 'app:mirrorLocalStorageSync']) {
    const at = main.indexOf("('" + channel + "'");
    assert.ok(at > 0); assert.ok(main.slice(at, main.indexOf('\n});', at)).includes('noteCardSignalSettingsChanged(key)'));
  }
  const original = h.ctx.projectManager;
  h.ctx.projectManager = { db: { db: { prepare() { throw new Error('private shutdown'); } } } };
  assert.doesNotThrow(() => h.ctx.broadcastTabTaskPlan('T', {}, 'test'), 'metadata failure cannot fail the existing plan publisher');
  h.ctx.projectManager = original;
});

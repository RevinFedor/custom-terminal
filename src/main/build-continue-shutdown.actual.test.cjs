'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { handleBuildContinueApi } = require('./build-continue-api');
const shutdown = require('./build-install-continue');
const copy = value => JSON.parse(JSON.stringify(value));
const owner = { tabId: 'source', projectId: 'P', toolType: 'codex', sessionId: 'source-S',
  expectedTarget: { toolType: 'codex', sessionId: 'source-S' } };
function fixture(t) {
  let saved = null, failEvidence = false;
  const views = ['source', 'worker', '754', '257'].map(tabId => {
    const executionContext = { provider: 'codex', sessionId: tabId + '-S', turnId: tabId + '-T', generation: 1 };
    return { tabId, projectId: 'P', toolType: 'codex', sessionId: tabId + '-S', revision: 'cut-' + tabId, known: true,
      busy: ['source', 'worker'].includes(tabId), executionContext,
      subject: { kind: 'codex-execution', toolType: 'codex', sessionId: tabId + '-S', targetExecutionContext: executionContext } };
  });
  const op = createBuildContinueOperations({ pid: process.pid, instanceId: 'fixture-Main', now: () => 1000,
    read: () => saved, write: value => { if (failEvidence && value.operations.some(op => op.shutdownEvidence)) return false; saved = copy(value); },
    captureTabs: () => views, captureOne: id => views.find(view => view.tabId === id), readRuns: () => [], verifyInstallJob: async () => ({}),
    // Historical receipts/report deliberately disagree with the actual own-turn census.
    readInputBlockers: () => [{ tabId: '754', operationKey: 'old-754', status: 'delivery-unknown', sessionId: 'different-SID' }],
    readMcp: () => ({ exactRpcOwners: false, historicalReport: { tabs: ['754', '257'].map(tabId => ({ tabId, wasActive: true, interruption: 'unknown' })) } }),
  });
  t.after(() => op.dispose());
  const binding = { version: 1, requestId: 'request-one', requestHash: 'a'.repeat(64), requestHashVersion: 2,
    jobId: 'job-one', operationId: 'voice-force-job-one', maintenanceOperationId: 'install:noted:job-one',
    callbackHandoffId: 'build-install-return:job-one', source: owner };
  return { op, views, binding, fail: () => failEvidence = true, saved: () => saved };
}
test('actual Main shutdown producer persists the presealed binding; startup resolver carries it without rewriting its process census', async t => {
  const h = fixture(t), db = new NodeSqlite(':memory:'); db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT)'); t.after(() => db.close());
  const registration = await h.op.registerInstall(h.binding);
  await h.op.capture(h.binding.operationId, process.pid, registration.installBinding); h.op.prepareShutdown();
  const release = shutdown.registerInstallShutdownBindings(() => h.op.shutdownBindings()); t.after(release);
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const begin = main.indexOf('function persistShutdownInterruptedAgentSnapshot(');
  const end = main.indexOf('\nfunction captureStartupInterruptedAgentSnapshot(', begin);
  assert(begin > 0 && end > begin);
  const events = [], context = vm.createContext({ createShutdownInterruptedSnapshot: shutdown.createShutdownInterruptedSnapshot,
    Date: { now: () => 1001 }, process, SHUTDOWN_INTERRUPTED_SESSIONS_KEY: shutdown.SHUTDOWN_INTERRUPTED_SESSIONS_KEY,
    projectManager: { db: { setAppState(key, value) { events.push('persist'); db.prepare('INSERT INTO app_state VALUES(?,?)').run(key, JSON.stringify(value)); } } },
    console: { log() {} } });
  vm.runInContext(main.slice(begin, end) + '\nglobalThis.produce = persistShutdownInterruptedAgentSnapshot;', context);
  const snapshot = context.produce(new Map([['source', { engine: 'codex', sessionId: 'source-S' }], ['worker', { engine: 'codex', sessionId: 'worker-S' }]]), 'before-quit');
  events.push('controlled-PTY-stop'); assert.deepEqual(events, ['persist', 'controlled-PTY-stop']);
  const saved = JSON.parse(db.prepare('SELECT value FROM app_state').get().value);
  assert.deepEqual(saved.installBindings, h.op.shutdownBindings()); assert.equal(saved.shutdownPid, process.pid);
  const startup = shutdown.resolveStartupInterruptedSnapshot({ persistedSnapshot: saved, projects: [{ id: 'P', tabs: [
    { tabId: 'source', commandType: 'codex', codexSessionId: 'source-S', wasInterrupted: true },
    { tabId: 'worker', commandType: 'codex', codexSessionId: 'worker-S', wasInterrupted: true } ] }] });
  assert.deepEqual(startup.installBindings, saved.installBindings);
  assert.deepEqual(startup.targets.map(target => target.tabId), ['source', 'worker']);
  assert.deepEqual(snapshot.targets.map(target => target.tabId), ['source', 'worker']);
});
test('historical UNKNOWN with another SID and wasActive from report cannot select 754/257 for automatic Continue', async t => {
  const h = fixture(t), registered = await h.op.registerInstall(h.binding);
  const cut = await h.op.capture(h.binding.operationId, process.pid, registered.installBinding);
  assert.deepEqual(cut.targets.map(target => target.source.tabId), ['source', 'worker']);
  assert.deepEqual(cut.references.input.map(input => input.operationKey), ['old-754']);
  assert.equal(cut.participants.find(item => item.source.tabId === '754').busy, false);
  assert.equal(cut.references.mcp.historicalReport.tabs[0].wasActive, true, 'original report is retained as evidence, never an input list');
});
test('mandatory evidence write failure refuses capture/Quit API; no fallback shutdown or replacement is invoked', async t => {
  const h = fixture(t), registered = await h.op.registerInstall(h.binding); h.fail();
  let answer, quit = 0;
  await handleBuildContinueApi({ req: { method: 'POST' }, res: {}, parsed: { pathname: '/api/build-continue/operations' },
    service: h.op, readBody: async () => ({ version: 2, action: 'capture-voice-install', operationId: h.binding.operationId,
      expectedMainPid: process.pid, binding: registered.installBinding }),
    sendJson(_res, status, body) { answer = { status, body }; }, quit() { quit++; } });
  assert.equal(answer.status, 503); assert.match(answer.body.error, /write_unconfirmed/); assert.equal(quit, 0);
});
test('cancelling an unstarted registered operation reopens on the same schema without a capture fence', async t => {
  const h = fixture(t), registered = await h.op.registerInstall(h.binding);
  const cancelled = await h.op.cancelInstall(h.binding.operationId, registered.installBinding);
  assert.equal(cancelled.phase, 'settled'); assert.equal(h.op.capturing(), false);
  const reopened = createBuildContinueOperations({ read: h.saved, write() {}, readRuns: () => [], captureTabs: () => [] });
  t.after(() => reopened.dispose()); assert.equal(reopened.get(h.binding.operationId).phase, 'settled');
});

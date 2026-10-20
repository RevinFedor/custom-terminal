'use strict';
// Actual RunStore + private JSON + actual operational delivery. Browser,
// provider, receipts and physical source input are explicitly controlled.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), ts = require('typescript');
const { OrchestrationRunStore, classifyAgentSendReceipt } = require('./orchestration-runs');
const { createOperationalDelivery } = require('./external-research-operational-delivery');
const policy = require('./external-research-maintenance');
async function fixture(t) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'startup-maintenance-')), file = path.join(root, 'orchestration-runs.json');
  const stores = [], revoked = [];
  const reopen = options => {
    const store = new OrchestrationRunStore(file, { onOperationalRevoked: (_r, n) => { revoked.push(n.id); return { ok: true }; }, ...options });
    stores.push(store); return store;
  };
  const seed = reopen();
  await seed.reserveOrGet({ runId: 'R', runKind: 'external-research', requestFingerprint: 'same-body',
    sourceTabId: 'original-source', sourceSessionId: 'original-sid',
    sourceSendTarget: { toolType: 'codex', sessionId: 'original-sid' }, notifySource: true,
    externalResearchJobId: 'noted_R', externalResearchIntent: { provider: 'chatgpt', prompt: 'original', options: {}, files: [] } });
  await seed.recordExternalOperationalFailure('R', { reason: 'transport_unavailable', code: 'ECONNREFUSED' });
  await seed.flush();
  const before = await seed.getInternal('R');
  t.after(async () => { for (const store of stores) await store.flush(); fs.rmSync(root, { recursive: true }); });
  return { file, before, revoked, reopen, stores };
}
const startupMaintenance = { version: 1, operationId: 'install:startup:one' };
test('startup argv is scoped to one valid exact operation, never an arbitrary app setting', () => {
  assert.deepEqual(policy.startupFromArgv(['app', '--research-maintenance-operation=install:startup:one']), startupMaintenance);
  assert.deepEqual(policy.startupArguments('install:startup:one'), ['--args', '--research-maintenance-operation=install:startup:one']);
  assert.equal(policy.startupFromArgv(['app', '--unrelated']), null);
  for (const args of [['--research-maintenance-operation='], ['--research-maintenance-operation'],
    ['--research-maintenance-operation=a', '--research-maintenance-operation=a'], ['--research-maintenance-operation=../bad']]) {
    assert.equal(policy.startupFromArgv(args).error, 'research_maintenance_startup_invalid');
  }
});
test('startup commits same quiet operation before any restored pending notice can prepare input', async t => {
  const f = await fixture(t), store = f.reopen({ startupMaintenance });
  let inputs = 0;
  const delivery = createOperationalDelivery({ store, classify: classifyAgentSendReceipt, logger: { warn() {} },
    prepare: () => { inputs++; throw Error('must not reach source'); }, pin() {}, lookup: async () => ({ absentBeforeAdmission: false }), send() { inputs++; } });
  try { delivery.schedule('R'); await delivery.drain(); } finally { delivery.stop(); }
  assert.equal(inputs, 0);
  const state = await store.getResearchMaintenance(), run = await store.getInternal('R');
  assert.equal(state.activeOperationId, startupMaintenance.operationId);
  assert.equal(state.startup.operationId, startupMaintenance.operationId); assert.equal(state.startup.durable, true);
  assert.equal(state.startup.beforeRestore, true);
  assert.ok(f.revoked.length > 0);
  assert.ok(Object.values(run.externalResearchOperational.notices).every(n => n.delivery === 'suppressed'));
  for (const key of ['requestFingerprint', 'externalResearchJobId', 'externalResearchIntent', 'sourceSessionId', 'externalResearchDeliveryBirth']) {
    assert.deepEqual(run[key], f.before[key], key);
  }
  const normalRestart = f.reopen();
  assert.equal((await normalRestart.getResearchMaintenance()).activeOperationId, startupMaintenance.operationId);
});
test('startup receipt owner must be ready and metadata remains unknown until the strict commit', async t => {
  const f = await fixture(t); let release, enter;
  const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const store = f.reopen({ startupMaintenance, beforeStartupMaintenance: async () => { enter(); await held; } });
  let resolved = false;
  const loading = store.listAll().then(value => { resolved = true; return value; });
  try {
    await Promise.race([entered, loading.then(() => assert.fail('startup bypassed receipt readiness'))]);
    assert.equal(resolved, false); assert.equal(store.readInheritedActivity().known, false);
    assert.equal(store.readTabInspection('original-source').known, false);
  } finally { release(); await loading; }
  assert.equal((await store.getResearchMaintenance()).startup.durable, true);
});
test('strict startup EIO is not quiet ACK; retry commits same RAM owner and restart retains it', async t => {
  const f = await fixture(t), store = f.reopen({ startupMaintenance }), rename = fs.promises.rename;
  fs.promises.rename = async (...args) => { if (args[1] === f.file) throw Object.assign(Error('owned startup EIO'), { code: 'EIO' }); return rename(...args); };
  try { await assert.rejects(store.initialize({ requireAuthority: true }), { code: 'EIO' }); }
  finally { fs.promises.rename = rename; }
  assert.equal(store.readInheritedActivity().known, false);
  await store.initialize({ requireAuthority: true });
  const state = await store.getResearchMaintenance();
  assert.equal(state.operations.length, 1); assert.equal(state.startup.durable, true);
  assert.equal((await f.reopen().getResearchMaintenance()).activeOperationId, startupMaintenance.operationId);
});
test('unconfirmed exact input cancellation cannot become a startup quiet receipt', async t => {
  const f = await fixture(t); let cancellationReady = false;
  const store = f.reopen({ startupMaintenance, onOperationalRevoked: () => ({ ok: cancellationReady }) });
  await assert.rejects(store.getResearchMaintenance(), { code: 'external_research_operational_cancel_unconfirmed' });
  assert.equal(store.readInheritedActivity().known, false);
  assert.equal(store.startupMaintenanceReceipt, null);
  cancellationReady = true;
  const state = await store.getResearchMaintenance();
  assert.equal(state.startup.durable, true); assert.equal(state.operations.length, 1);
});
test('concurrent startup callers share one handover, spent descriptor never reopens completed operation', async t => {
  const f = await fixture(t); let readiness = 0;
  const store = f.reopen({ startupMaintenance, beforeStartupMaintenance: async () => { readiness++; } });
  await Promise.all([store.listAll(), store.getSettings(), store.getResearchMaintenance()]);
  assert.equal(readiness, 1);
  await store.transitionResearchMaintenance({ action: 'complete', operationId: startupMaintenance.operationId });
  const replay = f.reopen({ startupMaintenance });
  const state = await replay.getResearchMaintenance();
  assert.equal(state.activeOperationId, null); assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].state, 'completed'); assert.equal(state.startup.operationState, 'completed');
});
test('different active owner and malformed descriptor never receive startup quiet ACK', async t => {
  const f = await fixture(t), first = f.reopen();
  await first.transitionResearchMaintenance({ action: 'begin', operationId: 'install:other' });
  const wrong = f.reopen({ startupMaintenance });
  await assert.rejects(wrong.getResearchMaintenance(), { code: 'research_maintenance_busy' });
  const invalid = f.reopen({ startupMaintenance: { version: 1, error: 'research_maintenance_startup_invalid' } });
  await assert.rejects(invalid.getResearchMaintenance(), { code: 'research_maintenance_startup_invalid' });
  assert.equal((await f.reopen().getResearchMaintenance()).activeOperationId, 'install:other');
});

function actualStartup(f, receiptReady) {
  // Execute unchanged production factory/queue/recovery functions, not a
  // model of their ordering. Electron, receipt startup and queue are ports.
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const tree = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
  const names = ['getOrchestrationRunStore', 'restoreAgentSendQueueAfterReceipts',
    'stopOrchestrationStartupRecovery', 'startOrchestrationStartupRecovery'];
  const functions = names.map(name => tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name));
  assert.ok(functions.every(Boolean));
  const start = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'start').getText(tree);
  assert.match(start, /restoreAgentSendQueueAfterReceipts\(startupQueue\)/);
  const events = [];
  const queue = { resume: () => {
    const disk = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(disk.researchMaintenance.operations.find(x => x.operationId === startupMaintenance.operationId)?.state, 'active');
    assert.ok(disk.runs.every(r => Object.values(r.externalResearchOperational.notices).every(n => n.delivery === 'suppressed')));
    events.push('fifo-resume');
  } };
  const ctx = vm.createContext({ require, process: { argv: ['app', '--research-maintenance-operation=' + startupMaintenance.operationId] },
    path, app: { getPath: () => path.dirname(f.file) },
    OrchestrationRunStore: class extends OrchestrationRunStore {
      constructor(...args) { super(...args); f.stores.push(this); }
    },
    orchestrationRunStore: null, orchestrationStartupRecovery: null,
    agentSendReceiptStartupReady: receiptReady, agentSendReceiptStore: {}, agentSendQueue: queue,
    sendQueueRecoveryReady: false, scheduleTabActivityBroadcast() {},
    revokeExternalOperationalDelivery: (_r, n) => { f.revoked.push(n.id); return { ok: true }; },
    revokeExternalCompletionDelivery: () => ({ ok: true }),
    getExternalOperationalDelivery: () => ({ restore: runs => {
      assert.ok(runs.every(r => Object.values(r.externalResearchOperational.notices).every(n => n.delivery === 'suppressed')));
      events.push('operational-restore');
    } }),
    getExternalResearchCoordinator: () => ({ wakeDelivery: () => events.push('final-wake') }),
    getAgentResponseState: null, readAgentObservedResponse: null,
    reconcileActiveOrchestrations: async () => events.push('research-reconcile'),
    setTimeout, clearTimeout, console,
  });
  vm.runInContext(functions.map(n => n.getText(tree)).join('\n'), ctx);
  return { ctx, events, queue };
}
test('actual startup factory and FIFO restore wait for receipt readiness and durable quiet before resume', async t => {
  const f = await fixture(t); let release;
  const ready = new Promise(r => { release = r; }), a = actualStartup(f, ready);
  const pending = a.ctx.restoreAgentSendQueueAfterReceipts(a.queue);
  await Promise.resolve();
  assert.equal(a.ctx.sendQueueRecoveryReady, false); assert.deepEqual(a.events, []);
  release({ ready: true }); await pending;
  await a.ctx.getOrchestrationRunStore().listAll();
  assert.equal(a.ctx.sendQueueRecoveryReady, true);
  assert.equal(a.events.filter(x => x === 'fifo-resume').length, 1);
  assert.equal(a.events.filter(x => x === 'operational-restore').length, 1);
  assert.equal((await a.ctx.getOrchestrationRunStore().getResearchMaintenance()).startup.beforeRestore, true);
});
test('actual startup recovery retries failed strict handover and resumes existing FIFO exactly once', async t => {
  const f = await fixture(t), a = actualStartup(f, Promise.resolve({ ready: true })), rename = fs.promises.rename;
  fs.promises.rename = async (...args) => { if (args[1] === f.file) throw Object.assign(Error('owned wired startup EIO'), { code: 'EIO' }); return rename(...args); };
  try { await assert.rejects(a.ctx.restoreAgentSendQueueAfterReceipts(a.queue), { code: 'EIO' }); }
  finally { fs.promises.rename = rename; }
  assert.equal(a.ctx.sendQueueRecoveryReady, false); assert.deepEqual(a.events, []);
  await a.ctx.startOrchestrationStartupRecovery();
  await a.ctx.getOrchestrationRunStore().listAll();
  assert.equal(a.ctx.sendQueueRecoveryReady, true);
  assert.equal(a.ctx.orchestrationStartupRecovery, null);
  assert.equal(a.events.filter(x => x === 'fifo-resume').length, 1);
  assert.equal(a.events.filter(x => x === 'research-reconcile').length, 1);
  await a.ctx.restoreAgentSendQueueAfterReceipts(a.queue);
  assert.equal(a.events.filter(x => x === 'fifo-resume').length, 1);
});

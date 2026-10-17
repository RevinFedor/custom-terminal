'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest: hash } = require('./agent-send-receipt-registry');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, { admission = async () => true } = {}) {
  const state = { terminalToken: {}, projectId: 'P', cwd: '/fixture', toolType: 'codex',
    sessionId: 'SOURCE', inputRevision: 7, stopping: false };
  const db = new Database(':memory:');
  const store = createAgentSendReceiptStore(db);
  const executions = [], writes = [];
  let queue;
  const gate = createHistoryMutationInputGate({ capture: () => ({ ...state }),
    readSendBusy: () => queue.hasUnsettledInput('T'), wake: id => queue.wake(id), log: { log() {} } });
  queue = new AgentSendQueue({ store, admit: async request => !gate.held(request.tabId) && await admission(request),
    claimDispatch: request => gate.claimSend(request.tabId), execute: async request => {
      executions.push(request);
      // Same immutable target check as the production scenario; no retarget.
      if (request.expectedTarget.sessionId !== state.sessionId) return { submitted: false, code: 'agent_send_session_changed' };
      gate.assert(request.tabId, null, { action: 'send' });
      writes.push(request.handoffId);
      return { submitted: false, code: 'fixture-no-provider' };
    } });
  t.after(() => { queue.dispose(); db.close(); });
  const add = (id, surface = 'desktop-history') => {
    const request = { tabId: 'T', provider: 'codex', handoffId: id, sendOperationKey: 'history:T:' + id,
      prompt: 'immutable ' + id, source: surface === 'tab-message' ? 'tab-message:exact' : 'history-panel',
      expectedTarget: { toolType: 'codex', sessionId: state.sessionId } };
    const identity = { operationKey: request.sendOperationKey, tabId: 'T', provider: 'codex', surface,
      sessionId: state.sessionId, handoffId: id, requestFingerprint: hash(request), promptHash: hash(request.prompt), promptLength: request.prompt.length };
    return queue.enqueue({ request, identity });
  };
  const reserve = (patch = {}) => gate.reserve({ tabId: 'T', operationId: 'rewind-A', sessionId: state.sessionId,
    toolType: 'codex', owner: 'renderer-A', ...patch });
  return { state, db, store, queue, gate, executions, writes, add, reserve };
}

test('actual FIFO holds ordinary/tab-message at Stop/COW, same item/attempt and original branch after settlement', async t => {
  const h = fixture(t), proof = h.reserve();
  const a = h.add('manual'), b = h.add('message', 'tab-message');
  await tick();
  assert.equal(h.executions.length, 0);
  for (const item of [a, b]) {
    assert.equal(h.queue.item(item.record.operationKey).state, 'waiting');
    assert.equal(h.store.get(item.record.operationKey).attemptId, null);
    assert.equal(h.queue.receipt(item.record.operationKey).status, 'application-queued');
  }
  assert.throws(() => h.gate.assert('T', null, { action: 'resume', sessionId: 'SOURCE' }), /history_input_mutation_pending/);
  assert.throws(() => h.gate.assert('T', null, { action: 'send' }), /history_input_mutation_pending/);
  h.state.sessionId = 'CHILD'; h.gate.bound(proof, 'CHILD');
  h.gate.assert('T', proof, { action: 'resume', toolType: 'codex', sessionId: 'CHILD' });
  assert.throws(() => h.gate.assert('T', proof, { action: 'resume', sessionId: 'SOURCE' }), /target_changed/);
  h.gate.finish(proof, 'renderer-A');
  await tick(); await tick(); await tick();
  assert.deepEqual(h.executions.map(r => r.handoffId), ['manual', 'message']);
  assert.deepEqual(h.executions.map(r => r.expectedTarget.sessionId), ['SOURCE', 'SOURCE']);
  assert.deepEqual(h.writes, [], 'no automatic transfer/paste/Enter into CHILD');
  assert.equal(h.queue.item(a.record.operationKey).id, a.item.id);
  assert.equal(h.store.get(a.record.operationKey).attemptId, null);
});

test('reservation closes the race AFTER asynchronous Send admission, without terminal attempt', async t => {
  const wait = deferred(), h = fixture(t, { admission: () => wait.promise });
  h.add('race'); await tick();
  const proof = h.reserve();
  wait.resolve(true); await tick();
  assert.equal(h.executions.length, 0);
  assert.equal(h.store.get('history:T:race').attemptId, null);
  h.gate.finish(proof); await tick(); await tick();
  assert.deepEqual(h.writes, ['race']);
});

test('active dispatch / unknown Enter slot prevents new History admission, without modifying delivery', async t => {
  const h = fixture(t), release = h.gate.claimSend('T');
  assert.throws(() => h.reserve(), /history_input_send_pending/); release();
  const item = h.add('unknown');
  // Hold the existing durable input slot as unknown; no delivery rewrite.
  const start = h.store.beginAttempt({ ...item.record, operationKey: item.record.operationKey });
  h.store.settleAttempt(item.record.operationKey, start.attemptId, { submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
  h.db.prepare("UPDATE agent_send_queue SET state='awaiting-receipt' WHERE operation_key=?").run(item.record.operationKey);
  const before = h.store.get(item.record.operationKey);
  assert.throws(() => h.reserve(), /history_input_send_pending/);
  assert.deepEqual(h.store.get(item.record.operationKey), before);
});

test('old/wrong proof and foreign owner cannot release or Resume the reserved tab', t => {
  const h = fixture(t), proof = h.reserve();
  assert.throws(() => h.gate.finish({ ...proof, token: 'fake' }), /reservation_changed/);
  assert.throws(() => h.gate.finish(proof, 'renderer-B'), /owner_changed/);
  assert.equal(h.gate.held('T'), true);
  h.gate.finish(proof);
  const newer = h.reserve({ operationId: 'rewind-B' });
  assert.throws(() => h.gate.finish(proof), /reservation_changed/);
  assert.throws(() => h.gate.assert('T', proof, { sessionId: 'SOURCE' }), /reservation_changed/);
  h.gate.finish(newer);
  assert.throws(() => h.gate.assert('T', newer, { sessionId: 'SOURCE' }), /reservation_changed/);
});

test('renderer loss never wakes FIFO in the middle of an owned asynchronous write', async t => {
  const h = fixture(t), proof = h.reserve(), wait = deferred();
  const pending = h.gate.run(proof, () => wait.promise);
  h.add('after-crash'); await tick();
  h.gate.revokeOwner('renderer-A');
  assert.equal(h.gate.held('T'), true);
  assert.throws(() => h.gate.assert('T', proof, { action: 'mutation' }), /reservation_changed/);
  assert.equal(h.executions.length, 0);
  wait.resolve(); await pending; await tick(); await tick();
  assert.equal(h.gate.held('T'), false);
  assert.deepEqual(h.writes, ['after-crash']);
});

test('terminal/cwd/project/session replacement invalidates mutation authority, not its held FIFO', t => {
  for (const patch of [{ terminalToken: {} }, { cwd: '/other' }, { projectId: 'other' }, { sessionId: 'FOREIGN' }, { inputRevision: 8 }]) {
    const h = fixture(t), proof = h.reserve(); Object.assign(h.state, patch);
    assert.throws(() => h.gate.assert('T', proof, { action: 'mutation' }), /owner_changed/);
    assert.equal(h.gate.held('T'), true); h.gate.finish(proof);
  }
});

test('actual Main launch/write assertion rejects foreign Resume; own exact child works without weakening Stop/target proof', t => {
  const h = fixture(t), proof = h.reserve();
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'assertAgentSendLaunchCurrent').getText(ast);
  const actual = vm.runInNewContext(body + '\nassertAgentSendLaunchCurrent', {
    historyMutationInput: h.gate, terminals: new Map([['T', h.state.terminalToken]]),
  });
  assert.throws(() => actual('T', 'codex', { sessionId: 'SOURCE' }), e => e.code === 'history_input_mutation_pending');
  h.state.sessionId = 'CHILD'; h.gate.bound(proof, 'CHILD');
  assert.doesNotThrow(() => actual('T', 'codex', { sessionId: 'CHILD', historyInput: proof }, { expectedTerminal: h.state.terminalToken }));
  assert.throws(() => actual('T', 'codex', { sessionId: 'SOURCE', historyInput: proof }), /target_changed/);
  assert.throws(() => actual('T', 'codex', { sessionId: 'CHILD', historyInput: proof,
    sendOperationKey: 'old', sendAttemptId: 'old' }), /target_changed/);
  h.gate.authorizeResume(proof, { command: 'codex-c', sessionId: 'CHILD' });
  assert.throws(() => h.gate.authorizeResume(proof), /already_claimed/);
  h.gate.finish(proof);
  assert.throws(() => actual('T', 'codex', { sessionId: 'CHILD', historyInput: proof }), /reservation_changed/);
});

test('own Resume can materialize its proven writer, not lend its token to another launch or Send', t => {
  const h = fixture(t), proof = h.reserve();
  assert.throws(() => h.gate.authorizeResume(proof, { command: 'codex-c', sessionId: 'SOURCE', prompt: 'not a Resume' }), /target_changed/);
  h.gate.authorizeResume(proof, { command: 'codex-c', sessionId: 'SOURCE' });
  h.state.runSeq = 8; h.state.inputOwnerLaunchId = 'OWN';
  h.gate.claimLaunch(proof, 'OWN', 8);
  h.state.sessionId = 'PROVEN-OWN-WRITER'; h.state.inputRevision++;
  assert.doesNotThrow(() => h.gate.assert('T', proof, { sessionId: 'SOURCE' }));
  h.state.inputOwnerLaunchId = 'FOREIGN';
  assert.throws(() => h.gate.assert('T', proof, { action: 'mutation' }), /owner_changed/);
  h.gate.finish(proof);
});

test('explicit Stop cancels future mutation writes; it never treats unknown Send as no-input', async t => {
  const h = fixture(t), proof = h.reserve(), wait = deferred();
  const write = h.gate.run(proof, () => wait.promise);
  h.gate.cancel('T'); assert.equal(h.gate.held('T'), true);
  assert.throws(() => h.gate.assert('T', proof, { action: 'mutation' }), /reservation_changed/);
  wait.resolve(); await write; assert.equal(h.gate.held('T'), false);
});

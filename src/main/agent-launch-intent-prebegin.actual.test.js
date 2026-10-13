'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createAgentLaunchPreparationRegistry } = require('./agent-launch-preparation');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['captureAgentLaunchFence', 'withAgentLaunchFence', 'getTerminalStopRevision',
  'readAgentLaunchIntentSource', 'agentLaunchIntentSourceCurrent', 'agentLaunchIntentTrace',
  'agentLaunchIntentRefusal', 'agentLaunchIntentPayloadKey', 'watchAgentLaunchIntentSender',
  'beginAgentLaunchIntent', 'cancelAgentLaunchIntent', 'runAgentLaunchIntentAttempt', 'assertAgentSendLaunchCurrent'];
const code = names.map(name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast)).join('\n');
function fixture() {
  const term = {}, sender = Object.assign(new EventEmitter(), { id: 1 });
  const registry = createAgentLaunchPreparationRegistry();
  const env = { crypto, console: { warn() {}, log() {} }, terminalLaunchFenceOrders: new WeakMap(), nextTerminalLaunchFenceOrder: 0,
    terminals: new Map([['T', term]]), terminalStopRevisions: new WeakMap(), terminalLifecycleEpochs: new WeakMap(),
    terminalProjects: new Map([['T', '/fixture']]), terminalProjectIds: new Map([['T', 'P']]),
    aiStoppingTabs: new Map(), agentLaunchIntentSenders: new Set(), agentLaunchPreparations: registry,
    resolveAuthoritativeTabProjectId: () => 'P', agentSendRequestTargetFailure: () => null,
    AGENT_SEND_DURABLE_STATES: { IN_FLIGHT: 'in-flight' },
    agentSendReceiptStore: { get: () => ({ tabId: 'T', provider: 'codex', attemptId: 'A', state: 'in-flight' }),
      isDeliveryCancelled: () => false },
    projectManager: { db: { db: { prepare: () => ({ all: () => [
      { id: 1, project_id: 'P', cwd: '/fixture', codex_session_id: 'S' },
    ] }) } } },
  };
  vm.createContext(env); vm.runInContext(code, env);
  const request = { tabId: 'T', toolType: 'codex', intentId: 'launch:test:1', sessionId: 'S', cwd: '/fixture' };
  return { env, sender, term, registry, request, capture: () => env.captureAgentLaunchFence('T'),
    begin: input => env.beginAgentLaunchIntent({ sender }, input) };
}

test('Stop before FIRST begin refuses the original physical fence with the revocation event completely absent', () => {
  const f = fixture(); const original = f.capture();
  f.env.terminalStopRevisions.set(f.term, 1); // deliberately NO renderer event
  const result = f.begin({ ...f.request, launchFence: original });
  assert.equal(result.success, false); assert.equal(result.code, 'agent_launch_cancelled');
  assert.equal(f.registry.getIntentByIdentity({ ...f.request, senderId: 1 }).revoked, true);
  const fresh = f.begin({ ...f.request, intentId: 'launch:test:2', launchFence: f.capture() });
  assert.equal(fresh.success, true, 'a new explicit intent may use a newly observed Main fence');
});

// Composition executes real renderer scope, retry classifier, Main registry,
// admission and final authority guard. Only IPC scheduling, SQL rows and the
// process/PTY ports are controlled; this is not a native/provider acceptance.
const turn = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function composed(options = {}) {
  const { createAgentLaunchAdmission } = await import('../renderer/utils/agentLaunchAdmission.mjs');
  const f = fixture(), requests = [], writes = [], delays = [];
  const payload = { tabId: 'T', command: 'codex-c', sessionId: 'S', cwd: '/fixture',
    ...(options.send ? { sendOperationKey: 'O', sendAttemptId: 'A' } : {}) };
  const original = f.capture();
  const invoke = async (channel, input) => {
    requests.push({ channel, input: structuredClone(input) });
    if (channel === 'agent:begin-launch-intent') {
      await options.beforeBegin?.(f);
      return f.begin(input);
    }
    if (channel === 'agent:cancel-launch-intent' || channel === 'agent:finish-launch-intent') {
      return f.env.cancelAgentLaunchIntent({ sender: f.sender }, input, channel.includes('finish'));
    }
    assert.equal(channel, 'codex:run-command');
    const result = await f.env.runAgentLaunchIntentAttempt(f.sender, input, async () => {
      f.env.assertAgentSendLaunchCurrent('T', 'codex', input, { validateTarget: true });
      const refused = await options.lookup?.(input.launchAttempt, f);
      if (refused) return refused;
      f.env.assertAgentSendLaunchCurrent('T', 'codex', input, { validateTarget: true });
      assert.equal(f.registry.markIntentWrite(input.launchIntent.token, input.launchAttempt, false, 'L'), true);
      writes.push(structuredClone(input));
      assert.equal(f.registry.markIntentWrite(input.launchIntent.token, input.launchAttempt, true), true);
      return { success: true, accepted: true, launchId: 'L' };
    });
    return options.transport ? options.transport(result) : result;
  };
  const events = new EventEmitter();
  const scope = createAgentLaunchAdmission({ invoke, events,
    tabId: 'T', toolType: 'codex', sessionId: 'S', cwd: '/fixture', launchFence: original,
    ...(options.send ? { sendOperationKey: 'O', sendAttemptId: 'A' } : {}),
    responseTimeoutMs: 15, signal: options.signal,
    wait: async ms => { delays.push(ms); await options.backoff?.(f); },
  });
  return { ...f, scope, events, requests, writes, delays, payload, original };
}
const unknownLookup = { success: false, accepted: false, launchWritten: false,
  error: 'process_lookup_failed', reason: 'process_lookup_unknown', lookupUnknown: true };

test('composed recovery repeats only launch admission with the same original witness and one immutable payload', async () => {
  const f = await composed({ lookup: attempt => attempt === 1 ? unknownLookup : null });
  const result = await f.scope.run('codex:run-command', f.payload);
  assert.equal(result.success, true); assert.equal(result.admissionAttempts, 2);
  assert.deepEqual(f.delays, [1000]); assert.equal(f.writes.length, 1);
  const calls = f.requests.filter(r => r.channel === 'codex:run-command');
  assert.deepEqual(calls.map(r => r.input.launchAttempt), [1, 2]);
  assert.deepEqual(calls[0].input.launchFence, structuredClone(f.original));
  assert.deepEqual(calls[1].input.launchIntent, calls[0].input.launchIntent);
  assert.equal((await f.scope.run('codex:run-command', f.payload)).success, true);
  assert.equal(f.writes.length, 1, 'same scope rejoin is not another invocation');
  await f.scope.finish();
});

test('composed retry has one four-attempt budget without creating a second preparation owner', async () => {
  const f = await composed({ lookup: () => unknownLookup, backoff: current => {
    const state = [...current.registry.list()]; assert.deepEqual(state, []);
  } });
  const result = await f.scope.run('codex:run-command', f.payload);
  assert.equal(result.retryExhausted, true); assert.equal(result.admissionAttempts, 4);
  assert.deepEqual(f.delays, [1000, 2500, 5000]); assert.equal(f.writes.length, 0);
  await f.scope.finish();
});

test('late already-observed create publication cannot cancel a newer explicit launch intent', async () => {
  const f = await composed();
  f.events.emit('agent:launch-fence-revoked', null, { tabId: 'T', launchFence: f.original });
  const result = await f.scope.run('codex:run-command', f.payload);
  assert.equal(result.success, true); assert.equal(f.writes.length, 1);
  await f.scope.finish();
});

test('late exit of an older PTY cannot erase a newer Main fence received through create/publication', async () => {
  const { rememberAgentLaunchFence, readAgentLaunchFence, observeAgentLaunchFences } = await import('../renderer/utils/agentLaunchFence.mjs');
  const events = new EventEmitter(), f = fixture(), first = f.capture();
  observeAgentLaunchFences(events); rememberAgentLaunchFence('T-exit', first);
  f.env.terminals.set('T', {}); const second = f.capture();
  rememberAgentLaunchFence('T-exit', second);
  events.emit('terminal:exit', null, 'T-exit', 0, first);
  assert.deepEqual(readAgentLaunchFence('T-exit'), structuredClone(second));
  events.emit('terminal:exit', null, 'T-exit', 0, second);
  assert.equal(readAgentLaunchFence('T-exit'), null);
});

for (const boundary of ['before-first-begin', 'backoff']) test('composed Stop with LOST revocation event refuses the old intent at ' + boundary, async () => {
  const stop = f => { f.env.terminalStopRevisions.set(f.term, 1); };
  const f = await composed(boundary === 'before-first-begin' ? { beforeBegin: stop }
    : { lookup: attempt => attempt === 1 ? unknownLookup : null, backoff: stop });
  const result = await f.scope.run('codex:run-command', f.payload);
  assert.equal(result.success, false); assert.equal(f.writes.length, 0);
  assert.match(result.code || result.error, /agent_launch_/);
  await f.scope.finish();
});

test('source cancellation during a held probe revokes Main authority before the final write', async () => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const f = await composed({ signal: controller.signal, lookup: async () => { entered(); await held; return null; } });
  const pending = f.scope.run('codex:run-command', f.payload);
  await reached; controller.abort('source-edited'); await turn(); release();
  assert.equal((await pending).success, false); await turn();
  assert.equal(f.writes.length, 0); await f.scope.finish();
});

for (const lose of ['rejected', 'silent']) test('launch ' + lose + ' ACK does not downgrade previous Send evidence through the real flow', async () => {
  const { runAgentSendFlow } = await import('../renderer/utils/agentSendFlow.mjs');
  const f = await composed({ send: true, transport: () => lose === 'rejected'
    ? Promise.reject(new Error('controlled lost ACK')) : new Promise(() => {}) });
  const pending = runAgentSendFlow({ prepareContext: async () => ({}), ensureReady: async () => {
    const result = await f.scope.run('codex:run-command', f.payload);
    if (result.success !== true) throw Object.assign(new Error(result.error), result);
    return result;
  }, proveComposer: () => assert.fail('unknown launch cannot advance'),
  runProviderOperation: () => assert.fail('no Send write from unknown launch') });
  await assert.rejects(pending, error => {
    assert.equal(error.sendReceipt?.deliveryUnknown, true);
    assert.equal(error.sendReceipt.submitted, null);
    assert.equal(error.sendReceipt.pasteWritten, undefined);
    assert.equal(error.sendReceipt.enterWritten, undefined);
    return true;
  });
  assert.equal(f.writes.length, 1);
  assert.equal(f.requests.filter(r => r.channel === 'codex:run-command').length, 1);
  await f.scope.finish();
});

test('missing first fence is not permission to capture the current post-Stop authority', () => {
  const f = fixture(); f.env.terminalStopRevisions.set(f.term, 1);
  const result = f.begin(f.request);
  assert.equal(result.success, false); assert.equal(result.code, 'agent_launch_original_fence_required');
});

test('PTY replacement before first begin also rejects even if Stop revision starts at zero again', () => {
  const f = fixture(), old = f.capture();
  f.env.terminals.set('T', {});
  const result = f.begin({ ...f.request, launchFence: old });
  assert.equal(result.success, false); assert.equal(result.code, 'agent_launch_cancelled');
});

test('the original witness cannot be refreshed by a duplicate begin after Stop', () => {
  const f = fixture(), old = f.capture();
  const first = f.begin({ ...f.request, launchFence: old }); assert.equal(first.success, true);
  f.env.terminalStopRevisions.set(f.term, 1);
  const reused = f.begin({ ...f.request, launchFence: f.capture() });
  assert.equal(reused.success, false); assert.equal(reused.code, 'agent_launch_intent_fence_changed');
  assert.throws(() => f.env.assertAgentSendLaunchCurrent('T', 'codex', {
    launchIntent: first.launchIntent, launchFence: old,
  }), error => error.code === 'agent_launch_intent_cancelled' || error.code === 'agent_launch_intent_missing');
});

test('fence order survives delayed create/read publication: old owner and old revision cannot replace new cache', async () => {
  const { rememberAgentLaunchFence, readAgentLaunchFence } = await import('../renderer/utils/agentLaunchFence.mjs');
  const f = fixture(), first = f.capture();
  assert.equal(rememberAgentLaunchFence('T-order', first), true);
  f.env.terminalStopRevisions.set(f.term, 1); const second = f.capture();
  assert.ok(second.order > first.order); assert.equal(rememberAgentLaunchFence('T-order', second), true);
  assert.equal(rememberAgentLaunchFence('T-order', first), false);
  f.env.terminals.set('T', {}); const replaced = f.capture();
  assert.ok(replaced.order > second.order); rememberAgentLaunchFence('T-order', replaced);
  assert.equal(rememberAgentLaunchFence('T-order', second), false);
  assert.deepEqual(readAgentLaunchFence('T-order'), JSON.parse(JSON.stringify(replaced)));
});

test('stale admission publishes the current fence only as a future observation; the original intent stays refused', () => {
  for (const alreadyBegun of [false, true]) {
    const f = fixture(), original = f.capture();
    if (alreadyBegun) assert.equal(f.begin({ ...f.request, launchFence: original }).success, true);
    f.env.terminalStopRevisions.set(f.term, 1); // publication completely lost
    const result = f.begin({ ...f.request, launchFence: original });
    assert.equal(result.success, false);
    assert.deepEqual(structuredClone(result.launchFence), structuredClone(original), 'refusal retains the historical authority');
    assert.equal(result.observedLaunchFence?.stopRevision, 1);
    assert.ok(result.observedLaunchFence.order > original.order);
    assert.equal(f.begin({ ...f.request, launchFence: result.observedLaunchFence }).success, false,
      'receiving a new observation cannot renew this retired intent ID');
  }
});

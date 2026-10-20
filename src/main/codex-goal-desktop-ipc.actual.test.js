'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCodexGoalDesktopIpc } = require('./codex-goal-desktop-ipc');
const { createCodexRuntimePolicyController, inspectCodexPolicyDialog } = require('./codex-runtime-policies');
const tick = () => new Promise(resolve => setImmediate(resolve));
const goal = 'Resume paused goal?\nGoal: desktop source test\n> 1. Resume goal  Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';

async function fixture({ confirm = true } = {}) {
  let frame = { valid: true, seq: 1, text: goal }, readable = false, sequence = 0;
  const timers = new Map(), writes = [], calls = [], events = [];
  const owner = { terminal: {}, live: true, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1, sessionId: 'S' };
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }), readFrame: async () => readable ? frame : { valid: false },
    withWriteLock: async (_term, work) => work({ active: true }), readPolicy: () => ({}),
    isComposer: f => f.text === 'composer', stopAll: () => assert.fail('Goal choice must not Stop'),
    publish: (_tab, policy) => events.push(policy),
    setTimer: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id),
    sendKey: async (_tab, key, { guard }) => {
      assert.equal(guard(), true); writes.push(key);
      if (key === '\r') { if (confirm) frame = { valid: true, seq: frame.seq + 1, text: 'composer' }; }
      else {
        const next = inspectCodexPolicyDialog(frame.text).selectedIndex + (key === '\x1b[B' ? 1 : -1);
        frame = { valid: true, seq: frame.seq + 1,
          text: frame.text.replace('> ', '  ').replace('  ' + next + '.', '> ' + next + '.') };
      }
      controller.observe('T', frame);
      return { written: true };
    },
  });
  controller.observe('T', frame); await tick();
  for (const fire of [...timers.values()]) await fire();
  readable = true;
  const handlers = new Map();
  registerCodexGoalDesktopIpc({ ipcMain: { handle: (channel, handler) => {
    assert.equal(handlers.has(channel), false); handlers.set(channel, handler);
  } }, actions: { read: (...args) => controller.readGoalAction(...args), apply: (...args) => controller.applyGoalAction(...args) },
  describeTab: id => id === 'T' ? { toolType: 'codex' } : id === 'claude' ? { toolType: 'claude' } : null });
  const invoke = async (channel, request) => { calls.push({ channel, request }); return handlers.get(channel)({}, request); };
  return { invoke, controller, owner, calls, writes, events, async expire() {
    for (const fire of [...timers.values()]) await fire(); await tick();
  }, paint(text = goal) { frame = { valid: true, seq: frame.seq + 1, text }; controller.observe('T', frame); } };
}

for (const action of ['resume', 'leave-paused']) test('actual renderer adapter → desktop callback → API → Main controller: ' + action, async () => {
  const { createCodexGoalDesktopAdapter } = await import('../renderer/utils/codexGoalDesktopAdapter.mjs');
  const h = await fixture();
  const adapter = createCodexGoalDesktopAdapter({ invoke: h.invoke, createRequestId: () => 'desktop-1' });
  await adapter.refresh('T');
  const initial = adapter.snapshot('T', 'S');
  assert.deepEqual(initial.availableActions, ['resume', 'leave-paused']);
  assert.deepEqual(h.writes, [], 'read must not observe or act');
  const applying = adapter.choose('T', 'S', initial.operationId, action);
  assert.equal(await adapter.choose('T', 'S', initial.operationId, action), false, 'duplicate click blocked before await');
  await applying; await tick(); await adapter.refresh('T');
  const result = adapter.snapshot('T', 'S');
  assert.equal(result.status, 'confirmed'); assert.equal(result.choiceConfirmed, true);
  assert.equal(result.requestId, 'desktop-1'); assert.equal(result.operationId, initial.operationId);
  assert.deepEqual(h.writes, action === 'resume' ? ['\r'] : ['\x1b[B', '\r']);
  assert.equal(h.calls.filter(call => call.channel === 'codex:apply-goal-action').length, 1);
  assert.ok(h.calls.some(call => call.channel === 'codex:read-goal-action' && call.request.requestId === 'desktop-1'));
  assert.deepEqual(result.availableActions, []);
});

test('lost IPC ACK recovers exact request by reads, without a second apply or false success', async () => {
  const { createCodexGoalDesktopAdapter } = await import('../renderer/utils/codexGoalDesktopAdapter.mjs');
  const h = await fixture({ confirm: false });
  const adapter = createCodexGoalDesktopAdapter({ createRequestId: () => 'lost-ack', invoke: async (...args) => {
    const value = await h.invoke(...args);
    if (args[0] === 'codex:apply-goal-action') throw new Error('ACK lost');
    return value;
  } });
  await adapter.refresh('T'); const op = adapter.snapshot('T', 'S').operationId;
  await adapter.choose('T', 'S', op, 'resume'); await tick(); await h.expire(); await adapter.refresh('T');
  const unknown = adapter.snapshot('T', 'S');
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.choiceConfirmed, false);
  assert.equal(unknown.requestId, 'lost-ack'); assert.deepEqual(unknown.availableActions, []);
  assert.equal(await adapter.choose('T', 'S', op, 'leave-paused'), false);
  adapter.dismiss('T', op); await adapter.refresh('T');
  assert.equal(adapter.snapshot('T', 'S').hidden, true);
  assert.deepEqual(h.writes, ['\r']);
  assert.equal(h.calls.filter(call => call.channel === 'codex:apply-goal-action').length, 1);
  h.owner.live = false; h.controller.clear('T'); await adapter.refresh('T');
  assert.equal(adapter.receipt('T', 'lost-ack').status, 'unknown');
  assert.equal(h.calls.at(-1).request.requestId, 'lost-ack', 'Stop still reads the retained receipt');
});

test('newer proven same menu permits a new explicit recovery and retains the old unknown receipt', async () => {
  const { createCodexGoalDesktopAdapter } = await import('../renderer/utils/codexGoalDesktopAdapter.mjs');
  const h = await fixture({ confirm: false }); let id = 0;
  const adapter = createCodexGoalDesktopAdapter({ invoke: h.invoke, createRequestId: () => 'r' + ++id });
  await adapter.refresh('T'); const op = adapter.snapshot('T', 'S').operationId;
  await adapter.choose('T', 'S', op, 'resume'); await tick();
  h.paint(); await h.expire(); await adapter.refresh('T');
  assert.equal(adapter.snapshot('T', 'S').recoveryAvailable, true);
  assert.equal(h.writes.length, 1, 'recovery availability never acts automatically');
  await adapter.choose('T', 'S', op, 'leave-paused'); await tick();
  assert.equal(adapter.receipt('T', 'r1').status, 'unknown');
  assert.equal(adapter.snapshot('T', 'S').requestId, 'r2');
  assert.deepEqual(h.writes, ['\r', '\x1b[B', '\r']);
});

test('desktop IPC rejects foreign/missing/invalid/stale/stopped actions through existing guards', async () => {
  const h = await fixture();
  const initial = await h.invoke('codex:read-goal-action', { tabId: 'T' });
  for (const tabId of ['missing', 'claude', '', null, '\n']) {
    const result = await h.invoke('codex:apply-goal-action', { tabId, operationId: initial.operationId, requestId: 'bad', action: 'resume' });
    assert.equal(result.ok, false);
  }
  assert.equal((await h.invoke('codex:apply-goal-action', { tabId: 'T', operationId: 'stale', requestId: 'stale', action: 'resume' })).reason, 'stale-goal-operation');
  h.owner.live = false;
  const result = await h.invoke('codex:apply-goal-action', { tabId: 'T', operationId: initial.operationId, requestId: 'stopped', action: 'leave-paused' });
  assert.equal(result.accepted, false); assert.deepEqual(h.writes, []);
});

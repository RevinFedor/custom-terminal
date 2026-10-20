'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { inspectCodexUsagePrompt } = require('./codex-usage-prompt');
const { createCodexRuntimePolicyController, inspectCodexPolicyDialog,
  stopCodexPolicyTargets, projectCodexPolicyRuntime } = require('./codex-runtime-policies');
const { createCodexLiveSettingsObserver } = require('./codex-live-settings');
const { parseCodexVerifiedComposerFooter, selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');
const { waitForAgentReadyTransition, READINESS_CHANGED_EVENT } = require('./agent-ready-wait');

const goal = 'Resume paused goal?\nGoal: continue the existing task\n› 1. Resume goal   Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';
const usage = 'You’re now using Luna, a faster model for simpler tasks.\nUse your reset to continue using the most advanced models.\n› 1. Add Credits\n  2. Reset usage\n  3. Continue with Luna Reserve\nPress enter to confirm or esc to continue working';
const composer = (model = 'gpt-6-astra', effort = 'max') => '› Ask Codex to do anything\n' + model + ' ' + effort + ' · Context 42% used';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const owner = { terminal: {}, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1, live: true,
    ownerId: 'launch:L', sessionId: null };
  const writes = [], phases = [], timers = [];
  let frame = { valid: true, seq: 1, text: options.text || goal };
  let locked = Promise.resolve();
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }), readFrame: async () => options.readFrame ? options.readFrame(frame) : frame,
    readPolicy: () => options.policy || {},
    isComposer: value => !!parseCodexVerifiedComposerFooter(value.text),
    withWriteLock: async (_term, work) => { await locked; return work({ active: true }); },
    sendKey: async (_tab, key, { guard }) => {
      options.beforeWrite?.(owner);
      if (!guard()) return { written: false, reason: 'owner-changed' };
      writes.push(key);
      if (key !== '\r') {
        const dialog = inspectCodexPolicyDialog(frame.text);
        const next = dialog.selectedIndex + (key === '\x1b[B' ? 1 : -1);
        frame = { ...frame, seq: frame.seq + 1, text: frame.text.replace('› ', '  ').replace(new RegExp('  ' + next + '\\.'), '› ' + next + '.') };
        controller.observe('T', frame);
      }
      if (options.synchronousResult && key === '\r') paint(composer());
      return { written: true };
    },
    stopAll: options.stopAll || (async () => ({ success: true })),
    publish: (_tab, value) => phases.push(value),
    setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {},
  });
  function paint(text = frame.text, extra = {}) {
    frame = { ...frame, seq: frame.seq + 1, text, ...extra }; controller.observe('T', frame);
  }
  return { owner, controller, writes, phases, paint, timers, get frame() { return frame; },
    lock() { let resolve; locked = new Promise(r => { resolve = r; }); return resolve; } };
}

test('usage grammar: exact current bounded menu, wrapped fallback, no credits/reset action', () => {
  for (const text of [usage, usage.replace('Continue with Luna Reserve', 'Continue with\nLuna Reserve'), usage + '\n']) {
    assert.equal(inspectCodexUsagePrompt(text).targetIndex, 3);
    assert.equal(inspectCodexUsagePrompt(text).interactive, true);
    assert.equal(selectCodexCurrentInteractiveFrameText(text).trim(), text.trim());
  }
  const old = usage + '\n' + composer();
  assert.equal(inspectCodexUsagePrompt(old).visible, false);
  assert.equal(inspectCodexUsagePrompt(usage + '\n' + usage).interactive, true);
  assert.equal(inspectCodexUsagePrompt('model is at capacity').visible, false);
  assert.equal(inspectCodexUsagePrompt(usage.replace('  2. Reset usage', '  2. Unknown purchase')).interactive, false);
});

for (const [label, policy, expected] of [
  ['default Resume', {}, ['\r']], ['Leave paused', { resumeGoal: false }, ['\x1b[B', '\r']],
  ['explicit override', { resumeGoal: false, resumeOverride: true }, ['\r']],
]) test('Goal policy ' + label + ': one action and committed result, not key write', async () => {
  const h = fixture({ policy }); h.paint(); h.paint(); await tick();
  assert.deepEqual(h.writes, expected);
  assert.equal(h.controller.read('T').phase, 'confirming');
  h.paint(); await tick(); assert.deepEqual(h.writes, expected);
  h.paint(composer()); await tick(); assert.equal(h.controller.read('T'), null);
  h.paint(composer()); await tick(); assert.deepEqual(h.writes, expected);
});

test('fresh still-visible provider choice yields typed manual state and never retries Enter', async () => {
  const h = fixture(); h.paint(); await tick(); h.paint(); await h.timers.at(-1)();
  const policy = h.controller.read('T');
  assert.equal(policy.manualActionRequired, true);
  const status = projectCodexPolicyRuntime({ sessionStatus: 'starting', busy: false, inputReady: true, liveLifecycle: true }, policy);
  assert.equal(status.sessionStatus, 'active'); assert.equal(status.inputReady, false);
  assert.equal(status.liveLifecycle, true); assert.equal(status.startupFailed, false);
  const events = new EventEmitter();
  await assert.rejects(waitForAgentReadyTransition({ tabId: 'T', eventBus: events, readStatus: async () => status }),
    error => error.code === 'codex_resume_goal_action_required' && error.statusCode === 409);
  h.paint(); h.paint(); await tick(); assert.deepEqual(h.writes, ['\r']);
  h.paint(composer()); assert.equal(h.controller.read('T'), null, 'late actual success wins, no retry');
});

for (const frame of ['uncommitted','same-pre-enter','older','non-dialog','fractional-seq']) {
  test('Goal confirmation checkpoint keeps an unobserved ' + frame + ' result pending, not manual', async () => {
    const h = fixture(); h.paint(); await tick(); const action = h.frame;
    if (frame === 'uncommitted') h.paint(goal, { valid: false });
    if (frame === 'older') h.paint(goal, { seq: action.seq - 1 });
    if (frame === 'non-dialog') h.paint('new output without an input proof');
    if (frame === 'fractional-seq') h.paint(goal, { seq: action.seq + 0.5 });
    const timersBefore = h.timers.length; await h.timers.at(-1)();
    assert.equal(h.controller.read('T').manualActionRequired, false);
    assert.equal(h.controller.read('T').reason, 'provider-result-unobserved');
    const request = h.controller.readGoalAction('T');
    assert.equal(request.status, 'unknown'); assert.equal(request.recoveryAvailable, false);
    assert.deepEqual(request.availableActions, []); assert.equal(request.choiceConfirmed, false);
    assert.equal(h.controller.applyGoalAction('T', { operationId: request.operationId, requestId:'no-replay', action:'resume' }).accepted, false);
    assert.equal(h.timers.length, timersBefore, 'a read checkpoint must not create another timer');
    assert.deepEqual(h.writes, ['\r']);
    h.paint(composer(), { valid: true, seq: action.seq + 10 });
    assert.equal(h.controller.readGoalAction('T').status, 'confirmed'); assert.deepEqual(h.writes, ['\r']);
  });
}

test('late fresh Goal after unobserved result is manual and explicit-only, never a second automatic Enter', async () => {
  const h = fixture(); h.paint(); await tick(); await h.timers.at(-1)();
  assert.equal(h.controller.read('T').manualActionRequired, false);
  h.paint(); assert.equal(h.controller.read('T').manualActionRequired, true);
  assert.equal(h.controller.read('T').reason, 'provider-choice-not-confirmed');
  assert.equal(h.controller.readGoalAction('T').recoveryAvailable, true);
  h.paint(); await tick(); assert.deepEqual(h.writes, ['\r']);
});

test('failed Goal confirmation read is unknown until an event, not manual action or a retry timer', async () => {
  let unavailable = false;
  const h = fixture({ readFrame: frame => { if (unavailable) throw Error('controlled frame failure'); return frame; } });
  h.paint(); await tick(); unavailable = true; await h.timers.at(-1)();
  assert.equal(h.controller.read('T').manualActionRequired, false);
  assert.equal(h.controller.readGoalAction('T').status, 'unknown'); assert.deepEqual(h.writes, ['\r']);
  h.paint(composer()); assert.equal(h.controller.readGoalAction('T').status, 'confirmed');
});

test('usage confirmation behavior is unchanged when its response frame is unobserved', async () => {
  const h = fixture({ text: usage }); h.paint(); await tick(); h.paint(usage, { valid: false });
  await h.timers.at(-1)(); assert.equal(h.controller.read('T').type, 'usage-exhaustion');
  assert.equal(h.controller.read('T').manualActionRequired, true);
  assert.deepEqual(h.writes, ['\x1b[B','\x1b[B','\r']);
});

test('synchronous committed result during Enter does not resurrect confirming', async () => {
  const h = fixture({ synchronousResult: true }); h.paint(); await tick();
  assert.equal(h.controller.read('T'), null);
});

test('current operational turn preserves queue-ready capability without inventing modal success or retrying a reappeared dialog', async () => {
  const h = fixture(); h.owner.turnId = 'A'; h.paint(); await tick();
  assert.equal(h.controller.observeOperationalTurn('T', 'A'), false);
  assert.equal(h.controller.observeOperationalTurn('T', 'B'), true);
  assert.equal(h.controller.read('T'), null);
  h.paint(); await tick();
  assert.equal(h.controller.read('T').phase, 'manual'); assert.deepEqual(h.writes, ['\r']);
  h.paint(composer()); assert.equal(h.controller.read('T'), null);
  const changed = fixture(); changed.paint(); await tick(); changed.owner.inputRevision++;
  assert.equal(changed.controller.observeOperationalTurn('T', 'C'), false, 'another prompt does not settle this choice');
});

for (const change of ['inputRevision', 'runSeq', 'lifecycleGeneration', 'terminal', 'live']) {
  test('owner changed at write: ' + change, async () => {
    const h = fixture({ beforeWrite(owner) { owner[change] = change === 'terminal' ? {} : change === 'live' ? false : 'changed'; } });
    h.paint(); await tick(); assert.deepEqual(h.writes, []);
  });
}

test('native input while waiting for existing PTY queue cancels automatic selection', async () => {
  const h = fixture(); const release = h.lock(); h.paint(); h.owner.inputRevision++; release(); await tick();
  assert.deepEqual(h.writes, []); assert.equal(h.controller.read('T').phase, 'manual');
});

test('a known dialog waiting on a busy PTY queue has a finite explanation and cannot write after its deadline', async () => {
  const h = fixture(); const release = h.lock(); h.paint();
  await h.timers[0](); assert.equal(h.controller.read('T').phase, 'manual');
  release(); await tick(); assert.deepEqual(h.writes, []);
});

test('uncommitted and old frames never choose; a different dialog becomes its own action', async () => {
  const h = fixture(); h.paint(goal, { valid: false }); await tick(); assert.deepEqual(h.writes, []);
  h.paint(goal, { valid: true }); await tick(); h.paint(composer());
  h.controller.observe('T', { valid: true, seq: 1, text: goal }); await tick(); assert.deepEqual(h.writes, ['\r']);
  h.paint(usage); await tick(); assert.deepEqual(h.writes, ['\r', '\x1b[B', '\x1b[B', '\r']);
});

test('continue quota selects fallback only; current unrecognized menu is manual, not a purchase', async () => {
  const h = fixture({ text: usage }); h.paint(); await tick();
  assert.deepEqual(h.writes, ['\x1b[B', '\x1b[B', '\r']);
  h.paint(composer('gpt-reserve')); assert.equal(h.controller.read('T'), null);
  const bad = fixture({ text: usage.replace('Reset usage', 'Other action') }); bad.paint(); await tick();
  assert.deepEqual(bad.writes, []); assert.equal(bad.controller.read('T').phase, 'manual');
});

test('Stop-all uses only common process Stop for exact idle/busy/queued owners, no Enter', async () => {
  const owners = Object.fromEntries(['idle', 'busy', 'queued'].map(id => [id, { terminal: {}, lifecycleGeneration: 'G', runSeq: 1, live: true }]));
  const calls = [];
  const stopAll = () => stopCodexPolicyTargets({ tabIds: ['idle', 'busy', 'queued', 'claude', 'absent'],
    capture: id => owners[id], stop: async (id, guard) => {
      assert.equal(guard(), true); calls.push(id); return { success: true };
    } });
  const h = fixture({ text: usage, policy: { usage: 'stop-all' }, stopAll });
  h.paint(); h.paint(); await tick(); assert.deepEqual(calls.sort(), ['busy', 'idle', 'queued']);
  assert.deepEqual(h.writes, []);
  const result = await stopCodexPolicyTargets({ tabIds: ['busy'], capture: id => owners[id], stop: async (id, guard) => {
    owners[id] = { ...owners[id], terminal: {} }; assert.equal(guard(), false); return { success: false };
  } }); assert.equal(result.success, false);
});

test('live model source confirms both directions, never changes saved intent, rejects raw notices and stale frames', () => {
  const owner = { live: true, terminal: {}, lifecycleGeneration: 'G', runSeq: 1, ownerId: 'launch:L' };
  const published = [], requested = { model: 'gpt-6-astra', effort: 'max' };
  let ts = 0;
  const observer = createCodexLiveSettingsObserver({ capture: () => ({ ...owner }), publish: (_tab, p) => published.push(p), now: () => ++ts });
  const paint = (seq, text, valid = true) => observer.observe('T', { valid, seq, text });
  paint(1, composer()); paint(2, usage); assert.equal(observer.read('T').model, 'gpt-6-astra');
  paint(3, composer('gpt-reserve')); assert.equal(observer.read('T').model, 'gpt-reserve');
  paint(4, 'Automatically switched back to gpt-5.6-sol max because ordinary usage is available again.');
  assert.equal(observer.read('T').model, 'gpt-reserve');
  paint(5, composer('gpt-5.6-sol'), false); assert.equal(observer.read('T').model, 'gpt-reserve');
  paint(6, 'Automatically switched back to gpt-5.6-sol max because ordinary usage is available again.\n' + composer('gpt-5.6-sol'));
  assert.equal(observer.read('T').model, 'gpt-5.6-sol'); assert.equal(observer.read('T').reason, 'ordinary-usage-restored');
  paint(3, composer('gpt-reserve')); assert.equal(observer.read('T').model, 'gpt-5.6-sol');
  owner.ownerId = owner.sessionId = 'S'; paint(7, composer('gpt-5.6-sol'));
  assert.equal(observer.read('T').ownerId, 'S');
  paint(8, composer('gpt-6-astra')); assert.equal(observer.read('T').model, requested.model);
  assert.deepEqual(requested, { model: 'gpt-6-astra', effort: 'max' });
  owner.runSeq++; assert.equal(observer.read('T'), null);
  assert.equal(published.length, 5);
});

test('response timeout does not own the still running policy; GET catch-up requires no new action', async () => {
  const h = fixture(); h.paint(); await tick();
  const events = new EventEmitter();
  const readStatus = async () => projectCodexPolicyRuntime({ status: 'starting', sessionStatus: 'starting', inputReady: false }, h.controller.read('T'));
  await assert.rejects(waitForAgentReadyTransition({ tabId: 'T', eventBus: events, timeoutMs: 10, readStatus }), error => error.code === 'agent_ready_timeout');
  h.paint(composer()); events.emit(READINESS_CHANGED_EVENT, null, { tabId: 'T' });
  assert.equal(h.controller.read('T'), null); assert.deepEqual(h.writes, ['\r']);
});

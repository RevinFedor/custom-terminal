'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = require('node:module');
const base = process.env.NOTED_GOAL_CHOICE_PREIMAGE;
const load = name => {
  if (!base) return require('./' + name);
  const loaded = new Module(path.join(__dirname, name), module);
  loaded.filename = path.join(__dirname, name); loaded.paths = module.paths;
  const original = loaded.require.bind(loaded);
  loaded.require = id => id === './codex-resume-goal-prompt' ? load('codex-resume-goal-prompt.js') : original(id);
  loaded._compile(fs.readFileSync(path.join(base, 'PRE-' + name), 'utf8'), loaded.filename);
  return loaded.exports;
};
const { createCodexRuntimePolicyController } = load('codex-runtime-policies.js');
const { resolveCodexResumeGoalPreference } = load('codex-resume-goal-prompt.js');
const menu = 'Resume paused goal?\nGoal: private fixture\n> 1. Resume goal  Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nenter select · esc back';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(policy = {}) {
  const owner = { terminal: {}, live: true, lifecycleGeneration: 'G', runSeq: 7, inputRevision: 2 };
  const timers = new Map(), writes = [], events = [];
  let frame = { valid: true, seq: 28, text: menu }, timer = 0;
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }), readFrame: async () => frame, readPolicy: () => policy,
    withWriteLock: async (_term, work) => work({ active: true }),
    sendKey: async (_tab, key, { guard }) => { assert.equal(guard(), true); writes.push(key); return { written: true }; },
    isComposer: f => f.text === 'composer', stopAll: () => assert.fail('not a process Stop'),
    publish: (_tab, event) => events.push(event),
    setTimer: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }, clearTimer: id => timers.delete(id),
  });
  return { owner, writes, events, timers, controller,
    paint(text = menu) { frame = { ...frame, seq: frame.seq + 1, text }; controller.observe('T', frame); },
    async expire() { const entry = [...timers.values()].find(t => t.ms === 3000); assert.ok(entry); await entry.fn(); await tick(); } };
}

test('unset or cleared preference is an actual immediately actionable manual Goal, no automatic key or timer', async () => {
  for (const configured of [undefined, null]) {
    assert.equal(resolveCodexResumeGoalPreference(undefined, configured), null);
    const h = fixture({ resumeGoal: configured }); h.paint(); await tick();
    assert.equal(h.controller.read('T').reason, 'user-choice-required');
    assert.deepEqual(h.controller.readGoalAction('T').availableActions, ['resume', 'leave-paused']);
    assert.equal(h.controller.readGoalAction('T').action, null, 'manual policy is not an invented wire action');
    assert.deepEqual(h.writes, []); assert.equal(h.timers.size, 0);
    const { operationId } = h.controller.readGoalAction('T');
    h.controller.applyGoalAction('T', { operationId, requestId: 'manual', action: 'resume' }); await tick();
    assert.deepEqual(h.writes, ['\r']); h.paint('composer');
    assert.equal(h.controller.readGoalAction('T', { requestId: 'manual' }).choiceConfirmed, true);
  }
});

test('explicit saved choices and history-only override retain their previous meaning', () => {
  assert.equal(resolveCodexResumeGoalPreference(undefined, true), true);
  assert.equal(resolveCodexResumeGoalPreference(undefined, false), false);
  assert.equal(resolveCodexResumeGoalPreference(false, true), false);
  assert.equal(resolveCodexResumeGoalPreference(true, null), true);
});

test('original same-frame gap emits one failure capture but never repeats Enter or grants recovery', async () => {
  const h = fixture({ resumeGoal: true }); h.paint(); await tick(); await h.expire();
  const state = h.controller.readGoalAction('T');
  assert.equal(state.status, 'unknown'); assert.equal(state.recoveryAvailable, false);
  assert.equal(h.controller.read('T').manualActionRequired, false, 'no guessed live menu / no Send renewal');
  assert.deepEqual(h.writes, ['\r']);
  const captures = h.events.filter(event => event.captureDiagnostic === true);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].reason, 'provider-result-unobserved');
  assert.equal(captures[0].operationId, state.operationId);
  assert.equal(captures[0].actionAttempted, true);
  assert.equal(captures[0].owner.inputRevision, 2);
  assert.equal(typeof captures[0].writeAttemptAt, 'number');
  assert.equal(typeof captures[0].writeReturnedAt, 'number');
  assert.ok(captures[0].writeReturnedAt >= captures[0].writeAttemptAt);
  const failed = h.controller.applyGoalAction('T', { operationId: state.operationId, requestId: 'not-replay', action: 'resume' });
  assert.equal(failed.accepted, false); assert.deepEqual(h.writes, ['\r']);
  h.paint(); await tick();
  assert.equal(h.events.filter(event => event.captureDiagnostic === true).length, 1, 'a later proven menu is not duplicate diagnosis');
  assert.equal(h.controller.readGoalAction('T').recoveryAvailable, true);
  h.paint('composer'); assert.equal(h.controller.readGoalAction('T').status, 'confirmed');
});

test('Main actual policy publication uses the existing diagnostic writer on the exact failed operation', async () => {
  const source = fs.readFileSync(base ? path.join(base, 'PRE-main.js') : path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('function getCodexRuntimePolicies('), end = source.indexOf('\nfunction publishCodexObservedRuntime(', start);
  assert.ok(start > 0 && end > start);
  const captures = [], wakes = [];
  let options;
  const context = { codexRuntimePolicies: null, codexLiveSettingsObserver: null,
    createCodexLiveSettingsObserver: () => ({}), createCodexRuntimePolicyController: value => { options = value; return {}; },
    captureCodexPolicyOwner() {}, withPtyWriteLock() {},
    console: { log() {}, warn() {} }, captureTerminalHistoryPreviewDiagnostic: payload => {
      captures.push(payload); return Promise.resolve({ incidentId: 'private' });
    }, publishCodexObservedRuntime() {}, resetCodexTuiReadyDetection() {},
    emitAgentReadinessChanged: (...args) => wakes.push(args), scheduleProjectActivityBroadcast() {},
  };
  vm.runInNewContext(source.slice(start, end) + '\ngetCodexRuntimePolicies()', context);
  options.publish('T', { type: 'resume-goal', phase: 'confirming', policy: 'resume',
    reason: 'provider-result-unobserved', operationId: 'exact-op', captureDiagnostic: true,
    actionWritten: true, actionAttempted: true, frameSeq: 28, owner: { inputRevision: 2 } });
  await tick(); assert.equal(captures.length, 1);
  assert.equal(captures[0].tabId, 'T'); assert.equal(captures[0].toolType, 'codex');
  assert.equal(captures[0].context.operationId, 'exact-op');
  assert.equal(captures[0].incidentReason, 'codex-goal-choice-failed');
  assert.equal(wakes.length, 1);
});

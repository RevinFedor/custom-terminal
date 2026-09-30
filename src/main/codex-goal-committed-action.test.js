'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('./codex-resume-goal-prompt');
const { selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');
const { inspectCodexInputReadyTextCore, parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
const runtimePolicies = require('./codex-runtime-policies');
const { createCodexLiveSettingsObserver } = require('./codex-live-settings');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const menu = 'Resume paused goal?\nGoal: continue the existing task\n› 1. Resume goal   Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';
function part(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }

function harness({ configured, override, screen = menu, usagePolicy } = {}) {
  const writes = [], microtasks = [], timers = [], clears = [];
  const state = { armedAt: 100, raw: '', allowedPromptTypes: new Set(['resume-goal']), firedTypes: new Set(), actionInFlightPrompt: null };
  const startup = new Map([['T', state]]), runtime = { input: 1, runSeq: 1, isRunning: true, screen };
  const term = { write(value) {
    assert.equal(state.firedTypes.has('resume-goal'), false, 'no fictional completion before the key'); writes.push(value);
    if (value === '\x1b[B' || value === '\x1b[A') {
      const selected = runtimePolicies.inspectCodexPolicyDialog(runtime.screen).selectedIndex;
      const next = selected + (value === '\x1b[B' ? 1 : -1);
      runtime.screen = runtime.screen.replace('› ', '  ').replace(new RegExp('  ' + next + '\\.'), '› ' + next + '.');
    }
  } };
  const mirror = { lastCommittedVisibleSnapshot: null, complete: true, writeSeq: 0, flushedSeq: 0 };
  const snapshotFor = (text, committed = true) => {
    mirror.writeSeq++; mirror.flushedSeq = mirror.writeSeq;
    const snapshot = { authoritativeFrameCommitted: committed, writeSeq: mirror.writeSeq, lines: text.split('\n').map(text => ({ text })) };
    mirror.lastCommittedVisibleSnapshot = snapshot;
    return snapshot;
  };
  const ctx = {
    ...policy, console: { log() {}, warn() {} }, Date: { now: () => 101 },
    codexStartupAutoEnter: startup,
    getHeadlessTerminalMirror: () => mirror,
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', runtime]]),
    getTerminalInputRevision: () => runtime.input,
    codexLastRunCommandPayload: new Map([['T', { resumePausedGoal: override }]]),
    projectManager: { db: { getAppState: key => key === 'codexResumePausedGoal' ? configured : usagePolicy } },
    CODEX_STARTUP_AUTO_ENTER_TTL_MS: 45000, CODEX_STARTUP_AUTO_ENTER_BUFFER_LIMIT: 20480,
    cleanCodexTuiFrame: value => value,
    readCodexAuthoritativeScreen: async () => ({ success: true, clean: runtime.screen, snapshot: snapshotFor(runtime.screen) }),
    queueMicrotask: fn => microtasks.push(fn), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    resetCodexTuiReadyDetection() {},
    clearCodexStartupAutoEnter: (tabId, reason) => { clears.push(reason); startup.delete(tabId); },
    waitForRender: () => Object.assign(Promise.resolve({ timedOut: false }), { markWriteTime() {} }),
    ...runtimePolicies, createCodexLiveSettingsObserver,
    getTerminalLifecycleGeneration: () => 'G', getCodexWriterProofSnapshot: () => null,
    getLiveAiRuntimeOwners: () => ['codex'], resolveAiToolOwner: () => 'codex', aiStoppingTabs: new Map(),
    codexTurnWatchers: new Map(),
    codexRuntimePolicies: null, codexLiveSettingsObserver: null,
    ...require('./codex-reserve-recovery'), providerStates: new Map(),
    getCodexModelEffortIntentRecord: () => null,
    pasteInflight: new WeakMap(), ptyWriteOwners: new WeakMap(), ptyActiveWriteOperation: new WeakMap(), ptyLastQueuedWriteOperation: new WeakMap(),
    captureCodexFrame: async () => ({}),
    inspectCodexInputReadyVisibleText: (_text, source, { lines }) => inspectCodexInputReadyTextCore(
      selectCodexCurrentInteractiveFrameText(lines), '', { requireSyncMarker: false, requireInitializedComposer: true, source }),
    parseCodexVerifiedComposerFooter,
    publishCodexRuntimeProjection: () => ({ sessionStatus: 'starting' }), _webBroadcast() {},
    scheduleProjectActivityBroadcast() {}, emitAgentReadinessChanged() {}, mainWindow: null,
    markCodexTuiReadyAfterVerifiedComposer: async () => true,
    stopAiProcessInTabSerialized: async (_tab, options) => {
      assert.equal(options.toolType, 'codex'); assert.equal(options.stopReason, 'manual-stop');
      assert.equal(options.preSignalGuard().allowed, true);
      clears.push('common-stop'); return { success: true };
    },
  };
  const code = part('function observeCodexStartupGoalCommittedFrame(', 'function getCodexLateMcpRecoveryIdentity(')
    + part('function detectCodexStartupAutoEnterPrompt(', 'function normalizeCodexPickerValue(')
    + part('function withPtyWriteLock(', 'function markActivePtySubmit(');
  const api = vm.runInNewContext(code + '\n({observeCodexStartupGoalCommittedFrame,tryHandleCodexStartupAutoEnter,getCodexRuntimePolicies})', ctx);
  return {
    state, writes, timers, clears, runtime,
    raw: () => api.tryHandleCodexStartupAutoEnter('T', menu),
    frame(text = menu, committed = true) {
      const snapshot = snapshotFor(text, committed);
      api.observeCodexStartupGoalCommittedFrame('T', mirror, snapshot);
    },
    policy: () => api.getCodexRuntimePolicies().read('T'),
    liveSettings: () => ctx.codexLiveSettingsObserver?.read('T'),
    async drain() { while (microtasks.length) await microtasks.shift()(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('raw goal announcement never writes; one completed frame selects Resume exactly once without a delay', async () => {
  const h = harness(); h.raw(); await h.drain(); assert.deepEqual(h.writes, []);
  h.frame(menu, false); await h.drain(); assert.deepEqual(h.writes, []);
  h.frame(); h.frame(); await h.drain(); h.frame(); await h.drain();
  assert.deepEqual(h.writes, ['\r']);
  assert.equal(h.timers.length, 0);
  assert.equal(h.state.firedTypes.has('resume-goal'), false, 'old startup handler is no longer a second owner');
  assert.equal(h.policy().phase, 'confirming', 'key write alone is not completion');
});

test('29Sep footer uses the same committed policy and preserves both saved choices', async () => {
  const compact = menu.replace('Press enter to confirm or esc to go back', 'enter select · esc back');
  for (const configured of [true, false]) {
    const h = harness({ configured, screen: compact });
    h.frame(compact, false); await h.drain(); assert.deepEqual(h.writes, []);
    h.frame(compact); await h.drain();
    assert.deepEqual(h.writes, configured ? ['\r'] : ['\x1b[B', '\r']);
    assert.equal(h.policy().phase, 'confirming');
    h.frame(h.runtime.screen); await h.drain();
    assert.deepEqual(h.writes, configured ? ['\r'] : ['\x1b[B', '\r'], 'no second Enter for an unchanged modal');
  }
});

test('actual main adapter selects only quota fallback through its real PTY lock, or delegates Stop-all without keys', async () => {
  const usage = 'You’re now using Luna, a faster model for simpler tasks.\n› 1. Add Credits\n  2. Reset usage\n  3. Continue with Luna Reserve\nPress enter to confirm or esc to continue working';
  const h = harness({ screen: usage }); h.frame(usage); await h.drain();
  assert.deepEqual(h.writes, ['\x1b[B', '\x1b[B', '\r']);
  assert.equal(h.policy().type, 'usage-exhaustion');
  for (const model of ['gpt-reserve', 'gpt-5.6-sol', 'gpt-6-astra']) {
    h.runtime.screen = '› Ask Codex to do anything\n' + model + ' max · Context 42% used';
    h.frame(h.runtime.screen); await h.drain();
    assert.equal(h.liveSettings().model, model);
    assert.equal(h.policy(), null);
  }
  const stop = harness({ screen: usage, usagePolicy: 'stop-all' }); stop.frame(usage); await stop.drain();
  assert.deepEqual(stop.writes, []); assert.deepEqual(stop.clears, ['common-stop']);
});

test('the actual reported repaint race does not consume the unwritten step', async () => {
  const h = harness({ screen: 'Resuming session…' });
  h.frame(); await h.drain();
  assert.deepEqual(h.writes, []);
  assert.equal(h.state.firedTypes.has('resume-goal'), false);
  assert.equal(h.state.actionInFlightPrompt, null);
  assert.deepEqual(h.clears, []);
  h.runtime.screen = menu;
  h.frame(); await h.drain();
  assert.deepEqual(h.writes, ['\r']);
});

test('global Leave paused and explicit record-context override use guarded selection, without changing model defaults', async () => {
  for (const options of [{ configured: false }, { configured: true, override: false }]) {
    const h = harness(options); h.frame(); await h.drain();
    assert.deepEqual(h.writes, ['\x1b[B', '\r']);
  }
  const h = harness({ configured: false, override: true }); h.frame(); await h.drain();
  assert.deepEqual(h.writes, ['\r']);
});

test('manual input after the observed frame cancels instead of selecting or sending', async () => {
  const h = harness(); h.frame(); h.runtime.input++; await h.drain();
  assert.deepEqual(h.writes, []);
  assert.equal(h.policy().reason, 'input-owner-changed');
});

test('wrapped goal labels/footer remain a current modal, while an old dialog above a composer does not', () => {
  const wrapped = menu.replace('Resume paused goal?', 'Resume paused\ngoal?')
    .replace('1. Resume goal', '1. Resume\ngoal').replace('confirm or esc', 'confirm\nor esc');
  assert.equal(policy.inspectCodexResumeGoalPrompt(wrapped).canAutoEnter, true);
  const current = selectCodexCurrentInteractiveFrameText('old output\n' + wrapped);
  assert.ok(current.startsWith('Resume paused'));
  const inactive = selectCodexCurrentInteractiveFrameText(menu + '\n\n› Ask Codex to do anything\ngpt-5.6-luna low · Context 1% used');
  assert.equal(inactive.includes('Resume paused goal?'), false);
  assert.equal(policy.inspectCodexResumeGoalPrompt('› Ask Codex to do anything').visible, false);
});

test('preference defaults to Resume and explicit operation policy wins', () => {
  assert.equal(policy.resolveCodexResumeGoalPreference(undefined, undefined), true);
  assert.equal(policy.resolveCodexResumeGoalPreference(undefined, false), false);
  assert.equal(policy.resolveCodexResumeGoalPreference(false, true), false);
  assert.equal(policy.resolveCodexResumeGoalPreference(true, false), true);
});

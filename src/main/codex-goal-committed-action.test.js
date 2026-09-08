'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('./codex-resume-goal-prompt');
const { selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const menu = 'Resume paused goal?\nGoal: continue the existing task\n› 1. Resume goal   Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\nPress enter to confirm or esc to go back';
function part(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }

function harness({ configured, override, screen = menu } = {}) {
  const writes = [], microtasks = [], timers = [], clears = [];
  const state = { armedAt: 100, raw: '', allowedPromptTypes: new Set(['resume-goal']), firedTypes: new Set(), actionInFlightPrompt: null };
  const startup = new Map([['T', state]]), runtime = { input: 1, runSeq: 1, screen };
  const term = { write(value) { assert.equal(state.firedTypes.has('resume-goal'), false, 'no fictional completion before the key'); writes.push(value); if (value === '\x1b[B') runtime.screen = menu.replace('› 1.', '  1.').replace('  2.', '› 2.'); } };
  const mirror = { lastCommittedVisibleSnapshot: null };
  const ctx = {
    ...policy, console: { log() {}, warn() {} }, Date: { now: () => 101 },
    codexStartupAutoEnter: startup,
    getHeadlessTerminalMirror: () => mirror,
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', runtime]]),
    getTerminalInputRevision: () => runtime.input,
    codexLastRunCommandPayload: new Map([['T', { resumePausedGoal: override }]]),
    projectManager: { db: { getAppState: () => configured } },
    CODEX_STARTUP_AUTO_ENTER_TTL_MS: 45000, CODEX_STARTUP_AUTO_ENTER_BUFFER_LIMIT: 20480,
    cleanCodexTuiFrame: value => value,
    readCodexAuthoritativeScreen: async () => ({ success: true, clean: runtime.screen }),
    queueMicrotask: fn => microtasks.push(fn), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    resetCodexTuiReadyDetection() {},
    clearCodexStartupAutoEnter: (tabId, reason) => { clears.push(reason); startup.delete(tabId); },
    waitForRender: () => Object.assign(Promise.resolve({ timedOut: false }), { markWriteTime() {} }),
  };
  const code = part('function observeCodexStartupGoalCommittedFrame(', 'function getCodexLateMcpRecoveryIdentity(')
    + part('function detectCodexStartupAutoEnterPrompt(', 'function normalizeCodexPickerValue(');
  const api = vm.runInNewContext(code + '\n({observeCodexStartupGoalCommittedFrame,tryHandleCodexStartupAutoEnter})', ctx);
  return {
    state, writes, timers, clears, runtime,
    raw: () => api.tryHandleCodexStartupAutoEnter('T', menu),
    frame(text = menu, committed = true) {
      const snapshot = { authoritativeFrameCommitted: committed, lines: text.split('\n').map(text => ({ text })) };
      mirror.lastCommittedVisibleSnapshot = snapshot;
      api.observeCodexStartupGoalCommittedFrame('T', mirror, snapshot);
    },
    async drain() { while (microtasks.length) await microtasks.shift()(); },
  };
}

test('raw goal announcement never writes; one completed frame selects Resume exactly once without a delay', async () => {
  const h = harness(); h.raw(); await h.drain(); assert.deepEqual(h.writes, []);
  h.frame(menu, false); await h.drain(); assert.deepEqual(h.writes, []);
  h.frame(); h.frame(); await h.drain(); h.frame(); await h.drain();
  assert.deepEqual(h.writes, ['\r']);
  assert.equal(h.timers.length, 0);
  assert.equal(h.state.firedTypes.has('resume-goal'), true);
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
  assert.ok(h.clears.includes('resume-goal-input-changed'));
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

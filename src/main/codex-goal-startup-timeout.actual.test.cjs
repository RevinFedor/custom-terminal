'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { createCodexRuntimePolicyController } = require('./codex-runtime-policies');
const { shouldSurfaceCodexStartupTimeout } = require('./codex-runtime-contract');
const { createInputPreparation } = require('./agent-send-preparation');
const { inspectCodexInputReadyTextCore, parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
const source = fs.readFileSync(process.env.NOTED_GOAL_STARTUP_MAIN_SOURCE || __dirname + '/main.js', 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['hasCodexPolicyInitializedComposer', 'getCodexStartupNoStateTimeout', 'maybeSurfaceCodexStartupNoStateTimeout'];
const declarations = names.map(name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name))
  .filter(Boolean).map(n => n.getText(ast)).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const menu = 'Resume paused goal?\nGoal: fixture\n> 1. Resume goal Mark it active and continue when idle\n  2. Leave paused Keep it paused; use /goal resume later\nenter select · esc back';
// Exact bottom-band text from f9457601, no historical conversation body.
const composer = '› Ask Codex to do anything\n \n  GPT-6.1-Sol max · C… Goal paused (/goal resume)    ⚠ 1 warning · f2 to view\n';

function fixture() {
  const owner = { terminal: {}, live: true, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 0 };
  const writes = [], reports = [], events = [], pending = new Map([['T', { launchId: 'L', startedAt: 1000 }]]);
  const ready = new Set(), failureTabs = new Set(), failures = new Map();
  const clock = { now: 1_346_612 };
  let seq = 28, frame = { valid: true, seq, text: menu };
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }), readFrame: async () => frame, readPolicy: () => ({ resumeGoal: null }),
    withWriteLock: async (_term, work) => work({ active: true }),
    sendKey: async (_tab, key, { guard }) => { assert.equal(guard(), true); writes.push(key); return { written: true }; },
    isComposer: f => inspectCodexInputReadyTextCore(f.text, '', { requireSyncMarker: false,
      requireInitializedComposer: true }).ready === true && !!parseCodexVerifiedComposerFooter(f.text),
    stopAll: () => assert.fail('not process Stop'),
    publish() {}, setTimer: () => 1, clearTimer() {}, now: () => clock.now,
  });
  const ctx = vm.createContext({ codexRuntimePolicies: controller, codexLastRunCommandPayload: pending,
    codexTuiReadyTabs: ready, codexTuiReadyLastNotReady: failures, codexStartupNoStateTimeoutTabs: failureTabs,
    codexStartupAutoEnter: new Map(), codexManualActionRequired: new Map(), Date: { now: () => clock.now },
    shouldSurfaceCodexStartupTimeout, CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000,
    getCodexLiveInputControl: () => null, getCodexMcpStartupStatus: () => null,
    hasCodexPromptOrTurnInFlight: () => false, clearCodexLaunchAcceptancePending() {},
    clearCodexStartupNoStateTimeoutTimer() {}, reportTerminalIncident: (...args) => reports.push(args),
    getCodexRuntimeSessionId: () => 'S', getCodexPublicWriterFields: () => ({ writerConfirmed: false }),
    _webBroadcast: (...args) => events.push(args), emitCodexTuiNotReadyState: (...args) => events.push(args),
    console: { warn() {}, log() {} },
  });
  vm.runInContext(declarations, ctx);
  const paint = (text = menu) => { frame = { valid: true, seq: ++seq, text }; controller.observe('T', frame); };
  return { ctx, controller, owner, writes, reports, events, pending, ready, failures, failureTabs, clock, paint,
    timeout: () => ctx.getCodexStartupNoStateTimeout('T'),
    surface: status => ctx.maybeSurfaceCodexStartupNoStateTimeout('T', status),
    async choose() { paint(); const { operationId } = controller.readGoalAction('T');
      controller.applyGoalAction('T', { operationId, requestId: 'exact-choice', action: 'resume' }); await tick(); },
  };
}

test('actual handled Goal composer bridges the pending process-ready await without the old22-minute startup error', async () => {
  const h = fixture(); await h.choose();
  assert.equal(h.timeout(), null, 'the live Goal action has its own outcome');
  h.paint(composer); assert.equal(h.controller.read('T'), null);
  assert.equal(h.controller.readGoalAction('T').choiceConfirmed, true);
  assert.equal(h.timeout(), null, 'a synchronous committed UI proof precedes async process-ready commit');
  assert.deepEqual(h.writes, ['\r']);
  assert.equal(h.ready.size, 0, 'no readiness or writer authority invented');
  assert.equal(h.pending.get('T').startedAt, 1000, 'no startup or Send deadline renewed');
  const preparation = createInputPreparation(61000, () => null, () => h.clock.now);
  assert.equal(preparation.failure().code, 'agent_send_preparation_expired');
});

test('a stale captured timeout cannot publish error/incident after current Goal composer proof', async () => {
  const h = fixture(), old = h.timeout(); assert.ok(old);
  await h.choose(); h.paint(composer); h.surface(old);
  assert.equal(h.reports.length, 0); assert.equal(h.events.length, 0);
  assert.equal(h.failureTabs.size, 0); assert.equal(h.failures.size, 0);
});

test('raw/manual input can prove initialized UI without falsely confirming the earlier automatic Goal choice', async () => {
  const h = fixture(); await h.choose(); h.owner.inputRevision++; h.paint(composer);
  const choice = h.controller.readGoalAction('T');
  assert.equal(choice.choiceConfirmed, false); assert.equal(choice.status, 'unknown');
  assert.equal(h.timeout(), null, 'startup UI initialization is not choice/delivery proof');
  assert.deepEqual(h.writes, ['\r']); assert.equal(h.ready.size, 0);
});

for (const field of ['terminal', 'lifecycleGeneration', 'runSeq', 'live']) test('old Goal UI proof cannot mask a different owner: ' + field, async () => {
  const h = fixture(); await h.choose(); h.paint(composer);
  h.owner[field] = field === 'terminal' ? {} : field === 'live' ? false : 'changed';
  const status = h.timeout(); assert.ok(status); h.surface(status);
  assert.equal(h.reports.length, 1); assert.equal(h.events.length, 2);
});

test('ordinary uninitialized startup still produces the same real timeout diagnostic', () => {
  const h = fixture(), status = h.timeout(); assert.equal(status.reason, 'startup-timeout:no-ready-signal');
  h.surface(status); assert.equal(h.reports.length, 1); assert.equal(h.failureTabs.has('T'), true);
});

for (const change of [{ phase: 'confirming' }, { currentOperation: false }, { runtimeLive: false },
  { resultFrameSeq: 28 }, { resultFrameSeq: null }, { resultFrameSeq: 29.5 },
  { reason: 'current-turn-operational:turn', resultFrameSeq: null }]) {
  test('no suppression from key/partial/stale/operational-only metadata: ' + JSON.stringify(change), () => {
    const h = fixture(); h.ctx.codexRuntimePolicies = { read: () => null, readGoalAction: () => ({
      phase: 'handled', currentOperation: true, runtimeLive: true, initialFrameSeq: 28, frameSeq: 29, resultFrameSeq: 29,
      reason: 'committed-composer', actionWritten: true, ...change }) };
    assert.ok(h.timeout());
  });
}

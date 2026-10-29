'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { createCodexRuntimePolicyController, inspectCodexPolicyDialog } = require('./codex-runtime-policies');
const { parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
const goal = 'Resume paused goal?\nGoal: private cold restore fixture\n> 1. Resume goal Mark it active and continue when idle\n  2. Leave paused Keep it paused; use /goal resume later\nenter select · esc back';
const selected = goal.replace('> 1.', '  1.').replace('  2.', '> 2.');
const composer = '> Ask Codex to do anything\ngpt-6.1-sol max · Context 42% used';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const owner = { terminal: {}, lifecycleGeneration: 'G', runSeq: 4, inputRevision: 103, live: true };
  let frame = { valid: true, seq: 24387, text: goal }, now = 1000;
  const writes = [], publications = [], timers = new Map(); let id = 0;
  const controller = createCodexRuntimePolicyController({
    capture: () => ({ ...owner }), readFrame: async () => frame,
    readPolicy: () => ({ resumeGoal: false, actionDeadlineAt: 61000 }),
    withWriteLock: async (_term, work) => work({ active: true }),
    sendKey: async (_tab, key, { guard }) => { assert.equal(guard(), true); writes.push(key); return { written: true }; },
    isComposer: f => !!parseCodexVerifiedComposerFooter(f.text),
    stopAll: () => assert.fail('Goal selection is not process Stop'),
    publish: (_tab, value) => publications.push(value), now: () => now,
    setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; },
    clearTimer: key => timers.delete(key),
  });
  return { owner, writes, controller, publications, timers, setTime: value => { now = value; },
    paint(text = frame.text, extra = {}) { frame = { ...frame, seq: frame.seq + 1, text, ...extra }; controller.observe('T', frame); },
    get frame() { return frame; } };
}

test('actual policy keeps one written navigation pending after old2s frame checkpoint; late selected frame resumes without a second arrow', async () => {
  const h = fixture(); h.paint(); await tick();
  assert.deepEqual(h.writes, ['\x1b[B']);
  assert.equal(h.controller.readGoalAction('T').status, 'pending');
  assert.equal(h.controller.readGoalAction('T').phase, 'awaiting-selection');
  assert.equal(h.publications.some(p => p.captureDiagnostic), false);
  h.paint(goal, { valid: false }); h.paint(goal, { valid: true }); await tick();
  assert.deepEqual(h.writes, ['\x1b[B']);
  assert.equal(h.controller.readGoalAction('T').status, 'pending', 'redraw still showing old selection is not a second key grant');
  h.paint(selected); await tick();
  assert.deepEqual(h.writes, ['\x1b[B', '\r'], JSON.stringify(h.controller.readGoalAction('T')));
  assert.equal(h.controller.readGoalAction('T').choiceConfirmed, false);
  h.paint(composer); await tick();
  assert.equal(h.controller.readGoalAction('T').choiceConfirmed, true);
  h.paint(composer); await tick(); assert.deepEqual(h.writes, ['\x1b[B', '\r']);
});

for (const field of ['terminal', 'lifecycleGeneration', 'runSeq', 'inputRevision', 'live']) {
  test('late selection cannot write Enter after current owner changes: ' + field, async () => {
    const h = fixture(); h.paint(); await tick();
    h.owner[field] = field === 'terminal' ? {} : field === 'live' ? false : 'changed';
    // An OLD operation cannot consume a new owner's frame. Main would attach
    // owner provenance before admitting a separate NEW launch observation.
    h.paint(selected, { valid: false }); await tick(); assert.deepEqual(h.writes, ['\x1b[B']);
    assert.equal(h.controller.readGoalAction('T').choiceConfirmed, false);
  });
}

test('cold navigation uses only remaining original launch lifetime, never renews on redraw', async () => {
  const h = fixture(); h.setTime(51000); h.paint(); await tick();
  const timer = [...h.timers.values()].find(value => value.ms === 10000);
  assert.ok(timer);
  h.paint(goal); h.paint(goal); await tick();
  assert.equal(h.timers.size, 1);
  h.setTime(61000); await timer.fn(); await tick();
  assert.equal(h.controller.readGoalAction('T').phase, 'manual');
  assert.equal(h.controller.readGoalAction('T').reason, 'policy-action-deadline');
  h.paint(selected); await tick(); assert.deepEqual(h.writes, ['\x1b[B']);
});

test('cold policy does not replace original remaining60s by an early10s choice timer', async () => {
  const h = fixture(); h.paint(); await tick();
  assert.deepEqual([...h.timers.values()].map(t => t.ms), [60000]);
});

test('same Main launch preference defaults unattended MCP to Leave paused, retains saved choice and explicit override', () => {
  const source = fs.readFileSync(__dirname + '/main.js', 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'resolveCodexLaunchGoalPreference');
  assert.ok(node, 'actual Main launch preference port');
  const records = new Map(); let configured = null;
  const context = vm.createContext({ ...require('./codex-resume-goal-prompt'),
    agentSendReceiptStore: { get: key => records.get(key) },
    projectManager: { db: { getAppState: () => configured } } });
  vm.runInContext(node.getText(ast), context);
  const read = payload => context.resolveCodexLaunchGoalPreference('T', payload);
  assert.equal(read({}), null, 'desktop manual remains manual');
  assert.equal(read({ goalChoiceContext: 'terminal-mcp' }), false);
  configured = true; assert.equal(read({ goalChoiceContext: 'terminal-mcp' }), true);
  configured = false; assert.equal(read({ goalChoiceContext: 'terminal-mcp', resumePausedGoal: true }), true);
  configured = null;
  for (const surface of ['project-api', 'orchestration', 'tab-message']) {
    records.set('O', { tabId: 'T', attemptId: 'A', provider: 'codex', surface });
    assert.equal(read({ sendOperationKey: 'O', sendAttemptId: 'A' }), false);
    assert.equal(read({ sendOperationKey: 'O', sendAttemptId: 'foreign' }), null);
  }
  records.set('O', { tabId: 'T', attemptId: 'A', provider: 'codex', surface: 'desktop-history' });
  assert.equal(read({ sendOperationKey: 'O', sendAttemptId: 'A' }), null);
  records.set('O', { tabId: 'other', attemptId: 'A', provider: 'codex', surface: 'orchestration' });
  assert.equal(read({ sendOperationKey: 'O', sendAttemptId: 'A' }), null);
});

test('actual Main cold Goal deadline uses exact physical launch, not an older/source SID or new time', () => {
  const source = fs.readFileSync(__dirname + '/main.js', 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'readCodexGoalLaunchDeadline');
  assert.ok(node);
  const terminal = {}, owner = { live: true, terminal, runSeq: 4, lifecycleGeneration: 'G' };
  let initialized = false;
  const launch = { launchId: 'L', startedAt: 1000, terminalToken: terminal, runSeq: 4, lifecycleGeneration: 'G' };
  const context = vm.createContext({ codexLastRunCommandPayload: new Map([['T', launch]]),
    captureCodexPolicyOwner: () => owner, hasCodexEstablishedComposerLifecycle: () => initialized,
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000 });
  vm.runInContext(node.getText(ast), context);
  assert.equal(context.readCodexGoalLaunchDeadline('T'), 61000);
  for (const [key, value] of [['terminalToken', {}], ['runSeq', 5], ['lifecycleGeneration', 'other'], ['startedAt', 0], ['launchId', null]]) {
    const old = launch[key]; launch[key] = value;
    assert.equal(context.readCodexGoalLaunchDeadline('T'), null, key); launch[key] = old;
  }
  initialized = true; assert.equal(context.readCodexGoalLaunchDeadline('T'), null, 'warm owner must not inherit an old retained startup clock');
  initialized = false; owner.live = false; assert.equal(context.readCodexGoalLaunchDeadline('T'), null);
});

test('actual MCP start handler supplies unattended context and Main launch snapshots the same policy', () => {
  const source = fs.readFileSync(__dirname + '/main.js', 'utf8');
  const route = source.slice(source.indexOf("req.url === '/terminal/ai-start'"), source.indexOf("req.url === '/terminal/create'"));
  const codex = route.slice(route.indexOf("if (engine === 'codex')"), route.indexOf("else if (engine === 'claude')"));
  assert.match(codex, /runCodexCommandFromPayload[\s\S]*goalChoiceContext: 'terminal-mcp'/);
  assert.match(codex, /waitForMainAgentStartReady/);
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const runner = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runCodexCommandFromPayloadInner');
  assert.match(runner.getText(ast), /resumePausedGoal: resolveCodexLaunchGoalPreference\(tabId, payload\)/);
});

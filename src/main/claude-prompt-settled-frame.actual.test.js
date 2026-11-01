'use strict';

// The Claude prompt-stability proof used to run only at the END of a
// synchronized-output frame. Claude does not always paint its last frame that
// way. Production 2026-10-31 (tabs 6d6fd1718b66, 029152fbe588, 2efc9b9b7a35):
// a resumed launch printed the 5-hour usage-limit notice outside a
// synchronized pair and then sat at an idle composer. Every input of the proof
// was already satisfied — the real composer parser reads that screen as
// `absent`, sync closed, writeSeq == flushedSeq == 330 — yet nothing ever ran
// the proof:
//   17:13:29.304  [StartupTx] step-start phase=model command="/model claude-opus-5[1m]"
//   (nothing else — no prompt-stability, no paste, the gate stays `pending`)
// so the tab showed "Configuring claude…" forever and the Run After send that
// launched it waited on the gate until the user gave up.
//
// These tests run the REAL functions out of main.js with only their
// collaborators replaced, plus the real composer parser and the real registry.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const { createClaudePromptStabilityRegistry } = require('./claude-prompt-stability');
const { parseClaudeComposerCurrentFrame } = require('./claude-composer-proof');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = (name) => ast.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  .getText(ast);
const constant = (name) => ast.statements
  .find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((d) => d.name.getText(ast) === name))
  .getText(ast);

const TAB = 'tab-9b788f9d-6847-4b56-a44c-6d6fd1718b66';
const GEN = 'claude-launch-7';

// The exact stuck screen, captured by production diagnostic d74a44f4
// (headless mirror, writeSeq == flushedSeq == 330, sync closed). The parser
// reads line geometry and styles, so a hand-typed copy is not equivalent.
const STUCK = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/claude-usage-limit-idle-composer.json'), 'utf8'));

function harness({ lines: screenLines = STUCK.lines, turnBusy = false, stopping = false,
  sync = false, flushed = 330, written = 330, dialog = false } = {}) {
  const timers = [];
  const logs = [];
  const registry = createClaudePromptStabilityRegistry({
    log: (line) => logs.push(line),
    // The production 45s silence deadline must not be what resolves this test.
    timeoutMs: 0,
  });
  const state = {
    failed: false, writeSeq: written, flushedSeq: flushed,
    redrawTrace: { synchronizedOutputOpen: sync },
  };
  const lines = dialog
    ? [{ row: 0, text: 'Switch model?', wrapped: false }, ...screenLines]
    : screenLines;
  const ctx = vm.createContext({
    console: { log: (line) => logs.push(line), warn() {} },
    claudePromptStability: registry,
    claudeLaunchGenerationByTab: new Map([[TAB, { generation: GEN }]]),
    getHeadlessTerminalMirror: () => state,
    claudeTurnBusy: new Map(turnBusy ? [[TAB, true]] : []),
    aiStoppingTabs: new Map(stopping ? [[TAB, { toolType: 'claude' }]] : []),
    getHeadlessVisibleBufferSnapshot: () => ({
      ...STUCK, success: true, source: 'headless-main', synchronizedOutputOpen: sync,
      writeSeq: written, flushedSeq: flushed, lines,
    }),
    claudeTrustFolderPromptHintTabs: new Set(),
    claudeAutoModeDefaultPromptHintTabs: new Set(),
    inspectClaudeTrustFolderPromptSnapshot: () => ({ visible: false }),
    inspectClaudeAutoModeDefaultPromptSnapshot: () => ({ visible: false }),
    looksLikeClaudeTrustFolderPromptText: () => false,
    looksLikeClaudeAutoModeDefaultPromptText: () => false,
    stripVTControlCharacters: require('node:util').stripVTControlCharacters,
    parseClaudeComposerCurrentFrame,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext([
    constant('CLAUDE_SETTLED_FRAME_DEBOUNCE_MS'),
    // The REAL heuristic: a stub here hid that the usage-limit screen matched it.
    declaration('looksLikeClaudeRewindMenuText'),
    declaration('observeClaudeSynchronizedFrameFlushed'),
    declaration('scheduleClaudeSettledFrameObservation'),
  ].join('\n'), ctx);
  return { ctx, registry, state, timers, logs };
}

function waitForPrompt(registry) {
  registry.open(TAB, GEN, 'claude-run-command-resume');
  let settled = null;
  registry.wait(TAB, GEN).then((result) => { settled = result; });
  return () => settled;
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test('the real parser reads the stuck screen as a proven empty composer', () => {
  const proof = parseClaudeComposerCurrentFrame({ ...STUCK, success: true });
  assert.equal(proof.proofOutcome, 'absent',
    'every input of the readiness proof was already satisfied in production');
});

test('a composer painted outside a synchronized frame is proven once output settles', async () => {
  const { ctx, registry, state, timers, logs } = harness();
  const result = waitForPrompt(registry);

  // An ordinary flush — the usage-limit notice — not a synchronized-frame end.
  ctx.scheduleClaudeSettledFrameObservation(TAB, state);
  assert.equal(timers.length, 1, 'the proof waits for the output burst to end');
  assert.equal(timers[0].ms, 300, 'a debounce, not a readiness timeout');
  timers[0].fn();
  await flushPromises();

  const settled = result();
  assert.ok(settled, 'the startup transaction is released instead of hanging');
  assert.equal(settled.ready, true);
  assert.match(settled.reason, /^settled-composer-frame:330$/);
  assert.ok(settled.lease, 'a real lease, so /model is still validated at paste time');
  assert.ok(logs.some((line) => /settled-output .* outcome=marked/.test(line)),
    'the decision is logged');
});

test('nothing is done when no startup transaction is waiting', () => {
  const { ctx, registry, state, timers } = harness();
  registry.open(TAB, GEN, 'claude-run-command-resume');
  // Open but nobody waits: ordinary output must not cost a snapshot parse.
  ctx.scheduleClaudeSettledFrameObservation(TAB, state);
  assert.equal(timers.length, 0);
  // No registry entry at all (Codex, shell, closed tab): also nothing.
  const other = harness();
  other.ctx.scheduleClaudeSettledFrameObservation('tab-other', other.state);
  assert.equal(other.timers.length, 0);
});

test('an already stable prompt is never re-stamped (an outstanding lease stays valid)', async () => {
  const { ctx, registry, state, timers } = harness();
  registry.open(TAB, GEN, 'launch');
  registry.markStable(TAB, GEN, 'current-composer-frame:300');
  const lease = registry.snapshot(TAB).result.lease;
  // A later ordinary flush while the prompt is stable and nobody waits.
  ctx.scheduleClaudeSettledFrameObservation(TAB, state);
  assert.equal(timers.length, 0);
  assert.equal(registry.validate(TAB, GEN, lease).valid, true,
    'the transaction holding this lease can still paste');
});

test('every existing refusal of the proof still holds on the settled path', async () => {
  for (const [label, options, reason] of [
    ['turn running', { turnBusy: true }, 'turn-busy'],
    ['stopping', { stopping: true }, 'stopping'],
    ['sync frame still open', { sync: true }, 'sync-frame-open'],
    ['bytes not flushed yet', { written: 331, flushed: 330 }, 'output-not-flushed'],
    // Claude draws the model confirmation IN PLACE of the composer.
    ['model dialog on screen', { lines: ['Switch model?', '',
      '❯ 1. Yes, switch to Opus 5', '  2. No, keep the current model', '',
      'Enter to confirm · Esc to cancel'].map((text, row) => ({ row, text, wrapped: false })) },
      'dialog-visible'],
    ['no composer on screen', { lines: [{ row: 0, text: 'Welcome to Claude Code', wrapped: false },
      { row: 1, text: 'Loading…', wrapped: false }] }, 'composer-not-proven'],
  ]) {
    const { ctx, registry, state, timers, logs } = harness(options);
    const result = waitForPrompt(registry);
    ctx.scheduleClaudeSettledFrameObservation(TAB, state);
    assert.equal(timers.length, 1, label);
    timers[0].fn();
    await flushPromises();
    assert.equal(result(), null, label + ': must not release the transaction');
    assert.equal(registry.snapshot(TAB).ready, false, label);
    assert.ok(logs.some((line) => line.includes('outcome=' + reason)),
      label + ': the refusal is explained in the log (' + reason + ')');
  }
});

test('history text above a proven composer is not mistaken for an active dialog', async () => {
  // Production 2026-11-01, tab 6d6fd1718b66, after the fix above: the proof now
  // ran, but answered dialog-visible on every frame. The usage-limit notice
  // "…continuing automatically at 11:10pm · esc to cancel" plus the idle "❯"
  // matched the Rewind-menu heuristic over the whole viewport.
  const ctxOnly = harness();
  assert.equal(ctxOnly.ctx.looksLikeClaudeRewindMenuText(
    STUCK.lines.map((line) => line.text || '').join('\n')), true,
    'the whole stuck viewport does match the heuristic (that was the bug)');
  const { ctx, registry, state, timers } = harness();
  const result = waitForPrompt(registry);
  ctx.scheduleClaudeSettledFrameObservation(TAB, state);
  timers[0].fn();
  await flushPromises();
  assert.equal(result()?.ready, true, 'the proven composer region holds no dialog');
});

test('a real Rewind menu (no composer) still refuses the prompt', async () => {
  const rewindMenu = [
    'Rewind conversation',
    '',
    '❯ 1. Fix the startup hang',
    '  2. Earlier prompt',
    '',
    'Enter to continue · Esc to cancel',
  ].map((text, row) => ({ row, text, wrapped: false }));
  const { ctx, registry, state, timers, logs } = harness({ lines: rewindMenu });
  const result = waitForPrompt(registry);
  ctx.scheduleClaudeSettledFrameObservation(TAB, state);
  timers[0].fn();
  await flushPromises();
  assert.equal(result(), null, 'no /model may be written over a Rewind menu');
  assert.ok(logs.some((line) => line.includes('outcome=dialog-visible')));
});

test('the synchronized-frame path is unchanged and the settled path is wired to ordinary flushes', () => {
  assert.ok(main.includes(`if (meta?.synchronizedFrameEnd === true) {
            observeClaudeSynchronizedFrameFlushed(tabId, state, seq);
          } else {
            scheduleClaudeSettledFrameObservation(tabId, state);
          }`), 'ordinary flushes schedule the settled-output proof');
  // Disposal cancels a pending observation instead of letting it fire later.
  const dispose = declaration('disposeHeadlessTerminalMirror');
  assert.ok(dispose.includes('clearTimeout(state.claudeSettledFrameTimer)'));
});

'use strict';

// Codex pins the raw PTY byte window at the exact moment a control action
// fails. A Claude setting had no such capture, so the log kept only a short
// `error=` line and these two outcomes looked identical afterwards:
//
//   /model claude-opus-5[1m]  -> API error: 429 ... · model not changed
//   /model claude-opus-5[1m]  -> Set model to Opus 5 and saved as your default
//
// Observed on 2026-10-31 for tab 2efc9b9b7a35: two 429 refusals, then the same
// command succeeded. Reconstructing that needed scattered lines from four
// different log tags. This capture is observation only: it pins an
// already-recorded window and must never write input, retry a command or
// settle a receipt.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const {
  isClaudeStartupSettingUndelivered,
} = require('../shared/claude-startup-failure.cjs');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = (name) => ast.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  .getText(ast);

// The real function from main.js, with only its collaborators replaced.
function harness() {
  const reports = [];
  const warnings = [];
  const ctx = vm.createContext({
    isClaudeStartupSettingUndelivered,
    reportTerminalIncident: (key, payload) => {
      reports.push({ key, payload });
      return Promise.resolve({ success: true });
    },
    console: { warn: (...args) => warnings.push(args.join(' ')), log() {} },
  });
  vm.runInContext(declaration('captureClaudeSettingFailureBytes'), ctx);
  return { capture: ctx.captureClaudeSettingFailureBytes, reports, warnings };
}

const PROVIDER_REFUSAL = Object.freeze({
  tabId: 'tab-20e4793e-3d5f-4cad-942d-2efc9b9b7a35',
  status: 'failed',
  generation: 'claude-launch-29',
  attemptId: 'A1',
  resultRevision: 3,
  reason: 'process-started',
  errorCode: 'claude_rate_limit',
  error: "API error: 429 This request would exceed your account's rate limit."
    + ' Please try again later · model not changed',
  failedCommand: '/model claude-opus-5[1m]',
  proofOutcome: 'found',
  userRetryable: true,
});

test('a failed setting pins the terminal bytes with its exact identity', () => {
  const { capture, reports } = harness();
  capture(PROVIDER_REFUSAL);

  assert.equal(reports.length, 1);
  const { key, payload } = reports[0];
  // One report per attempt+result, so a re-read cannot double-capture.
  assert.equal(key, 'claude-setting:' + PROVIDER_REFUSAL.tabId + ':A1:3');
  assert.equal(payload.tabId, PROVIDER_REFUSAL.tabId);
  assert.equal(payload.toolType, 'claude');
  assert.equal(payload.incidentReason, 'claude-setting-not-confirmed');
  // The settings card already tells the user; no second toast.
  assert.equal(payload.silent, true);

  // Everything needed to tell the two outcomes apart, without the prompt text.
  assert.equal(payload.context.failedCommand, '/model claude-opus-5[1m]');
  assert.equal(payload.context.errorCode, 'claude_rate_limit');
  assert.match(payload.context.error, /429/);
  assert.equal(payload.context.proofOutcome, 'found');
  assert.equal(payload.context.generation, 'claude-launch-29');
  assert.equal(payload.context.attemptId, 'A1');
  assert.equal(payload.context.userRetryable, true);
  // A provider answered: delivered, not an undelivered local failure.
  assert.equal(payload.context.undelivered, false);
  assert.match(payload.context.coverage, /not proof that Claude applied or rejected it/);
});

test('an undelivered local failure is captured and marked as such', () => {
  const { capture, reports } = harness();
  capture({
    ...PROVIDER_REFUSAL,
    errorCode: 'claude_startup_setting_rejected',
    error: '/model claude-opus-5[1m] was not confirmed by Claude'
      + '; reason=external_editor_timeout',
    reason: 'claude-startup-command-not-proven-at-enter',
    proofOutcome: 'unresolved',
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].payload.context.undelivered, true,
    'the report must say the command never reached Claude');
  assert.equal(reports[0].payload.context.proofOutcome, 'unresolved');
});

test('only a failed gate is captured', () => {
  for (const status of ['pending', 'ready', 'cleared']) {
    const { capture, reports } = harness();
    capture({ ...PROVIDER_REFUSAL, status });
    assert.equal(reports.length, 0, 'status=' + status + ' must not capture bytes');
  }
  // A failure without an addressable tab cannot be attributed to a terminal.
  const { capture, reports } = harness();
  capture({ ...PROVIDER_REFUSAL, tabId: '' });
  capture({});
  capture();
  assert.equal(reports.length, 0);
});

test('a diagnostic failure never breaks the gate publication', () => {
  const warnings = [];
  const ctx = vm.createContext({
    isClaudeStartupSettingUndelivered,
    reportTerminalIncident: () => { throw new Error('artifact disk full'); },
    console: { warn: (...args) => warnings.push(args.join(' ')), log() {} },
  });
  vm.runInContext(declaration('captureClaudeSettingFailureBytes'), ctx);
  // Must not throw: the user's settings state is more important than its report.
  ctx.captureClaudeSettingFailureBytes(PROVIDER_REFUSAL);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ClaudeSettingBytes/);
  assert.match(warnings[0], /artifact disk full/);
});

test('the capture runs on the gate publication and writes nothing to the terminal', () => {
  // Wired into publishGate, so every failed Claude setting is covered rather
  // than one call site remembering to ask for it.
  assert.ok(main.includes('captureClaudeSettingFailureBytes(payload);\n    return publishClaudeStartupDefaultsGate(payload, { notifyRenderer: true });'),
    'publishGate captures the bytes before publishing the failed gate');

  const body = declaration('captureClaudeSettingFailureBytes');
  // An observer: no PTY write, no key, no retry, no receipt settlement.
  for (const forbidden of ['safePasteAndSubmit', 'sendKey', '.write(', 'retry',
    'observeReceipt', 'ptyProcess', 'terminal:input']) {
    assert.equal(body.includes(forbidden), false,
      'the byte capture must stay observation-only: ' + forbidden);
  }
  // Same reporter Codex uses, so artifact limits/dedup/pruning are shared.
  assert.ok(body.includes('reportTerminalIncident('));
});

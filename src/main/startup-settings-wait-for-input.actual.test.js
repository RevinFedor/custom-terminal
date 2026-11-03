'use strict';
// A successful Rewind left a red "Settings error" behind it.
//
// Rewind stops Claude, rewrites the transcript and starts Claude again. It
// releases its input hold only once the new session proves it takes input.
// Startup settings see the fresh process slightly earlier, wrote immediately,
// and were refused by that hold:
//
//   13:43:38.8  Rewind started Claude again
//   13:43:40.0  startup settings: new process, writing /model
//   13:43:40.7  refused — history_input_mutation_pending
//   13:43:41.3  Rewind released the hold        (0.6s too late)
//
// Both halves were wrong for the user. The write should have waited for the
// release — the signal already exists and the Send FIFO uses it — and the
// outcome should not have been painted as a failure of a Rewind that had in
// fact completed. The refusal itself stays: while the rewrite owns the
// terminal, nothing else may write into it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const gate = (() => {
  const start = main.indexOf('async function ensureClaudeSettingEvidenceProcessOwner');
  assert.ok(start > 0, 'settings process-owner gate not found');
  const end = main.indexOf('const acceptance = await waitForAiLaunchAccepted', start);
  assert.ok(end > start, 'launch wait not found');
  return main.slice(start, end);
})();
const classifier = require(path.join(__dirname, '..', 'shared', 'claude-startup-failure.cjs'));

test('startup settings wait for the input hold to be released', () => {
  assert.match(gate, /historyMutationInput\.held\(tabId\)/,
    'the existing hold must be observed before writing');
  assert.match(gate, /while \(historyMutationInput\.held\(tabId\) && Date\.now\(\) < until\)/,
    'and waited out, not refused on first sight');
});

test('the wait is bounded and gives up by reporting the hold', () => {
  assert.match(gate, /Date\.now\(\) \+ 15000/, 'an unbounded wait would hang startup settings');
  assert.match(gate, /'setting-history-input-held'/,
    'after the deadline the hold is the reported reason, not a blind write');
});

test('the wait keeps rechecking ownership, it does not just sleep', () => {
  // A Rewind can replace the process, and a newer settings operation can
  // supersede this one, while we are waiting.
  assert.match(gate, /claudeSettingEvidenceProcessScopeCurrent\(tabId, scope\)/);
  assert.match(gate, /const pending = checkOperation\(\);/);
  const loop = gate.slice(gate.indexOf('while (historyMutationInput.held'));
  assert.ok(loop.indexOf('claudeSettingEvidenceProcessScopeCurrent') > 0
    && loop.indexOf('checkOperation()') > 0, 'both checks must be INSIDE the loop');
});

test('waiting happens before the launch-acceptance wait, not after', () => {
  // Writing first and asking later is exactly the bug.
  const held = main.indexOf('historyMutationInput.held(tabId)',
    main.indexOf('async function ensureClaudeSettingEvidenceProcessOwner'));
  const accept = main.indexOf('reason: \'startup-setting-process-owner\'', held);
  assert.ok(held > 0 && accept > held, 'the hold check must precede the launch wait');
});

test('a held input is presented as pending, not as a settings error', () => {
  for (const message of ['history_input_mutation_pending', 'setting-history-input-held']) {
    const described = classifier.describeClaudeStartupFailure({
      error: message, failedCommand: '/model claude-opus-5[1m]',
    });
    assert.equal(described.title, 'Settings pending', message);
    assert.equal(described.pending, true, message);
    assert.match(described.userMessage, /ждут освобождения ввода/);
    assert.doesNotMatch(described.userMessage, /не удалось применить/,
      'nothing was rejected, so it must not say the setting failed');
  }
});

test('a real settings rejection is still an error', () => {
  const described = classifier.describeClaudeStartupFailure({
    error: 'какая-то другая ошибка', failedCommand: '/model claude-opus-5[1m]',
  });
  assert.equal(described.title, 'Settings error');
  assert.notEqual(described.pending, true);
  assert.match(described.userMessage, /не удалось применить модель/);
});

test('the match is on the message, which is what the gate actually publishes', () => {
  // The gate logs `error=history_input_mutation_pending` with `code=-`, so
  // keying this off errorCode would never fire (02.11 13:43:40, 13:56:27).
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'claude-startup-failure.cjs'), 'utf8');
  assert.match(source, /if \(\/history_input_mutation_pending\|setting-history-input-held\/\.test\(message\)\)/,
    'the branch must inspect the message, not only a code');
});

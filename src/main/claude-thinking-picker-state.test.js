'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectClaudeThinkingPickerSnapshot,
  inspectClaudeThinkingProceedSnapshot,
} = require('./claude-thinking-picker-state');

function snapshot(text, selectedRow = null) {
  return {
    success: true,
    lines: String(text).split('\n').map((line, row) => ({
      row,
      text: line,
      hasInverse: row === selectedRow,
    })),
  };
}

test('current full Think picker proves checked and selected states', () => {
  const enabled = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    '❯ Enabled ✔',
    '  Disabled',
    'Enter to confirm · Esc to exit',
  ].join('\n')));
  assert.deepEqual(enabled, {
    visible: true,
    stateKnown: true,
    thinking: true,
    selectedThinking: true,
    reason: 'current-picker-proven',
  });

  const movedToDisabled = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    '  Enabled ✔',
    '❯ Disabled',
    'Enter to confirm · Esc to exit',
  ].join('\n')));
  assert.equal(movedToDisabled.thinking, true);
  assert.equal(movedToDisabled.selectedThinking, false);
});

test('incomplete differential text cannot prove picker state', () => {
  const incomplete = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    'Enabled',
    'Enter to confirm · Esc to exit',
  ].join('\n')));
  assert.equal(incomplete.visible, true);
  assert.equal(incomplete.stateKnown, false);
  assert.equal(incomplete.reason, 'options-incomplete');
});

test('old Think picker in scrollback cannot authorize input', () => {
  const stale = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    'Enabled ✔',
    'Disabled',
    'Enter to confirm · Esc to exit',
    'ordinary transcript line',
    '❯',
  ].join('\n')));
  assert.equal(stale.visible, false);
  assert.equal(stale.reason, 'footer-not-current');
});

test('current proceed dialog is distinct from the Think picker', () => {
  const frame = snapshot([
    'Do you want to proceed?',
    '❯ Yes',
    '  No',
    'Enter to confirm · Esc to cancel',
  ].join('\n'));
  assert.equal(inspectClaudeThinkingProceedSnapshot(frame).visible, true);
  assert.equal(inspectClaudeThinkingPickerSnapshot(frame).visible, false);
});

test('prose mentioning proceed without current dialog controls is not actionable', () => {
  const frame = snapshot([
    'assistant: Do you want to proceed?',
    'ordinary explanation',
    '❯',
  ].join('\n'));
  assert.equal(inspectClaudeThinkingProceedSnapshot(frame).visible, false);
});

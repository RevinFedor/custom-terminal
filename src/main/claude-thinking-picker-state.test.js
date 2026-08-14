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
    modalPresent: true,
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
  assert.equal(incomplete.modalPresent, true);
  assert.equal(incomplete.stateKnown, false);
  assert.equal(incomplete.reason, 'options-incomplete');
});

test('current picker without its later footer is present but not yet actionable', () => {
  const partial = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    'Enable or disable thinking for this session.',
    '❯ 1. Enabled ✔  Claude will think before',
    '                responding',
    '  2. Disabled   Claude will respond without',
    '                extended thinking',
  ].join('\n')));
  assert.equal(partial.visible, false);
  assert.equal(partial.modalPresent, true);
  assert.equal(partial.stateKnown, false);
  assert.equal(partial.reason, 'footer-missing');
});

test('title-only first paint is treated as an incomplete current modal', () => {
  const partial = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    'Enable or disable thinking for this session.',
  ].join('\n')));
  assert.equal(partial.visible, false);
  assert.equal(partial.modalPresent, true);
  assert.equal(partial.reason, 'footer-missing');
});

test('old partial picker followed by the current composer is not a live modal', () => {
  const stale = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    'Enabled ✔',
    'Disabled',
    'ordinary transcript line',
    '❯ current draft',
  ].join('\n')));
  assert.equal(stale.visible, false);
  assert.equal(stale.modalPresent, false);
  assert.equal(stale.reason, 'footer-missing');
});

test('narrow wrapped production picker is fully classified after its footer arrives', () => {
  const complete = inspectClaudeThinkingPickerSnapshot(snapshot([
    'Toggle thinking mode',
    'Enable or disable thinking for this session.',
    '❯ 1. Enabled ✔  Claude will think before',
    '                responding',
    '  2. Disabled   Claude will respond without',
    '                extended thinking',
    'Enter to confirm · Esc to cancel',
  ].join('\n')));
  assert.equal(complete.visible, true);
  assert.equal(complete.modalPresent, true);
  assert.equal(complete.stateKnown, true);
  assert.equal(complete.thinking, true);
  assert.equal(complete.selectedThinking, true);
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
  assert.equal(stale.modalPresent, false);
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

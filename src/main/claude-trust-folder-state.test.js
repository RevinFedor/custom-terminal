'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inspectClaudeTrustFolderPromptSnapshot,
  getClaudeTrustFolderSelectionKey,
  looksLikeClaudeTrustFolderPromptHintText,
  looksLikeClaudeTrustFolderPromptText,
} = require('./claude-trust-folder-state');

const prompt = [
  'Accessing workspace:',
  '/Users/fedor/Desktop/sc-desktop',
  'Quick safety check: Is this a project you created or one you trust?',
  "Claude Code'll be able to read, edit, and execute files here.",
  'Security guide',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
];

test('recognizes the complete Claude folder trust prompt with Yes selected', () => {
  assert.equal(looksLikeClaudeTrustFolderPromptText(prompt.join('\n')), true);
  assert.deepEqual(inspectClaudeTrustFolderPromptSnapshot({
    success: true,
    lines: prompt.map((text) => ({ text })),
  }), {
    visible: true,
    selectedOption: 1,
    reason: 'trust-prompt-visible',
  });
});

test('No and unproven selection are not mistaken for selected Yes', () => {
  const noSelected = prompt.map((line) => line
    .replace('❯ 1.', '  1.')
    .replace('  2. No', '❯ 2. No'));
  assert.equal(inspectClaudeTrustFolderPromptSnapshot({
    success: true,
    lines: noSelected.map((text) => ({ text })),
  }).selectedOption, 2);
  assert.equal(inspectClaudeTrustFolderPromptSnapshot({
    success: true,
    lines: prompt.map((text) => ({ text: text.replace('❯ 1.', '  1.') })),
  }).selectedOption, null);
});

test('a quoted option or partial prompt is never actionable', () => {
  assert.equal(looksLikeClaudeTrustFolderPromptText('❯ 1. Yes, I trust this folder'), false);
  assert.equal(inspectClaudeTrustFolderPromptSnapshot({
    success: true,
    lines: [{ text: 'User said: Quick safety check and 1. Yes, I trust this folder' }],
  }).visible, false);
});

test('the unique safety-check title blocks readiness before the whole menu arrives', () => {
  assert.equal(looksLikeClaudeTrustFolderPromptHintText(
    'Quick safety check: Is this a project you created or one you trust?',
  ), true);
  assert.equal(looksLikeClaudeTrustFolderPromptText(
    'Quick safety check: Is this a project you created or one you trust?',
  ), false);
});

test('Claude 2.1.265 unnumbered reversed choices retain semantic Yes/No, not row numbers', () => {
  const text = prompt.slice(0, -2).concat(['❯ No, exit', '  Yes, I trust this folder']);
  const snapshot = rows => ({ success: true, lines: rows.map(text => ({ text })) });
  const first = inspectClaudeTrustFolderPromptSnapshot(snapshot(text));
  assert.equal(first.visible, true);
  assert.equal(first.selectedOption, 2, 'No is a semantic option, not the first row number');
  const selectedYes = text.slice(0, -2).concat(['  No, exit', '❯ Yes, I trust this folder']);
  assert.equal(inspectClaudeTrustFolderPromptSnapshot(snapshot(selectedYes)).selectedOption, 1);
});

test('selects semantic Yes in either option order, not a fixed arrow', () => {
  const snapshot = choices => ({ success: true, lines: prompt.slice(0, -2).concat(choices).map(text => ({ text })) });
  assert.equal(getClaudeTrustFolderSelectionKey(snapshot(['❯ No, exit', 'Yes, I trust this folder'])), '\x1b[B');
  assert.equal(getClaudeTrustFolderSelectionKey(snapshot(['1. Yes, I trust this folder', '❯ 2. No, exit'])), '\x1b[A');
  assert.equal(getClaudeTrustFolderSelectionKey(snapshot(['❯ Yes, I trust this folder', 'No, exit'])), null);
  assert.equal(getClaudeTrustFolderSelectionKey(snapshot(['No, exit', 'Yes, I trust this folder'])), null);
  assert.equal(getClaudeTrustFolderSelectionKey(snapshot(['❯ No, exit', 'Yes, I trust this folder', 'Yes, I trust this folder'])), null);
  assert.equal(getClaudeTrustFolderSelectionKey(snapshot(['❯ No, exit', '❯ Yes, I trust this folder'])), null);
});

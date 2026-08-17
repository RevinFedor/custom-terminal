'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideCodexUpdatePromptAction,
  decideCodexUpdatePromptDismissal,
  inspectCodexUpdatePrompt,
} = require('./codex-update-prompt');

const firstSelected = [
  '✨ Update available! 0.146.0 -> 0.147.0',
  '',
  '› 1. Update now',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  'Press enter to continue',
].join('\n');

const secondSelected = firstSelected
  .replace('› 1. Update now', '  1. Update now')
  .replace('  2. Skip', '› 2. Skip');

const boundary = {
  sameTerminal: true,
  sameRunSeq: true,
  sameInputRevision: true,
  screenAvailable: true,
};

test('requires selecting Skip before confirming the update modal', () => {
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: firstSelected,
  }).action, 'select-skip');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: secondSelected,
  }).action, 'confirm-skip');
});

test('does not write against a changed lifecycle, input, or incomplete modal', () => {
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    sameTerminal: false,
    cleanText: firstSelected,
  }).reason, 'terminal-changed');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    sameRunSeq: false,
    cleanText: firstSelected,
  }).reason, 'run-changed');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    sameInputRevision: false,
    cleanText: firstSelected,
  }).reason, 'input-changed');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: firstSelected.replace('Press enter to continue', ''),
  }).allowed, false);
});

test('third option and old scrollback never authorize automatic input', () => {
  const thirdSelected = firstSelected
    .replace('› 1. Update now', '  1. Update now')
    .replace('  3. Skip until next version', '› 3. Skip until next version');
  assert.equal(inspectCodexUpdatePrompt(thirdSelected).canAutoSkip, false);

  const oldModalWithNewComposer = firstSelected
    + '\n\n› Implement {feature}\ngpt-5.6-sol max · Full Access';
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: oldModalWithNewComposer,
  }).allowed, false);
});

test('Enter is acknowledged only after the interactive modal disappears', () => {
  assert.equal(decideCodexUpdatePromptDismissal({
    ...boundary,
    cleanText: secondSelected,
  }).reason, 'prompt-still-visible');
  assert.deepEqual(decideCodexUpdatePromptDismissal({
    ...boundary,
    cleanText: '› Implement {feature}\ngpt-5.6-sol max · Full Access',
  }).allowed, true);
});

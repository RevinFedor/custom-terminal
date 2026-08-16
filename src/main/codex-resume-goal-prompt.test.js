'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideCodexResumeGoalAutoEnter,
  inspectCodexResumeGoalPrompt,
} = require('./codex-resume-goal-prompt');

const narrowProductionFrame = [
  'Resume paused goal?',
  'Goal: Исправить архитектуру пользовательского f',
  '',
  '› 1. Resume goal   Mark it active and continue',
  '                   when idle',
  '  2. Leave paused  Keep it paused; use /goal',
  '                   resume later',
  '',
  'Press enter to confirm or esc to go back',
].join('\n');

test('recognizes the wrapped production Resume goal frame and selected safe default', () => {
  assert.deepEqual(inspectCodexResumeGoalPrompt(narrowProductionFrame), {
    visible: true,
    interactiveVisible: true,
    canAutoEnter: true,
    firstOptionSelected: true,
    secondOptionSelected: false,
    missing: [],
    skipReason: null,
  });
});

test('recognizes a wide Resume goal frame', () => {
  const frame = [
    'Resume paused goal?',
    'Goal: Finish the lifecycle repair',
    '',
    '› 1. Resume goal  Mark it active and continue when idle',
    '  2. Leave paused Keep it paused; use /goal resume later',
    '',
    'Press enter to confirm or esc to go back',
  ].join('\n');
  assert.equal(inspectCodexResumeGoalPrompt(frame).canAutoEnter, true);
});

test('does not override a user-selected Leave paused choice', () => {
  const frame = narrowProductionFrame
    .replace('› 1. Resume goal', '  1. Resume goal')
    .replace('  2. Leave paused', '› 2. Leave paused');
  const prompt = inspectCodexResumeGoalPrompt(frame);
  assert.equal(prompt.visible, true);
  assert.equal(prompt.canAutoEnter, false);
  assert.equal(prompt.skipReason, 'leave-paused-selected');
});

test('rejects incomplete and quoted prose instead of guessing from the title', () => {
  const incomplete = narrowProductionFrame.replace('Press enter to confirm or esc to go back', '');
  assert.equal(inspectCodexResumeGoalPrompt(incomplete).canAutoEnter, false);
  assert.equal(inspectCodexResumeGoalPrompt(incomplete).skipReason, 'missing:footer');

  const prose = [
    'The screen said Resume paused goal?',
    'Goal: example',
    '› 1. Resume goal',
    '2. Leave paused',
    'I selected it manually.',
  ].join('\n');
  assert.equal(inspectCodexResumeGoalPrompt(prose).canAutoEnter, false);
});

test('requires the exact current terminal, run, input revision, and screen', () => {
  const base = {
    sameTerminal: true,
    sameRunSeq: true,
    sameInputRevision: true,
    screenAvailable: true,
    cleanText: narrowProductionFrame,
  };
  assert.equal(decideCodexResumeGoalAutoEnter(base).allowed, true);
  assert.equal(decideCodexResumeGoalAutoEnter({ ...base, sameTerminal: false }).reason, 'terminal-changed');
  assert.equal(decideCodexResumeGoalAutoEnter({ ...base, sameRunSeq: false }).reason, 'run-changed');
  assert.equal(decideCodexResumeGoalAutoEnter({ ...base, sameInputRevision: false }).reason, 'input-changed');
  assert.equal(decideCodexResumeGoalAutoEnter({ ...base, screenAvailable: false }).reason, 'screen-unavailable');
  assert.equal(decideCodexResumeGoalAutoEnter({ ...base, cleanText: '› ordinary prompt' }).reason, 'prompt-closed');
});

test('an old Resume goal modal followed by a newer screen cannot authorize Enter', () => {
  const stale = narrowProductionFrame + '\n› ordinary prompt\ngpt-5.6-sol max · Context 90%';
  const prompt = inspectCodexResumeGoalPrompt(stale);
  assert.equal(prompt.visible, true);
  assert.equal(prompt.canAutoEnter, false);
  assert.match(prompt.skipReason, /missing:footer/);
});

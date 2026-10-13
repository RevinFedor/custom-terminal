'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideCodexLeaveGoalPausedAutoEnter,
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
    titleIndex: 0,
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

test('29Sep compact footer recognizes the same complete picker, not its scrollback copy', () => {
  const frame = narrowProductionFrame.replace('Press enter to confirm or esc to go back', 'enter select · esc back');
  assert.equal(inspectCodexResumeGoalPrompt(frame).interactiveVisible, true);
  assert.equal(inspectCodexResumeGoalPrompt(frame).canAutoEnter, true);
  assert.equal(inspectCodexResumeGoalPrompt(frame + '\n› Actual composer\nGPT-6-Astra max · Context 40% used').interactiveVisible, false);
  assert.equal(inspectCodexResumeGoalPrompt(frame.replace('  2. Leave paused', '  2. Something else')).interactiveVisible, false);
});

test('0.162 Goal description prefix is not the selected-option marker', () => {
  for (const footer of ['Press enter to confirm or esc to go back', 'enter select · esc back']) {
    const frame = narrowProductionFrame
      .replace('Goal: Исправить', '› Goal: Исправить')
      .replace('Press enter to confirm or esc to go back', footer);
    const prompt = inspectCodexResumeGoalPrompt(frame);
    assert.equal(prompt.interactiveVisible, true);
    assert.equal(prompt.canAutoEnter, true);
    assert.deepEqual(prompt.missing, []);

    const leave = frame.replace('› 1.', '  1.').replace('  2.', '› 2.');
    const leavePrompt = inspectCodexResumeGoalPrompt(leave);
    assert.equal(leavePrompt.interactiveVisible, true);
    assert.equal(leavePrompt.canAutoEnter, false);
    assert.equal(leavePrompt.secondOptionSelected, true);
    assert.equal(inspectCodexResumeGoalPrompt(frame.replace('› 1.', '  1.')).canAutoEnter, false,
      'the description marker must not invent a selected option');
  }
});

test('prefixed Goal still requires a body, both options and the current complete footer', () => {
  const frame = narrowProductionFrame.replace('Goal: Исправить', '› Goal: Исправить');
  for (const invalid of [
    frame.replace(/› Goal:[^\n]*/, '› Goal:'),
    frame.replace('› Goal:', '> Goal:'),
    frame.replace('› Goal:', 'Example › Goal:'),
    frame.replace('  2. Leave paused', '  2. Another action'),
    frame.replace('Press enter to confirm or esc to go back', ''),
    frame + '\n› Ask Codex to do anything\ngpt-6-astra max · Context 42% used',
  ]) assert.equal(inspectCodexResumeGoalPrompt(invalid).interactiveVisible, false);

  const base = { sameTerminal: true, sameRunSeq: true, sameInputRevision: true,
    screenAvailable: true, cleanText: frame };
  assert.equal(decideCodexResumeGoalAutoEnter(base).allowed, true);
  for (const key of ['sameTerminal', 'sameRunSeq', 'sameInputRevision', 'screenAvailable']) {
    assert.equal(decideCodexResumeGoalAutoEnter({ ...base, [key]: false }).allowed, false);
  }
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

test('history-only Resume can select Leave paused without starting the saved goal', () => {
  const leaveFrame = narrowProductionFrame
    .replace('› 1. Resume goal', '  1. Resume goal')
    .replace('  2. Leave paused', '› 2. Leave paused');
  const base = {
    sameTerminal: true,
    sameRunSeq: true,
    sameInputRevision: true,
    screenAvailable: true,
  };
  assert.equal(decideCodexLeaveGoalPausedAutoEnter({ ...base, cleanText: leaveFrame }).allowed, true);
  assert.equal(decideCodexLeaveGoalPausedAutoEnter({ ...base, cleanText: narrowProductionFrame }).allowed, false);
});

test('an old Resume goal modal followed by a newer screen cannot authorize Enter', () => {
  const stale = narrowProductionFrame + '\n› ordinary prompt\ngpt-5.6-sol max · Context 90%';
  const prompt = inspectCodexResumeGoalPrompt(stale);
  assert.equal(prompt.visible, true);
  assert.equal(prompt.canAutoEnter, false);
  assert.match(prompt.skipReason, /missing:footer/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCodexResumeGoalPrompt, decideCodexResumeGoalAutoEnter } = require('./codex-resume-goal-prompt');

// Own live Codex 0.162.0 / 80x24 committed mirror, 19Oct14:33UTC.
// The picker occupies columns6+, while the old composer remains at columns0..3.
// Complete original generation/writeSeq and serialized screen are retained in
// source4196/GOAL-NATIVE-HEADLESS-SNAPSHOT.json. No user transcript in this fixture.
const frame = [
  '      Resume paused goal?',
  '› As  Goal: After explicit Resume reply with the test marker',
  '      and complete this synthetic Goal. No project work.',
  '  GP  No project files, tools or other work.                         iew',
  '',
  '    › 1. Resume goal   Mark it active and continue when idle',
  '      2. Leave paused  Keep it paused; use /goal resume later',
  '',
  '      enter select · esc back',
].join('\n');

test('actual inset Goal picker ignores only the underlay left of its proven content column', () => {
  const value = inspectCodexResumeGoalPrompt(frame);
  assert.equal(value.interactiveVisible, true);
  assert.equal(value.canAutoEnter, true);
  assert.deepEqual(value.missing, []);
});

test('inset body alone cannot invent current dialog/option/footer authority', () => {
  for (const text of [
    frame.replace('› As  Goal:', '› As Goal:'),
    frame.replace('› As  Goal:', '› As   Goal:'),
    frame.replace('› As  Goal: After explicit Resume reply with the test marker', '› As  Goal:'),
    frame.replace('      Resume paused goal?', 'Quote Resume paused goal?'),
    frame.replace('    › 1. Resume goal', '      1. Resume goal'),
    frame.replace('      2. Leave paused', '       2. Leave paused'),
    frame.replace('      enter select · esc back', ''),
    frame + '\n› New composer\ngpt-6-luna high · Context 42% used',
  ]) assert.equal(inspectCodexResumeGoalPrompt(text).canAutoEnter, false, text);
});

test('inset description does not select Resume or bypass physical owner guards', () => {
  const leave = frame.replace('    › 1.', '      1.').replace('      2.', '    › 2.');
  assert.equal(inspectCodexResumeGoalPrompt(leave).interactiveVisible, true);
  assert.equal(inspectCodexResumeGoalPrompt(leave).canAutoEnter, false);
  const base = { sameTerminal: true, sameRunSeq: true, sameInputRevision: true,
    screenAvailable: true, cleanText: frame };
  assert.equal(decideCodexResumeGoalAutoEnter(base).allowed, true);
  for (const key of ['sameTerminal', 'sameRunSeq', 'sameInputRevision', 'screenAvailable'])
    assert.equal(decideCodexResumeGoalAutoEnter({ ...base, [key]: false }).allowed, false);
});

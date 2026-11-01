'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  changedFilePresentation,
  fileBatchPresentation,
} = require('./tab-work-context.js');

// Fedor31Oct/01Nov decision: a context chip has a size limit. It tells the
// reader WHICH files changed and WHERE; it is not a transport for file bodies.
// The incident: a 959-character draft was sent as 2,031,330 characters because
// two linked files were pasted in full, which then triggered an auto-compact.
//
// Limit is 200000 characters (~50K tokens): twice the existing context-update
// text limit, ~10x below the incident. Over the limit the chip keeps its facts
// and drops the diff body; it never truncates mid-diff, because half a diff
// reads as if the rest of the file did not change.

const LIMIT = 200000;

function lines(count, prefix) {
  return Array.from({ length: count }, (_, i) => prefix + ' ' + i).join('\n') + '\n';
}

test('an ordinary diff passes through untouched', () => {
  const before = 'alpha\nbeta\ngamma\n';
  const after = 'alpha\nBETA CHANGED\ngamma\n';
  const result = changedFilePresentation(before, after);
  assert.equal(result.diffOmitted, undefined, 'no omission for a small diff');
  assert.match(result.text, /@@/, 'the real hunk header is present');
  assert.match(result.text, /\+ BETA CHANGED/, 'the changed line is present');
  assert.ok(result.text.length < 500);
});

test('a diff just under the limit is still delivered in full', () => {
  // ~60 chars per changed line pair; stay comfortably below the cap.
  const before = lines(1000, 'old');
  const after = lines(1000, 'new');
  const result = changedFilePresentation(before, after);
  assert.ok(result.text.length <= LIMIT, 'fixture must be under the cap: ' + result.text.length);
  assert.equal(result.diffOmitted, undefined);
  assert.match(result.text, /@@/);
});

test('an oversized diff drops its body but keeps every fact', () => {
  const before = lines(40000, 'old');
  const after = lines(40000, 'new');
  const result = changedFilePresentation(before, after);
  assert.ok(result.diffOmitted, 'the omission is reported, not silent');
  assert.equal(result.diffOmitted.reason, 'context-chip-diff-limit');
  assert.equal(result.diffOmitted.limit, LIMIT);
  assert.ok(result.diffOmitted.characters > LIMIT);
  // Facts the reader needs are preserved.
  assert.equal(result.startLine, 1);
  assert.ok(result.endLine >= 40000, 'the end line still covers the whole change');
  assert.equal(result.changedLineCount, 40000);
  assert.ok(result.text.length < 1000, 'the chip itself is small now: ' + result.text.length);
  assert.match(result.text, /предел/);
  assert.match(result.text, /прочитайте файл/);
  // Never a partial diff.
  assert.ok(!result.text.includes('@@'), 'no half-diff is emitted');
});

test('hunks and counts stay intact for callers that only need numbers', () => {
  const result = changedFilePresentation(lines(40000, 'old'), lines(40000, 'new'));
  assert.ok(Array.isArray(result.hunks) && result.hunks.length > 0,
    'structured hunks remain available to internal callers');
});

test('several files whose sum exceeds the limit are capped together', () => {
  // The exact incident shape: each file individually acceptable, the sum not.
  const changes = [
    { path: '/tmp/a.md', beforeText: lines(9000, 'old'), afterText: lines(9000, 'new'),
      afterHash: 'hash-a' },
    { path: '/tmp/b.md', beforeText: lines(9000, 'old'), afterText: lines(9000, 'new'),
      afterHash: 'hash-b' },
  ];
  const result = fileBatchPresentation(changes);
  assert.ok(result.diffOmitted, 'the assembled body is checked, not only each file');
  assert.equal(result.diffOmitted.reason, 'context-chip-diff-limit');
  assert.ok(result.text.length < 2000, 'chip stays small: ' + result.text.length);
  // Both files are still named with their ranges.
  assert.match(result.text, /\/tmp\/a\.md/);
  assert.match(result.text, /\/tmp\/b\.md/);
  assert.match(result.text, /изменённых строк/);
  assert.ok(!result.text.includes('@@'), 'no partial diffs in a batch either');
  // The title keeps its normal summary so the user still sees the scale.
  assert.match(result.title, /2 файла/);
});

test('a small multi-file chip is unchanged', () => {
  const changes = [
    { path: '/tmp/a.md', beforeText: 'a\nb\n', afterText: 'a\nB\n', afterHash: 'h1' },
    { path: '/tmp/b.md', beforeText: 'c\nd\n', afterText: 'c\nD\n', afterHash: 'h2' },
  ];
  const result = fileBatchPresentation(changes);
  assert.equal(result.diffOmitted, undefined);
  assert.match(result.text, /@@/, 'real diffs are still delivered');
  assert.match(result.text, /\+ B/);
  assert.match(result.text, /\+ D/);
});

test('the incident payload would no longer reach the prompt', () => {
  // ~2.03M characters of diff, as on 31Oct.
  const before = lines(30000, 'original content line with some length to it');
  const after = lines(30000, 'replacement content line with some length too');
  const single = changedFilePresentation(before, after);
  assert.ok(single.diffOmitted.characters > 1_000_000, 'fixture reproduces the scale');
  assert.ok(single.text.length < 1000,
    'the chip shrinks from ~2M to under 1K characters');
});

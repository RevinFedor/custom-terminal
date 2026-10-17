'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validGitDiffRequestId, stableGitPathIdentity, measureGitDiffText } = require('./git-diff-diagnostics.cjs');

test('Git diff diagnostic IDs are bounded and reject arbitrary input', () => {
  assert.equal(validGitDiffRequestId('git-diff-boot-17'), 'git-diff-boot-17');
  assert.equal(validGitDiffRequestId('x'.repeat(200)), null);
  assert.equal(validGitDiffRequestId('git-diff-/private/path'), null);
});

test('Git diff size metrics count UTF-8 bytes and physical lines without retaining content', () => {
  assert.deepEqual(measureGitDiffText('a\né\n'), { chars: 4, utf8Bytes: 5, lines: 2 });
  assert.deepEqual(measureGitDiffText(''), { chars: 0, utf8Bytes: 0, lines: 0 });
  assert.deepEqual(measureGitDiffText('one'), { chars: 3, utf8Bytes: 3, lines: 1 });
});

test('Git path identity is stable, opaque, and bounded', () => {
  const first = stableGitPathIdentity('/synthetic/repo/.semantic-index.json');
  assert.match(first, /^sha256:[a-f0-9]{20}$/);
  assert.equal(stableGitPathIdentity('/synthetic/repo/.semantic-index.json'), first);
  assert.notEqual(stableGitPathIdentity('/synthetic/repo/other'), first);
  assert.equal(stableGitPathIdentity(''), null);
});

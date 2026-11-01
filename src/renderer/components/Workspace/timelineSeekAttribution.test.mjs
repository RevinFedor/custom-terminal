// A Timeline click commits three store writes synchronously (panel-open, seek
// target, dot state); every subscriber re-renders inside that same task, before
// the dot loader can paint. Unattributed, the whole cost was reported as
// `during=none-marked` — a 452ms task at 13:37:48.8 UTC on the installed build
// named nothing, which is why the next repair could only have been a guess.
//
// This is a source contract: both click paths must open a mark BEFORE the first
// store write and close it on the next frame, so the freeze probe can bill it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(HERE, 'Timeline.tsx'), 'utf8');

const seekMark = "markRendererActivity('timeline-seek:' + tabId.slice(-8))";

test('both Timeline seek paths are attributed', () => {
  assert.equal(source.split(seekMark).length - 1, 2,
    'the dot path and the preview-body path both commit the seek and both need a mark');
});

test('the mark opens before the first store write, not after', () => {
  let searched = 0;
  for (let found = 0; found < 2; found++) {
    const at = source.indexOf(seekMark, searched);
    assert.ok(at > 0, 'seek mark ' + found + ' must exist');
    searched = at + seekMark.length;
    const after = source.slice(at, at + 420);
    const writeAt = after.indexOf('setHistoryScrollToUuid(');
    assert.ok(writeAt > 0,
      'mark ' + found + ' must be followed by the seek write it accounts for');
    const before = source.slice(Math.max(0, at - 420), at);
    assert.ok(!before.includes('setHistoryScrollToUuid('),
      'mark ' + found + ' must open BEFORE the write; a mark opened after it '
      + 'would leave the expensive commit unattributed again');
    assert.match(after.slice(0, writeAt), /requestAnimationFrame\(\(\) => endSeekMark\(\)\)/,
      'mark ' + found + ' must close on the next frame, so the commit and the '
      + 'paint it blocks are both inside the window');
  }
});

test('the existing surface-swap mark is not replaced by the seek mark', () => {
  assert.ok(source.includes("markRendererActivity('timeline-swap:' + tabId.slice(-8))"),
    'a session swap and a seek inside the same session are different work and '
    + 'must stay separately named');
});

test('the dot loader the seek turns on still exists', () => {
  assert.match(source, /dotClickState === 'loading'/,
    'the seek sets clickedState=loading; without the loader branch the user '
    + 'would get a freeze with no feedback at all');
});

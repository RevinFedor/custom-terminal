import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('a reveal clears stale gesture ownership before changing height', () => {
  const start = source.indexOf('const historyRevealOps =');
  const end = source.indexOf('// Correlated geometry proof', start);
  const reveal = source.slice(start, end);
  assert.match(reveal, /setHistoryTailFollowIntent\(false\)/);
  assert.match(reveal, /historyUserGestureAtRef\.current = 0/);
  assert.match(reveal, /historyUserScrollDirectionRef\.current = null/);
});

test('only a real downward gesture can re-enable follow at the physical bottom', () => {
  const start = source.indexOf('const recentGestureDirection =');
  const end = source.indexOf('if (scrollArrowRef.current)', start);
  const reconciliation = source.slice(start, end);
  assert.match(reconciliation, /userReachedBottom: physicalPinned/);
  assert.match(reconciliation, /recentGestureDirection === 'down'/);
  assert.match(reconciliation, /pointerDirection === 'down'/);
});

test('the explicit bottom command supplies its own follow intent', () => {
  const start = source.indexOf('const scrollToBottom =');
  const end = source.indexOf('const handleControlsHeightChange', start);
  assert.match(source.slice(start, end), /setHistoryTailFollowIntent\(true\)/);
});

test('group expansion stabilizes the clicked semantic header across late remeasure', () => {
  const start = source.indexOf('const expandGroupPreservingViewport =');
  const end = source.indexOf('const collapseGroupPreservingViewport =', start);
  const expand = source.slice(start, end);
  assert.match(expand, /flushSync\(/, 'the first corrected frame must land before paint');
  assert.match(expand, /stabilizeHistoryRevealAnchor\(/);
  assert.match(expand, /data-history-group/);
});

test('Virtuoso receives a primitive follow prop, not a callback it treats as enabled', () => {
  assert.match(source, /followOutput=\{historyFollowOutputEnabled \? 'auto' : false\}/);
  assert.doesNotMatch(source, /followOutput=\{\(\) =>/);
  const revealStart = source.indexOf('const historyRevealOps =');
  const revealEnd = source.indexOf('// Correlated geometry proof', revealStart);
  assert.match(
    source.slice(revealStart, revealEnd),
    /flushSync\(\(\) => setHistoryTailFollowIntent\(false\)\)/,
  );
});

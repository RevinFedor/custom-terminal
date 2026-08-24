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

test('send tail ownership spans optimistic append, composer collapse, and durable adoption', () => {
  const transactionStart = source.indexOf('const keepHistoryTailPinnedAfterMutation =');
  const transactionEnd = source.indexOf('// Card- and group-level toggles', transactionStart);
  const transaction = source.slice(transactionStart, transactionEnd);
  assert.match(transaction, /settleUntilStable:\s*true/);
  assert.match(transaction, /HISTORY_TAIL_MUTATION_MIN_SETTLE_FRAMES/);
  assert.match(transaction, /HISTORY_TAIL_MUTATION_MAX_SETTLE_FRAMES/);
  assert.match(transaction, /HISTORY_TAIL_MUTATION_REQUIRED_STABLE_FRAMES/);

  const appendStart = source.indexOf('const appendLocalPromptEntry =');
  const appendEnd = source.indexOf('const updateLocalPromptEntryStatus =', appendStart);
  assert.match(
    source.slice(appendStart, appendEnd),
    /keepHistoryTailPinnedAfterMutation\('prompt-submitted', true\)/,
  );
  assert.match(source, /keepHistoryTailPinnedAfterMutation\('durable-refresh'\)/);

  const gestureStart = source.indexOf('const handleUserScrollIntent =');
  const gestureEnd = source.indexOf('const handleHistoryTouchStart =', gestureStart);
  assert.match(
    source.slice(gestureStart, gestureEnd),
    /historyTailPinScheduler\.cancel\(\)/,
    'a real wheel or touch gesture must immediately take ownership back',
  );
  const pointerStart = source.indexOf('const handleHistoryScrollerPointerDown =');
  const pointerEnd = source.indexOf('const handleHistoryScrollerPointerEnd =', pointerStart);
  assert.match(
    source.slice(pointerStart, pointerEnd),
    /historyTailPinScheduler\.cancel\(\)/,
    'grabbing the native scrollbar must take ownership before its first movement',
  );
  assert.match(transaction, /historyPointerScrollActiveRef\.current/);
});

test('group expansion waits for the applied false follow prop, then anchors before paint', () => {
  const barrierStart = source.indexOf('// Expansion is intentionally a TWO-COMMIT transaction');
  const start = source.indexOf('const expandGroupPreservingViewport =');
  const end = source.indexOf('const collapseGroupPreservingViewport =', start);
  const barrier = source.slice(barrierStart, start);
  const expand = source.slice(start, end);
  assert.match(barrier, /useEffect\(\(\) =>/);
  assert.match(barrier, /if \(!pending \|\| historyFollowOutputEnabled\) return/);
  assert.match(barrier, /barrier=follow-prop-effect/);
  assert.match(barrier, /setExpandedGroupKeys/);
  assert.match(barrier, /useLayoutEffect\(\(\) =>/);
  assert.match(barrier, /stabilizePendingHistoryGroupExpand\(pending\)/);
  assert.doesNotMatch(expand, /setExpandedGroupKeys/, 'the click must not resize in the unpin commit');
  assert.match(expand, /pendingHistoryGroupExpandRef\.current/);
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

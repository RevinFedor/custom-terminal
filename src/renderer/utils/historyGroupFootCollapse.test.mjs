import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const panelSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const presentationSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx'),
  'utf8',
);

/**
 * Collapsing an expanded block from the FOOT of its rail.
 *
 * A block taller than the screen used to have exactly one control — its
 * header — so closing it meant scrolling all the way back up first. The rail's
 * bottom end is now that second control, and these tests lock the two things
 * that are easy to break silently: where the view lands, and that the rail
 * costs no extra height.
 */

const footHandler = (() => {
  const start = panelSource.indexOf('const collapseGroupFromFoot =');
  assert.ok(start >= 0, 'foot-collapse handler must exist');
  return panelSource.slice(start, panelSource.indexOf('\n  }, [', start));
})();

test('the view lands on the block header, not on wherever the click was', () => {
  // Collapsing removes everything ABOVE the click point. Holding scrollTop
  // would leave the user looking at rows from further down while the block
  // they just closed sits off-screen above — it would read as "the block
  // disappeared".
  assert.match(footHandler, /data-history-group/, 'must locate the block header');
  assert.match(footHandler, /getBoundingClientRect/, 'header position decides the landing');
  // Only a missing/off-screen header enters the navigation branch. A visible
  // header receives no post-collapse scroll command.
  assert.match(footHandler, /headerOffset === null \|\| headerOffset < 0/);
});

test('a header scrolled out of the virtualized DOM is reached by index', () => {
  // With the header far above, there is no DOM node to measure — the display
  // list still knows where the block is.
  assert.match(footHandler, /displayUnits\.findIndex/);
  assert.match(footHandler, /scrollToIndex\(\{ index: headerIndex, align: 'start' \}\)/);
  assert.match(footHandler, /requestAnimationFrame/, 'landing waits for the collapsed list geometry');
  assert.match(footHandler, /landedHeader\.getBoundingClientRect/);
});

test('the collapse keeps header navigation but creates no empty tail reserve', () => {
  // The product deliberately accepts the browser's post-collapse scroll
  // range. If the header cannot physically reach the top without blank space,
  // it only needs to remain visible; no synthetic Footer is allowed.
  assert.doesNotMatch(footHandler, /holdHistoryShrinkFrame|armTailReserve|tailSpacer/);
  assert.doesNotMatch(panelSource, /data-history-tail-spacer|historyTailSpacerRef/);
  // Following must be released BEFORE the resize (same order as every other
  // collapse path), or a stale tail pin rides the shrink to the new bottom.
  const unpin = footHandler.indexOf('unpinTail()');
  const mutate = footHandler.indexOf('setExpandedGroupKeys');
  assert.ok(unpin >= 0 && mutate > unpin, 'unpin must precede the state change');
});

test('the foot renders on the LAST member only and adds no height', () => {
  // One control per block, at the end of the rail.
  assert.match(panelSource, /expandedGroup\.last && \(\s*<HistoryGroupFoot/);
  assert.match(panelSource, /expandedSubgroup\.last && \(\s*<HistoryGroupFoot/);
  assert.match(presentationSource, /(?:const|function) HistoryGroupFoot/);
  // Absolutely positioned over the rail's own bottom segment: the block's
  // height is unchanged, which is what keeps measured-geometry snapshots and
  // the collapse math honest.
  const css = panelSource.slice(panelSource.indexOf("/* The rail's FOOT:"));
  assert.match(css.slice(0, 1000), /position: absolute/);
  assert.match(css.slice(0, 1000), /bottom: 0/);
});

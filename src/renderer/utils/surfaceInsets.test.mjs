import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMELINE_COLLAPSED_SLOT_WIDTH,
  resolveTimelineInset,
  resolveSidePanelInset,
  resolveCenterRightInset,
} from './surfaceInsets.mjs';

test('timeline: only an expanded UNPINNED tree covers the center', () => {
  // Collapsed rail already owns its slot — nothing to dodge.
  assert.equal(resolveTimelineInset({ treeMode: false, pinned: false, width: 420 }), 0);
  // Pinned is a column: the center box is already narrower, so insetting would
  // double-count and push controls into empty space.
  assert.equal(resolveTimelineInset({ treeMode: true, pinned: true, width: 420 }), 0);
  assert.equal(
    resolveTimelineInset({ treeMode: true, pinned: false, width: 420 }),
    420 - TIMELINE_COLLAPSED_SLOT_WIDTH,
  );
});

test('timeline: never negative, even if width is below the collapsed slot', () => {
  assert.equal(resolveTimelineInset({ treeMode: true, pinned: false, width: 10 }), 0);
});

test('side panel: whichever one is docked contributes its width', () => {
  const widths = { sideTerminalWidth: 360, sideHistoryWidth: 614 };
  assert.equal(resolveSidePanelInset({ ...widths, sideTerminalOpen: false, sideHistoryOpen: false }), 0);
  assert.equal(resolveSidePanelInset({ ...widths, sideTerminalOpen: true, sideHistoryOpen: false }), 360);
  assert.equal(resolveSidePanelInset({ ...widths, sideTerminalOpen: false, sideHistoryOpen: true }), 614);
});

test('side panel: only one slot exists, so an impossible both-open state stays single-counted', () => {
  // Swapping the primary surface closes the other panel, so both-open should
  // never occur. If it ever does, the inset must not become the SUM — that
  // would shove controls far past the panel edge.
  const inset = resolveSidePanelInset({
    sideTerminalOpen: true, sideTerminalWidth: 360,
    sideHistoryOpen: true, sideHistoryWidth: 614,
  });
  assert.equal(inset, 360);
});

test('center inset: timeline and side panel stack', () => {
  assert.equal(resolveCenterRightInset({
    treeMode: true, pinned: false, width: 420,
    sideTerminalOpen: false, sideTerminalWidth: 360,
    sideHistoryOpen: true, sideHistoryWidth: 614,
  }), (420 - TIMELINE_COLLAPSED_SLOT_WIDTH) + 614);
});

test('center inset: nothing open → flush right', () => {
  assert.equal(resolveCenterRightInset({}), 0);
});

test('center inset: garbage widths degrade to 0 rather than NaN', () => {
  // A NaN here would silently blank the CSS value and drop the control back to
  // the wrong edge — the exact class of bug this module exists to prevent.
  const inset = resolveCenterRightInset({
    treeMode: true, pinned: false, width: undefined,
    sideHistoryOpen: true, sideHistoryWidth: null,
  });
  assert.equal(inset, 0);
  assert.ok(Number.isFinite(inset));
});

test('a PINNED side panel contributes no inset (it is a column, not an overlay)', () => {
  // Pinned means the centre box already ends before the panel. Insetting on
  // top of that would push the controls a whole panel-width into empty space.
  const args = {
    sideTerminalOpen: false, sideTerminalWidth: 360,
    sideHistoryOpen: true, sideHistoryWidth: 614,
  };
  assert.equal(resolveSidePanelInset({ ...args, sidePanelPinned: false }), 614);
  assert.equal(resolveSidePanelInset({ ...args, sidePanelPinned: true }), 0);
});

test('pinned side panel still leaves the Timeline inset intact', () => {
  // The two obstacles are independent: pinning the panel says nothing about
  // an expanded Timeline overlaying the same edge.
  const inset = resolveCenterRightInset({
    treeMode: true, pinned: false, width: 420,
    sideHistoryOpen: true, sideHistoryWidth: 614, sidePanelPinned: true,
  });
  assert.equal(inset, 420 - TIMELINE_COLLAPSED_SLOT_WIDTH);
});

// THE BUG. The terminal's scroll-to-bottom arrow vanished whenever the
// terminal was the SIDE panel: the same component measured its right edge as
// if it were the centre, shifted the arrow left by its own panel width, and
// parked it in the middle of the transcript next door. From the user's seat
// the centre had an arrow and the panel had none.
test('a surface that IS the side panel insets nothing — it is the obstacle', () => {
  const asCentre = resolveCenterRightInset({
    sideTerminalOpen: true, sideTerminalWidth: 460,
  });
  const asPanel = resolveCenterRightInset({
    isSidePanel: true,
    sideTerminalOpen: true, sideTerminalWidth: 460,
  });
  assert.equal(asCentre, 460);
  assert.equal(asPanel, 0);
});

test('being the side panel also cancels the Timeline inset', () => {
  // The Timeline overlays the CENTRE. A docked panel is not the centre, so an
  // expanded Timeline is not in front of it either.
  assert.equal(resolveCenterRightInset({
    isSidePanel: true,
    treeMode: true, pinned: false, width: 420,
    sideHistoryOpen: true, sideHistoryWidth: 614,
  }), 0);
});

test('the flag is opt-in: omitting it keeps the centre arithmetic', () => {
  const args = { treeMode: true, pinned: false, width: 420 };
  assert.equal(resolveCenterRightInset(args), 420 - TIMELINE_COLLAPSED_SLOT_WIDTH);
  assert.equal(resolveCenterRightInset({ ...args, isSidePanel: false }), 420 - TIMELINE_COLLAPSED_SLOT_WIDTH);
});

test('the inset follows the panel width, so a drag moves the controls with it', () => {
  // The other half of the report: the strip did not move while the panel was
  // being dragged. Both read the same width, so they cannot disagree.
  const at = (w) => resolveCenterRightInset({ sideHistoryOpen: true, sideHistoryWidth: w });
  assert.equal(at(614), 614);
  assert.equal(at(734), 734);
  assert.equal(at(280), 280);
});

test('two surfaces, two answers: the strip dodges the panel the terminal IS', () => {
  // Reported: chat centred, terminal opened with Cmd+] — and Run after did not
  // move at all, while the reverse layout worked.
  //
  // The arrow is drawn INSIDE the terminal, the Run after strip is portalled out
  // to a host spanning the whole centre column. In transcript-primary those two
  // boxes have different right edges: the terminal IS the docked panel (its own
  // edge is clear), but the strip still has to step left by that panel's width.
  // A single shared value answered the terminal's question and froze the strip.
  const shared = {
    treeMode: false, pinned: false, width: 0,
    sideTerminalOpen: true, sideTerminalWidth: 620,
    sideHistoryOpen: false, sideHistoryWidth: 580,
    sidePanelPinned: false,
  };
  // Centre-anchored (Run after): must dodge the docked terminal.
  assert.equal(resolveCenterRightInset(shared), 620);
  // Terminal-anchored (its own arrow): nothing to dodge, it is the panel.
  assert.equal(resolveCenterRightInset({ ...shared, isSidePanel: true }), 0);
});

test('closing the panel returns both to the edge', () => {
  const closed = {
    treeMode: false, pinned: false, width: 0,
    sideTerminalOpen: false, sideTerminalWidth: 620,
    sideHistoryOpen: false, sideHistoryWidth: 580,
  };
  assert.equal(resolveCenterRightInset(closed), 0);
  assert.equal(resolveCenterRightInset({ ...closed, isSidePanel: true }), 0);
});

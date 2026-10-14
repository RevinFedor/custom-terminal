import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceFolderDwell,
  isPointInsideGestureRegion,
  leaseForScrollPosition,
  mergeControlledOutline,
  nextFolderRowExpansion,
  normalizeOutsidePointerPolicy,
  reserveForScrollTarget,
  resolveHorizontalMovePolicy,
  setOutlineExpanded,
  shouldToggleFolderRowClick,
  shouldTrackExpansionPromise,
} from './pointer.js';

test('horizontal corridor extends only the X axis of the gesture region', () => {
  const rect = { left: 100, right: 300, top: 40, bottom: 440 };

  assert.equal(normalizeOutsidePointerPolicy('unknown'), 'cancel');
  assert.equal(isPointInsideGestureRegion(450, 200, rect, 'cancel'), false);
  assert.equal(isPointInsideGestureRegion(450, 200, rect, 'horizontal-corridor'), true);
  assert.equal(isPointInsideGestureRegion(-50, 200, rect, 'horizontal-corridor'), true);
  assert.equal(isPointInsideGestureRegion(200, 20, rect, 'horizontal-corridor'), false);
  assert.equal(isPointInsideGestureRegion(200, 460, rect, 'horizontal-corridor'), false);
});

test('host horizontal policy can block a valid core mutation with a stable reason', () => {
  assert.deepEqual(resolveHorizontalMovePolicy(undefined), { ok: true, reason: null });
  assert.deepEqual(resolveHorizontalMovePolicy(true), { ok: true, reason: null });
  assert.deepEqual(resolveHorizontalMovePolicy(false), { ok: false, reason: 'host-policy' });
  assert.deepEqual(
    resolveHorizontalMovePolicy({ ok: false, reason: 'group-depth-locked' }),
    { ok: false, reason: 'group-depth-locked' },
  );
});

test('scroll reserve stays zero until a measured anchor needs extra range', () => {
  assert.equal(reserveForScrollTarget({
    currentReserve: 0,
    physicalMax: 420,
    targetScrollTop: 420,
  }), 0);

  assert.equal(reserveForScrollTarget({
    currentReserve: 0,
    physicalMax: 420,
    targetScrollTop: 673.25,
  }), 254);
});

test('scroll reserve grows from an existing lease and never guesses row height', () => {
  assert.equal(reserveForScrollTarget({
    currentReserve: 83,
    physicalMax: 503,
    targetScrollTop: 618.4,
  }), 199);

  assert.equal(reserveForScrollTarget({
    currentReserve: 199,
    physicalMax: 619,
    targetScrollTop: 580,
  }), 199);
});

test('scroll reserve includes viewport underfill when the list is shorter than its scroller', () => {
  assert.equal(reserveForScrollTarget({
    currentReserve: 0,
    physicalMax: 0,
    naturalMax: -400,
    targetScrollTop: 63,
  }), 463);

  assert.equal(reserveForScrollTarget({
    currentReserve: 463,
    physicalMax: 63,
    naturalMax: -400,
    targetScrollTop: 30,
  }), 463);
});

test('post-drop lease keeps physical support until the anchored viewport returns naturally', () => {
  assert.deepEqual(leaseForScrollPosition({ naturalMax: -400, scrollTop: 63 }), {
    height: 463,
    naturalMax: -400,
    ceiling: 63,
  });
  assert.deepEqual(leaseForScrollPosition({ naturalMax: -400, scrollTop: 30 }), {
    height: 430,
    naturalMax: -400,
    ceiling: 30,
  });
  assert.equal(leaseForScrollPosition({ naturalMax: -400, scrollTop: 0 }), null);
  assert.deepEqual(leaseForScrollPosition({ naturalMax: 420, scrollTop: 618.4 }), {
    height: 199,
    naturalMax: 420,
    ceiling: 618.4,
  });
  assert.equal(leaseForScrollPosition({ naturalMax: 420, scrollTop: 420 }), null);
});

test('post-drop lease cannot regrow after the user releases part of its range', () => {
  const partiallyReleased = leaseForScrollPosition({
    naturalMax: -400,
    scrollTop: 30,
    ceiling: 63,
  });
  assert.deepEqual(partiallyReleased, {
    height: 430,
    naturalMax: -400,
    ceiling: 30,
  });
  assert.deepEqual(leaseForScrollPosition({
    naturalMax: -400,
    scrollTop: 55,
    ceiling: partiallyReleased.ceiling,
  }), partiallyReleased);
});

test('folder click outside a drag does not enter drag expansion bookkeeping', () => {
  assert.equal(shouldTrackExpansionPromise(null, null), false);
  assert.equal(shouldTrackExpansionPromise(undefined, null), false);
  assert.equal(
    shouldTrackExpansionPromise(
      { phase: 'pending', sessionId: 'pending' },
      { phase: 'pending', sessionId: 'pending' },
    ),
    false,
  );
  assert.equal(
    shouldTrackExpansionPromise(
      { phase: 'dragging', sessionId: 'active' },
      { phase: 'dragging', sessionId: 'active' },
    ),
    true,
  );
});

test('every eligible folder row click toggles regardless of multi-click detail', () => {
  for (const eventDetail of [1, 2, 3]) {
    assert.equal(shouldToggleFolderRowClick({
      collapsible: true,
      hasChildren: true,
      eventDetail,
    }), true);
  }
  assert.equal(shouldToggleFolderRowClick({
    collapsible: true,
    hasChildren: true,
    insideIgnoredControl: true,
  }), false);
  assert.equal(shouldToggleFolderRowClick({
    collapsible: false,
    hasChildren: true,
  }), false);
});

test('rapid folder row clicks toggle the latest optimistic outline instead of a stale rendered row', () => {
  let outline = [{
    id: 'folder',
    kind: 'folder',
    collapsible: true,
    expanded: false,
    hasChildren: true,
    children: [],
  }];

  const firstDesired = nextFolderRowExpansion(outline, 'folder');
  assert.equal(firstDesired, true);
  outline = setOutlineExpanded(outline, 'folder', firstDesired).outline;

  const secondDesired = nextFolderRowExpansion(outline, 'folder');
  assert.equal(secondDesired, false);
  outline = setOutlineExpanded(outline, 'folder', secondDesired).outline;
  assert.equal(outline[0].expanded, false);
});

test('async dwell pause preserves the completed cycle', () => {
  let result = advanceFolderDwell(null, {
    targetId: 'folder',
    now: 0,
    interval: 900,
  });
  result = advanceFolderDwell(result.dwell, {
    targetId: 'folder',
    now: 900,
    interval: 900,
  });
  assert.equal(result.shouldToggle, true);
  assert.equal(result.dwell.cycle, 1);

  result = advanceFolderDwell(result.dwell, {
    targetId: 'folder',
    pending: true,
    now: 901,
    interval: 900,
  });
  assert.equal(result.dwell.cycle, 1);
  assert.equal(result.dwell.progress, 0);

  result = advanceFolderDwell(result.dwell, {
    targetId: 'folder',
    pending: false,
    now: 1200,
    interval: 900,
  });
  assert.equal(result.dwell.cycle, 1);
  assert.equal(result.dwell.startedAt, 1200);
});

test('expansion patch changes folders but never file parents', () => {
  const outline = [
    { id: 'folder', kind: 'folder', collapsible: true, expanded: false, children: [] },
    { id: 'file', kind: 'file', collapsible: false, expanded: false, children: [] },
  ];
  const folder = setOutlineExpanded(outline, 'folder', true);
  assert.equal(folder.changed, true);
  assert.equal(folder.outline[0].expanded, true);

  const file = setOutlineExpanded(folder.outline, 'file', true);
  assert.equal(file.changed, false);
  assert.equal(file.outline[1].expanded, false);
});

test('controlled merge preserves preview placement and adds lazy children', () => {
  const preview = [
    {
      id: 'destination',
      kind: 'folder',
      collapsible: true,
      expanded: true,
      children: [{ id: 'source', kind: 'file', children: [] }],
    },
    { id: 'origin', kind: 'folder', collapsible: true, expanded: true, children: [] },
  ];
  const incoming = [
    {
      id: 'destination',
      kind: 'folder',
      collapsible: true,
      expanded: false,
      children: [{ id: 'loaded', kind: 'file', children: [] }],
    },
    {
      id: 'origin',
      kind: 'folder',
      collapsible: true,
      expanded: true,
      children: [{ id: 'source', kind: 'file', children: [] }],
    },
  ];
  const merged = mergeControlledOutline(
    preview,
    incoming,
    new Map([['destination', true]]),
  );

  assert.deepEqual(merged[0].children.map((node) => node.id), ['source', 'loaded']);
  assert.deepEqual(merged[1].children, []);
  assert.equal(merged[0].expanded, true);
});

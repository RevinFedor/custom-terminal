import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWindowDisplay, reconcileWindowDisplay, revealHiddenWindow, reconcileWorkspaceDisplayPatch,
  splitWindowPane, windowSplitAvailability, resolveHiddenWindowNavigationTarget } from './windowDisplayLayouts.mjs';
import { paneGridRects, paneColumns, paneTabs, paneSlots, selectChooserSlot, dropTabFromAllPaneStrips, sanitizePanes, removePaneAt, addTabToPane } from './splitPanesModel.mjs';
import { buildSessionSnapshot } from './sessionSnapshot.mjs';
import { captureSpaceLayout, restoreSpaces } from './workspaceSpacesModel.mjs';
import { applyWorkspaceWindowMutation } from './workspaceWindowMutation.mjs';
import { describeWorkspaceWindowTargets, resolveWorkspaceWindowTarget, workspacePlacementsForTab } from './workspaceWindowTarget.mjs';
import { onScreenTabIds } from './tabVisitHistoryRule.mjs';

const big = { key: 'external', internal: false };
const small = { key: 'builtin', internal: true };
const original = () => ({ splitPanes: ['a', 'b', 'c', 'd'].map((id, i) => ({
  projectId: 'p', tabId: id, column: Math.min(i, 2),
  ...(i === 2 ? { tabs: [{ projectId: 'p', tabId: 'c' }, { projectId: 'p', tabId: 'c2' }] } : {}),
})), splitFocusedIndex: 0, splitSizes: { cols: [.3, .3, .4], rows: [[1], [1], [.6, .4]] } });
const visible = layout => layout.splitPanes.filter(p => !p.displayHidden).map(p => p.tabId);
const idOf = (layout, tab) => layout.splitPanes.find(p => p.tabId === tab).windowId;

test('hidden navigation uses a remembered row within its column and falls back when that column is gone',()=>{
  const layout={windowDisplayKey:'builtin',splitFocusedIndex:0,splitPanes:[
    {windowId:'left',column:0},{windowId:'right-top',column:1},{windowId:'right-bottom',column:1},
    {windowId:'hidden',column:99,displayHidden:true}],
    windowDisplayLayouts:{builtin:{lastPositions:[{windowId:'hidden',column:1,row:1}]}}};
  assert.deepEqual(resolveHiddenWindowNavigationTarget(layout,'hidden'),{paneIndex:2,reason:'remembered-position'});
  const shorter={...layout,splitPanes:layout.splitPanes.filter(p=>p.windowId!=='right-bottom')};
  assert.equal(resolveHiddenWindowNavigationTarget(shorter,'hidden').paneIndex,1);
  const noRight={...layout,splitPanes:layout.splitPanes.filter(p=>p.column!==1)};
  assert.deepEqual(resolveHiddenWindowNavigationTarget(noRight,'hidden'),{paneIndex:0,reason:'focused-fallback'});
  assert.equal(resolveHiddenWindowNavigationTarget(layout,'left'),null);
});

test('legacy hidden rect is accepted only for one exact current place and survives first profile capture',()=>{
  const layout={windowDisplayKey:'builtin',splitFocusedIndex:0,splitSizes:null,splitPanes:[
    {windowId:'left',column:0},{windowId:'right',column:1},{windowId:'hidden',column:9,displayHidden:true,
      displayRect:{leftPct:50,topPct:0,widthPct:50,heightPct:100}}],
    windowDisplayLayouts:{builtin:{positions:[{windowId:'left',column:0,row:0},{windowId:'right',column:1,row:0}]}}};
  assert.deepEqual(resolveHiddenWindowNavigationTarget(layout,'hidden'),{paneIndex:1,reason:'legacy-exact-position'});
  const upgraded=reconcileWindowDisplay(layout,small);
  assert.deepEqual(resolveHiddenWindowNavigationTarget(upgraded,'hidden'),{paneIndex:1,reason:'remembered-position'});
  const foreign=structuredClone(layout);foreign.splitPanes[2].displayRect.widthPct=33;
  assert.equal(resolveHiddenWindowNavigationTarget(foreign,'hidden').paneIndex,0);
  foreign.splitPanes[2].displayRect.widthPct=NaN;
  assert.equal(resolveHiddenWindowNavigationTarget(foreign,'hidden').paneIndex,0);
});

test('current display memory neither inherits another display address nor retains a deleted window',()=>{
  let layout=applyWindowDisplay(applyWindowDisplay(original(),big),small);
  const target=idOf(layout,'c');
  assert.equal(resolveHiddenWindowNavigationTarget(layout,target).paneIndex,0,'external column is not laptop placement');
  layout=reconcileWindowDisplay(revealHiddenWindow(layout,1,target),small);
  layout=reconcileWindowDisplay({...layout,splitPanes:layout.splitPanes.filter(p=>p.windowId!==target)},small);
  for(const profile of Object.values(layout.windowDisplayLayouts)) {
    assert.ok(!profile.positions.some(p=>p.windowId===target));
    assert.ok(!(profile.lastPositions || []).some(p=>p.windowId===target));
  }
});

const hiddenSplitFixture = () => ({ windowDisplayKey: 'builtin', windowDisplayLayouts: {},
  splitFocusedIndex: 0, splitSizes: null, splitPanes: [
    { projectId: 'p', tabId: 'a', windowId: 'a' },
    { projectId: 'p', tabId: 'b', windowId: 'b', column: 7, displayHidden: true,
      displayRect: { leftPct: 50, widthPct: 50, topPct: 0, heightPct: 100 },
      tabs: [{ projectId: 'p', tabId: 'b' }, { projectId: 'q', tabId: 'b2' }] },
  ] });

for (const side of ['left', 'right', 'above', 'below']) {
  test(`split hidden window ${side} uses the visible grid and preserves content identity`, () => {
    const initial = hiddenSplitFixture();
    const hidden = initial.splitPanes[1];
    const opened = splitWindowPane(freeze(initial.splitPanes), 0, null, 0, side);
    assert.equal(opened.panes.length, 2);
    assert.equal(opened.panes[opened.focusedIndex].windowId, 'b');
    assert.deepEqual(paneSlots(opened.panes[opened.focusedIndex]), paneSlots(hidden));
    const rect = paneGridRects(opened.panes, null)[opened.focusedIndex];
    assert.deepEqual(rect, side === 'left'
      ? { leftPct: 0, topPct: 0, widthPct: 50, heightPct: 100 }
      : side === 'right' ? { leftPct: 50, topPct: 0, widthPct: 50, heightPct: 100 }
      : side === 'above' ? { leftPct: 0, topPct: 0, widthPct: 100, heightPct: 50 }
      : { leftPct: 0, topPct: 50, widthPct: 100, heightPct: 50 });
  });
}

test('split preserves other hidden windows, then falls back to the ordinary empty slot', () => {
  const initial = hiddenSplitFixture();
  const other = { projectId: 'p', tabId: 'c', windowId: 'c', displayHidden: true, column: 10 };
  let next = splitWindowPane([...initial.splitPanes, other], 0, null, 0);
  assert.strictEqual(next.panes[2], other, 'hidden geometry is not re-columned by the visible split');
  assert.equal(next.panes[2].displayHidden, true);
  next = splitWindowPane(next.panes, 1, null, 1);
  assert.deepEqual(next.panes.map(p => p.windowId), ['a', 'b', 'c']);
  next = splitWindowPane(next.panes, 2, null, 2);
  assert.equal(next.panes.length, 4);
  assert.equal(next.panes[3].tabId, '');
  assert.equal(splitWindowPane(next.panes, 3, null, 3), null);
});

test('filling a fresh placeholder removes its profile address without changing another monitor layout', () => {
  let layout = hiddenSplitFixture();
  layout.splitPanes.splice(1, 0, { projectId: '', tabId: '', windowId: 'placeholder', column: 1 });
  layout = reconcileWindowDisplay(layout, small);
  const external = { positions: [{ windowId: 'b', column: 0, row: 0 }, { windowId: 'a', column: 1, row: 0 }],
    focusedWindowId: 'a', sizes: { cols: [.4, .6], rows: [[1], [1]] } };
  layout.windowDisplayLayouts.external = external;
  assert.equal(windowSplitAvailability(layout.splitPanes, 0).horizontal, true);
  layout = reconcileWindowDisplay(revealHiddenWindow(layout, 1, 'b'), small);
  assert.equal(layout.splitPanes.length, 2);
  assert.ok(!JSON.stringify(layout.windowDisplayLayouts).includes('placeholder'));
  assert.deepEqual(layout.windowDisplayLayouts.external, external);
  const roundTrip = applyWindowDisplay(applyWindowDisplay(layout, big), small);
  assert.deepEqual(visible(roundTrip), ['a', 'b']);
  assert.equal(roundTrip.splitPanes.length, 2);
});

test('chooser, parked chips and return history are not disposable blank windows', () => {
  for (const fields of [
    { tabs: [{ slotId: 'choose', projectId: 'p' }], selectedSlotId: 'choose' },
    { tabs: [{ projectId: 'p', tabId: 'parked' }] },
    { history: [{ projectId: 'p', tabId: 'previous' }] },
    { prevProjectId: 'p', prevTabId: 'legacy-previous' },
    { detachedTabs: [{ projectId: 'p', tabId: 'removed', closedOrder: 4 }] },
  ]) {
    const layout = hiddenSplitFixture();
    layout.splitPanes[0] = { projectId: '', tabId: '', windowId: 'a', ...fields };
    const shown = revealHiddenWindow(layout, 0, 'b');
    assert.equal(shown.splitPanes.length, 2);
    assert.equal(shown.splitPanes[1].windowId, 'a');
    assert.equal(shown.splitPanes[1].displayHidden, true);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(shown.splitPanes[1][key], value);
  }
});

test('a hidden empty window cannot disable a visible split and a stale hidden anchor cannot move it', () => {
  const panes = [{ projectId: 'p', tabId: 'a', windowId: 'a' },
    { projectId: '', tabId: '', windowId: 'hidden-blank', displayHidden: true }];
  assert.equal(windowSplitAvailability(panes, 0).horizontal, true);
  assert.equal(splitWindowPane(panes, 0, null, 1), null);
  const next = splitWindowPane(panes, 0, null, 0);
  assert.equal(next.panes.length, 2);
  assert.equal(next.panes[1].windowId, 'hidden-blank');
  assert.equal(next.panes[1].displayHidden, false);
});

test('hidden source remains an exact MCP target; sidebar switcher can still offer its tabs', () => {
  const layout = applyWindowDisplay(applyWindowDisplay(original(), big), small);
  const spaces = describeWorkspaceWindowTargets({ spaces: [{ id: 's', name: 'main', layout }], activeSpaceId: 's', fingerprint: 'revision' });
  const placement = workspacePlacementsForTab(spaces, 'c')[0];
  assert.equal(placement.hidden, true);
  assert.equal(placement.shown, true);
  const target = resolveWorkspaceWindowTarget({ describedSpaces: spaces, activeSpaceId: 's', sourceTabId: 'c', fingerprint: 'revision', target: { anchor: 'source', mode: 'same-window' } });
  assert.equal(target.ok, true);
  assert.equal(target.paneIndex, 2);
  const changed = applyWorkspaceWindowMutation({ layout, target, entries: [{ projectId: 'p', tabId: 'new' }] });
  assert.equal(changed.ok, true);
  assert.deepEqual(visible(changed.layout), ['a', 'b']);
  assert.ok(paneTabs(changed.layout.splitPanes[2]).some(t => t.tabId === 'new'));
  assert.equal(onScreenTabIds({ panes: changed.layout.splitPanes }).includes('c2'), false);
});

test('a new window beside a hidden source is placed offscreen without changing the laptop layout', () => {
  const layout = applyWindowDisplay(applyWindowDisplay(original(), big), small);
  const changed = applyWorkspaceWindowMutation({ layout,
    target: { ok: true, paneIndex: 2, mode: 'new-window', side: 'below' },
    entries: [{ projectId: 'p', tabId: 'background-new' }], focus: false, show: false });
  assert.equal(changed.ok, true);
  assert.deepEqual(visible(changed.layout), ['a', 'b']);
  assert.equal(changed.layout.splitPanes[changed.paneIndex].tabId, 'background-new');
  assert.equal(changed.layout.splitPanes[changed.paneIndex].displayHidden, true);
  const returned = applyWindowDisplay(changed.layout, big);
  assert.ok(visible(returned).includes('background-new'));
});

test('external → laptop → whole window switch → external → laptop remembers geometry, not duplicate content', () => {
  const large = applyWindowDisplay(original(), big, 's');
  const oldRects = paneGridRects(large.splitPanes, large.splitSizes);
  let laptop = applyWindowDisplay(large, small, 's');
  assert.deepEqual(visible(laptop), ['a', 'b']);
  assert.deepEqual(paneColumns(laptop.splitPanes).map(c => c.length), [1, 1]);
  laptop = reconcileWindowDisplay(revealHiddenWindow(laptop, 1, idOf(laptop, 'c')), small);
  assert.deepEqual(visible(laptop), ['a', 'c']);
  assert.deepEqual(paneTabs(laptop.splitPanes[1]).map(p => p.tabId), ['c', 'c2']);
  laptop.splitSizes = { cols: [.45, .55], rows: [[1], [1]] };
  const moved = addTabToPane(laptop.splitPanes, 1, 'p', 'new');
  laptop = reconcileWindowDisplay({ ...laptop, splitPanes: moved.panes }, small);
  const returned = applyWindowDisplay(laptop, big);
  assert.deepEqual(paneGridRects(returned.splitPanes, returned.splitSizes), oldRects);
  assert.deepEqual(visible(returned), ['a', 'b', 'new', 'd']);
  assert.equal(returned.splitPanes[2].windowId, large.splitPanes[2].windowId);
  const again = applyWindowDisplay(returned, small);
  assert.deepEqual(visible(again), ['a', 'new']);
  assert.deepEqual(again.splitSizes.cols, [.45, .55]);
  // UUIDs can legitimately contain "c2". Test the absence of tab CONTENT,
  // not a substring that may appear in an unrelated window address.
  assert.doesNotMatch(JSON.stringify(again.windowDisplayLayouts), /"(tabs|tabId|projectId|history|selectedSlotId)":/);
});

test('first laptop visit retains focused window even when it was fourth', () => {
  const layout = original(); layout.splitFocusedIndex = 3;
  const next = applyWindowDisplay(layout, small);
  assert.deepEqual(visible(next), ['a', 'd']);
  assert.equal(next.splitPanes[next.splitFocusedIndex].tabId, 'd');
  assert.equal(applyWindowDisplay(next, big).splitPanes.length, 4);
});

test('restore sanitizes tabs in hidden windows without losing their identity or profile', () => {
  let layout = applyWindowDisplay(applyWindowDisplay(original(), big), small);
  const cId = idOf(layout, 'c');
  const scrubbed = sanitizePanes(layout.splitPanes, layout.splitFocusedIndex, (_p, tab) => tab !== 'c');
  layout = { ...layout, splitPanes: scrubbed.panes };
  assert.equal(layout.splitPanes.length, 4);
  const state = { ...layout, openProjects: new Map(), activeSpaceId: 's', spaces: [{ id: 's', layout }] };
  const saved = JSON.parse(JSON.stringify(buildSessionSnapshot(state)));
  const restored = restoreSpaces(saved, saved).spaces.find(s => s.id === 's').layout;
  const large = applyWindowDisplay(restored, big);
  const c = large.splitPanes.find(p => p.windowId === cId);
  assert.equal(c.tabId, '');
  assert.deepEqual(paneTabs(c).map(p => p.tabId), ['c2']);
});

test('Full cannot revive a tab from another monitor profile', () => {
  let layout = applyWindowDisplay(applyWindowDisplay(original(), big), small);
  const removed = dropTabFromAllPaneStrips(layout.splitPanes, 'c2');
  layout = reconcileWindowDisplay({ ...layout, splitPanes: removed.panes }, small);
  assert.equal(applyWindowDisplay(layout, big).splitPanes.flatMap(paneTabs).some(t => t.tabId === 'c2'), false);
});

test('closing windows removes references from profiles; last visible slot leaves a vacancy', () => {
  let layout = applyWindowDisplay(applyWindowDisplay(original(), big), small);
  const aId = idOf(layout, 'a');
  for (let i = 0; i < 2; i++) {
    const removed = removePaneAt(layout.splitPanes, layout.splitFocusedIndex, 0);
    layout = reconcileWindowDisplay({ ...layout, splitPanes: removed.panes, splitFocusedIndex: removed.focusedIndex }, small);
  }
  assert.deepEqual(visible(layout), ['']);
  assert.equal(layout.splitPanes.filter(p => p.displayHidden).length, 2);
  assert.equal(JSON.stringify(layout.windowDisplayLayouts).includes(aId), false);
});

test('store boundary covers dormant layouts and skips non-layout traffic', () => {
  const state = { ...original(), workspaceDisplay: big, activeSpaceId: 's', isRestoring: false,
    spaces: [{ id: 's' }, { id: 'other', layout: original() }] };
  const first = { ...state, ...reconcileWorkspaceDisplayPatch(state, { workspaceDisplay: big }) };
  const next = { ...first, ...reconcileWorkspaceDisplayPatch(first, { workspaceDisplay: small }) };
  assert.deepEqual(visible(next), ['a', 'b']);
  assert.deepEqual(visible(next.spaces[1].layout), ['a', 'b']);
  assert.deepEqual(reconcileWorkspaceDisplayPatch(next, { unrelated: 1 }), { unrelated: 1 });
  assert.equal(captureSpaceLayout(next).windowDisplayKey, 'builtin');
});

function mixedHiddenLayout() {
  const layout = original();
  layout.splitPanes.forEach(pane => { pane.windowId = 'window-' + pane.tabId; });
  layout.splitPanes[1].tabs = [
    { projectId: 'p', tabId: 'b' }, { slotId: 'outgoing-slot', projectId: 'p', cwd: '/outgoing' },
  ];
  Object.assign(layout.splitPanes[2], {
    tabs: [
      { slotId: 'leading', projectId: 'p', cwd: '/leading' },
      { projectId: 'p', tabId: 'c' },
      { slotId: 'middle', projectId: 'q', cwd: '/middle' },
      { projectId: 'q', tabId: 'c2' },
      { slotId: 'trailing', projectId: 'p', cwd: '/trailing' },
    ],
    history: [{ projectId: 'p', tabId: 'older' }],
    detachedTabs: [{ projectId: 'p', tabId: 'detached', closedOrder: 9 }],
  });
  return applyWindowDisplay(applyWindowDisplay(layout, big), small);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('reveal selects a parked cross-project tab without changing mixed order or other window content', () => {
  const layout = freeze(mixedHiddenLayout());
  const incoming = layout.splitPanes[2];
  const next = revealHiddenWindow(layout, 1, incoming.windowId, { projectId: 'q', tabId: 'c2' });
  assert.equal(next.splitFocusedIndex, 1);
  assert.equal(next.splitPanes[1].projectId, 'q');
  assert.equal(next.splitPanes[1].tabId, 'c2');
  assert.equal(next.splitPanes[1].selectedSlotId, undefined);
  assert.deepEqual(paneSlots(next.splitPanes[1]), paneSlots(incoming));
  assert.deepEqual(next.splitPanes[1].history, [
    { projectId: 'p', tabId: 'c' }, { projectId: 'p', tabId: 'older' },
  ]);
  assert.deepEqual(next.splitPanes[1].detachedTabs, incoming.detachedTabs);
  assert.deepEqual(next.splitPanes[2], {
    ...layout.splitPanes[1], displayHidden: true,
    displayRect: paneGridRects(layout.splitPanes, layout.splitSizes)[1],
  });
  assert.equal(next.splitPanes[0], layout.splitPanes[0]);
  assert.equal(next.splitPanes[3], layout.splitPanes[3]);
  assert.equal(next.splitSizes, layout.splitSizes);
  assert.equal(next.windowDisplayLayouts, layout.windowDisplayLayouts);
});

test('chooser reveal keeps every chip and retains an already selected chooser', () => {
  const layout = freeze(mixedHiddenLayout());
  const next = revealHiddenWindow(layout, 0, 'window-c', { slotId: 'middle' });
  assert.equal(next.splitPanes[0].tabId, '');
  assert.equal(next.splitPanes[0].projectId, '');
  assert.equal(next.splitPanes[0].selectedSlotId, 'middle');
  assert.deepEqual(paneSlots(next.splitPanes[0]), paneSlots(layout.splitPanes[2]));
  assert.deepEqual(next.splitPanes[0].history[0], { projectId: 'p', tabId: 'c' });

  const selected = { ...layout, splitPanes: selectChooserSlot(layout.splitPanes, 2, 'middle').panes };
  for (const selection of [undefined, { slotId: 'middle' }]) {
    const revealed = revealHiddenWindow(selected, 1, 'window-c', selection);
    assert.equal(revealed.splitPanes[1].selectedSlotId, 'middle');
    assert.equal(revealed.splitPanes[1].tabId, '');
    assert.deepEqual(revealed.splitPanes[1].history, selected.splitPanes[2].history);
    assert.deepEqual(paneSlots(revealed.splitPanes[1]), paneSlots(selected.splitPanes[2]));
  }
  const real = revealHiddenWindow(selected, 1, 'window-c', { projectId: 'q', tabId: 'c2' });
  assert.equal(real.splitPanes[1].tabId, 'c2');
  assert.equal(real.splitPanes[1].selectedSlotId, undefined);
  assert.deepEqual(paneSlots(real.splitPanes[1]), paneSlots(selected.splitPanes[2]));
});

test('default reveal and explicit current-tab reveal preserve the prior selection and history', () => {
  const layout = freeze(mixedHiddenLayout());
  for (const selection of [undefined, { projectId: 'p', tabId: 'c' }]) {
    const next = revealHiddenWindow(layout, 1, 'window-c', selection);
    const { displayHidden, displayRect, column, ...content } = layout.splitPanes[2];
    assert.deepEqual(next.splitPanes[1], { ...content, column: layout.splitPanes[1].column,
      displayHidden: false, displayRect: null });
  }
});

test('foreign, missing and malformed selections fail without changing layout', () => {
  const layout = freeze(mixedHiddenLayout());
  const before = JSON.stringify(layout);
  for (const selection of [
    { projectId: 'p', tabId: 'b' }, { projectId: 'p', tabId: 'c2' },
    { projectId: 'q', tabId: 'c' }, { projectId: 'p', tabId: 'missing' },
    { slotId: 'outgoing-slot' }, { slotId: 'missing' },
    { projectId: 'p', tabId: 'c', slotId: 'middle' },
    { projectId: 'p', tabId: 'c', extra: true }, { tabId: 'c' },
    { projectId: '', tabId: 'c' }, { slotId: '' }, { slotId: 1 }, {}, null, [], 'c',
  ]) {
    assert.equal(revealHiddenWindow(layout, 1, 'window-c', selection), null, JSON.stringify(selection));
    assert.equal(JSON.stringify(layout), before);
  }
  for (const targetIndex of [-1, 2, 20, 0.5, NaN]) {
    assert.equal(revealHiddenWindow(layout, targetIndex, 'window-c', { slotId: 'middle' }), null);
  }
  assert.equal(revealHiddenWindow(layout, 1, 'deleted-window', { slotId: 'middle' }), null);
});

test('repeated reveal is a no-op; swapping back and monitor round trips keep placement and selection', () => {
  const layout = freeze(mixedHiddenLayout());
  const next = reconcileWindowDisplay(revealHiddenWindow(layout, 1, 'window-c', { projectId: 'q', tabId: 'c2' }), small);
  assert.equal(revealHiddenWindow(next, 1, 'window-c', { slotId: 'middle' }), null);
  assert.deepEqual(next.windowDisplayLayouts.external, layout.windowDisplayLayouts.external);
  assert.deepEqual(next.windowDisplayLayouts.builtin.positions, [
    { windowId: 'window-a', column: 0, row: 0 }, { windowId: 'window-c', column: 1, row: 0 },
  ]);
  const returned = applyWindowDisplay(next, big);
  assert.deepEqual(returned.windowDisplayLayouts.external.positions, layout.windowDisplayLayouts.external.positions);
  assert.deepEqual(returned.splitSizes, layout.windowDisplayLayouts.external.sizes);
  assert.deepEqual(visible(returned), ['a', 'b', 'c2', 'd']);
  const laptop = applyWindowDisplay(returned, small);
  assert.deepEqual(visible(laptop), ['a', 'c2']);
  const outgoing = revealHiddenWindow(laptop, 1, 'window-b');
  assert.equal(outgoing.splitPanes[1].tabId, 'b');
  assert.deepEqual(paneSlots(outgoing.splitPanes[1]), paneSlots(layout.splitPanes[1]));
  const again = revealHiddenWindow(outgoing, 1, 'window-c');
  assert.equal(again.splitPanes[1].tabId, 'c2');
  assert.deepEqual(paneSlots(again.splitPanes[1]), paneSlots(layout.splitPanes[2]));
});

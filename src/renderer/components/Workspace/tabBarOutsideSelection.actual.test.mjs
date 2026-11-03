import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The real source of the "clear selection on click outside" effect. The guard
// is read from TabBar.tsx itself so a future edit that reintroduces the
// container-bounds shortcut for the sidebar fails here instead of in the UI.
const source = fs.readFileSync(new URL('./TabBar.tsx', import.meta.url), 'utf8');
const effect = source.slice(
  source.indexOf('// Clear tab selection on click outside TabBar'),
  source.indexOf('// The host model contains more data than DnD needs'),
);

test('the outside-click guard resolves a row, not the container, before clearing', () => {
  assert.ok(effect.includes('clearSelection(projectId)'), 'effect still clears the selection');
  // A row/group/opt-out element keeps the selection in BOTH layouts.
  assert.match(effect, /closest\('\[data-tab-id\], \[data-tab-group-id\], \[data-keep-selection\]'\)/);
  // The container-bounds check is the horizontal-only shortcut: the vertical
  // sidebar column spans the whole height, so its empty area below the last
  // tab is inside that element and used to swallow the click.
  assert.match(effect, /if \(!isVerticalLayout\) \{[\s\S]*parentElement[\s\S]*\}/);
  assert.ok(effect.indexOf('insideRow') < effect.indexOf('parentElement'),
    'the row check runs before the container check');
});

test('the effect re-subscribes when the layout changes', () => {
  const deps = effect.slice(effect.lastIndexOf('}, ['), effect.lastIndexOf(']);') + 3);
  assert.match(deps, /isVerticalLayout/);
  assert.match(deps, /selectedTabIds\.length/);
  assert.match(deps, /menuOnlyForProject/);
});

// Behavioural model of the shipped guard: same order, same early returns.
function clearsSelection({ row, keepSelection, contextMenu, isVerticalLayout, insideBarBounds }) {
  if (row) return false;
  if (!isVerticalLayout && insideBarBounds) return false;
  if (contextMenu) return false;
  if (keepSelection) return false;
  return true;
}

test('sidebar empty space clears, sidebar rows and opt-outs do not', () => {
  const V = { isVerticalLayout: true, insideBarBounds: true };
  assert.equal(clearsSelection({ ...V, row: true }), false, 'tab row keeps selection');
  assert.equal(clearsSelection({ ...V, contextMenu: true }), false, 'context menu keeps selection');
  assert.equal(clearsSelection({ ...V, keepSelection: true }), false, 'opt-out keeps selection');
  // The regression this test exists for.
  assert.equal(clearsSelection({ ...V }), true, 'empty area below the last tab clears');
  assert.equal(clearsSelection({ isVerticalLayout: true, insideBarBounds: false }), true,
    'workspace overlay outside the sidebar clears');
});

test('horizontal TabBar behaviour is unchanged', () => {
  const H = { isVerticalLayout: false };
  assert.equal(clearsSelection({ ...H, insideBarBounds: true, row: true }), false);
  assert.equal(clearsSelection({ ...H, insideBarBounds: true }), false,
    'the 30px strip still absorbs its own empty space');
  assert.equal(clearsSelection({ ...H, insideBarBounds: false }), true,
    'a click on the workspace overlay clears');
});

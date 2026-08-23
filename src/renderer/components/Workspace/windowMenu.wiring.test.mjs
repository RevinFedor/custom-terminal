import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const menu = read('MoveToWindowMenu.tsx');
const split = read('SplitPaneChrome.tsx');
const tabBar = read('TabBar.tsx');

test('tab and split entry points render the same complete window-menu component', () => {
  assert.match(tabBar, /<MoveToWindowMenu[\s\S]{0,240}preferredSide=\{submenuSide\}/);
  assert.match(split, /<MoveToWindowMenu[\s\S]{0,160}mode="swap"/);
  assert.doesNotMatch(split, /swapMapOpen|setSwapMapOpen/,
    'swap must not keep a second click-gated inline-map implementation');

  assert.match(menu, /const label = isSwap \? 'Поменять местами' : 'Move to window'/);
  assert.match(menu, /data-tab-context-action=\{isSwap \? undefined : 'move-to-window'\}/);
  assert.match(menu, /data-split-swap-item=\{isSwap \? true : undefined\}/);
});

test('the shared submenu opens on hover and owns viewport-aware flyout geometry', () => {
  assert.match(menu, /onMouseEnter=\{show\}/);
  assert.match(menu, /<SideFlyout/);
  assert.match(menu, /createPortal\(/);
  assert.match(menu, /resolveSubmenuSide\(\{/);
  assert.match(menu, /side=\{resolvedSide\}/);
  assert.match(menu, /edgePadding=\{CONTEXT_MENU_METRICS\.viewportInset\}/);
  assert.match(menu, /window\.addEventListener\('mousemove', onMove, true\)/);
  assert.match(menu, /pointInside\(event\.clientX, event\.clientY, flyout\)/);
});

test('window cards stay one compact row and only the vertical axis may scroll', () => {
  assert.match(menu, /windowPickerNaturalHeight\(maxRows\)/);
  assert.match(menu, /windowPickerNaturalWidth\(columnCount\)/);
  assert.match(menu, /minHeight: WINDOW_PICKER_METRICS\.cellHeight/);
  assert.match(menu, /height: WINDOW_PICKER_METRICS\.cellHeight/);
  assert.match(menu, /flex: `0 0 \$\{WINDOW_PICKER_METRICS\.cellHeight\}px`/);
  assert.match(menu, /viewportMaxHeight/);
  assert.match(menu, /overflowX: 'hidden'/);
  assert.match(menu, /overflowY: 'auto'/);
  assert.match(menu, /width: '100%'/);
  assert.doesNotMatch(menu, /width: naturalWidth/);
  assert.doesNotMatch(menu, /MAP_HEIGHT_PX|height:\s*104/);
});

test('split directions are ordered left, above, below and use shared row geometry', () => {
  const left = split.indexOf("label: 'Слева'");
  const above = split.indexOf("label: 'Сверху'");
  const below = split.indexOf("label: 'Снизу'");
  assert.ok(left >= 0 && left < above && above < below, 'direction order is left → above → below');
  assert.match(split, /Icon: PanelLeft, enabled: splitCan\.horizontal/);
  assert.match(split, /data-split-direction-item=\{side\}/);
  assert.match(split, /\.\.\.CONTEXT_MENU_ROW_STYLE/);
  assert.match(split, /data-context-menu-metrics=\{CONTEXT_MENU_METRICS_HOOK\}/);
  assert.match(split, /side === 'left'[\s\S]{0,180}addEmptySplitPane\(paneIndex \?\? null, 'left'\)/);
  assert.match(split, /addVerticalSplitPane\(paneIndex \?\? null, side\)/);
});

test('pane-chip close stays destructive but names its full scope compactly', () => {
  assert.match(tabBar, /const contextOpenedFromWindow = !!\(/);
  assert.match(tabBar, /tabContextSurface\(renameHostRef\.current, contextMenu\.tabId\)/);
  const close = tabBar.slice(
    tabBar.indexOf('data-tab-context-action="close"'),
    tabBar.indexOf('</button>', tabBar.indexOf('data-tab-context-action="close"')) + 9,
  );
  assert.match(close, /onClick=\{handleClose\}/, 'full close keeps the existing destructive action');
  assert.match(close, /data-tab-close-scope="full"/);
  assert.match(close, />\s*Full\s*</);
  assert.match(close, /\) : 'Close Tab'\}/, 'sidebar wording remains unchanged');
});

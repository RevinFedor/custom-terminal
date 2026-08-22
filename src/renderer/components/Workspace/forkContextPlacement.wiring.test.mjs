import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tabBar = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');
const uiStore = fs.readFileSync(path.join(here, '..', '..', 'store', 'useUIStore.ts'), 'utf8');

function forkBlock() {
  const at = tabBar.indexOf('  const handleContextFork = async');
  const end = tabBar.indexOf('  const handleContextForkToSDK', at);
  assert.ok(at >= 0 && end > at);
  return tabBar.slice(at, end);
}

test('pane context fork stays beside its source; sidebar context stays sidebar-only', () => {
  const block = forkBlock();
  const placement = tabBar.slice(
    tabBar.indexOf('  const placeContextCreatedTab = ('),
    tabBar.indexOf('  const handleContextFork = async'),
  );
  assert.match(block, /tabContextSurface\(renameHostRef\.current, tab\.id\)/);
  assert.match(block, /afterVisualSubtree: true/);
  assert.match(block, /placeContextCreatedTab\(contextSurface, tab\.id, newTabId\)/);
  assert.match(placement, /paneHoldsTab\(pane, sourceTabId\)/);
  assert.match(placement, /addTabToSplitPaneStrip\(paneIndex, projectId, newTabId\)/);
  assert.match(placement, /reorderSplitPaneTab\(paneIndex, newTabId, sourceIndex \+ 1\)/);
  assert.match(placement, /addTabToCenterStrip\(projectId, newTabId\)/);
  assert.match(placement, /reorderCenterStripTab\(projectId, newTabId, sourceIndex \+ 1\)/);
  assert.doesNotMatch(block, /activateCenterTab\(projectId, newTabId\)/,
    'shared activation would move a sidebar-only fork into the current window');
});

test('SDK context fork follows the same origin and subtree rules', () => {
  const at = tabBar.indexOf('  const handleContextForkToSDK = async');
  const end = tabBar.indexOf('  const handleCloseTab = async', at);
  const block = tabBar.slice(at, end);
  assert.match(block, /tabContextSurface\(renameHostRef\.current, tab\.id\)/);
  assert.match(block, /afterVisualSubtree: true/);
  assert.match(block, /background: true/);
  assert.match(block, /placeContextCreatedTab\(contextSurface, tab\.id, sdkTabId\)/);
});

test('fork keeps the source loader local and fresh tab presentation defaults to AI Chat', () => {
  const block = forkBlock();
  assert.match(block, /setTabPendingOperation\(projectId, tab\.id, operationLabel\)/);
  assert.match(block, /finally \{\s*clearOperationLabel\(\)/);
  assert.match(uiStore, /const APP_STATE_KEY_NEW_TAB_PRIMARY_SURFACE = 'newTabPrimarySurface'/);
  assert.match(uiStore, /const initialNewTabPrimarySurface[\s\S]{0,160}\? 'terminal'\s*:\s*'history'/);
  assert.match(uiStore, /sideTerminalOpenTabs: initialSideTerminalOpenTabs/);
});

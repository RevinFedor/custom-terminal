import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(renderer, 'App.tsx'), 'utf8');
const store = readFileSync(join(renderer, 'store/useWorkspaceStore.ts'), 'utf8');
const sidebar = readFileSync(join(renderer, 'components/Workspace/TabSidebar.tsx'), 'utf8');
const terminalArea = readFileSync(join(renderer, 'components/Workspace/TerminalArea.tsx'), 'utf8');
const switcher = readFileSync(join(renderer, 'components/Workspace/TabSwitcherOverlay.tsx'), 'utf8');
const paneChip = readFileSync(join(renderer, 'components/Workspace/PaneTabChip.tsx'), 'utf8');
const tabBar = readFileSync(join(renderer, 'components/Workspace/TabBar.tsx'), 'utf8');
const paneStrip = readFileSync(join(renderer, 'components/Workspace/PaneTabStrip.tsx'), 'utf8');
const spaceStrip = readFileSync(join(renderer, 'components/Workspace/SpaceStrip.tsx'), 'utf8');
const history = readFileSync(join(renderer, 'components/Workspace/HistoryPanel.tsx'), 'utf8');
const primaryFocus = readFileSync(join(renderer, 'utils/tabPrimaryInputFocus.ts'), 'utf8');
const css = readFileSync(join(renderer, 'styles/globals.css'), 'utf8');

test('left sidebar is an explicit keyboard-focus surface with visible ownership', () => {
  assert.match(app, /data-keyboard-focus-owner=\{activeArea\}/);
  assert.match(app, /closest\?\.\('\[data-keyboard-focus-surface="sidebar"\]'\)/);
  assert.match(sidebar, /data-keyboard-focus-surface="sidebar"/);
  assert.match(sidebar, /setActiveArea\('sidebar'\)/);
  assert.match(terminalArea, /setActiveArea\('workspace'\)/);
  assert.match(css, /data-keyboard-focus-owner="sidebar"[\s\S]*data-tab-sidebar/);
  assert.match(css, /data-keyboard-focus-owner="sidebar"[\s\S]*data-split-pane-focus-frame="1"/);
  assert.doesNotMatch(
    css,
    /data-keyboard-focus-owner="sidebar" \[data-split-pane-focus-actions\] \{[\s\S]{0,180}display: none/,
    'sidebar focus may dim pane actions but must not change strip width',
  );
  assert.match(paneChip, /data-chip-active=\{visuallyActive \? '1' : '0'\}/);
  assert.match(
    css,
    /\[data-chip-shown="1"\]:not\(\[data-chip-active="1"\]\)/,
    'sidebar focus may quiet other panes but must preserve the placed tab active marker',
  );
  assert.doesNotMatch(
    css,
    /\[data-chip-shown="1"\]\s*\{/,
    'a broad shown-chip override erases active feedback after sidebar replacement',
  );
});

test('Cmd+T asks the common focus resolver and sidebar creation has no pane placement', () => {
  const start = app.indexOf('// Cmd+T - New Tab or New Project');
  const end = app.indexOf('// Arrow keys for project navigation', start);
  const body = app.slice(start, end);
  assert.match(body, /const keyboardTarget = readKeyboardFocusTarget\(\)/);
  assert.match(body, /keyboardTarget\.kind === 'sidebar'/);
  assert.match(body, /createTabAfterCurrent\(sidebarProjectId,[\s\S]*background: true/);
  assert.match(body, /pendingEditTabId: newTabId/);
  const sidebarBranch = body.slice(body.indexOf("keyboardTarget.kind === 'sidebar'"), body.indexOf("keyboardTarget.kind === 'pane'"));
  assert.doesNotMatch(sidebarBranch, /addTabToSplitPaneStrip|placeTab\(/);
});

test('Cmd+W detaches the exact focused pane tab and an empty pane is a no-op', () => {
  const start = app.indexOf('// Cmd+W - Close Tab/Project');
  const end = app.indexOf('// Cmd+, - Toggle Settings Modal', start);
  const body = app.slice(start, end);
  assert.match(body, /if \(!keyboardTarget\.projectId \|\| !keyboardTarget\.tabId\) return/);
  assert.match(body, /detachTabFromWindow\([\s\S]*keyboardTarget\.projectId,[\s\S]*keyboardTarget\.tabId,[\s\S]*keyboardTarget\.paneIndex/);
  assert.doesNotMatch(body.slice(body.indexOf("keyboardTarget.kind === 'pane'"), body.indexOf('const targetProjectId')), /closeTab\(/);
  const detachStart = store.indexOf('detachTabFromWindow: (projectId, tabId, paneIndex) => {');
  const detach = store.slice(detachStart, store.indexOf('\n  removeTabFromSplit:', detachStart));
  assert.match(detach, /restoreSplitPanePreviousTab\(tabId\)/);
  assert.match(detach, /clearTabFromSplitPane\(tabId\)/);
  assert.match(detach, /removeTabFromCenterStrip\(projectId, tabId\)/);
  assert.match(detach, /splitPanes: \[\{ projectId: '', tabId: '' \}\]/);
  assert.match(detach, /activeSpaceTab: null/);
});

test('global switcher commit returns keyboard ownership to its displayed pane', () => {
  const commit = switcher.slice(switcher.indexOf('const commitRow ='), switcher.indexOf('// Средний клик по строке'));
  assert.match(commit, /setActiveArea\('workspace'\)/);
  const refocus = app.slice(app.indexOf('const handleWindowRefocus ='), app.indexOf("ipcRenderer.on('window:refocus-active'"));
  assert.match(refocus, /activeArea !== 'workspace'/);
});

test('explicit tab and workflow focus returns input to the primary authoring surface', () => {
  assert.match(primaryFocus, /requestAnimationFrame\(\(\) => \{/);
  assert.match(primaryFocus, /window\.setTimeout\(\(\) => \{/);
  assert.match(primaryFocus, /requestVersion !== primaryInputFocusRequestVersion/);
  assert.match(primaryFocus, /focusedPane\.tabId !== tabId/);
  assert.match(primaryFocus, /focusedEditableBelongsToUser\(\)/);
  assert.match(primaryFocus, /historyPanelOpenTabs\[tabId\] === true/);
  assert.match(primaryFocus, /history-panel:focus-composer/);
  assert.match(primaryFocus, /claude-sdk:focus-composer/);
  assert.match(primaryFocus, /nt:window-refocus-active/);
  assert.match(primaryFocus, /\[Focus:PrimaryInput\]/);
  const sidebarActivation = tabBar.slice(
    tabBar.indexOf('const activateTabFromSidebar ='),
    tabBar.indexOf('const handleTabClick ='),
  );
  assert.match(sidebarActivation, /setActiveArea\('workspace'\)/);
  assert.match(tabBar, /requestTabPrimaryInputFocus\(tabId, 'sidebar-tab-click'\)/);
  assert.match(paneChip, /requestTabPrimaryInputFocus\(tabId, 'pane-tab-chip-click'\)/);
  assert.match(paneStrip, /requestFocusedWorkspacePrimaryInput\('pane-header-click'\)/);
  assert.match(terminalArea, /requestFocusedWorkspacePrimaryInput\('pane-body-click'\)/);
  const paneBodyFocusSelector = terminalArea.slice(
    terminalArea.indexOf('const preservesOwnFocus ='),
    terminalArea.indexOf(');', terminalArea.indexOf('const preservesOwnFocus =')) + 2,
  );
  assert.doesNotMatch(paneBodyFocusSelector, /\[data-history-owner\]|\[data-timeline\]/);
  assert.match(spaceStrip, /requestFocusedWorkspacePrimaryInput\('workflow-strip-click'\)/);
  assert.match(switcher, /requestTabPrimaryInputFocus\(row\.tab\.id, 'tab-switcher-commit'\)/);
  assert.match(history, /if \(detail\.immediate\) applyFocus\(\)/);
});

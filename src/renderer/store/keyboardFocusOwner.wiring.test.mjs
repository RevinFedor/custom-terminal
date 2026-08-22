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
const css = readFileSync(join(renderer, 'styles/globals.css'), 'utf8');

test('left sidebar is an explicit keyboard-focus surface with visible ownership', () => {
  assert.match(app, /data-keyboard-focus-owner=\{activeArea\}/);
  assert.match(app, /closest\?\.\('\[data-keyboard-focus-surface="sidebar"\]'\)/);
  assert.match(sidebar, /data-keyboard-focus-surface="sidebar"/);
  assert.match(sidebar, /setActiveArea\('sidebar'\)/);
  assert.match(terminalArea, /setActiveArea\('workspace'\)/);
  assert.match(css, /data-keyboard-focus-owner="sidebar"[\s\S]*data-tab-sidebar/);
  assert.match(css, /data-keyboard-focus-owner="sidebar"[\s\S]*data-split-pane-focus-frame="1"/);
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sidebar = fs.readFileSync(path.join(here, 'TabSidebar.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(here, 'Workspace.tsx'), 'utf8');
const tabBar = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');

test('every open project keeps one persistent sidebar layer', () => {
  assert.match(workspace, /<PersistentTabSidebarStack/);
  assert.match(workspace, /projectIds=\{persistentSidebarProjectIds\}/);
  assert.match(workspace, /presentedProjectId=\{presentedSidebarProjectId\}/);
  assert.match(sidebar, /data-tab-sidebar-layer=\{projectId\}/);
  assert.match(sidebar, /opacity: presented \? 1 : 0/);
  assert.match(sidebar, /inert=\{!presented\}/);
  assert.match(sidebar, /pointerEvents: presented \? 'auto' : 'none'/);
  assert.match(sidebar, /const TabSidebar = React\.memo\(TabSidebarComponent\)/);
});

test('hidden sidebars prewarm serially after startup and never cool down', () => {
  assert.match(sidebar, /const sidebarWarmQueue: Array<\(\) => void> = \[\]/);
  assert.match(sidebar, /requestIdleCallback/);
  assert.match(sidebar, /subscribeStartupRestoreProgress/);
  assert.match(sidebar, /awokenProjectIds\.has\(projectId\)/);
  assert.match(sidebar, /\[Perf:SidebarWake\] phase=painted/);
  assert.doesNotMatch(sidebar, /setAwokenProjectIds\(new Set\(\[presentedProjectId\]\)\)/,
    'presentation changes may add a surface but must not discard warm siblings');
});

test('TabBar subscribes to its project projection, not the whole project Map', () => {
  assert.doesNotMatch(tabBar, /useWorkspaceStore\(\(state\) => state\.openProjects\);/);
  assert.match(tabBar, /tabSidebarProjectFingerprint\(state\.openProjects\.get\(projectId\)\)/);
  assert.match(tabBar, /openProjectIdsFingerprint\(state\.openProjects\)/);
  assert.doesNotMatch(tabBar, /state\.activeProjectId === projectId/,
    'a hidden project should retain its own active row before it is shown');
});

test('a hidden retained list cannot steal a pane context menu', () => {
  assert.match(tabBar, /closest<HTMLElement>\('\[data-tab-sidebar-layer\]'\)/);
  assert.match(tabBar, /layer\.dataset\.sidebarPresented !== '1'/);
});

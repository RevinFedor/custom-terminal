import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'Workspace.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'TabSidebar.tsx'), 'utf8');
const navigation = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'WorkspaceNavigationRow.tsx'), 'utf8');
const tools = fs.readFileSync(path.join(renderer, 'components', 'Workspace', 'SidebarToolsRow.tsx'), 'utf8');

test('one navigation row owns project tools and workflow strip across Dashboard and Workspace', () => {
  const navigationIndex = app.indexOf('<WorkspaceNavigationRow');
  const dashboardIndex = app.indexOf("{view === 'dashboard' && <Dashboard />}");
  const workspaceIndex = app.indexOf('<Workspace\n', dashboardIndex);
  assert.ok(navigationIndex > 0 && dashboardIndex > navigationIndex && workspaceIndex > dashboardIndex);
  assert.match(app, /dashboard=\{view === 'dashboard'\}/);
  assert.match(navigation, /<SidebarToolsRow[\s\S]*?presentation=\{dashboard \? 'dashboard' : 'workspace'\}/);
  assert.match(navigation, /<SpaceStrip/);
  assert.match(navigation, /openProjects\.has\(INBOX_PROJECT_ID\)/);
  assert.doesNotMatch(workspace, /<SpaceStrip/);
  assert.doesNotMatch(sidebar, /<SidebarToolsRow/);
});

test('Dashboard contracts directory tools to History and re-enters the selected Project Home', () => {
  assert.match(tools, /presentation === 'workspace' && !isSystemProject/);
  assert.match(tools, /presentation === 'dashboard'[\s\S]*?setProjectView\(projectId, 'home'\)[\s\S]*?showWorkspace\(projectId\)/);
  assert.match(tools, /data-sidebar-tools-presentation=\{presentation\}/);
});

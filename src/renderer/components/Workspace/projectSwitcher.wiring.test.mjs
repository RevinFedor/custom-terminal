// Ctrl+Q project-switcher wiring that the pure row model cannot prove.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const overlay = fs.readFileSync(path.join(here, 'ProjectSwitcherOverlay.tsx'), 'utf8');
const terminal = fs.readFileSync(path.join(here, 'Terminal.tsx'), 'utf8');
const app = fs.readFileSync(path.join(here, '..', '..', 'App.tsx'), 'utf8');
const store = fs.readFileSync(path.join(here, '..', '..', 'store', 'useWorkspaceStore.ts'), 'utf8');

test('Ctrl+Q never reaches either xterm key handler', () => {
  const swallows = terminal.match(
    /event\.ctrlKey && !event\.metaKey && !event\.altKey\s*\n?\s*&& event\.type === 'keydown' && event\.code === 'KeyQ'/g,
  ) || [];
  assert.equal(swallows.length, 2);
});

test('the layout-independent singleton is mounted exactly once', () => {
  assert.match(overlay, /event\.code === 'KeyQ'/);
  assert.doesNotMatch(overlay, /event\.key === 'q'/i);
  assert.equal((app.match(/<ProjectSwitcherOverlay\s*\/>/g) || []).length, 1);
  assert.match(app, /import ProjectSwitcherOverlay from/);
  assert.doesNotMatch(app, /WorkflowSwitcherOverlay/);
});

test('fast release rebuilds rows from live project state', () => {
  const keyUp = overlay.slice(overlay.indexOf('const onKeyUp'), overlay.indexOf('const onBlur'));
  assert.match(keyUp, /computeProjectRows\(\)/);
  assert.match(keyUp, /initialProjectIndex\(effectiveRows\)/);
});

test('closing synchronously releases keyboard ownership', () => {
  const close = overlay.slice(overlay.indexOf('const close'), overlay.indexOf('const commitRow'));
  assert.match(close, /openRef\.current = false;/);
});

test('project commit reuses sidebar-only navigation and cannot switch workflow', () => {
  const commit = overlay.slice(overlay.indexOf('const commitRow'), overlay.indexOf('useEffect(() => {'));
  assert.match(commit, /if \(!row \|\| row\.current\) return;/);
  assert.match(commit, /showDashboard\(\)/);
  assert.match(commit, /showWorkspace\(row\.id\)/);
  assert.doesNotMatch(commit, /openProject\(/);
  assert.doesNotMatch(commit, /switchWorkspaceSpace\(/);

  const showWorkspace = store.slice(store.indexOf('showWorkspace: (projectId) =>'), store.indexOf('openProject: async'));
  assert.match(showWorkspace, /focusedProjectId: projectId/);
  assert.match(showWorkspace, /\.\.\.\(centerAlive \? \{\} : \{ activeProjectId: projectId \}\)/);
  assert.doesNotMatch(showWorkspace, /switchWorkspaceSpace/);
});

test('rows use project icons and preview the matching titlebar card', () => {
  assert.match(overlay, /data-project-icon=\{row\.id\}/);
  assert.doesNotMatch(overlay, /data-workflow-icon/);
  assert.match(overlay, /emitProjectHoverPreview\(row\?\.kind === 'project' \? row\.id : null\)/);
  assert.match(overlay, /if \(!open\) \{[\s\S]*emitProjectHoverPreview\(null\)/);
  assert.match(app, /const hovered = isHovered \|\| isPreviewHovered;/);
});

test('the anchor row is visually distinct from the selected target', () => {
  assert.match(overlay, /row\.current \? 'inset 2px 0 0 0 #6e6e76' : 'none'/);
});

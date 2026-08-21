import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');
const repoRoot = path.resolve(rendererRoot, '..', '..');
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const chrome = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/SplitPaneChrome.tsx'), 'utf8');
const area = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TerminalArea.tsx'), 'utf8');
const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8');
const database = fs.readFileSync(path.join(repoRoot, 'src/main/database.js'), 'utf8');

test('double-click creates a durable window-scoped tab before placing its chip', () => {
  assert.match(chrome, /background: true,[\s\S]{0,500}windowScoped: true,[\s\S]{0,500}visualParentTabId: '',/);
  assert.match(chrome, /addTabToSplitPaneStrip\(paneIndex, owner, newTabId\)/);
  assert.match(store, /windowScoped\?: boolean/);
  assert.match(store, /isTabPlacedInWorkspace: \(tabId\) => \{/);
  assert.match(store, /layout\?\.centerStrips/);
});

test('empty-pane launch uses pane placement as the visible commit', () => {
  assert.match(area, /const placeInTargetPane = \(createdTabId: string\) => \{/);
  assert.match(area, /current\.addTabToSplitPaneStrip\(paneIndex, targetProjectId, createdTabId\)/);
  assert.match(area, /background: true,[\s\S]{0,120}windowScoped: true/);
  assert.match(area, /placeInTargetPane\(createdTabId\)/);
  assert.match(store, /createSDKTab:[\s\S]{0,250}windowScoped\?: boolean/);
});

test('Shift+Cmd+T captures the focused pane and restores into it', () => {
  assert.match(app, /const targetPaneIndex = ws\.splitPanes\.length > 0 \? ws\.splitFocusedIndex : -1/);
  assert.match(app, /ws\.reopenLastClosedTab\(restoreProjectId, targetPaneIndex >= 0/);
  assert.match(store, /reopenLastClosedTab: \(projectId, options\) => \{/);
  assert.match(store, /background: paneTargetExists/);
  assert.match(store, /current\.addTabToSplitPaneStrip\(requestedPaneIndex, projectId, result\.tabId\)/);
});

test('window-scoped ownership survives save, restart, close and restore', () => {
  assert.match(database, /ALTER TABLE tabs ADD COLUMN window_scoped INTEGER DEFAULT 0/);
  assert.match(database, /ALTER TABLE tab_history ADD COLUMN window_scoped INTEGER DEFAULT 0/);
  assert.match(database, /windowScoped: t\.window_scoped === 1 \|\| undefined/);
  assert.match(database, /tab\.windowScoped \? 1 : 0/);
  assert.match(store, /windowScoped: entry\.window_scoped === 1 \|\| undefined/);
  assert.match(store, /windowScoped: tab\.windowScoped/);
});

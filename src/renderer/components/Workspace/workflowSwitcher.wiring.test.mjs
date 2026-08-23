// Ctrl+Q — workflow switcher wiring beyond the pure model.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const overlay = fs.readFileSync(path.join(here, 'WorkflowSwitcherOverlay.tsx'), 'utf8');
const terminal = fs.readFileSync(path.join(here, 'Terminal.tsx'), 'utf8');
const app = fs.readFileSync(path.join(here, '..', '..', 'App.tsx'), 'utf8');

test('Ctrl+Q never reaches the PTY — both xterm handlers swallow it', () => {
  const swallows = terminal.match(
    /event\.ctrlKey && !event\.metaKey && !event\.altKey\s*\n?\s*&& event\.type === 'keydown' && event\.code === 'KeyQ'/g,
  ) || [];
  assert.equal(swallows.length, 2);
});

test('the gesture is keyboard-layout agnostic and mounted once', () => {
  assert.match(overlay, /event\.code === 'KeyQ'/);
  assert.doesNotMatch(overlay, /event\.key === 'q'/i);
  assert.equal((app.match(/<WorkflowSwitcherOverlay\s*\/>/g) || []).length, 1);
  assert.match(app, /import WorkflowSwitcherOverlay from/);
});

test('fast release rebuilds live workflow rows', () => {
  const keyUp = overlay.slice(overlay.indexOf('const onKeyUp'), overlay.indexOf('const onBlur'));
  assert.match(keyUp, /computeWorkflowRows\(\)/);
  assert.match(keyUp, /initialWorkflowIndex\(effectiveRows\)/);
});

test('pointer commit closes keyboard ownership before Ctrl keyup can commit again', () => {
  const close = overlay.slice(overlay.indexOf('const close'), overlay.indexOf('const commitRow'));
  assert.match(close, /openRef\.current = false;/);
});

test('Ctrl+Q commits top-level places, never sidebar-only project parking', () => {
  const commit = overlay.slice(overlay.indexOf('const commitRow'), overlay.indexOf('useEffect(() => {'));
  assert.match(commit, /if \(!row \|\| row\.current\) return;/);
  assert.match(commit, /showDashboard\(\)/);
  assert.match(commit, /openProject\(INBOX_PROJECT_ID/);
  assert.match(commit, /switchWorkspaceSpace\(row\.id\)/);
  assert.doesNotMatch(commit, /showWorkspace\(row\.id\)/);
});

test('workflow icons stay colored while Inbox remains a project surface', () => {
  assert.match(overlay, /data-workflow-icon=\{row\.id\}/);
  assert.match(overlay, /workflowFallbackColor\(row\.id\)/);
  assert.match(overlay, /data-project-icon=\{INBOX_PROJECT_ID\}/);
  assert.match(overlay, /data-workflow-switcher-row=\{row\.id\}/);
});

test('the anchor row does not look like a target', () => {
  assert.match(overlay, /row\.current \? 'inset 2px 0 0 0 #6e6e76' : 'none'/);
});

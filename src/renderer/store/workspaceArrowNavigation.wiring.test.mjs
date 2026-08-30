import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');

test('workspace arrows are captured before composer/xterm and use one pure resolver', () => {
  const start = app.indexOf('const handleWorkspaceArrowNavigationCapture =');
  const end = app.indexOf("window.addEventListener('keydown', handleWorkspaceArrowNavigationCapture", start);
  assert.ok(start >= 0 && end > start, 'missing workspace arrow capture handler');
  const body = app.slice(start, end);

  assert.match(body, /resolveWorkspaceArrowCommand\(e\)/);
  assert.match(body, /resolveSpatialPaneTarget\(/);
  assert.match(body, /resolveWorkspaceCycleTarget\(/);
  assert.match(body, /navigationStore\.focusSplitPane\(targetPaneIndex\)/);
  assert.match(body, /navigationStore\.switchWorkspaceSpace\(targetSpaceId\)/);
  assert.match(body, /requestFocusedWorkspacePrimaryInput\('pane-arrow-navigation'\)/);
  assert.match(body, /requestFocusedWorkspacePrimaryInput\('workflow-arrow-navigation'\)/);
  assert.match(body, /preventDefault\(\)/);
  assert.match(body, /stopImmediatePropagation/);
  assert.match(app, /addEventListener\('keydown', handleWorkspaceArrowNavigationCapture, true\)/);
  assert.match(app, /removeEventListener\('keydown', handleWorkspaceArrowNavigationCapture, true\)/);
});

test('modal, picker and rename inputs keep their own arrow contract', () => {
  const start = app.indexOf('const handleWorkspaceArrowNavigationCapture =');
  const end = app.indexOf("window.addEventListener('keydown', handleWorkspaceArrowNavigationCapture", start);
  const body = app.slice(start, end);
  assert.match(body, /workspaceArrowNavigationBlocked\(e\.target, document\)/);
});

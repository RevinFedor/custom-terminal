import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const tabBar = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');
const controlBar = fs.readFileSync(path.join(workspaceDir, 'ClaudeControlBar.tsx'), 'utf8');

test('context Fork enters the clicked pane through canonical tab activation', () => {
  const start = tabBar.indexOf('const handleContextFork = async');
  const end = tabBar.indexOf('const handleContextForkToSDK', start);
  assert.ok(start >= 0 && end > start);
  const body = tabBar.slice(start, end);
  assert.match(body, /createTabAfterCurrent[\s\S]*?background: true/);
  assert.match(body, /paneIndexHoldingTab\(state\.splitPanes, tab\.id\)/);
  assert.match(body, /state\.focusSplitPane\(sourcePaneIndex\)/);
  assert.match(body, /state\.activateCenterTab\(projectId, newTabId\)/);
  assert.ok(
    body.indexOf('state.activateCenterTab(projectId, newTabId)')
      > body.indexOf('createTabAfterCurrent'),
  );
});

test('Claude settings presentation is owned by the exact session proof', () => {
  assert.match(controlBar, /confirmedSettingsOwnerSessionId/);
  assert.match(controlBar, /selectSessionOwnedSettings\(\{/);
  assert.match(controlBar, /stateOwnerSessionId: confirmedSettingsOwnerSessionId/);
  assert.match(controlBar, /data-setting-proof-warning="model"/);
  assert.match(controlBar, /data-setting-proof-warning="effort"/);
  assert.match(controlBar, /confirmedClaudeModel/);
  assert.match(controlBar, /confirmedClaudeEffort/);
});


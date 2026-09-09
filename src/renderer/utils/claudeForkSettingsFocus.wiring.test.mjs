import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const tabBar = fs.readFileSync(path.join(workspaceDir, 'TabBar.tsx'), 'utf8');
const controlBar = fs.readFileSync(path.join(workspaceDir, 'ClaudeControlBar.tsx'), 'utf8');

test('context Fork preserves its exact origin instead of using global activation', () => {
  const start = tabBar.indexOf('const handleContextFork = async');
  const end = tabBar.indexOf('const handleContextForkToSDK', start);
  assert.ok(start >= 0 && end > start);
  const body = tabBar.slice(start, end);
  assert.match(body, /createTabAfterCurrent[\s\S]*?background: true/);
  assert.match(body, /tabContextSurface\(renameHostRef\.current, tab\.id\)/);
  assert.match(body, /placeContextCreatedTab\(contextSurface, tab\.id, newTabId\)/);
  assert.doesNotMatch(body, /activateCenterTab\(projectId, newTabId\)/);
});

test('Claude settings presentation is owned by the exact session proof', () => {
  assert.match(controlBar, /confirmedSettingsOwnerSessionId/);
  assert.match(controlBar, /selectSessionOwnedSettings\(\{/);
  assert.match(controlBar, /stateOwnerSessionId: confirmedSettingsOwnerSessionId/);
  assert.match(controlBar, /data-setting-proof-warning=\{claudeModelProofNeedsAttention/);
  assert.match(controlBar, /data-setting-proof-warning=\{claudeEffortProofNeedsAttention/);
  assert.match(controlBar, /confirmedClaudeModel/);
  assert.match(controlBar, /confirmedClaudeEffort/);
});

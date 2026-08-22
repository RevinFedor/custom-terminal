import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = readFileSync(join(renderer, 'store/useWorkspaceStore.ts'), 'utf8');
const app = readFileSync(join(renderer, 'App.tsx'), 'utf8');
const web = readFileSync(join(renderer, '../main/web-server.js'), 'utf8');

test('workspace read API includes every workflow and a compare token', () => {
  const start = app.indexOf("if (action === 'describeWorkspaceLayout')");
  const end = app.indexOf("if (action === 'recoverWorkspaceSpaces')", start);
  const block = app.slice(start, end);
  assert.match(block, /spacesWithLiveLayout\(/);
  assert.match(block, /workspaceSpacesFingerprint\(/);
  assert.match(block, /activeSpaceId: state\.activeSpaceId/);
  assert.match(block, /projectIds:[\s\S]*isInboxProjectId/);
});

test('recovery validates in renderer and is committed synchronously', () => {
  const start = store.indexOf('recoverWorkspaceSpaces: (request) => {');
  const end = store.indexOf('\n  workspaceSpaceTabCount:', start);
  const block = store.slice(start, end);
  assert.match(block, /recoverWorkspaceSpacesModel\(/);
  assert.match(block, /openProjects\.get\(projectId\)\?\.tabs\.has\(tabId\)/);
  assert.match(block, /isSystemProject: isInboxProjectId/);
  assert.match(block, /knownProjectTabs/);
  assert.match(block, /saveSessionImmediate\(\{[\s\S]*workspace-space-recovery/);
  assert.match(block, /request\?\.dryRun === true/);
});

test('only explicit workflow deletion may persist a smaller space-id set', () => {
  const start = store.indexOf('removeWorkspaceSpace: (id) => {');
  const end = store.indexOf('\n  renameWorkspaceSpace:', start);
  const block = store.slice(start, end);
  assert.match(block, /saveSessionImmediate\(\{/);
  assert.match(block, /reason: 'workspace-space-remove'/);
  assert.match(block, /allowWorkspaceSpaceRemoval: true/);
});

test('authenticated web recovery route requires candidates and forwards fingerprint', () => {
  const start = web.indexOf("parsed.pathname === '/api/workspace/spaces/recover'");
  const end = web.indexOf('// ONE call applies the whole arrangement', start);
  const block = web.slice(start, end);
  assert.ok(start >= 0);
  assert.match(block, /candidates required/);
  assert.match(block, /bridgeRequest\('recoverWorkspaceSpaces'/);
  assert.match(block, /expectedFingerprint/);
  assert.match(block, /overwriteExistingIds/);
  assert.match(block, /dryRun/);
  assert.match(app, /workspaceRecoveryProjectProof/);
  assert.match(app, /payload\?\.dryRun !== true\) await ensureWorkspaceRecoveryProjects/);
});

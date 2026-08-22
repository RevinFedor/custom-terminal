import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const mainDir = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(mainDir, 'main.js'), 'utf8');
const web = readFileSync(join(mainDir, 'web-server.js'), 'utf8');
const app = readFileSync(join(mainDir, '../renderer/App.tsx'), 'utf8');

test('workspace writes forward revision metadata on async and shutdown paths', () => {
  const asyncAt = main.indexOf("ipcMain.handle('app:setState'");
  const syncAt = main.indexOf("ipcMain.on('app:setStateSync'");
  const body = main.slice(asyncAt, main.indexOf('// Bulk synchronous hydrate', syncAt));
  assert.match(body, /allowWorkspaceSpaceRemoval/);
  assert.match(body, /setAppState\(key, value, \{[\s\S]*reason,[\s\S]*source,[\s\S]*allowWorkspaceSpaceRemoval/);
  assert.match(body, /write rejected/);
  assert.ok(asyncAt >= 0 && syncAt > asyncAt);
});

test('revision IPC returns one parsed snapshot without exposing database access to renderer', () => {
  assert.match(main, /ipcMain\.handle\('app:listStateRevisions'/);
  assert.match(main, /ipcMain\.handle\('app:getStateRevision'/);
  assert.match(main, /JSON\.parse\(revision\.value\)/);
});

test('web API lists summaries and asks live renderer to merge a selected revision', () => {
  const listAt = web.indexOf("parsed.pathname === '/api/workspace/revisions'");
  const recoverAt = web.indexOf("bridgeRequest('recoverWorkspaceSessionRevision'", listAt);
  assert.ok(listAt >= 0 && recoverAt > listAt);
  const block = web.slice(listAt, web.indexOf('// ONE call applies the whole arrangement', recoverAt));
  assert.match(block, /listAppStateRevisions\('workspace-session'/);
  assert.match(block, /parsed\.query\.limit/);
  assert.doesNotMatch(block, /value:\s*revision\.value/);
  assert.match(block, /bridgeRequest\('recoverWorkspaceSessionRevision'/);
  assert.match(block, /expectedFingerprint/);

  const actionAt = app.indexOf("if (action === 'recoverWorkspaceSessionRevision')");
  const action = app.slice(actionAt, app.indexOf("if (action === 'arrangeWorkspaceLayout')", actionAt));
  assert.match(action, /app:getStateRevision/);
  assert.match(action, /recoverWorkspaceSpaces\(/);
  assert.match(action, /dryRun/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('directory change uses the shared lifecycle queue and exact live cwd proof', () => {
  const main = read('src/main/main.js');
  const handlerStart = main.indexOf("ipcMain.handle('terminal:change-working-directory'");
  const handlerEnd = main.indexOf("\nipcMain.handle('terminal:get-shell-prompt-readiness'", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);

  assert.match(handler, /runKeyedExclusive\(aiLifecycleActionInflight, tabId/);
  assert.match(handler, /proveIdleShellForAgentLaunch\(tabId, 'cwd-change'/);
  const register = handler.indexOf('terminalCwdChangeProofs.begin(');
  const write = handler.indexOf('writeAgentLaunchCommandToIdleShell(', register);
  const awaitProof = handler.indexOf('await pending.promise', write);
  assert.ok(register >= 0 && write > register && awaitProof > write);
  assert.doesNotMatch(handler, /setTimeout\([\s\S]*?success:\s*true/);

  const updateStart = main.indexOf("ipcMain.handle('terminal:updateCwd'");
  const updateEnd = main.indexOf("\n// Change only this tab's working directory", updateStart);
  const update = main.slice(updateStart, updateEnd);
  assert.match(update, /validateTerminalCwdCandidate/);
  assert.match(update, /terminalCwdChangeProofs\.observe\(\{/);
  assert.match(update, /terminalToken:\s*terminals\.get\(tabId\)/);
  assert.match(update, /persisted,/);
});

test('Sidebar click drives Finder, then stop/change/fork flow for the exact tab', () => {
  const workspace = read('src/renderer/components/Workspace/Workspace.tsx');
  const sidebar = read('src/renderer/components/Workspace/Sidebar.jsx');

  assert.match(sidebar, /data-directory-change-trigger/);
  assert.match(sidebar, /onClick=\{handleDirectoryTitleClick\}/);
  assert.match(workspace, /app:select-directory/);
  assert.match(workspace, /waitForAgentTurnToSettle/);
  assert.match(workspace, /runtime\.stopProcess\(tabId/);
  assert.match(workspace, /terminal:change-working-directory/);
  assert.match(workspace, /latestStore\.updateTabCwd\(ownerProjectId, tabId, changed\.cwd\)/);
  assert.match(workspace, /command:\s*'claude-f'[\s\S]*?relocateWorkingDirectory:\s*true/);
  assert.match(workspace, /command:\s*'codex-f'[\s\S]*?cwd:\s*changed\.cwd/);
});

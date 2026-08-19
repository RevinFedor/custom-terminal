'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('history context uses provider history APIs and never the normal turn submit path', () => {
  const main = read('src/main/main.js');
  const codex = read('src/main/ipc/codex-data.js');
  const scenario = read('src/renderer/utils/agentScenarios.ts');
  assert.match(main, /agent:record-history-context/);
  assert.match(main, /historyOnly: true[\s\S]{0,120}modelTurnStarted: false/);
  const injectBody = codex.match(/injectHistoryContext = async function[\s\S]*?ipcMain\.handle\('codex:get-account-profiles'/)?.[0] || '';
  assert.ok(injectBody);
  assert.doesNotMatch(injectBody, /thread\/(?:start|resume|inject_items)|CodexAppServerClient/);
  assert.match(injectBody, /type: 'thread_settings_applied'/);
  assert.match(injectBody, /type: 'response_item'/);
  assert.match(injectBody, /type: 'user_message'/);
  assert.match(injectBody, /handle\.appendFile\(serialized, 'utf8'\)/);
  const claude = read('src/main/ipc/claude-data.js');
  assert.match(claude, /CLAUDE_HISTORY_CONTEXT_ACK_TEXT/);
  assert.match(claude, /if \(isClaudeHistoryContextAck\(entry\)\) continue/);
  assert.match(scenario, /recordHistoryContext\(tabId, prompt/);
  assert.match(scenario, /if \(recordWithoutReply === true\) \{[\s\S]*return \{[\s\S]*historyContextResult/);
});

test('fresh Codex history binding is accepted by both renderer and main CAS gates', () => {
  const store = read('src/renderer/store/useWorkspaceStore.ts');
  const main = read('src/main/main.js');
  assert.match(store, /'editRange', 'deleteRange', 'historyContext'/);
  assert.match(main, /'editRange', 'deleteRange', 'historyContext'/);
});

test('recording waits for startup receipt reconciliation and checks Stop cancellation before mutation', () => {
  const main = read('src/main/main.js');
  const handler = main.match(/ipcMain\.handle\('agent:record-history-context'[\s\S]*?\n\}\);\n\n\/\/ Programmatic paste/)?.[0] || '';
  assert.match(handler, /await agentSendReceiptStartupReady/);
  assert.match(handler, /agentSendCancellations\.isCancelled\(tabId, handoffId, attemptId\)/);
  assert.match(handler, /markAttemptState[\s\S]*ENTER_ARMED/);
});

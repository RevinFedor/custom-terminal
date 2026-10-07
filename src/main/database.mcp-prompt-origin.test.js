'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { promptTransportHash, backfillConfirmedSystemPromptPresentations, decorateHistoryPromptPresentations } = require('./history-prompt-presentations');
const { _api } = require('./ipc/codex-data');

test('an old confirmed plain MCP send stays purple after SQLite reopen and carrier promotion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-mcp-origin-'));
  const file = path.join(root, 'private.db');
  let manager;
  t.after(() => { manager?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = () => { const db = new DatabaseManager({ existingConnection: new SQLite(file) }); db.initTables(); return db; };
  manager = open();
  const sid = 'mcp-origin-session', text = 'Continue the existing source check', stamp = '2026-10-06T06:59:59.419Z';
  const records = [{ type: 'response_item', __line: 24894, __byteOffset: 1000, timestamp: stamp,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  { type: 'event_msg', __line: 24895, __byteOffset: 2000, timestamp: stamp,
    payload: { type: 'user_message', message: text } }];
  const before = JSON.stringify(records);
  const receipts = createAgentSendReceiptStore(manager.db);
  const identity = { operationKey: 'project:T:continuation', tabId: 'T', handoffId: 'continuation',
    requestFingerprint: 'fixed', surface: 'project-api', provider: 'codex', sessionId: sid,
    promptHash: promptTransportHash(text), promptLength: text.length };
  const attempt = receipts.beginAttempt(identity);
  receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { source: 'codex-terminal-mcp' });
  receipts.settleAttempt(identity.operationKey, attempt.attemptId, { status: 'audit-pending', submitted: true, auditPending: true });
  assert.equal(receipts.promoteFromAudit({ operationKey: identity.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', sessionId: sid, success: true, expectedHash: identity.promptHash, actualHash: identity.promptHash,
    auditTimestamp: stamp, entryUuid: `codex-user-${sid}-24894`, sourceIdentity: `codex-user-source-${sid}-1000` }).promoted, true);
  assert.equal(backfillConfirmedSystemPromptPresentations(manager, receipts.list({ state: 'confirmed' })), 1);
  manager.close(); manager = open();
  const decorated = decorateHistoryPromptPresentations(manager, { toolType: 'codex', sessionId: sid,
    entries: _api.buildCodexFullHistory(records, sid) });
  assert.equal(decorated.length, 1);
  assert.equal(decorated[0].uuid, `codex-user-${sid}-24895`);
  assert.equal(decorated[0].semanticTags[0].source, 'terminal-mcp');
  assert.equal(decorated[0].content, text);
  const { resolveHistoryOrchestrationPromptPresentation } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  assert.equal(resolveHistoryOrchestrationPromptPresentation(decorated[0]).kind, 'terminal-mcp');
  assert.equal(JSON.stringify(records), before);
  assert.equal(createAgentSendReceiptStore(manager.db).get(identity.operationKey).state, 'confirmed');
});

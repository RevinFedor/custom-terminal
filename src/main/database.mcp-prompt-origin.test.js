'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { promptTransportHash, backfillConfirmedSystemPromptPresentations, decorateHistoryPromptPresentations,
  normalizePromptPresentationSnapshot, saveAuditedPromptPresentation, cloneCodexPromptPresentationsForProvenChild } = require('./history-prompt-presentations');
const { AgentSendQueue } = require('./agent-send-queue');
const { withTerminalMcpPromptSource } = require('./terminal-mcp-prompt-source');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
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

test('legacy waiting-outcome receipt without a snapshot recovers only its exact row after SQLite reopen', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-message-outcome-origin-'));
  const file = path.join(root, 'private.db');
  let manager;
  t.after(() => { manager?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = () => { const db = new DatabaseManager({ existingConnection: new SQLite(file) }); db.initTables(); return db; };
  manager = open();
  const sid = '918b29e9-3369-4d94-8739-3b2cbefe7351';
  const handoffId = 'tab-message-outcome:ed61ac6a-c867-433f-8f93-1d3ba6d9eb52:reply';
  const text = '[Tab message: waiting outcome]\nOutcome: reply_processing_timeout';
  const stamp = '2026-10-23T07:49:55.000Z';
  const store = createAgentSendReceiptStore(manager.db);
  const identity = { operationKey: handoffId, handoffId, tabId: 'private-target', requestFingerprint: 'frozen',
    surface: 'tab-message', provider: 'codex', sessionId: sid, promptHash: promptTransportHash(text), promptLength: text.length };
  const attempt = store.beginAttempt(identity);
  store.stageAttemptContext(identity.operationKey, attempt.attemptId, { source: 'codex-' + handoffId, presentationSnapshot: null });
  store.settleAttempt(identity.operationKey, attempt.attemptId, { status: 'audit-pending', submitted: true, auditPending: true });
  assert.equal(store.promoteFromAudit({ operationKey: identity.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', sessionId: sid, success: true, expectedHash: identity.promptHash, actualHash: identity.promptHash,
    auditTimestamp: stamp, entryUuid: `codex-user-${sid}-78581`, sourceIdentity: `codex-user-source-${sid}-1000` }).promoted, true);
  const frozen = JSON.stringify(store.get(identity.operationKey));
  assert.equal(backfillConfirmedSystemPromptPresentations(manager, store.list({ state: 'confirmed' })), 1);
  assert.equal(JSON.stringify(store.get(identity.operationKey)), frozen);
  manager.close(); manager = open();
  const record = { uuid: `codex-user-${sid}-78581`, role: 'user', content: text, timestamp: stamp,
    sourceIdentity: `codex-user-source-${sid}-1000` };
  const quote = { ...record, uuid: 'ordinary-quote', sourceIdentity: 'foreign' };
  const [unchanged, row] = decorateHistoryPromptPresentations(manager, { toolType: 'codex', sessionId: sid, entries: [quote, record] });
  assert.equal(unchanged, quote);
  const { resolveHistoryOrchestrationPromptPresentation, resolveHistoryPromptSender } =
    await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const service = resolveHistoryOrchestrationPromptPresentation(row);
  assert.deepEqual(service, { kind: 'tab-message-outcome', phase: 'prompt' });
  assert.equal(resolveHistoryPromptSender(service).label, 'Noted · статус вопроса');
  assert.equal(row.content, text);
  assert.equal(JSON.stringify(createAgentSendReceiptStore(manager.db).get(identity.operationKey)), frozen);
});

test('one-way sender survives actual SQLite FIFO, lost ACK/reopen, exact audit and canonical child projection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-mcp-sender-'));
  const file = path.join(root, 'private.db');
  let manager, queue;
  t.after(() => { queue?.dispose(); manager?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = () => { const db = new DatabaseManager({ existingConnection: new SQLite(file) }); db.initTables(); return db; };
  const restore = () => {
    manager = open();
    const store = createAgentSendReceiptStore(manager.db);
    queue = new AgentSendQueue({ store, ready: () => false, execute: () => assert.fail('no native input authorized') });
    return store;
  };
  let store = restore();
  const prompt = 'Keep **literal** notice; no answer required', sid = 'recipient-session';
  const headers = { 'x-noted-terminal-source': Buffer.from(JSON.stringify({ server: 'terminal', mode: 'internal',
    tabId: 'sender', projectId: 'P' })).toString('base64url') };
  const presentationSnapshot = withTerminalMcpPromptSource(null, 'terminal-mcp', headers,
    () => ({ tabId: 'sender', tabName: 'Captured source', projectId: 'P' }));
  const request = { tabId: 'T', handoffId: 'fixed-notice', prompt, source: 'terminal-mcp', queue: true, presentationSnapshot };
  const identity = { operationKey: 'project:T:fixed-notice', tabId: 'T', handoffId: 'fixed-notice',
    requestFingerprint: fingerprintAgentSendRequest({ prompt, source: 'terminal-mcp', queue: true }),
    surface: 'project-api', provider: 'codex', sessionId: sid, promptHash: promptTransportHash(prompt), promptLength: prompt.length };
  assert.equal(queue.enqueue({ identity, request }).ok, true);
  assert.equal(store.get(identity.operationKey).attemptId, null);
  const frozen = queue.item(identity.operationKey).request_json;
  assert.equal(normalizePromptPresentationSnapshot(store.get(identity.operationKey).receipt.presentationSnapshot)
    .semanticTags[0].sourceTabName, 'Captured source');
  queue.dispose(); manager.close();
  store = restore();
  const savedRequest = JSON.parse(queue.item(identity.operationKey).request_json);
  const retryPresentation = withTerminalMcpPromptSource(null, 'terminal-mcp', headers,
    () => assert.fail('sender rename/closure cannot affect retry'), savedRequest);
  assert.equal(queue.enqueue({ identity, request: { ...request, presentationSnapshot: retryPresentation } }).replayed, true);
  assert.equal(queue.item(identity.operationKey).request_json, frozen);
  assert.equal(queue.enqueue({ identity, request: { ...request, prompt: 'different' } }).ok, false);
  assert.equal(store.get(identity.operationKey).attemptId, null);

  const attempt = store.beginAttempt(identity);
  store.stageAttemptContext(identity.operationKey, attempt.attemptId, { source: 'codex-terminal-mcp', presentationSnapshot });
  store.settleAttempt(identity.operationKey, attempt.attemptId, { status: 'audit-pending', submitted: true, auditPending: true });
  const timestamp = '2026-10-23T05:10:22.887Z';
  assert.equal(store.promoteFromAudit({ operationKey: identity.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', sessionId: sid, success: true, expectedHash: identity.promptHash, actualHash: identity.promptHash,
    auditTimestamp: timestamp, entryUuid: `codex-user-${sid}-12`, sourceIdentity: `codex-user-source-${sid}-1000` }).promoted, true);
  assert.equal(saveAuditedPromptPresentation(manager, { toolType: 'codex', sessionId: sid,
    entryUuid: `codex-user-${sid}-12`, auditTimestamp: timestamp, actualHash: identity.promptHash,
    snapshot: store.get(identity.operationKey).receipt.presentationSnapshot }), true);
  queue.dispose(); manager.close();
  store = restore();
  const sourceRecords = [{ type: 'event_msg', __line: 12, timestamp, payload: { type: 'user_message', message: prompt } }];
  const rows = decorateHistoryPromptPresentations(manager, { toolType: 'codex', sessionId: sid,
    entries: _api.buildCodexFullHistory(sourceRecords, sid) });
  const { resolveHistoryOrchestrationPromptPresentation, resolveHistoryPromptSender, projectHistoryServicePromptBody } =
    await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const expected = { sourceTabId: 'sender', sourceTabName: 'Captured source', sourceProjectId: 'P' };
  assert.deepEqual(resolveHistoryPromptSender(resolveHistoryOrchestrationPromptPresentation(rows[0])), expected);
  assert.deepEqual(projectHistoryServicePromptBody(rows[0]), { text: prompt, projected: false });
  const childRecords = [{ ...sourceRecords[0], __line: 20 }];
  assert.equal(cloneCodexPromptPresentationsForProvenChild(manager, { sourceSessionId: sid, childSessionId: 'child',
    sourceRecords, childRecords }).cloned, 1);
  const child = decorateHistoryPromptPresentations(manager, { toolType: 'codex', sessionId: 'child',
    entries: _api.buildCodexFullHistory(childRecords, 'child') });
  assert.deepEqual(resolveHistoryPromptSender(resolveHistoryOrchestrationPromptPresentation(child[0])), expected);
  assert.equal(store.get(identity.operationKey).state, 'confirmed');
  assert.equal(store.get(identity.operationKey).requestFingerprint, identity.requestFingerprint);
  assert.equal(queue.item(identity.operationKey).request_json, frozen);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const auditHelpers = require('./codex-prompt-audit');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { saveAuditedPromptPresentation } = require('./history-prompt-presentations');
const { createCodexLiveUserCarrierPairer } = require('./codex-live-user-carrier-pairing');
const tree = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['observeCodexPromptAuditCarrier', 'processCodexUserMessagePasteAudit', 'finishCodexPasteAudit',
  'publishAgentPromptAuditResult', 'codexLiveUserCarrierKind', 'codexLiveSourceIdentity', 'codexDurableUserUuidFromLiveRecord'];
const source = names.map(name => { const n = tree.statements.find(n => n.name?.text === name);
  assert.ok(n, name); return n.getText(tree); }).join('\n');
const sid = 'fixture-logical-users', prompt = 'same approved prompt';
const timestamp = '2026-10-06T01:00:00.000Z';
const chip = label => ({ promptChips: [{ kind: 'prompt', id: 'chip-' + label, label, text: prompt }] });

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE history_prompt_presentations (tool_type TEXT, session_id TEXT, audit_timestamp TEXT,
    transport_hash TEXT, entry_uuid TEXT, schema_version INTEGER, chips_json TEXT, created_at INTEGER,
    updated_at INTEGER, PRIMARY KEY(tool_type,session_id,audit_timestamp,transport_hash))`);
  const manager = Object.create(DatabaseManager.prototype); manager.db = db;
  const store = createAgentSendReceiptStore(db);
  const audits = [], published = [], owners = [], warnings = [];
  const context = vm.createContext({ ...auditHelpers, createCodexLiveUserCarrierPairer,
    CODEX_LIVE_USER_EVENT_CARRIER: 'event_msg', CODEX_LIVE_USER_RESPONSE_CARRIER: 'response_item',
    codexKnownSessions: new Map(), pasteAuditHash: promptAuditFingerprint, saveAuditedPromptPresentation,
    agentSendReceiptStore: store, AGENT_SEND_DURABLE_STATES: STORE_STATES, projectManager: { db: manager },
    console: { log() {}, warn: message => warnings.push(message) },
    getPendingCodexPasteAudits: () => audits.filter(a => !a.finished),
    getCodexRuntimeSessionId: () => sid, pasteAuditPreview: text => text,
    getActiveAgentExecutionContext: () => null,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'controlled-service-message' }),
    isOrchestrationPromptAudit: () => false,
    routeAgentPromptAuditDetail: detail => published.push(detail), enrichCodexAuditAddress() {},
    holdPasteAuditCompletionForTest: () => false, releaseCodexProvisionalSourceAfterMatchedAudit() {},
    removePendingCodexPasteAudit: (_tab, audit) => { const i = audits.indexOf(audit); if (i >= 0) audits.splice(i, 1); },
    rememberCodexLivePromptOwner: (_state, owner) => owners.push(owner),
    reconcileDurableCodexPromptAuditsForTab() {}, clearTimeout,
  });
  vm.runInContext(source, context);
  const state = { tabId: 'T', sessionId: sid, filePath: '/fixture/rollout.jsonl', busy: false };
  const begin = (label, boundary) => {
    const identity = { operationKey: 'op-' + label, tabId: 'T', handoffId: 'handoff-' + label,
      surface: 'desktop-history', provider: 'codex', sessionId: sid, requestFingerprint: 'request-' + label,
      promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
    const started = store.beginAttempt(identity);
    const preSubmitBoundary = { sessionId: sid, filePath: state.filePath, fileSize: boundary, capturedAt: 1 };
    store.stageAttemptContext(identity.operationKey, started.attemptId, { sessionId: sid,
      transcriptBoundary: preSubmitBoundary, transportText: prompt });
    store.settleAttempt(identity.operationKey, started.attemptId, { submitted: true, auditPending: true });
    const audit = { handoffId: identity.handoffId, sendOperationKey: identity.operationKey,
      sendAttemptId: started.attemptId, expectedText: prompt, expectedHash: identity.promptHash,
      expectedLen: prompt.length, sentAt: 1, preSubmitBoundary, presentationSnapshot: chip(label) };
    audits.push(audit); return audit;
  };
  const observe = (kind, offset, stamp = timestamp) => {
    const record = { type: kind, timestamp: stamp, __byteOffset: offset, __line: offset,
      payload: kind === 'response_item' ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }
        : { type: 'user_message', message: prompt } };
    context.observeCodexPromptAuditCarrier(state, record);
    return context.processCodexUserMessagePasteAudit(state, record);
  };
  const boundary = type => context.observeCodexPromptAuditCarrier(state, { type: 'event_msg', payload: { type } });
  return { store, begin, observe, boundary, published, owners, warnings, context,
    presentation: () => manager.getHistoryPromptPresentationByAudit('codex', sid, timestamp, promptAuditFingerprint(prompt)) };
}

for (const order of ['event-first', 'response-first']) test(`actual live ${order} pair confirms one operation and preserves its SQL presentation`, t => {
  const h = fixture(t);
  h.begin('A', 0);
  h.observe(order === 'event-first' ? 'event_msg' : 'response_item', 100);
  assert.equal(h.store.get('op-A').state, 'confirmed');
  assert.equal(h.presentation().chips[0].label, 'A');
  const b = h.begin('B', 150);
  h.observe(order === 'event-first' ? 'response_item' : 'event_msg', 200);
  assert.equal(h.store.get('op-B').state, 'audit-pending');
  assert.equal(b.finished, undefined);
  assert.deepEqual(h.published.map(p => p.handoffId), ['handoff-A']);
  assert.equal(h.presentation().chips[0].label, 'A');
});

test('second task_started gives an equal prompt its own claim, while first start keeps the old companion', t => {
  const h = fixture(t);
  h.boundary('task_started'); h.begin('A', 0); h.observe('response_item', 100);
  h.begin('B', 150); h.boundary('task_started'); h.observe('event_msg', 200, '2026-10-06T01:00:01.000Z');
  assert.equal(h.store.get('op-B').state, 'confirmed');
  assert.deepEqual(h.published.map(p => p.handoffId), ['handoff-A', 'handoff-B']);
});

test('rejected durable promotion cannot save presentation even if the preliminary claim check finds no conflict', t => {
  const h = fixture(t);
  const audit = h.begin('B', 0);
  h.store.findConflictingAuditClaim = () => null;
  h.store.db.prepare('UPDATE agent_send_receipts SET attempt_id=? WHERE operation_key=?').run('replacement', 'op-B');
  h.observe('event_msg', 100);
  assert.equal(h.presentation(), null);
  assert.equal(audit.finished, undefined);
  assert.equal(h.published.length, 0);
});

for (const order of ['event-first', 'response-first']) test('unclaimed manual carrier before admission cannot donate its late companion: ' + order, t => {
  const h = fixture(t);
  h.observe(order === 'event-first' ? 'event_msg' : 'response_item', 100);
  h.begin('B', 150);
  h.observe(order === 'event-first' ? 'response_item' : 'event_msg', 200);
  assert.equal(h.store.get('op-B').state, 'audit-pending');
  assert.equal(h.published.length, 0);
  assert.equal(h.presentation(), null);
});

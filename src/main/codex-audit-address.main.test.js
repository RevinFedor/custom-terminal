'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { promptAuditFingerprint: hash } = require('./prompt-audit-fingerprint');
const api = require('./ipc/codex-data')._api;
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const from = source.indexOf('function enrichCodexAuditAddress(');
const to = source.indexOf('\nfunction holdPasteAuditCompletionForTest(', from);
assert.ok(from > 0 && to > from);

function harness(t, { delayRead } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-audit-main-'));
  const filePath = path.join(dir, 'rollout.jsonl'), text = 'exact user prompt';
  const prefix = JSON.stringify({ type: 'session_meta', payload: { id: 'session-a' } }) + '\n \n';
  const record = { type: 'event_msg', timestamp: '2026-09-19T16:47:17.123Z', payload: { type: 'user_message', message: text } };
  fs.writeFileSync(filePath, prefix + JSON.stringify(record) + '\n');
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = createAgentSendReceiptStore(db);
  const attempt = store.beginAttempt({ operationKey: 'send-a', tabId: 'tab-a', handoffId: 'handoff-a', surface: 'desktop-history',
    requestFingerprint: 'request-a', provider: 'codex', sessionId: 'session-a', promptHash: hash(text), promptLength: text.length });
  store.settleAttempt('send-a', attempt.attemptId, { submitted: true, status: 'audit-pending', auditPending: true });
  const audit = { sendOperationKey: 'send-a', sendAttemptId: attempt.attemptId, handoffId: 'handoff-a', expectedHash: hash(text), source: 'history' };
  const result = { success: true, sessionId: 'session-a', actualHash: hash(text), expectedHash: hash(text), actualLen: text.length,
    auditTimestamp: record.timestamp, sourceIdentity: 'codex-user-source-session-a-' + Buffer.byteLength(prefix), recordByteOffset: Buffer.byteLength(prefix) };
  const routes = [], logs = [], inflight = new Map();
  const context = vm.createContext({ require, path, Date, srcMainDir: __dirname, agentSendReceiptStore: store,
    AGENT_SEND_DURABLE_STATES: STORE_STATES, codexAuditAddressInflight: inflight,
    terminalProjects: new Map([['tab-a', dir]]), pasteAuditHash: hash,
    codexDataModule: { _api: { findCodexSessionFile: async () => ({ filePath }),
      readAuditRecordAddress: async (...args) => { await delayRead?.(); return api.readAuditRecordAddress(...args); },
      parseJsonlFile: () => { throw Error('full raw materialization is forbidden in enrichment'); } } },
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'fixture-no-live-writer' }),
    isOrchestrationPromptAudit: () => false,
    routeAgentPromptAuditDetail: detail => routes.push(detail),
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
  });
  vm.runInContext(source.slice(from, to) + '\nglobalThis.publish=publishAgentPromptAuditResult;', context);
  return { context, store, routes, logs, inflight, attempt, audit, result, text };
}

test('actual main enrichment updates the same receipt and routes canonical address to Timeline without a second send', async t => {
  const h = harness(t);
  h.context.publish('tab-a', h.audit, h.result, 'codex');
  const initial = h.store.get('send-a');
  assert.equal(initial.state, STORE_STATES.CONFIRMED); assert.equal(initial.auditIdentity.entryUuid, null);
  await Promise.all([...h.inflight.values()]);
  const enriched = h.store.get('send-a');
  assert.equal(enriched.attemptId, h.attempt.attemptId); assert.equal(enriched.settledAt, initial.settledAt);
  assert.equal(enriched.auditIdentity.entryUuid, 'codex-user-session-a-2');
  assert.equal(h.routes.length, 2); assert.equal(h.routes[1].entryUuid, enriched.auditIdentity.entryUuid);
  const { projectTimelineSentHandoff, mergeTimelineEntriesWithSentHandoffs } = await import('../renderer/utils/timelineTranscriptRefresh.mjs');
  const handoff = { queueStatus: 'sent', toolType: 'codex', handoffId: 'handoff-a', text: h.text, auditProof: h.routes[1] };
  const point = projectTimelineSentHandoff(handoff, { toolType: 'codex', sessionId: 'session-a' });
  assert.equal(point.uuid, enriched.auditIdentity.entryUuid);
  assert.equal(mergeTimelineEntriesWithSentHandoffs([{ ...point, isSentHandoffProjection: false }], [point]).length, 1);
  // Replayed earlier audit cannot erase the newly learned address.
  h.context.publish('tab-a', h.audit, h.result, 'codex');
  assert.equal(h.routes.at(-1).entryUuid, point.uuid); assert.equal(h.inflight.size, 0);
});

test('foreign late attempt is rejected before receipt/UI publication even after a valid physical read', async t => {
  const h = harness(t);
  h.context.publish('tab-a', h.audit, h.result, 'codex');
  await Promise.all([...h.inflight.values()]);
  const count = h.routes.length;
  h.context.publish('tab-a', { ...h.audit, sendAttemptId: 'foreign-attempt' }, { ...h.result, entryUuid: 'foreign-entry' }, 'codex');
  assert.equal(h.routes.length, count);
  assert.equal(h.store.get('send-a').auditIdentity.entryUuid, 'codex-user-session-a-2');
  assert.ok(h.logs.some(value => value.includes('ignore stale/foreign')));
});

test('file failure leaves source-only confirmed receipt intact, without downgrade or fake Timeline UUID', async t => {
  const h = harness(t, { delayRead: async () => { throw Error('source unavailable'); } });
  h.context.publish('tab-a', h.audit, h.result, 'codex');
  await Promise.all([...h.inflight.values()]);
  const kept = h.store.get('send-a');
  assert.equal(kept.state, STORE_STATES.CONFIRMED); assert.equal(kept.auditIdentity.entryUuid, null);
  assert.equal(h.routes.length, 1); assert.equal(h.inflight.size, 0);
  assert.ok(h.logs.some(value => value.includes('source unavailable')));
});

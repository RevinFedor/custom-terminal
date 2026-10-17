'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Sqlite = require('better-sqlite3');
const DatabaseManager = require('./database');
const { commitForkMetadata } = require('./fork-commit');
const { historyRewriteOperation } = require('../shared/fork-operation.cjs');
const { mapTimelineEntryUuidsAcrossFork } = require('./session-history-events');
const { cloneCodexPromptPresentationsForProvenChild, decorateHistoryPromptPresentations,
  promptTransportHash } = require('./history-prompt-presentations');
const source = fs.readFileSync(require.resolve('./ipc/codex-data'), 'utf8');
const start = source.indexOf('function persistCodexForkHistoryEvent(');
const end = source.indexOf('\nasync function writeCodexEditedFork(', start);
assert.ok(start > 0 && end > start);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const stamp = '2026-10-15T07:05:39.293Z';

function fixture(t) {
  const sql = new Sqlite(':memory:');
  const db = new DatabaseManager({ existingConnection: sql });
  db.initTables();
  t.after(() => sql.close());
  const envelope = '[Tab message: question]\nMessage ID: same-message\n\nQuestion:\n';
  const body = 'A bounded question, with its full audited text.';
  const text = envelope + body;
  const tag = { kind: 'tab-message', messageId: 'same-message', phase: 'question',
    sourceTabId: 'sender-tab', targetTabId: 'recipient-tab', sourceTabName: 'Source',
    envelopeStart: 0, envelopeText: envelope, bodyStart: envelope.length, bodyEnd: text.length,
    bodyProjectionHash: sha(text) };
  db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId: 'parent',
    entryUuid: 'codex-user-parent-1', auditTimestamp: stamp, transportHash: promptTransportHash(text),
    schemaVersion: 2, chips: [tag] });
  const records = [{ type: 'session_meta', payload: { id: 'parent' } },
    { __line: 1, type: 'event_msg', timestamp: stamp, payload: { type: 'user_message', message: text } }];
  const childEntry = (sessionId = 'child', content = text) => ({ role: 'user',
    uuid: 'codex-user-' + sessionId + '-1', sessionId, timestamp: stamp, content });
  const saveLegacy = (child = 'child', parent = 'parent', patch = {}) => db.saveSessionForkEvent({
    provider: 'codex', operationKind: 'rewind', sourceSessionId: parent, childSessionId: child,
    entryUuids: ['codex-user-' + child + '-1'],
    entryMappings: [{ sourceUuid: 'codex-user-' + parent + '-1', childUuid: 'codex-user-' + child + '-1' }],
    snapshotComplete: true, forkMode: 'history_rewind', origin: 'app', ...patch,
  });
  const decorate = (sessionId = 'child', entry = childEntry(sessionId)) => decorateHistoryPromptPresentations(db, {
    toolType: 'codex', sessionId, entries: [entry], logger: { info() {} },
  })[0];
  const timeline = (rows, sid) => rows.flatMap((r, index) => r.type === 'event_msg' && r.payload?.type === 'user_message'
    ? [{ type: 'user', uuid: 'codex-user-' + sid + '-' + (r.__line ?? index), timestamp: r.timestamp, content: r.payload.message }] : []);
  const persist = vm.runInNewContext(source.slice(start, end) + '; persistCodexForkHistoryEvent', {
    codexUsageStateStore: db, historyRewriteOperation, mapTimelineEntryUuidsAcrossFork,
    cloneCodexPromptPresentationsForProvenChild, buildCodexTimeline: timeline,
    buildCodexMutationTimeline: timeline, console: { log() {} },
  });
  return { db, sql, text, tag, records, childEntry, saveLegacy, decorate, persist };
}

test('legacy COW History restores exact service tags without mutating history, receipts or the sidecar DB', t => {
  const f = fixture(t); f.saveLegacy();
  const entry = f.childEntry(), frozen = JSON.stringify(entry);
  const beforeChanges = f.sql.prepare('SELECT total_changes() n').get().n;
  const result = f.decorate('child', entry);
  assert.equal(result.semanticTags?.[0].messageId, 'same-message');
  assert.equal(result.semanticTags[0].bodyProjectionHash, sha(entry.content));
  assert.equal(result.uuid, entry.uuid);
  assert.equal(result.content, entry.content);
  assert.equal(JSON.stringify(entry), frozen);
  assert.equal(f.db.getHistoryPromptPresentations('codex', 'child').length, 0);
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n, beforeChanges);
});

test('actual COW commit stores the sidecar atomically and idempotently with its lineage event', t => {
  const f = fixture(t);
  const request = { sourceSessionId: 'parent', childSessionId: 'child', sourceRecords: f.records,
    outputRecords: f.records.map(r => ({ ...r })), occurredAt: Date.parse(stamp), forkMode: 'history_rewind' };
  commitForkMetadata(f.db, () => f.persist(request));
  assert.equal(f.db.getHistoryPromptPresentations('codex', 'child').length, 1);
  assert.equal(f.decorate().semanticTags[0].messageId, 'same-message');
  commitForkMetadata(f.db, () => f.persist(request));
  assert.equal(f.db.getHistoryPromptPresentations('codex', 'child').length, 1);
  assert.equal(f.db.getHistoryPromptPresentations('codex', 'parent').length, 1);
});

test('sidecar storage failure rolls back the same COW metadata transaction', t => {
  const f = fixture(t);
  f.db.cloneCodexHistoryPromptPresentations = () => { throw new Error('controlled sidecar failure'); };
  assert.throws(() => commitForkMetadata(f.db, () => f.persist({ sourceSessionId: 'parent', childSessionId: 'child',
    sourceRecords: f.records, outputRecords: f.records, occurredAt: Date.parse(stamp), forkMode: 'history_rewind' })), /controlled sidecar failure/);
  assert.equal(f.db.getSessionHistoryContext('child').fork, null);
  assert.equal(f.db.getHistoryPromptPresentations('codex', 'child').length, 0);
});

test('copied services survive more than one already-created COW branch', t => {
  const f = fixture(t); f.saveLegacy(); f.saveLegacy('grandchild', 'child');
  const result = f.decorate('grandchild');
  assert.equal(result.semanticTags?.[0].messageId, 'same-message');
  assert.equal(result.uuid, 'codex-user-grandchild-1');
});

test('legacy projection reads each ancestor once, not one SQL lookup per History row', t => {
  const f = fixture(t);
  const entries = Array.from({ length: 1000 }, (_, index) => ({ ...f.childEntry(),
    uuid: 'codex-user-child-' + (index + 2), content: 'Ordinary prompt ' + index }));
  entries.push(f.childEntry());
  f.saveLegacy('child', 'parent', { entryUuids: entries.map(entry => entry.uuid) });
  const original = f.db.getHistoryPromptPresentations.bind(f.db);
  const reads = [];
  f.db.getHistoryPromptPresentations = (tool, sid) => { reads.push(sid); return original(tool, sid); };
  f.db.getHistoryPromptPresentationByAudit = () => { throw new Error('unexpected per-row lookup'); };
  const result = decorateHistoryPromptPresentations(f.db, { toolType: 'codex', sessionId: 'child',
    entries, logger: { info() {} } });
  assert.deepEqual(reads, ['child', 'parent']);
  assert.equal(result.filter(entry => entry.semanticTags).length, 1);
  assert.equal(result.at(-1).semanticTags[0].messageId, 'same-message');
});

test('a record created after an ancestor fork cannot borrow its older service sidecar', t => {
  const f = fixture(t);
  f.saveLegacy('child', 'parent', { occurredAt: Date.parse(stamp) - 2000 });
  f.saveLegacy('grandchild', 'child');
  assert.equal(f.decorate('grandchild').semanticTags, undefined);
});

test('a new COW commit from a legacy child materializes its inherited service metadata', t => {
  const f = fixture(t); f.saveLegacy();
  const records = [{ type: 'session_meta', payload: { id: 'child' } }, f.records[1]];
  commitForkMetadata(f.db, () => f.persist({ sourceSessionId: 'child', childSessionId: 'new-child',
    sourceRecords: records, outputRecords: records, occurredAt: Date.now(), forkMode: 'history_rewind' }));
  const rows = f.db.getHistoryPromptPresentations('codex', 'new-child');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chips[0].messageId, 'same-message');
  assert.equal(f.db.getHistoryPromptPresentations('codex', 'child').length, 0);
});

for (const [name, patch] of [
  ['incomplete snapshot', { snapshotComplete: false }],
  ['provider origin', { origin: 'provider' }],
  ['unproven operation', { operationKind: 'provider' }],
  ['row outside the committed prefix', { entryUuids: ['codex-user-child-9'] }],
]) test('legacy service recovery rejects ' + name, t => {
  const f = fixture(t); f.saveLegacy('child', 'parent', patch);
  assert.equal(f.decorate().semanticTags, undefined);
});

test('same UUID/timestamp with modified full text cannot inherit a service origin', t => {
  const f = fixture(t); f.saveLegacy();
  assert.equal(f.decorate('child', f.childEntry('child', f.text.replace('bounded', 'changed'))).semanticTags, undefined);
  assert.equal(f.decorate('child', { ...f.childEntry(), timestamp: '2026-10-15T07:05:40Z' }).semanticTags, undefined);
});

test('a service-looking quote without committed lineage remains ordinary text', t => {
  const f = fixture(t);
  assert.equal(f.decorate().semanticTags, undefined);
});

test('direct child presentation takes precedence over inherited service metadata', t => {
  const f = fixture(t); f.saveLegacy();
  f.db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId: 'child',
    entryUuid: 'codex-user-child-1', auditTimestamp: stamp, transportHash: promptTransportHash(f.text),
    schemaVersion: 2, chips: [{ ...f.tag, sourceTabName: 'Exact child metadata' }] });
  assert.equal(f.decorate().semanticTags[0].sourceTabName, 'Exact child metadata');
});

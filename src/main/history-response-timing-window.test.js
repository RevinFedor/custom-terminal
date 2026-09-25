'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const SQLite = require('better-sqlite3');
let fixturePath;
const electronPath = require.resolve('electron');
const previousElectron = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => fixturePath } } };
const DatabaseManager = require('./database');
if (previousElectron) require.cache[electronPath] = previousElectron;
else delete require.cache[electronPath];
const { decorateHistoryResponseTimings, decorateBoundHistoryResponseTimings,
  prepareHistoryResponseTimingWindow, observeHistoryResponseTimingBindings } = require('./history-response-timings');
const { SessionTranscriptService } = require('./session-transcript-service');

const at = Date.UTC(2026, 8, 25);
const row = (uuid, offset = 100) => ({ uuid, role: 'assistant', textPhase: 'final_answer',
  sessionId: 'session', timestamp: new Date(at + offset).toISOString(), content: uuid });
const request = { toolType: 'codex', sessionId: 'session', tabId: 'tab' };

function fixture(t) {
  fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-timing-window-'));
  const ownedPath = fixturePath;
  const db = new DatabaseManager();
  const writer = Object.create(DatabaseManager.prototype);
  writer.db = new SQLite(db.db.name);
  t.after(() => { writer.close(); db.close(); fs.rmSync(ownedPath, { recursive: true, force: true }); });
  const pending = (owner = writer) => {
    const interval = owner.saveActivityInterval({ tabId: 'tab', engine: 'codex', sessionId: 'session',
      startTs: at, endTs: at + 300 });
    owner.savePendingHistoryResponseTiming({ ...request, intervalId: interval.id });
    return interval.id;
  };
  return { db, writer, pending };
}

test('foreign pending commit after empty probe cannot bind to only the visible final', t => {
  const { db, pending } = fixture(t);
  const full = [row('offscreen', 100), row('visible', 200)];
  const original = db.getPendingHistoryResponseTimings.bind(db);
  let injected = false;
  let intervalId;
  db.getPendingHistoryResponseTimings = args => {
    const result = original(args);
    if (!injected) { injected = true; intervalId = pending(); }
    return result;
  };
  const result = prepareHistoryResponseTimingWindow(db, {
    ...request, fullEntries: full,
    entries: [{ uuid: 'offscreen', rowStub: true, role: 'assistant', hasContent: true }, full[1]],
  });
  assert.equal(injected, true);
  assert.equal(db.db.prepare('SELECT entry_uuid FROM history_response_timings WHERE interval_id=?').get(intervalId).entry_uuid, null);
  assert.equal(result.entries[1].responseTiming, undefined);
  assert.equal(result.revision, db.getHistoryResponseTimingRevision('codex', 'session', 'tab'));

  // The former proposed partial combined call is the negative control: it
  // incorrectly accepts one visible candidate from an ambiguous full set.
  decorateHistoryResponseTimings(db, { ...request, entries: [full[1]] });
  assert.equal(db.db.prepare('SELECT entry_uuid FROM history_response_timings WHERE interval_id=?').get(intervalId).entry_uuid, 'visible');
});

test('offscreen pending binding still uses the full projection and notifies after commit', t => {
  const { db, writer, pending } = fixture(t);
  const intervalId = pending();
  const full = [row('offscreen'), { uuid: 'visible-user', role: 'user', sessionId: 'session', content: 'prompt' }];
  const observations = [];
  const unsubscribe = observeHistoryResponseTimingBindings(() => {
    observations.push({ entryUuid: writer.db.prepare('SELECT entry_uuid FROM history_response_timings WHERE interval_id=?').get(intervalId).entry_uuid,
      inTransaction: db.db.inTransaction });
  });
  t.after(unsubscribe);
  const visible = [{ uuid: 'offscreen', rowStub: true, role: 'assistant', hasContent: true }, full[1]];
  const result = prepareHistoryResponseTimingWindow(db, { ...request, fullEntries: full, entries: visible });
  assert.deepEqual(observations, [{ entryUuid: 'offscreen', inTransaction: false }]);
  assert.deepEqual(result.entries, visible);
  const hydrated = prepareHistoryResponseTimingWindow(db, { ...request, fullEntries: full, entries: full });
  assert.equal(hydrated.entries[0].responseTiming.intervalId, intervalId);
  assert.equal(observations.length, 1, 'already-bound timing does not bind or notify again');
});

test('bound-only decoration never calls the pending or binding APIs', () => {
  const forbidden = () => { throw new Error('partial decoration must not bind'); };
  const decorated = decorateBoundHistoryResponseTimings({
    getPendingHistoryResponseTimings: forbidden, bindHistoryResponseTimingEntry: forbidden,
    getHistoryResponseTimingsForEntries: (_tool, ids) => [{ intervalId: 1, entryUuid: ids[0], startTs: at, endTs: at + 300, durationMs: 300 }],
  }, { ...request, entries: [row('visible')] });
  assert.equal(decorated[0].responseTiming.durationMs, 300);
});

test('foreign commit inside the read snapshot is deferred to a later revision', t => {
  const { db, pending } = fixture(t);
  const original = db.getHistoryResponseTimingsForEntries.bind(db);
  let injected = false;
  db.getHistoryResponseTimingsForEntries = (...args) => {
    const result = original(...args);
    if (!injected) { injected = true; pending(); }
    return result;
  };
  const full = [row('final')];
  const first = prepareHistoryResponseTimingWindow(db, { ...request, fullEntries: full, entries: full });
  assert.equal(first.revision, 'none', 'revision describes the same SQLite snapshot as the returned rows');
  assert.equal(first.entries[0].responseTiming, undefined);
  assert.notEqual(db.getHistoryResponseTimingRevision('codex', 'session', 'tab'), first.revision);
  const second = prepareHistoryResponseTimingWindow(db, { ...request, fullEntries: full, entries: full });
  assert.equal(second.entries[0].responseTiming.durationMs, 300);
});

test('continuous foreign pending writes cannot publish a falsely fresh revision', t => {
  const { db, pending } = fixture(t);
  const full = [row('first', 100), row('second', 200)];
  const original = db.getPendingHistoryResponseTimings.bind(db);
  let commits = 0;
  db.getPendingHistoryResponseTimings = args => {
    const result = original(args);
    if (!db.db.inTransaction) { commits += 1; pending(); }
    return result;
  };
  const result = prepareHistoryResponseTimingWindow(db, { ...request, fullEntries: full, entries: [full[1]] });
  assert.equal(commits, 3, 'reconciliation is bounded');
  assert.match(result.revision, /^pending-binding:/);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM history_response_timings WHERE entry_uuid IS NOT NULL').get().n, 0);
  db.getPendingHistoryResponseTimings = original;
  const settled = prepareHistoryResponseTimingWindow(db, { ...request, fullEntries: full, entries: [full[1]] });
  assert.equal(settled.revision, db.getHistoryResponseTimingRevision('codex', 'session', 'tab'));
  assert.notEqual(settled.revision, result.revision);
});

test('actual service keeps prompt revision hashing outside the timing read transaction', async t => {
  const { db } = fixture(t);
  db.db.prepare('INSERT INTO history_prompt_presentations(tool_type,session_id,audit_timestamp,transport_hash,chips_json) VALUES(?,?,?,?,?)')
    .run('codex', 'ancestor', 'at', 'hash', JSON.stringify([{ text: 'preserved metadata' }]));
  db.getHistoryPromptPresentationRevision('codex', 'session');
  const before = db._historyPromptRevisionCache.get('codex');
  assert.ok(before);
  const getRevision = db.getHistoryPromptPresentationRevision.bind(db);
  let calls = 0;
  db.getHistoryPromptPresentationRevision = (...args) => {
    calls += 1;
    assert.equal(db.db.inTransaction, false, 'timing snapshot must not make provider SHA cold');
    return getRevision(...args);
  };
  const full = [row('final')];
  const filePath = path.join(path.dirname(db.db.name), 'synthetic-ready.jsonl');
  fs.writeFileSync(filePath, JSON.stringify(full[0]) + '\n');
  const stat = fs.statSync(filePath);
  const service = new SessionTranscriptService({ getMainWindow: () => null,
    promptPresentationStore: db, codexData: { _api: {
      findCodexSessionFile: async () => ({ filePath }),
      projectCodexFullHistoryFromFile: async () => ({ success: true, entries: full, filePath,
        sourceSnapshot: { filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId: 'session' } }),
    } } });
  const result = await service.getHistory({ ...request, cwd: path.dirname(filePath), dehydrate: true, hydrate: { radius: 1 } });
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.equal(db.db.inTransaction, false);
  assert.equal(db._historyPromptRevisionCache.get('codex'), before);
});

test('provider-wide UUID lookup uses its exact index without changing ancestor row precedence', t => {
  const { db } = fixture(t);
  db.db.exec('DROP INDEX IF EXISTS idx_history_prompt_presentations_uuid');
  const insert = db.db.prepare(`INSERT INTO history_prompt_presentations
    (tool_type,session_id,audit_timestamp,transport_hash,entry_uuid,chips_json) VALUES(?,?,?,?,?,?)`);
  for (const session of ['z-parent', 'a-parent', 'm-parent']) {
    for (let i = 0; i < 5; i += 1) insert.run('codex', session, 'time-' + i, 'hash-' + i,
      i % 2 ? 'shared' : 'other', JSON.stringify([{ kind: 'prompt', text: session + ':' + i }]));
  }
  const plan = (indexed = false) => db.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM history_prompt_presentations
    ${indexed ? 'INDEXED BY idx_history_prompt_presentations_uuid' : ''}
    WHERE tool_type=? AND entry_uuid IN (?,?) ORDER BY session_id,entry_uuid,rowid`).all('codex', 'shared', 'other').map(row => row.detail).join('\n');
  assert.doesNotMatch(plan(), /entry_uuid=\?/);
  const legacyOrder = db.db.prepare(`SELECT session_id,entry_uuid,audit_timestamp,transport_hash
    FROM history_prompt_presentations INDEXED BY idx_history_prompt_presentations_entry
    WHERE tool_type=? AND entry_uuid IN (?,?)`).all('codex', 'shared', 'other');
  const prepare = db.db.prepare.bind(db.db);
  db.db.prepare = sql => prepare(sql.replace('INDEXED BY idx_history_prompt_presentations_uuid', ''));
  const before = db.getHistoryPromptPresentationsForEntries('codex', ['shared', 'other']);
  db.db.prepare = prepare;
  db.initTables();
  const after = db.getHistoryPromptPresentationsForEntries('codex', ['shared', 'other']);
  assert.match(plan(true), /idx_history_prompt_presentations_uuid.*entry_uuid=\?/);
  assert.deepEqual(after, before);
  assert.deepEqual(after.map(row => [row.sessionId, row.entryUuid, row.auditTimestamp, row.transportHash]),
    legacyOrder.map(row => [row.session_id, row.entry_uuid, row.audit_timestamp, row.transport_hash]));
});

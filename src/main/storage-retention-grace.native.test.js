'use strict';

// Run with ELECTRON_RUN_AS_NODE=1 and the repository Electron. Real owned
// SQLite/files, actual inventory + cleanup service; no installed user data,
// external providers, PTY, application restart or UI event simulation.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { StorageCleanupService } = require('./storage-cleanup-service');
const { normalizeStorageRetentionSettings, APP_STATE_KEY } = require('./storage-inventory');
const {
  HOUR_MS, SqliteStorageGraceStore, reconcileStorageGrace,
} = require('./storage-retention-grace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-grace-'));
  const dbPath = path.join(root, 'fixture.db');
  const db = new Database(dbPath);
  const manager = new DatabaseManager({ existingConnection: db });
  manager.initTables();
  manager.setAppState(APP_STATE_KEY, { enabled: true, gracePeriodHours: 24 });
  db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('fixture', root, 'fixture');
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  const session = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const file = path.join(codexHome, 'sessions', 'rollout-' + session + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: root } }) + '\n');
  fs.utimesSync(file, new Date(1_000_000), new Date(1_000_000));
  let nowMs = Date.now();
  const auditRows = [];
  let hook = null;
  const options = {
    sqlite: db, dbManager: manager, codexHome, claudeHome, appDataDir: root,
    now: () => nowMs,
    deleteCodexSession: async (id, item) => { assert.equal(id, session); fs.unlinkSync(item.path); },
    audit: { record: async (row) => { auditRows.push(row); if (row.status === 'attempt') hook?.(); } },
    logger: { log() {}, error() {} },
  };
  const service = new StorageCleanupService(options);
  const bind = () => db.prepare(`INSERT INTO tabs(project_id,tab_id,name,cwd,codex_session_id)
    VALUES('fixture','test-tab','test',?,?)`).run(root, session);
  const unbind = () => db.prepare("DELETE FROM tabs WHERE tab_id='test-tab'").run();
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, dbPath, db, manager, file, session, service, options, bind, unbind, auditRows,
    get now() { return nowMs; }, advance(ms) { nowMs += ms; }, onAttempt(fn) { hook = fn; },
    async item(svc = service) { return (await svc.scan({ force: true })).items.find((item) => item.sessionId === session); },
  };
}

test('saved reserve binding stays protected; full unbind waits 24h, then uses audited provider deletion', async (t) => {
  const f = fixture(t);
  f.bind();
  assert.equal((await f.item()).protected, true);
  assert.equal((await f.service.runRetentionSweep()).removed.length, 0);
  f.unbind();
  const closed = await f.item();
  assert.equal(closed.protected, false);
  assert.equal(closed.eligible, false);
  assert.equal(closed.unprotectedSince, f.now);
  assert.equal(closed.deleteAfter, f.now + 24 * HOUR_MS);
  f.advance(24 * HOUR_MS - 1);
  assert.equal((await f.service.runRetentionSweep()).removed.length, 0);
  assert.equal(fs.existsSync(f.file), true);
  f.advance(1);
  const result = await f.service.runRetentionSweep();
  assert.equal(result.success, true);
  assert.equal(result.removed.length, 1);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.auditRows.map((row) => row.status), ['attempt', 'removed']);
});

test('restore + close between scans invalidates the old clock in the binding transaction', async (t) => {
  const f = fixture(t);
  const before = await f.item();
  f.advance(23 * HOUR_MS);
  f.db.transaction(() => { f.bind(); f.unbind(); })();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_retention_grace').get().n, 0);
  const again = await f.item();
  assert.equal(again.unprotectedSince, f.now);
  assert.notEqual(again.unprotectedSince, before.unprotectedSince);
  f.advance(2 * HOUR_MS);
  assert.equal((await f.service.runRetentionSweep()).removed.length, 0);
  assert.equal(fs.existsSync(f.file), true);
});

test('restart preserves a clock and a lost clock grants a new wait rather than old-file deletion', async (t) => {
  const f = fixture(t);
  const first = await f.item();
  f.advance(4 * HOUR_MS);
  const otherConnection = new Database(f.dbPath);
  const restartedManager = new DatabaseManager({ existingConnection: otherConnection });
  const restarted = new StorageCleanupService({ ...f.options, sqlite: otherConnection, dbManager: restartedManager });
  t.after(() => otherConnection.close());
  assert.equal((await f.item(restarted)).unprotectedSince, first.unprotectedSince);
  f.db.exec('DELETE FROM storage_retention_grace');
  assert.equal((await f.item(restarted)).unprotectedSince, f.now);
  assert.equal((await f.item(restarted)).eligible, false);
});

test('rebind/close during awaited audit stops deletion even with no current reference at the end', async (t) => {
  const f = fixture(t);
  await f.item();
  f.advance(24 * HOUR_MS);
  f.onAttempt(() => f.db.transaction(() => { f.bind(); f.unbind(); })());
  const result = await f.service.runRetentionSweep();
  assert.equal(result.success, false);
  assert.equal(result.removed.length, 0);
  assert.equal(result.failures[0].error, 'storage_retention_waiting');
  assert.equal(fs.existsSync(f.file), true);
});

test('changed file and increased hours during awaited audit both prevent automatic deletion', async (t) => {
  for (const kind of ['file', 'hours', 'off']) {
    const f = fixture(t);
    await f.item();
    f.advance(24 * HOUR_MS);
    f.onAttempt(() => {
      if (kind === 'file') fs.appendFileSync(f.file, '{}\n');
      if (kind === 'hours') f.manager.setAppState(APP_STATE_KEY, { enabled: true, gracePeriodHours: 48 });
      if (kind === 'off') f.manager.setAppState(APP_STATE_KEY, { enabled: false, gracePeriodHours: 24 });
    });
    const result = await f.service.runRetentionSweep();
    assert.equal(result.removed.length, 0, kind);
    assert.equal(result.failures[0].error, kind === 'file' ? 'storage_retention_source_changed' : 'storage_retention_waiting', kind);
    assert.equal(fs.existsSync(f.file), true);
  }
});

test('Never is honored by real inventory; an explicit manual delete still uses its own contract', async (t) => {
  const f = fixture(t);
  f.manager.setAppState(APP_STATE_KEY, { enabled: true, retentionDays: { outside: null } });
  const item = await f.item();
  assert.equal(item.retentionDays, null);
  assert.equal(item.deleteAfter, null);
  assert.equal(item.eligible, false);
  f.advance(100 * 24 * HOUR_MS);
  assert.equal((await f.service.runRetentionSweep()).removed.length, 0);
  const scan = await f.service.scan({ force: true });
  const result = await f.service.deleteItems({ itemIds: [item.id], generation: scan.generation, source: 'manual' });
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(f.file), false);
});

test('new thin lineage invalidates exact source clocks but not recovery-copy clocks', (t) => {
  const f = fixture(t);
  const store = new SqliteStorageGraceStore(f.db);
  const source = {
    id: 'source', section: 'sessions', provider: 'codex', group: 'outside',
    sessionId: f.session, path: f.file, sizeBytes: 1, modifiedAt: 1,
    deleteAfter: 1, protected: false, deletable: true,
  };
  const recovery = { ...source, id: 'recovery', recoveryCopy: true };
  const borrowed = { ...source, id: 'borrowed', sessionId: 'other-source' };
  store.reconcile((previous) => reconcileStorageGrace([source, recovery, borrowed], normalizeStorageRetentionSettings({}), f.now, previous));
  f.db.prepare(`INSERT INTO session_history_events
    (event_key,event_type,provider,session_id,child_session_id,source_session_id,lineage_manifest_json)
    VALUES('fixture-fork','fork','codex','child','child',?,?)`).run(f.session, JSON.stringify({ sourceSegments: [{ physicalSessionId: 'other-source' }] }));
  assert.equal(store.get('source'), undefined);
  assert.equal(store.get('borrowed'), undefined);
  assert.ok(store.get('recovery'));
  // Legacy/bad manifest payload must not make an otherwise valid session
  // binding transaction fail inside the cleanup-owned SQL trigger.
  for (const manifest of ['bad-json', JSON.stringify({ sourceSegments: ['legacy-string', 4, null, { sessionId: f.session }] })]) {
    assert.doesNotThrow(() => f.db.prepare('UPDATE session_history_events SET lineage_manifest_json=?').run(manifest));
  }
});

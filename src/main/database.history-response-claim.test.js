'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-timing-claim-'));
  const filename = path.join(directory, 'db.sqlite');
  const a = Object.create(DatabaseManager.prototype), b = Object.create(DatabaseManager.prototype);
  a.db = new SQLite(filename); a.db.pragma('journal_mode = WAL'); a.initTables();
  b.db = new SQLite(filename); b.db.pragma('busy_timeout = 5000');
  t.after(() => { a.close(); b.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const interval = (sessionId = 'session') => {
    const row = a.saveActivityInterval({ tabId: 'tab', sessionId, engine: 'codex', startTs: 1000, endTs: 2000 });
    a.savePendingHistoryResponseTiming({ intervalId: row.id, toolType: 'codex', sessionId, tabId: 'tab' }); return row.id;
  };
  return { a, b, interval };
}
test('native SQLite: concurrent primary claims have one winner even after a stale preflight', t => {
  const { a, b, interval } = fixture(t), first = interval(), second = interval();
  const target = { toolType: 'codex', sessionId: 'session', entryUuid: 'final' };
  const prepare = a.db.prepare.bind(a.db); let injected = false;
  a.db.prepare = sql => {
    const statement = prepare(sql);
    if (!/UPDATE history_response_timings/i.test(sql)) return statement;
    return { run: (...args) => {
      if (!injected) { injected = true; assert.equal(b.bindHistoryResponseTimingEntry({ ...target, intervalId: second }), true); }
      return statement.run(...args);
    } };
  };
  assert.equal(a.bindHistoryResponseTimingEntry({ ...target, intervalId: first }), false);
  assert.equal(b.bindHistoryResponseTimingEntry({ ...target, intervalId: second }), true, 'same exact claim is idempotent');
  assert.equal(prepare('SELECT COUNT(*) AS n FROM history_response_timings WHERE entry_uuid=?').get('final').n, 1);
});
test('native SQLite: primary and alias claims protect each other in both orders', t => {
  const { a, b, interval } = fixture(t);
  const sourceId = interval('source'), childId = interval('child');
  assert.equal(a.bindHistoryResponseTimingEntry({ intervalId: sourceId, toolType: 'codex', sessionId: 'source', entryUuid: 'source-final' }), true);
  const clone = target => a.cloneHistoryResponseTimingsForSession({ toolType: 'codex', sourceSessionId: 'source',
    childSessionId: 'child', entryMappings: [{ sourceEntryUuid: 'source-final', childEntryUuid: target }] });
  assert.equal(b.bindHistoryResponseTimingEntry({ intervalId: childId, toolType: 'codex', sessionId: 'child', entryUuid: 'child-final' }), true);
  assert.equal(clone('child-final').cloned, 0, 'an alias cannot steal a primary target');
  assert.equal(clone('alias-final').cloned, 1);
  assert.equal(clone('alias-final').unchanged, 1);
  const otherId = interval('child');
  assert.equal(b.bindHistoryResponseTimingEntry({ intervalId: otherId, toolType: 'codex', sessionId: 'child', entryUuid: 'alias-final' }), false);
  assert.equal(b.getHistoryResponseTimingsForEntries('codex', ['alias-final']).length, 1);
});


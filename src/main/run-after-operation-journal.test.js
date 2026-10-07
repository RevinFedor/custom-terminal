'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { RunAfterOperationJournal } = require('./run-after-operation-journal');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-after-journal-'));
  const file = path.join(dir, 'private.sqlite'); let db = new Database(file), scope = 'S', failWrite = false;
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT)');
  const journal = epoch => new RunAfterOperationJournal({ db, epoch,
    scopeCurrent: (_target, expected) => expected === scope,
    commitState: writes => {
      for (const [key, value] of Object.entries(writes)) db.prepare('INSERT OR REPLACE INTO app_state VALUES (?,?)').run(key, value);
      if (failWrite) throw Error('private storage failure');
    } });
  let current = journal('main-A');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, get journal() { return current; }, scope: value => scope = value,
    fail: value => failWrite = value,
    reopen: () => { db.close(); db = new Database(file); current = journal('main-B'); } };
}
const input = { op: 'add', args: { text: 'private snapshot' }, runAfter: { version: 1 } };

test('same-ID is a durable read before another action; changed request or target conflicts', t => {
  const f = fixture(t), first = f.journal.reserve('op1', 'T', input, 'S');
  assert.equal(first.replay, false);
  assert.equal(f.journal.reserve('op1', 'T', input, 'S').replay, true);
  assert.throws(() => f.journal.reserve('op1', 'U', input, 'S'), /operation_conflict/);
  assert.throws(() => f.journal.reserve('op1', 'T', { ...input, args: { text: 'different' } }, 'S'), /operation_conflict/);
  f.journal.finish(first.ticket, { writes: { promptQueueByTab: '{"T":"snapshot"}' }, result: { itemId: 'I' } });
  f.reopen();
  const replay = f.journal.reserve('op1', 'T', input, 'new unrelated owner');
  assert.equal(replay.replay, true); assert.equal(replay.receipt.committed, true);
  assert.deepEqual(replay.receipt.result, { itemId: 'I' });
  assert.equal(f.db.prepare('SELECT value FROM app_state WHERE key=?').get('promptQueueByTab').value, '{"T":"snapshot"}');
});

test('owner change/copy or storage failure cannot produce a committed receipt or partial SQLite snapshot', t => {
  const f = fixture(t), first = f.journal.reserve('op2', 'T', input, 'S');
  f.scope('other'); assert.throws(() => f.journal.finish(first.ticket, { writes: { promptQueueByTab: 'bad' } }), /scope_changed/);
  f.scope('S'); f.fail(true);
  assert.throws(() => f.journal.finish(first.ticket, { writes: { promptQueueByTab: 'bad' } }), /storage failure/);
  assert.equal(f.db.prepare('SELECT * FROM app_state').all().length, 0);
  assert.equal(f.journal.read('op2').committed, false);
  assert.throws(() => f.journal.finish({ ...first.ticket, nonce: 'foreign' }), /operation_stale/);
});

test('lost HTTP ACK can settle late under the same ticket; restart uncertainty never redispatches', t => {
  const f = fixture(t), first = f.journal.reserve('op3', 'T', input, 'S');
  f.journal.unknown('op3', 'bridge_timeout');
  assert.equal(f.journal.read('op3').phase, 'unknown');
  f.journal.finish(first.ticket, { writes: { promptQueueByTab: 'committed' }, result: { version: 1 } });
  assert.equal(f.journal.read('op3').phase, 'applied');
  const second = f.journal.reserve('op4', 'T', input, 'S');
  f.reopen(); assert.equal(f.journal.read('op4').phase, 'unknown');
  assert.throws(() => f.journal.finish(second.ticket), /operation_stale/);
  assert.equal(f.journal.reserve('op4', 'T', input, 'S').replay, true);
});

test('Replay draft retains exact assets through unknown/commit/restart until explicit release', t => {
  const f = fixture(t), first = f.journal.reserve('op5', 'T', input, 'S');
  f.journal.holdAssets(first.ticket, ['A', 'A', 'B']);
  f.journal.unknown('op5'); assert.deepEqual([...f.journal.referencedAssetIds()], ['A', 'B']);
  f.journal.finish(first.ticket, { result: { draft: { text: '[Image #1]', imagePaths: [{ id: 1, assetId: 'A' }] } }, retainAssets: true });
  f.reopen(); assert.deepEqual([...f.journal.referencedAssetIds()], ['A', 'B']);
  assert.throws(() => f.journal.release('op5', 'foreign'), /release_invalid/);
  f.journal.release('op5', 'T'); f.journal.release('op5', 'T');
  assert.equal(f.journal.referencedAssetIds().size, 0); assert.equal(f.journal.read('op5').released, true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { adoptCompletedQueueTransfers } = require('./replay-asset-ownership');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-gc-inventory-'));
  const file = path.join(root, 'private.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode=WAL');
  db.exec(`
    CREATE TABLE history_prompt_presentations(tool_type TEXT,session_id TEXT,audit_timestamp TEXT,
      transport_hash TEXT,entry_uuid TEXT,schema_version INTEGER NOT NULL,chips_json TEXT NOT NULL);
    CREATE TABLE agent_send_queue(id INTEGER PRIMARY KEY,operation_key TEXT UNIQUE,state TEXT,
      asset_transfer_ids_json TEXT);
    CREATE TABLE agent_send_receipts(operation_key TEXT PRIMARY KEY);
    CREATE TABLE unrelated(value TEXT);
  `);
  const other = new Database(file);
  t.after(() => { other.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, other };
}
const image = c => c.repeat(64) + '.png';
const chips = id => JSON.stringify([{ kind: 'image-ref', assetId: id }]);
const history = db => DatabaseManager.prototype.getHistoryPromptPresentationAssetIds.call({ db });
const scanCounter = db => {
  let historyScans = 0, queueScans = 0;
  const original = db.prepare.bind(db);
  db.prepare = sql => {
    if (/SELECT\s+chips_json\s+FROM\s+history_prompt_presentations/i.test(sql)) historyScans++;
    if (/SELECT operation_key,asset_transfer_ids_json FROM agent_send_queue/i.test(sql)) queueScans++;
    return original(sql);
  };
  return () => ({ historyScans, queueScans });
};

test('query diagnostics expose bounded counts and memory, never inventory values or error text', t => {
  const { db } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 'private-session', 'time', 'hash', 'uuid', 3, chips(image('a')));
  const lines = [], log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    assert.deepEqual(history(db), [image('a')]);
    const prepare = db.prepare.bind(db);
    db.prepare = sql => {
      if (/SELECT\s+chips_json\s+FROM\s+history_prompt_presentations/i.test(sql)) {
        throw Error('PRIVATE-SENTINEL-FROM-SQL');
      }
      return prepare(sql);
    };
    // A local mutation invalidates the cached snapshot before the forced read error.
    db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
    assert.throws(() => history(db), /PRIVATE-SENTINEL-FROM-SQL/);
  } finally { console.log = log; }
  assert(lines.some(line => line.includes('phase=start') && line.includes('heapLimit=') && line.includes('external=')));
  assert(lines.some(line => line.includes('phase=end') && line.includes('rows=1') && line.includes('ids=1')));
  assert(lines.some(line => line.includes('phase=error')));
  for (const line of lines) {
    assert.equal(line.includes(image('a')), false);
    assert.equal(line.includes('private-session'), false);
    assert.equal(line.includes('PRIVATE-SENTINEL-FROM-SQL'), false);
  }
});

test('actual History inventory follows local writes, rollback, cross-connection commits and unrelated state', t => {
  const { db, other } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 's', 'time', 'hash', 'uuid', 3, chips(image('a')));
  const scans = scanCounter(db);
  assert.deepEqual(history(db), [image('a')]);
  assert.deepEqual(history(db), [image('a')]);
  db.prepare('INSERT INTO unrelated VALUES(?)').run('private');
  assert.deepEqual(history(db), [image('a')]);
  assert.equal(scans().historyScans, 1);

  db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
  assert.deepEqual(history(db), [image('b')]);
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('c')));
    assert.deepEqual(history(db), [image('c')]);
    throw Error('rollback');
  })(), /rollback/);
  assert.deepEqual(history(db), [image('b')]);
  other.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('d')));
  assert.deepEqual(history(db), [image('d')]);
  db.prepare('DELETE FROM history_prompt_presentations').run();
  assert.deepEqual(history(db), []);
  assert.equal(scans().historyScans, 6);
});

test('a reopened connection builds its own inventory and does not inherit a prior witness', t => {
  const { db, other } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 's', 'time', 'hash', 'uuid', 3, chips(image('a')));
  assert.deepEqual(history(db), [image('a')]);
  assert.deepEqual(history(other), [image('a')]);
  other.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
  assert.deepEqual(history(other), [image('b')]);
  assert.deepEqual(history(db), [image('b')]);
});

test('legacy queue without a transferred-asset column uses the unchanged inventory path', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE agent_send_queue(state TEXT, asset_ids_json TEXT)');
  db.prepare('INSERT INTO agent_send_queue VALUES(?,?)').run('waiting', JSON.stringify([image('a')]));
  const { readQueuedSendAssetIds } = require('./agent-send-queue');
  assert.deepEqual([...readQueuedSendAssetIds(db)], [image('a')]);
  assert.equal(adoptCompletedQueueTransfers(db), undefined);
});

test('queue candidate reuse never caches receipt or canonical-owner proof', t => {
  const { db, other } = fixture(t);
  db.exec(`INSERT INTO agent_send_queue VALUES(1,'a','completed','["${image('a')}"]');
    INSERT INTO agent_send_queue VALUES(2,'b','completed','["${image('b')}"]');`);
  const scans = scanCounter(db);
  adoptCompletedQueueTransfers(db);
  adoptCompletedQueueTransfers(db);
  assert.equal(scans().queueScans, 1);
  // A non-queue write cannot change candidate membership. The real owner
  // checks still run on every adoption call; missing receipts keep both pins.
  db.prepare('INSERT INTO unrelated VALUES(?)').run('owner changed');
  adoptCompletedQueueTransfers(db);
  assert.equal(scans().queueScans, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_send_queue WHERE asset_transfer_ids_json!='[]'").get().n, 2);
  other.exec("UPDATE agent_send_queue SET state='waiting' WHERE operation_key='a'");
  adoptCompletedQueueTransfers(db);
  assert.equal(scans().queueScans, 2);
  db.exec("UPDATE agent_send_queue SET asset_transfer_ids_json='[]' WHERE operation_key='b'");
  adoptCompletedQueueTransfers(db);
  assert.equal(scans().queueScans, 3);
});

test('replaced callback discards reuse and performs a real scan', t => {
  const { db } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 's', 'time', 'hash', 'uuid', 3, chips(image('a')));
  const scans = scanCounter(db);
  assert.deepEqual(history(db), [image('a')]);
  const trigger = db.prepare("SELECT sql FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '__noted_gc_history_%_update'").get();
  const callback = /SELECT\s+(\w+)\(\)/.exec(trigger.sql)?.[1];
  assert.ok(callback);
  db.function(callback, { varargs: true }, () => 0);
  db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
  assert.deepEqual(history(db), [image('b')]);
  db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('c')));
  assert.deepEqual(history(db), [image('c')]);
  assert.equal(scans().historyScans, 3);
});

test('a replacement zero-argument callback cannot spoof the cached witness', t => {
  const { db } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 's', 'time', 'hash', 'uuid', 3, chips(image('a')));
  assert.deepEqual(history(db), [image('a')]);
  const trigger = db.prepare("SELECT sql FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '__noted_gc_history_%_update'").get();
  const callback = /SELECT\s+(\w+)\(\)/.exec(trigger.sql)?.[1];
  assert.ok(callback);
  db.function(callback, () => 0);
  db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
  assert.deepEqual(history(db), [image('b')]);
});

test('an absent SQLite version cannot certify an unchanged cache', t => {
  const { db, other } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 's', 'time', 'hash', 'uuid', 3, chips(image('a')));
  const pragma = db.pragma.bind(db);
  db.pragma = (sql, options) => sql === 'main.data_version' ? undefined : pragma(sql, options);
  assert.throws(() => history(db), /gc_asset_witness_unavailable/);
  other.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
  assert.throws(() => history(db), /gc_asset_witness_unavailable/);
});

test('removed trigger invalidates reuse; a failed version read never returns stale inventory', t => {
  const { db } = fixture(t);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 's', 'time', 'hash', 'uuid', 3, chips(image('a')));
  const scans = scanCounter(db);
  assert.deepEqual(history(db), [image('a')]);
  const trigger = db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '__noted_gc_history_%_update'").get();
  db.exec('DROP TRIGGER temp.' + trigger.name);
  db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips(image('b')));
  assert.deepEqual(history(db), [image('b')]);
  assert.equal(scans().historyScans, 2);

  const fresh = new Database(':memory:');
  t.after(() => fresh.close());
  fresh.exec('CREATE TABLE history_prompt_presentations(schema_version INTEGER,chips_json TEXT)');
  fresh.prepare('INSERT INTO history_prompt_presentations VALUES(?,?)').run(3, chips(image('c')));
  assert.deepEqual(history(fresh), [image('c')]);
  const pragma = fresh.pragma.bind(fresh);
  fresh.pragma = (sql, options) => {
    if (sql === 'main.data_version') throw Error('private version read failure');
    return pragma(sql, options);
  };
  assert.throws(() => history(fresh), /private version read failure/);
});

test('History retains image paths, document projections, duplicates and legacy filtering exactly', t => {
  const { db } = fixture(t);
  const insert = db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)');
  const document = 'd'.repeat(64) + '.document.pdf';
  insert.run('codex', 'one', 't', 'h', 'u', 3, JSON.stringify([
    { kind: 'image-ref', assetId: image('a') },
    { kind: 'image-ref', assetId: 'invalid', path: '/synthetic/' + image('b') },
    { kind: 'authoring-projection', parts: [{ kind: 'file', assetId: document }] },
    { kind: 'image-ref', assetId: image('a') },
  ]));
  insert.run('claude', 'two', 't', 'h', 'u', 2, chips(image('c')));
  insert.run('codex', 'three', 't', 'h', 'u', 3, 'null');
  assert.deepEqual(history(db), [image('a'), image('b'), document]);
  assert.deepEqual(history(db), [image('a'), image('b'), document]);
});

test('oversized queue inventory falls back to all rows without truncation', t => {
  const { db } = fixture(t), insert = db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,?)');
  db.transaction(() => { for (let i = 0; i < 129; i++) insert.run(i, 'op' + i, 'completed', '["x"]'); })();
  const scans = scanCounter(db);
  adoptCompletedQueueTransfers(db);
  adoptCompletedQueueTransfers(db);
  assert.equal(scans().queueScans, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_send_queue WHERE asset_transfer_ids_json!='[]'").get().n, 129);
});

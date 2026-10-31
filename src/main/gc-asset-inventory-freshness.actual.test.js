'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { prepareQueueInventory, readQueueInventoryPinned } = require('./gc-asset-inventory-cache');

const image = c => c.repeat(64) + '.png';
const chips = c => JSON.stringify([{ kind: 'image-ref', assetId: image(c) }]);
const historyDDL = `CREATE TABLE history_prompt_presentations (
  tool_type TEXT, session_id TEXT, audit_timestamp TEXT, transport_hash TEXT,
  entry_uuid TEXT, schema_version INTEGER NOT NULL, chips_json TEXT NOT NULL)`;
const queueDDL = `CREATE TABLE agent_send_queue (
  id INTEGER PRIMARY KEY, operation_key TEXT UNIQUE, state TEXT, asset_transfer_ids_json TEXT)`;

function fixture(t) {
  const db = new Database(':memory:');
  db.exec(historyDDL + ';' + queueDDL);
  db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
    .run('codex', 'private', 'time', 'hash', 'uuid', 3, chips('a'));
  db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,?)')
    .run(1, 'private', 'completed', JSON.stringify([image('a')]));
  t.after(() => db.close());
  return db;
}

const history = db => DatabaseManager.prototype.getHistoryPromptPresentationAssetIds.call({ db });
function queue(db) {
  const tracker = prepareQueueInventory(db);
  return db.transaction(() => readQueueInventoryPinned(db, tracker,
    () => db.prepare(`SELECT operation_key,asset_transfer_ids_json FROM agent_send_queue
      WHERE state='completed' AND asset_transfer_ids_json!='[]'`).all()))();
}
const queueValue = c => [{ operation_key: 'private', asset_transfer_ids_json: JSON.stringify([image(c)]) }];

for (const kind of ['history', 'queue']) {
  test(kind + ': renamed main table cannot leave a tracker on the old table', t => {
    const db = fixture(t);
    const read = kind === 'history' ? () => history(db) : () => queue(db).value;
    const value = c => kind === 'history' ? [image(c)] : queueValue(c);
    assert.deepEqual(read(), value('a'));
    assert.deepEqual(read(), value('a'));
    if (kind === 'history') {
      db.exec('ALTER TABLE main.history_prompt_presentations RENAME TO history_old;' + historyDDL);
      db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
        .run('codex', 'private', 'time', 'hash', 'uuid', 3, chips('b'));
    } else {
      db.exec('ALTER TABLE main.agent_send_queue RENAME TO queue_old;' + queueDDL);
      db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,?)')
        .run(1, 'private', 'completed', JSON.stringify([image('b')]));
    }
    const trigger = db.prepare("SELECT tbl_name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE ?")
      .get('__noted_gc_' + kind + '_%_update');
    assert.equal(trigger.tbl_name, kind === 'history' ? 'history_old' : 'queue_old');
    assert.deepEqual(read(), value('b'));
    if (kind === 'history') db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips('c'));
    else db.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('c')]));
    assert.deepEqual(read(), value('c'));
  });

  test(kind + ': recreated TEMP schema with the same cookie cannot resurrect a missing tracker', t => {
    const db = fixture(t);
    const read = kind === 'history' ? () => history(db) : () => queue(db).value;
    const value = c => kind === 'history' ? [image(c)] : queueValue(c);
    assert.deepEqual(read(), value('a'));
    const initial = db.pragma('temp.schema_version', { simple: true });
    db.pragma('temp_store = MEMORY');
    const reset = db.pragma('temp.schema_version', { simple: true });
    if (kind === 'history') queue(db); else history(db);
    const reused = db.pragma('temp.schema_version', { simple: true });
    assert.equal(reset, 0);
    assert.equal(reused, initial);
    if (kind === 'history') db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips('b'));
    else db.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
    assert.deepEqual(read(), value('b'));
  });

  test(kind + ': TEMP shadow keeps unqualified scan semantics without reusing main cache', t => {
    const db = fixture(t);
    const read = kind === 'history' ? () => history(db) : () => queue(db).value;
    const value = c => kind === 'history' ? [image(c)] : queueValue(c);
    const table = kind === 'history' ? 'history_prompt_presentations' : 'agent_send_queue';
    assert.deepEqual(read(), value('a'));
    assert.deepEqual(read(), value('a'));
    db.exec('CREATE TEMP TABLE ' + table + ' AS SELECT * FROM main.' + table);
    assert.deepEqual(read(), value('a'));
    if (kind === 'history') {
      db.prepare('UPDATE temp.history_prompt_presentations SET chips_json=?').run(chips('b'));
      assert.deepEqual(read(), value('b'));
      db.prepare('UPDATE main.history_prompt_presentations SET chips_json=?').run(chips('c'));
    } else {
      db.prepare('UPDATE temp.agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
      assert.deepEqual(read(), value('b'));
      db.prepare('UPDATE main.agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('c')]));
    }
    assert.deepEqual(read(), value('b'));
    db.exec('DROP TABLE temp.' + table);
    assert.deepEqual(read(), value('c'));
  });

  test(kind + ': harmless main schema change retains a valid tracker', t => {
    const db = fixture(t);
    const table = kind === 'history' ? 'history_prompt_presentations' : 'agent_send_queue';
    const read = kind === 'history' ? () => history(db) : () => queue(db).value;
    const value = c => kind === 'history' ? [image(c)] : queueValue(c);
    assert.deepEqual(read(), value('a'));
    db.exec('ALTER TABLE main.' + table + ' ADD COLUMN private_extra TEXT');
    assert.deepEqual(read(), value('a'));
    if (kind === 'history') db.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips('b'));
    else db.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
    assert.deepEqual(read(), value('b'));
    if (kind === 'queue') assert.equal(queue(db).reason, 'hit');
    else {
      let scans = 0, original = db.prepare.bind(db);
      db.prepare = sql => {
        if (/SELECT\s+chips_json\s+FROM\s+history_prompt_presentations/i.test(sql)) scans++;
        return original(sql);
      };
      assert.deepEqual(read(), value('b'));
      assert.equal(scans, 0);
    }
  });

  test(kind + ': case-insensitive TEMP view shadow preserves unqualified reads', t => {
    const db = fixture(t);
    const table = kind === 'history' ? 'history_prompt_presentations' : 'agent_send_queue';
    const read = kind === 'history' ? () => history(db) : () => queue(db).value;
    const value = c => kind === 'history' ? [image(c)] : queueValue(c);
    assert.deepEqual(read(), value('a'));
    db.exec('CREATE TEMP TABLE private_shadow_source AS SELECT * FROM main.' + table);
    db.exec('CREATE TEMP VIEW "' + table.toUpperCase() + '" AS SELECT * FROM private_shadow_source');
    assert.deepEqual(read(), value('a'));
    if (kind === 'history') db.prepare('UPDATE temp.private_shadow_source SET chips_json=?').run(chips('b'));
    else db.prepare('UPDATE temp.private_shadow_source SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
    assert.deepEqual(read(), value('b'));
    db.exec('DROP VIEW temp."' + table.toUpperCase() + '"');
    assert.deepEqual(read(), value('a'));
  });
}

for (const kind of ['history', 'queue']) {
  for (const mode of ['hit', 'invalidated']) {
    for (const phase of ['before-pin', 'after-pin', 'before-version', 'after-version']) {
      test(kind + ': WAL commit ' + phase + ' preserves the pinned ' + mode + ' snapshot', t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-gc-wal-'));
        const file = path.join(root, 'private.sqlite'), db = new Database(file);
        db.pragma('journal_mode = WAL');
        db.exec(historyDDL + ';' + queueDDL);
        db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
          .run('codex', 'private', 'time', 'hash', 'uuid', 3, chips('a'));
        db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,?)')
          .run(1, 'private', 'completed', JSON.stringify([image('a')]));
        const other = new Database(file);
        t.after(() => { other.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
        const read = kind === 'history' ? () => history(db) : () => queue(db).value;
        const value = c => kind === 'history' ? [image(c)] : queueValue(c);
        assert.deepEqual(read(), value('a'));
        assert.deepEqual(read(), value('a'));
        if (mode === 'invalidated') {
          if (kind === 'history') db.exec('UPDATE history_prompt_presentations SET chips_json=chips_json');
          else db.exec("UPDATE agent_send_queue SET state='waiting'; UPDATE agent_send_queue SET state='completed'");
        }
        let fired = false;
        const commit = () => {
          assert.equal(fired, false); fired = true;
          if (kind === 'history') other.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips('b'));
          else other.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
        };
        const prepare = db.prepare.bind(db), pragma = db.pragma.bind(db);
        db.prepare = sql => {
          const statement = prepare(sql);
          if ((phase === 'before-pin' || phase === 'after-pin')
            && sql.startsWith("SELECT rootpage FROM main.sqlite_master")) {
            return { get(...args) {
              if (!fired && phase === 'before-pin') commit();
              const value = statement.get(...args);
              if (!fired && phase === 'after-pin') commit();
              return value;
            } };
          }
          return statement;
        };
        db.pragma = (sql, options) => {
          if (sql === 'main.data_version' && !fired && phase === 'before-version') commit();
          const value = pragma(sql, options);
          if (sql === 'main.data_version' && !fired && phase === 'after-version') commit();
          return value;
        };
        assert.deepEqual(read(), value(phase === 'before-pin' ? 'b' : 'a'));
        assert.equal(fired, true);
        db.prepare = prepare; db.pragma = pragma;
        assert.deepEqual(read(), value('b'));
      });
    }
  }
}

for (const kind of ['history', 'queue']) {
  for (const phase of ['before-scan', 'after-scan']) {
    test(kind + ': WAL commit ' + phase + ' cannot change an already pinned scan', t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-gc-wal-scan-'));
      const file = path.join(root, 'private.sqlite'), db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.exec(historyDDL + ';' + queueDDL);
      db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
        .run('codex', 'private', 'time', 'hash', 'uuid', 3, chips('a'));
      db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,?)')
        .run(1, 'private', 'completed', JSON.stringify([image('a')]));
      const other = new Database(file);
      t.after(() => { other.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const read = kind === 'history' ? () => history(db) : () => queue(db).value;
      const value = c => kind === 'history' ? [image(c)] : queueValue(c);
      assert.deepEqual(read(), value('a'));
      if (kind === 'history') db.exec('UPDATE history_prompt_presentations SET chips_json=chips_json');
      else db.exec("UPDATE agent_send_queue SET state='waiting'; UPDATE agent_send_queue SET state='completed'");
      let fired = false;
      const commit = () => {
        assert.equal(fired, false); fired = true;
        if (kind === 'history') other.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips('b'));
        else other.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
      };
      const prepare = db.prepare.bind(db);
      db.prepare = sql => {
        const statement = prepare(sql);
        const target = kind === 'history'
          ? /SELECT\s+chips_json\s+FROM\s+history_prompt_presentations/i.test(sql)
          : /SELECT operation_key,asset_transfer_ids_json FROM agent_send_queue/i.test(sql);
        if (!target) return statement;
        if (kind === 'history') return { *iterate(...args) {
          if (phase === 'before-scan') commit();
          yield* statement.iterate(...args);
          if (phase === 'after-scan') commit();
        } };
        return { all(...args) {
          if (phase === 'before-scan') commit();
          const value = statement.all(...args);
          if (phase === 'after-scan') commit();
          return value;
        } };
      };
      assert.deepEqual(read(), value('a'));
      assert.equal(fired, true);
      db.prepare = prepare;
      assert.deepEqual(read(), value('b'));
    });
  }
}

for (const kind of ['history', 'queue']) {
  for (const mode of ['hit', 'invalidated']) {
    test(kind + ': WAL commit after a ' + mode + ' return is visible to the next read', t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-gc-wal-return-'));
      const file = path.join(root, 'private.sqlite'), db = new Database(file);
      db.pragma('journal_mode = WAL');
      db.exec(historyDDL + ';' + queueDDL);
      db.prepare('INSERT INTO history_prompt_presentations VALUES(?,?,?,?,?,?,?)')
        .run('codex', 'private', 'time', 'hash', 'uuid', 3, chips('a'));
      db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,?)')
        .run(1, 'private', 'completed', JSON.stringify([image('a')]));
      const other = new Database(file);
      t.after(() => { other.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const read = kind === 'history' ? () => history(db) : () => queue(db).value;
      const value = c => kind === 'history' ? [image(c)] : queueValue(c);
      assert.deepEqual(read(), value('a'));
      if (mode === 'invalidated') {
        if (kind === 'history') db.exec('UPDATE history_prompt_presentations SET chips_json=chips_json');
        else db.exec("UPDATE agent_send_queue SET state='waiting'; UPDATE agent_send_queue SET state='completed'");
      }
      assert.deepEqual(read(), value('a'));
      if (kind === 'history') other.prepare('UPDATE history_prompt_presentations SET chips_json=?').run(chips('b'));
      else other.prepare('UPDATE agent_send_queue SET asset_transfer_ids_json=?').run(JSON.stringify([image('b')]));
      assert.deepEqual(read(), value('b'));
    });
  }
}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { HistoryPendingPayloads, readChunkedPayload } = require('./history-pending-payloads');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-pending-bound-'));
  const pending = new HistoryPendingPayloads({ directory });
  t.after(() => { pending.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return pending;
}

test('PENDING-NATIVE-CELL: size is checked before any native BLOB row allocation', t => {
  const pending = fixture(t); pending.set('own-result', 'small');
  pending.db.prepare('UPDATE payload_chunks SET body=? WHERE id=?').run(Buffer.alloc(256 * 1024), 'own-result');
  const prepare = pending.db.prepare.bind(pending.db); let bodyReads = 0;
  pending.db.prepare = sql => {
    if (/SELECT.*substr\(body/i.test(sql)) {
      const statement = prepare(sql), get = statement.get.bind(statement);
      statement.get = (...args) => { bodyReads++; return get(...args); };
      return statement;
    }
    return prepare(sql);
  };
  assert.throws(() => readChunkedPayload(pending.db, 'own-result', { offset: 0, limit: 2 }), /history_cache_checksum/);
  assert.equal(bodyReads, 0, 'the oversized cell must never reach a native BLOB getter');
});

test('PENDING-PRESERVE: full field, hash, range and surrogate semantics survive guarded reads', t => {
  const pending = fixture(t), text = 'a'.repeat(32767) + '😀tail';
  pending.set('own-result', text);
  assert.equal(pending.get('own-result'), text);
  const page = readChunkedPayload(pending.db, 'own-result', { offset: 32766, limit: 2 });
  assert.equal(page.payload, 'a'); assert.equal(page.nextOffset, 32767);
  assert.equal(readChunkedPayload(pending.db, 'own-result', { offset: 32767, limit: 2 }).payload, '😀');
  assert.throws(() => readChunkedPayload(pending.db, 'own-result', { offset: 32768, limit: 2 }), /history_payload_range_invalid/);
  assert.deepEqual(readChunkedPayload(pending.db, 'own-result', { expectedContentHash: '0'.repeat(64) }),
    { success: false, error: 'history_payload_changed', payloadId: 'own-result' });
});

test('PENDING-TRANSFER-CELL: sync/async cache transfer rejects oversized cell before native materialization', async t => {
  const pending = fixture(t), target = new Database(':memory:'); t.after(() => target.close());
  target.exec('CREATE TABLE payloads(id TEXT PRIMARY KEY,body BLOB)');
  pending.set('value', 'trusted'); target.transaction(() => pending.transferTo(target))();
  pending.set('value', 'new');
  pending.db.prepare('UPDATE payload_chunks SET body=? WHERE id=?').run(Buffer.alloc(256 * 1024), 'value');
  const prepare = pending.db.prepare.bind(pending.db); let bodyReads = 0;
  pending.db.prepare = sql => {
    const statement = prepare(sql);
    if (/SELECT.*substr\(body/i.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { bodyReads++; return get(...args); };
    }
    return statement;
  };
  assert.throws(() => target.transaction(() => pending.transferTo(target))(), /history_cache_checksum/);
  target.exec('BEGIN');
  try { await assert.rejects(pending.transferToAsync(target), /history_cache_checksum/); }
  finally { target.exec('ROLLBACK'); }
  assert.equal(bodyReads, 0);
  assert.equal(readChunkedPayload(target, 'value').payload, 'trusted');
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { StorageDeletionAudit } = require('./storage-deletion-audit');

test('storage deletion audit serializes concurrent append-only records', async () => {
  const writes = [];
  const audit = new StorageDeletionAudit({
    filePath: '/tmp/noted-storage-audit-test.jsonl',
    now: () => Date.UTC(2026, 7, 25, 7, 0, 0),
    mkdir: async () => {},
    appendFile: async (_target, content) => {
      await new Promise((resolve) => setImmediate(resolve));
      writes.push(content);
    },
  });
  await Promise.all([
    audit.record({ status: 'attempt', sessionId: 'one' }),
    audit.record({ status: 'removed', sessionId: 'one', deletedSessionIds: ['one', 'child'] }),
  ]);
  assert.equal(writes.length, 2);
  const rows = writes.map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.status), ['attempt', 'removed']);
  assert.equal(rows[0].timestamp, '2026-08-25T07:00:00.000Z');
  assert.deepEqual(rows[1].deletedSessionIds, ['one', 'child']);
});

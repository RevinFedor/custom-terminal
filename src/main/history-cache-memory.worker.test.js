'use strict';
// ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test this-file
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryReadClient } = require('./history-read-client');

test('actual reader publishes RAM counters; passive widget access never starts a reader', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-memory-worker-'));
  const client = new HistoryReadClient({ cacheDirectory: path.join(dir, 'cache'), sessionsDir: dir,
    memoryBudgetMb: 64, diskBudgetBytes: 3 * 1024 ** 3 });
  t.after(async () => { await client.close(); await fs.rm(dir, { recursive: true, force: true }); });
  assert.equal(client.getCacheMemorySnapshot().graphBytes, 0);
  assert.equal(client.worker, undefined); assert.equal(client.sequence, 0);
  const sessionId = 'cache-memory-fixture';
  await fs.writeFile(path.join(dir, 'rollout-' + sessionId + '.jsonl'), [
    { type: 'session_meta', payload: { id: sessionId, cwd: dir } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Private synthetic response' }] } },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  const value = await client.call('getHistory', { toolType: 'codex', sessionId, cwd: dir, dehydrate: true });
  assert.equal(value.success, true);
  const observed = client.getCacheMemorySnapshot();
  assert.equal(observed.status, 'ready'); assert.ok(observed.graphBytes > 0);
  assert.ok(Number.isSafeInteger(observed.indexBytes)); assert.equal(observed.generation, 1);
  const before = client.sequence;
  client.getCacheMemorySnapshot(); client.getCacheMemorySnapshot();
  assert.equal(client.sequence, before, 'preview reads must not enqueue RPC');
  const stats = await client.call('stats'); assert.equal(stats.cache.budgetBytes, 3 * 1024 ** 3);
  await client.close(); assert.equal(client.getCacheMemorySnapshot().status, 'unknown');
});

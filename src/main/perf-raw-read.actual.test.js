'use strict';
// Uses the product Codex raw reader and isolated synthetic files, not provider
// storage. Run with Electron's native ABI alongside the History worker tests.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { causal } = require('./perf-causal-context');
const { createThreadMetrics } = require('./perf-thread-metrics');
const { createCausalJournal } = require('./perf-causal-journal');
const { _api: api } = require('./ipc/codex-data');

test('actual raw consumer keeps parent/caller and distinguishes full/warm/append without content or reader changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-causal-raw-'));
  const sid = 'causal-private-session', file = path.join(root, 'rollout-' + sid + '.jsonl');
  const bytes = text => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T00:00:00Z',
    payload: { type: 'user_message', message: text } }) + '\n';
  const packets = [], metrics = createThreadMetrics();
  causal.configure({ enabled: true, metrics, sink: record => { packets.push(record); return true; } });
  t.after(async () => { causal.configure({ enabled: false }); metrics.close(); api.invalidateJsonlCache(file); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(file, bytes('PRIVATE_TRANSCRIPT_1'));
  const read = () => causal.run('private:actual-history-reader', { tabId: 'L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvY3VzdG9tLXRlcm1pbmFs-tab-3314',
    actionId: 'ui-private-1', readId: 'read-private-1' }, () => api.loadSessionRecords(sid, root, { sessionsDir: root }));
  const cold = await read(); assert.equal(cold.success, true); assert.equal(cold.records.length, 1);
  const warm = await read(); assert.equal(warm.records.length, 1); assert.notEqual(cold.records, warm.records);
  await fs.appendFile(file, bytes('PRIVATE_TRANSCRIPT_2'));
  const appended = await read(); assert.equal(appended.records.length, 2); assert.equal(cold.records.length, 1);
  const raw = packets.filter(r => r.name === 'codex.raw-records' && r.phase === 'settle');
  assert.deepEqual(raw.map(r => r.mode), ['first-read', 'memory-hit', 'append']);
  assert.deepEqual(raw.map(r => r.recordsAfter), [1, 1, 2]);
  assert.equal(raw[1].deltaBytes, 0); assert.equal(raw[2].deltaBytes, Buffer.byteLength(bytes('PRIVATE_TRANSCRIPT_2')));
  assert.ok(raw.every(r => r.actionId === 'ui-private-1' && r.parentSpanId));
  assert.ok(packets.some(r => r.name === 'codex.loadSessionRecords' && r.caller === 'private:actual-history-reader'));
  assert.ok(!JSON.stringify(packets).includes('PRIVATE_TRANSCRIPT'));
  assert.ok(!JSON.stringify(packets).includes(root));
  const journal = createCausalJournal({ artifacts: { write() {} } });
  for (const packet of packets) journal.record(packet, { pid: process.pid, kind: 'main' });
  assert.equal(journal.snapshot().counts.droppedBytes, 0, 'real correlation+clock metadata fits thin-record bound');
  journal.flush(true);
});

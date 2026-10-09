'use strict';
// Own Electron Node process, synthetic JSONL/cache, actual HistoryReadClient and
// worker. Deliberate blocks/GC are confined to this disposable test process.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const { HistoryReadClient } = require('../src/main/history-read-client');
const { createThreadMetrics } = require('../src/main/perf-thread-metrics');
const output = process.argv[2];
assert.ok(output, 'provide an evidence result path');
const abs = () => performance.timeOrigin + performance.now();
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-causal-transport-'));
  const result = { status: 'running', pid: process.pid, runtime: process.versions, cases: [] };
  const gcRecords = [], metrics = createThreadMetrics({ onGC: record => gcRecords.push(record) });
  let client;
  try {
    for (const [sessionId, length] of [['small', 500], ['large', 11 * 1024 * 1024]]) {
      const events = [];
      await fs.writeFile(path.join(root, 'rollout-' + sessionId + '.jsonl'), JSON.stringify({
        type: 'response_item', timestamp: '2026-10-09T00:00:00Z', payload: { type: 'message', role: 'assistant',
          phase: 'final_answer', content: [{ type: 'output_text', text: 'x'.repeat(length) }] } }) + '\n');
      client = new HistoryReadClient({ sessionsDir: root, cacheDirectory: path.join(root, 'cache'),
        memoryBudgetMb: 64, diagnosticSlowMs: 0, onDiagnostic: e => events.push(e) });
      const payload = { toolType: 'codex', cwd: root, sessionId, tabId: 'test-' + sessionId, dehydrate: false };
      await client.call('getHistory', payload, true); // establish source epoch and warm cache
      const before = metrics.read();
      const pending = client.call('getHistory', payload, true);
      const blockedFrom = abs();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      const resumed = abs(), blockMetrics = metrics.between(before);
      const binary = await pending;
      const decodeStart = abs(), decoded = v8.deserialize(Buffer.from(binary.data)), decodeEnd = abs();
      await client.call('stats');
      const worker = events.filter(e => e.side === 'worker' && e.event === 'request-complete' && e.method === 'getHistory').at(-1);
      const main = events.find(e => e.event === 'rpc-response' && e.requestId === worker.requestId);
      assert.ok(worker.replyReadyAbs > blockedFrom && worker.replyReadyAbs < resumed, 'worker finishes while receiver is blocked');
      assert.ok(main.receivedAbs >= resumed && main.deliveryMs > 400);
      assert.equal(binary.data.byteLength, worker.resultBytes);
      assert.equal(decoded.entries[0].content.length, length);
      assert.ok(blockMetrics.threadCpuMs < 250, 'receiver wait is not CPU-bound');
      result.cases.push({ sessionId, blockedFrom, resumed, blockMetrics, worker, main,
        decodeStartAbs: decodeStart, decodeEndAbs: decodeEnd, decodeMs: decodeEnd - decodeStart,
        resultBytes: binary.data.byteLength });
      await client.close(); client = null;
    }
    assert.ok(result.cases[0].resultBytes < 4096 && result.cases[1].resultBytes > 11 * 1024 * 1024);
    assert.equal(typeof global.gc, 'function', 'private canary must use --expose-gc');
    const gcFrom = abs(); global.gc(); const gcTo = abs();
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
    const matchingGC = gcRecords.filter(r => r.startAbs < gcTo && r.startAbs + r.durationMs > gcFrom);
    assert.ok(matchingGC.length > 0, 'actual Node GC correlates by execution time, not delayed observer delivery');
    result.gc = { from: gcFrom, to: gcTo, records: matchingGC };
    result.status = 'pass';
  } catch (error) { result.status = 'fail'; result.error = error.stack; process.exitCode = 1; }
  finally {
    await client?.close(); metrics.close(); await fs.rm(root, { recursive: true, force: true });
    result.cleanup = { workersClosed: true, syntheticSourceAndCacheRemoved: true };
    await fs.writeFile(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ status: result.status, result: output, error: result.error }));
  }
})();

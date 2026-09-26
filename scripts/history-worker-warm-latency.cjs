'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { HistoryReadClient } = require('../src/main/history-read-client');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-warm-latency-'));
  const row = (text, n) => JSON.stringify({ type: 'response_item', timestamp: new Date(1790300000000 + n * 1000).toISOString(),
    payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } }) + '\n';
  await fs.writeFile(path.join(root, 'rollout-warm.jsonl'), Array.from({ length: 80 }, (_, i) => row('warm ' + i, i)).join(''));
  await fs.writeFile(path.join(root, 'rollout-cold.jsonl'), Array.from({ length: 14000 }, (_, i) => row('cold ' + i + 'x'.repeat(1600), i)).join(''));
  const client = new HistoryReadClient({ sessionsDir: root, cacheDirectory: path.join(root, 'cache'), memoryBudgetMb: 128, diagnosticStages: true });
  const request = { toolType: 'codex', sessionId: 'warm', cwd: root, dehydrate: true, hydrate: { radius: 3, alwaysHydrateTail: 2 } };
  const samples = [], pending = [];
  try {
    assert.equal((await client.call('getHistory', request)).success, true);
    client.worker.on('message', event => {
      if (event.event !== 'cache-stage' || event.sessionId !== 'cold') return;
      const started = performance.now();
      pending.push(client.call('getHistory', request).then(result => {
        assert.equal(result.success, true);
        samples.push({ phase: event.phase, elapsedMs: performance.now() - started });
      }));
    });
    const started = performance.now();
    assert.equal((await client.call('getHistory', { ...request, sessionId: 'cold' })).success, true);
    await Promise.all(pending);
    const result = { artifact: root, coldMs: performance.now() - started, samples, status: 'PASS' };
    assert.ok(samples.some(s => s.phase === 'base-rows') && samples.some(s => s.phase === 'view-rows'));
    assert.ok(samples.filter(s => /-rows$/.test(s.phase)).every(s => s.elapsedMs < 500),
      'a prepared read must not wait through another owner\'s whole row transaction');
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

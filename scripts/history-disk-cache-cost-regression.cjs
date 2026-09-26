'use strict';
// Run with the repository's Electron binary in ELECTRON_RUN_AS_NODE mode.
// Synthetic rollouts only; deliberately exercises REAL byte-budget eviction.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { HistoryReadClient } = require('../src/main/history-read-client');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-disk-cost-'));
  const file = path.join(dir, 'rollout-large.jsonl');
  const handle = await fs.open(file, 'w');
  const turns = Number(process.env.NOTED_BENCH_TURNS || 8000);
  let chunk = '';
  const add = async row => { chunk += JSON.stringify(row) + '\n'; if (chunk.length > 1024 * 1024) { await handle.write(chunk); chunk = ''; } };
  for (let i = 0; i < turns; i++) {
    const timestamp = new Date(Date.UTC(2026, 8, 25) + i * 2000).toISOString();
    await add({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'prompt ' + i } });
    await add({ type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec_command', call_id: 'call-' + i, arguments: JSON.stringify({ cmd: 'cat synthetic-' + i + '.txt' }) } });
    await add({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'call-' + i, output: 'output ' + i + ' ' + 'x'.repeat(32768) } });
    await add({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer ' + i }] } });
  }
  if (chunk) await handle.write(chunk);
  await handle.close();
  const pressureFile = path.join(dir, 'rollout-pressure.jsonl');
  const pressureRows = Array.from({ length: 1600 }, (_, i) => JSON.stringify({ type: 'response_item', timestamp: '2026-09-25T00:00:00Z',
    payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'pressure ' + i + ' ' + 'p'.repeat(20000) }] } }) + '\n');
  await fs.writeFile(pressureFile, pressureRows.join('')); pressureRows.length = 0;
  const client = new HistoryReadClient({ cacheDirectory: path.join(dir, 'cache'), sessionsDir: dir, memoryBudgetMb: 64 });
  const request = { toolType: 'codex', sessionId: 'large', cwd: dir, tabId: 'bench', dehydrate: true, deltaOk: true,
    hydrate: { radius: 10, alwaysHydrateTail: 2 } };
  const result = { artifact: dir, bytes: (await fs.stat(file)).size, turns, stages: [] };
  let last = performance.now(), gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 5);
  async function measure(name, operation) {
    gap = 0; last = performance.now(); const started = last;
    const response = await operation();
    const finished = performance.now();
    // Let the overdue timer observe native message deserialization too. A
    // sample taken in this promise continuation would miss the final stall.
    await new Promise(resolve => setTimeout(resolve, 10));
    result.stages.push({ name, elapsedMs: finished - started, mainLoopMaxMs: gap,
      mainHeapUsed: process.memoryUsage().heapUsed, stats: await client.call('stats') });
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }
  try {
    const first = await measure('cold', () => client.call('getHistory', request));
    await measure('pressure', () => client.call('getHistory', { ...request, sessionId: 'pressure' }));
    const before = await client.call('stats');
    assert.equal(before.projector.sessions, 1, 'real byte-budget eviction left only the pressure owner');
    const uuid = first.entries[30].uuid;
    const page = await measure('disk seek after real eviction', () => client.call('getHistory', {
      ...request, ifRevision: first.revision, hydrate: { centerUuid: uuid, radius: 3, alwaysHydrateTail: 2 },
    }));
    const afterSeek = await client.call('stats');
    assert.equal(afterSeek.sourceBytes, before.sourceBytes);
    assert.equal(afterSeek.cache.continuationBytes, before.cache.continuationBytes);
    assert.equal(afterSeek.cache.pageRows - before.cache.pageRows, 9);
    assert.equal(page.payloadGeneration, first.payloadGeneration);
    const suffix = JSON.stringify({ type: 'response_item', timestamp: '2026-09-25T23:00:00Z', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'APPEND-PROBE' }],
    } }) + '\n';
    await fs.appendFile(file, suffix);
    const appended = await measure('append after real eviction', () => client.call('getHistory', { ...request, ifRevision: page.revision }));
    assert.ok((appended.entries || appended.changedEntries).some(row => row.content === 'APPEND-PROBE'));
    assert.equal(appended.payloadGeneration, first.payloadGeneration);
    const after = await client.call('stats');
    assert.equal(after.sourceBytes - afterSeek.sourceBytes, Buffer.byteLength(suffix));
    assert.ok(after.cache.writes - afterSeek.cache.writes <= 4, 'tiny append must not rewrite unchanged prepared rows');
    assert.ok(after.cache.diskBytes <= after.cache.budgetBytes);
    result.status = 'PASS';
  } catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1; }
  finally { clearInterval(timer); await client.close(); await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

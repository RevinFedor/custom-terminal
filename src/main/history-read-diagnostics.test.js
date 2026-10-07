'use strict';

// Run with the installed Electron ABI (no rebuild):
// ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test src/main/history-read-diagnostics.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { HistoryReadClient } = require('./history-read-client');

const record = (i, text = 'PRIVATE_TRANSCRIPT_TEXT') => ({ type: 'response_item', timestamp: new Date(1700000000000 + i).toISOString(),
  payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: text + i }] } });
const encode = records => records.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(t, rows = 8, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-diagnostics-private-'));
  const sessionId = 'diagnostic-session';
  const file = path.join(directory, 'rollout-' + sessionId + '.jsonl');
  await fs.writeFile(file, encode(Array.from({ length: rows }, (_, i) => record(i))));
  const events = [];
  const config = { cacheDirectory: path.join(directory, 'cache'), sessionsDir: directory, memoryBudgetMb: 64,
    diagnosticSlowMs: 0, ...options, onDiagnostic: event => events.push(event) };
  let client = new HistoryReadClient(config);
  const f = { directory, file, sessionId, events, config, get client() { return client; },
    payload: { toolType: 'codex', sessionId, cwd: directory, tabId: 'diagnostic-tab', dehydrate: true },
    async flush() { await client.call('stats'); },
    async restart() { await client.close(); client = new HistoryReadClient(config); },
    completed(method = 'getHistory') { return events.filter(e => e.side === 'worker' && e.event === 'request-complete' && e.method === method); },
  };
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return f;
}

function checkBounds(f) {
  for (const event of f.events) {
    assert.ok(JSON.stringify(event).length < 16384, 'one bounded diagnostic log record');
    if (event.phases) assert.ok(event.phases.length <= 16);
    for (const key of ['method', 'tool', 'tab', 'session']) if (event[key] != null) assert.ok(event[key].length <= 80);
  }
  const serialized = JSON.stringify(f.events);
  assert.ok(!serialized.includes(f.directory), 'no cwd or source paths in diagnostics');
  assert.ok(!serialized.includes('PRIVATE_TRANSCRIPT_TEXT'), 'no transcript content in diagnostics');
}

test('real worker correlates cold rebuild, binary serialization and main delivery without changing DTO/proof', async t => {
  const f = await fixture(t, 120);
  const binary = await f.client.call('getHistory', f.payload, true);
  const first = v8.deserialize(Buffer.from(binary.data));
  await f.flush();
  const worker = f.completed()[0];
  const main = f.events.find(e => e.event === 'rpc-response' && e.requestId === worker.requestId);
  for (const key of ['clientId', 'requestId', 'callId', 'workerGeneration', 'attempt', 'method', 'tool', 'tab', 'session']) assert.equal(main[key], worker[key], key);
  assert.equal(worker.source, 'raw-rebuild');
  assert.equal(worker.sourceBytes, (await fs.stat(f.file)).size);
  assert.equal(worker.fedRecords, 120);
  assert.equal(worker.consumedRecords, 120);
  assert.equal(worker.lineCount, 120);
  assert.equal(worker.resultBytes, binary.data.byteLength);
  assert.ok(worker.serializationMs >= 0 && worker.postMessageMs >= 0);
  assert.ok(main.roundtripMs >= worker.sessionQueueMs + worker.executionMs);
  assert.ok(main.deliveryMs >= 0 && main.inboundMs >= 0);
  assert.ok(worker.receivedAbs <= worker.executionStartAbs && worker.executionEndAbs <= worker.replyReadyAbs);
  assert.equal(worker.executionMs, worker.executionEndPerf - worker.executionStartPerf);
  assert.match(worker.timing, /nested/);
  assert.ok(worker.phases.some(p => p.phase === 'readPrepared' && p.reason === 'no-file'));
  assert.ok(worker.phases.some(p => p.phase === 'continuation-codec-write' && p.bytes > 0 && p.serializeMs >= 0));
  assert.ok(f.events.some(e => e.event === 'worker-ready' && e.cacheSchema.startsWith('v1-') && e.schema === 1));
  const plain = await f.client.call('getHistory', f.payload);
  assert.deepEqual(plain, first);
  assert.deepEqual(Object.keys(binary.proof).sort(), ['error', 'filePath', 'sourcePaths']);
  for (const object of [plain, plain.revision, binary.proof]) {
    for (const field of ['diagnostic', 'requestId', 'workerGeneration', 'phases', 'timings']) assert.equal(object?.[field], undefined);
  }
  checkBounds(f);
});

test('real same-session queue wait and independent cold admission are reported separately', async t => {
  const f = await fixture(t, 900);
  const otherSession = 'diagnostic-other';
  await fs.writeFile(path.join(f.directory, 'rollout-' + otherSession + '.jsonl'), encode(Array.from({ length: 600 }, (_, i) => record(i))));
  await Promise.all([
    f.client.call('getHistory', f.payload),
    f.client.call('getTimeline', f.payload),
    f.client.call('getHistory', { ...f.payload, sessionId: otherSession }),
  ]);
  await f.flush();
  const queued = f.completed('getTimeline')[0];
  assert.ok(queued.sessionQueueDepth >= 1);
  assert.ok(queued.sessionQueueMs > 1);
  assert.equal(queued.coldAdmissionMs, 0, 'disk timeline never joins the cold lane');
  const cold = f.completed().find(e => e.coldQueueDepth > 0);
  assert.ok(cold, 'one independent session really waited for cold admission');
  assert.ok(cold.coldAdmissionMs > 0);
  assert.equal(cold.coldAdmissionMs, cold.coldAdmittedPerf - cold.coldQueuedPerf);
  assert.ok(cold.executionMs >= cold.coldAdmissionMs, 'admission is nested in execution, not extra CPU');
  assert.ok(f.completed().every(e => e.sessionQueueDepth === 0));
  checkBounds(f);
});

test('SSD page hit after RAM eviction names both disk hit and index memory miss, with zero source bytes', async t => {
  const f = await fixture(t, 200);
  const first = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  const result = await f.client.call('getHistory', { ...f.payload, hydrate: { centerUuid: first.entries[30].uuid, radius: 2, alwaysHydrateTail: 1 } });
  await f.flush();
  const disk = f.completed().at(-1);
  assert.equal(result.success, true);
  assert.equal(disk.source, 'ssd');
  assert.equal(disk.sourceBytes, 0);
  assert.equal(disk.rebuilds, 0);
  const hit = disk.phases.find(p => p.phase === 'readPrepared' && p.outcome === 'hit');
  assert.equal(hit.reason, 'disk-hit');
  assert.equal(hit.indexOutcome, 'miss');
  assert.equal(hit.indexReason, 'not-in-memory');
  assert.equal(hit.pageRows, 6);
  assert.ok(hit.bytes > 0 && hit.durationMs >= 0 && hit.endAbs >= hit.startAbs);
  assert.equal(disk.resultBytes, null, 'structured clone does not force another serialization');
  assert.equal(disk.serializationMs, null);
  checkBounds(f);
});

test('warm projection is distinguished from SSD and raw rebuild', async t => {
  const f = await fixture(t, 8, { diskBudgetBytes: 1 });
  await f.client.call('getHistory', f.payload);
  await f.client.call('getHistory', f.payload);
  await f.flush();
  assert.equal(f.completed().at(-1).source, 'ram');
  assert.equal(f.completed().at(-1).sourceBytes, 0);
});

test('delivery invalidation retries the same logical request with exact attempt IDs', async t => {
  const f = await fixture(t);
  const request = f.client.request.bind(f.client);
  let first = true;
  f.client.request = async (...args) => {
    const result = await request(...args);
    if (first) {
      first = false;
      await fs.writeFile(f.file, encode([record(0, 'replacement')]));
      f.client.invalidate({ filePath: f.file });
    }
    return result;
  };
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.entries[0].content, 'replacement0');
  await f.flush();
  const attempts = f.completed();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].callId, attempts[1].callId);
  assert.notEqual(attempts[0].requestId, attempts[1].requestId);
  assert.deepEqual(attempts.map(e => e.attempt), [1, 2]);
  assert.equal(attempts[0].workerGeneration, attempts[1].workerGeneration);
  const retry = f.events.find(e => e.event === 'request-retry');
  assert.equal(retry.requestId, attempts[0].requestId);
  assert.equal(retry.reason, 'source-epoch-invalidated');
  assert.ok(f.events.some(e => e.event === 'source-epoch-invalidation'));
  assert.ok(f.events.some(e => e.event === 'call-complete' && e.attempt === 2 && e.outcome === 'success'));
  checkBounds(f);
});

test('actual worker death logs pending attempt and successful replacement generation', async t => {
  const f = await fixture(t);
  const worker = f.client.start();
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (...args) => args[0].event === 'source-epoch' ? void worker.terminate() : post(...args);
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.success, true);
  await f.flush();
  const failed = f.events.find(e => e.event === 'request-failed');
  const replacement = f.completed()[0];
  assert.equal(failed.workerGeneration, 1);
  assert.equal(replacement.workerGeneration, 2);
  assert.equal(failed.callId, replacement.callId);
  assert.equal(replacement.attempt, 2);
  assert.ok(f.events.some(e => e.event === 'worker-death' && e.pending === 1));
  assert.ok(f.events.some(e => e.event === 'request-retry' && e.reason === 'worker-exit'));
  checkBounds(f);
});

test('failure and close cancellation remain observable below the slow threshold', async t => {
  const f = await fixture(t, 4, { diagnosticSlowMs: 1e9 });
  await assert.rejects(f.client.call('unknown-method', f.payload), /history_read_method/);
  await f.flush();
  assert.equal(f.completed('unknown-method')[0].outcome, 'error');
  const worker = f.client.start();
  const post = worker.postMessage.bind(worker);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  worker.postMessage = (...args) => { if (args[0].event === 'source-epoch') { release(); return; } post(...args); };
  const pending = f.client.call('getHistory', f.payload);
  const rejected = assert.rejects(pending, /history_reader_closed/);
  await held;
  await f.client.close();
  await rejected;
  const cancellation = f.events.find(e => e.event === 'request-cancelled');
  assert.equal(cancellation.method, 'getHistory');
  assert.equal(cancellation.reason, 'client-closed');
  assert.ok(!f.events.some(e => e.event === 'worker-death'), 'intentional close has its own outcome');
  checkBounds(f);
});

for (const mode of ['disabled', 'disk-evicted', 'version-mismatch']) test('cache reason remains visible: ' + mode, async t => {
  const f = await fixture(t, 2, { diagnosticSlowMs: 1e9, ...(mode === 'disk-evicted' ? { diskBudgetBytes: 1 } : {}) });
  if (mode === 'disabled') await fs.writeFile(f.config.cacheDirectory, 'not a directory');
  await f.client.call('getHistory', f.payload);
  if (mode === 'version-mismatch') {
    await f.client.close();
    const version = (await fs.readdir(f.config.cacheDirectory)).find(name => name.startsWith('v1-'));
    await fs.rename(path.join(f.config.cacheDirectory, version), path.join(f.config.cacheDirectory, 'v1-0123456789abcdef'));
    await f.restart();
  } else await f.client.call('releaseMemory');
  const result = await f.client.call('getHistory', f.payload);
  await f.flush();
  assert.equal(result.success, true);
  assert.equal(f.completed().at(-1).source, 'raw-rebuild');
  const phases = f.completed().at(-1).phases;
  assert.ok(phases.some(p => p.reason === (mode === 'disk-evicted' ? 'disk-quota' : mode)), JSON.stringify(phases));
  checkBounds(f);
});

test('many rows and long private identity produce bounded summaries, not row diagnostics', async t => {
  const f = await fixture(t, 1600, { diagnosticSlowMs: 1e9 });
  await f.client.call('getHistory', { ...f.payload, tabId: '/private/user/' + 'PRIVATE_IDENTITY '.repeat(100) });
  await f.flush();
  const events = f.completed();
  assert.equal(events.length, 1);
  assert.match(events[0].tab, /^sha256:[a-f0-9]{24}$/);
  assert.ok(events[0].phases.length < 16);
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE_IDENTITY'));
  checkBounds(f);
});

test('UI action/read correlation is validated and stripped before all authority-bearing results', async t => {
  const f = await fixture(t);
  const baseline = await f.client.call('getHistory', f.payload);
  const tagged = await f.client.call('getHistory', { ...f.payload,
    diagnosticActionId: 'ui-boot123-42', diagnosticReadId: 'hr-boot123-99' }, true);
  assert.deepEqual(v8.deserialize(Buffer.from(tagged.data)), baseline);
  await f.client.call('searchHistory', { ...f.payload, query: 'PRIVATE_TRANSCRIPT_TEXT', diagnosticActionId: 'ui-boot123-43' });
  await f.client.call('getTimeline', { ...f.payload, diagnosticActionId: '/private/action', diagnosticReadId: 'x'.repeat(91) });
  await f.flush();
  for (const side of ['main', 'worker']) {
    const taggedEvent = f.events.find(e => e.side === side && e.diagnosticReadId === 'hr-boot123-99');
    assert.equal(taggedEvent.diagnosticActionId, 'ui-boot123-42');
  }
  assert.equal(f.completed('searchHistory')[0].diagnosticActionId, 'ui-boot123-43');
  assert.equal(f.completed('getTimeline')[0].diagnosticActionId, undefined);
  assert.equal(f.completed('getTimeline')[0].diagnosticReadId, undefined);
  assert.ok(!JSON.stringify([baseline, tagged.proof]).includes('diagnosticActionId'));
  checkBounds(f);
});

for (const mode of ['source-change', 'corrupt']) test('actual cache rejection retains its reason and rebuilds canonical output: ' + mode, async t => {
  const f = await fixture(t, 10, { diagnosticSlowMs: 1e9 });
  const original = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  if (mode === 'source-change') await fs.writeFile(f.file, encode([record(0, 'replacement')]));
  else {
    const version = (await fs.readdir(f.config.cacheDirectory)).find(name => name.startsWith('v1-'));
    const cachePath = path.join(f.config.cacheDirectory, version);
    const file = (await fs.readdir(cachePath)).find(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
    const db = new (require('better-sqlite3'))(path.join(cachePath, file));
    try { db.prepare('UPDATE rows SET stub=? WHERE pos=0').run('{"uuid":"corrupt"}'); } finally { db.close(); }
  }
  const result = await f.client.call('getHistory', f.payload);
  await f.flush();
  if (mode === 'corrupt') assert.deepEqual(result, original);
  else assert.equal(result.entries[0].content, 'replacement0');
  const diagnostic = f.completed().at(-1);
  assert.equal(diagnostic.source, mode === 'corrupt' ? 'ssd' : 'raw-rebuild');
  assert.ok(diagnostic.phases.some(p => mode === 'corrupt' ? p.reason === 'index-corrupt' : p.reason.startsWith('source-')));
  assert.ok(diagnostic.cacheReasons[mode === 'corrupt' ? 'error' : 'sourceChange'] > 0);
  checkBounds(f);
});

test('fast clean successes are quiet; source missing still logs a result failure', async t => {
  const f = await fixture(t, 8, { diagnosticSlowMs: 1e9 });
  await f.client.call('getHistory', f.payload);
  await f.client.call('getHistory', f.payload);
  await f.flush();
  assert.equal(f.completed().length, 1, 'only the rebuild emitted a summary');
  const missing = await f.client.call('getHistory', { ...f.payload, sessionId: 'missing-session' });
  await f.flush();
  assert.equal(missing.success, false);
  assert.equal(f.completed().at(-1).outcome, 'result-error');
  assert.equal(f.completed().at(-1).reason, 'source-missing');
});

test('full-record reads expose available record count without inventing per-request I/O bytes', async t => {
  const f = await fixture(t, 12);
  const result = await f.client.call('getHistory', { ...f.payload, dehydrate: false });
  await f.flush();
  assert.equal(result.entries.length, 12);
  const diagnostic = f.completed()[0];
  assert.equal(diagnostic.loadedRecords, 12);
  assert.equal(diagnostic.sourceSize, (await fs.stat(f.file)).size);
  assert.equal(diagnostic.sourceBytes, null);
  assert.equal(diagnostic.source, 'records-cache-or-raw');
  checkBounds(f);
});

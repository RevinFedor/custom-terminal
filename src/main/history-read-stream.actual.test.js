'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { HistoryReadClient } = require('./history-read-client');
const createNodeProcess = require('./test-helpers/history-node-process.cjs');
const { isHistoryReadCancelled } = require('./history-read-control');
const exec = promisify(execFile);
const options = { frameBytes: 1024, credits: 2, projection: 'history-entries' };
function record(index, leafBytes) {
  const prefix = 'FULL-' + index + '-';
  return { type: 'response_item', timestamp: new Date(1700000000000 + index).toISOString(),
    payload: { type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: prefix + 'x'.repeat(leafBytes - prefix.length) }] } };
}
async function fixture(t, count, leafBytes) {
  t.mock.method(console, 'log', () => {});
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-byte-actual-'));
  const sessionId = 'private-stream', file = path.join(directory, 'rollout-' + sessionId + '.jsonl');
  const handle = await fs.open(file, 'w');
  try { for (let i = 0; i < count; i++) await handle.write(JSON.stringify(record(i, leafBytes)) + '\n'); }
  finally { await handle.close(); }
  const events = [];
  const client = new HistoryReadClient({ sessionsDir: directory, cacheDirectory: path.join(directory, 'cache'),
    memoryBudgetMb: 64, diagnosticReadPhases: true, diagnosticSlowMs: 0,
    createTransport: data => {
      const child = createNodeProcess(data);
      // Node test host liveness substitution only: keep the owned IPC child
      // referenced until explicit cleanup. Production E28 ref/unref untouched.
      child.unref = () => {}; return child;
    }, onDiagnostic: event => events.push(event) });
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, sessionId, file, client, events,
    payload: { toolType: 'codex', cwd: directory, sessionId, tabId: 'private-stream-tab', dehydrate: false } };
}
async function consumeToOracle(f, stream, count, leafBytes) {
  const output = path.join(f.directory, 'own-wire.json');
  const handle = await fs.open(output, 'w');
  try { for await (const bytes of stream) await handle.write(bytes); }
  finally { await handle.close(); }
  // The sandbox child stdout pipe returns no bytes, even for an explicit
  // stdout.write probe. Demand a small receipt in this private fixture dir.
  const receipt = path.join(f.directory, 'own-wire-receipt.json');
  await exec(process.execPath, ['-e', 'require(process.argv[1])', path.join(__dirname, 'test-helpers/history-stream-wire-oracle.cjs'),
    output, String(count), String(leafBytes), f.sessionId, receipt], { maxBuffer: 16 * 1024 });
  const observed = JSON.parse(await fs.readFile(receipt, 'utf8')), ids = createHash('sha256');
  for (let i = 0; i < count; i++) ids.update(`codex-assistant-${f.sessionId}-${i}\n`);
  assert.equal(observed.orderedIdsSHA256, ids.digest('hex'));
  assert.equal(observed.firstUuid, stream.metadata.firstUuid); assert.equal(observed.lastUuid, stream.metadata.lastUuid);
  assert.equal(stream.metadata.entryCount, count); assert.equal(observed.contentBytes, count * leafBytes);
  assert.ok(stream.stats.maxOutstandingBytes <= 2048);
  assert.ok(stream.stats.maxQueuedFrames <= 2);
  return observed;
}

for (const [count, leafBytes] of [[1, 1024], [10, 1024], [100, 1024], [1, 16 * 1024], [1, 256 * 1024]]) {
  test(`actual worker/process stream preserves ${count} ordered IDs and full ${leafBytes}B leaf content`, { timeout: 15000 }, async t => {
    const f = await fixture(t, count, leafBytes);
    const stream = await f.client.openStream('getHistory', f.payload, options);
    assert.notEqual(f.client.worker.pid, process.pid);
    assert.equal(stream.metadata.sourceGraph, 'legacy-owned-array', 'does not disguise remaining preparation growth');
    const observed = await consumeToOracle(f, stream, count, leafBytes);
    t.diagnostic(JSON.stringify({ observed, credit: stream.stats, sourceGraph: stream.metadata.sourceGraph,
      boundary: 'Node24 child_process advanced copy; test-only node:sqlite adapter; not E28/native high-water' }));
    assert.equal(f.client.pending.size, 0); assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0);
  });
}

test('actual full worker stream abort before first byte retires its cold borrower; next explicit read completes', { timeout: 15000 }, async t => {
  const f = await fixture(t, 10, 1024), controller = new AbortController();
  const stream = await f.client.openStream('getHistory', f.payload, { ...options, signal: controller.signal });
  assert.equal(stream.stats.receivedBytes, 0);
  controller.abort(); await assert.rejects(stream.next(), isHistoryReadCancelled);
  const next = await f.client.openStream('getHistory', f.payload, options);
  await consumeToOracle(f, next, 10, 1024);
  assert.equal(f.client.workerGeneration, 1); assert.equal(f.client.pending.size, 0);
});

test('actual source append after first chunk invalidates this whole read; explicit fresh read keeps the appended row', { timeout: 15000 }, async t => {
  const f = await fixture(t, 10, 1024), stream = await f.client.openStream('getHistory', f.payload, options);
  await stream.next();
  await fs.appendFile(f.file, JSON.stringify(record(10, 1024)) + '\n');
  f.client.invalidate({ filePath: f.file, sourceAppend: true });
  await assert.rejects(stream.next(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  const next = await f.client.openStream('getHistory', f.payload, options);
  await consumeToOracle(f, next, 11, 1024);
  assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0);
});

test('actual controlled reader exit during stream leaves parent alive; only explicit next read creates boot2', { timeout: 15000 }, async t => {
  const f = await fixture(t, 10, 1024), parentPid = process.pid;
  const stream = await f.client.openStream('getHistory', f.payload, options); await stream.next();
  const child = f.client.worker; await child.terminate();
  await assert.rejects(stream.next(), error => ['HISTORY_READER_PROCESS_EXITED', 'HISTORY_READER_TRANSPORT_UNKNOWN'].includes(error.code));
  assert.equal(process.pid, parentPid); assert.equal(f.client.workerGeneration, 1); assert.equal(f.client.pending.size, 0);
  const next = await f.client.openStream('getHistory', f.payload, options);
  await consumeToOracle(f, next, 10, 1024);
  assert.equal(f.client.workerGeneration, 2); assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 0);
});

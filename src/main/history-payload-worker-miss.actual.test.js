'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SQLite = require('better-sqlite3');
const { HistoryReadClient } = require('./history-read-client');
const createNodeProcess = require('./test-helpers/history-node-process.cjs');
const LEAF_CHARS = 256 * 1024, PAGE_CHARS = 16 * 1024;
// Keep this sandbox host alive until node:test has emitted every terminal
// case. An unfinished async case must time out, never produce partial TAP.
const hostLiveness = setInterval(() => {}, 1000);
test.after(() => clearInterval(hostLiveness));

async function fixture(t) {
  t.mock.method(console, 'log', () => {});
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-worker-payload-miss-'));
  const sessionId = 'own-payload-miss', filePath = path.join(directory, 'rollout-' + sessionId + '.jsonl');
  const cacheDirectory = path.join(directory, 'cache'), events = [];
  const header = [{ type: 'session_meta', payload: { id: sessionId, cwd: directory } },
    { type: 'response_item', timestamp: '2026-10-22T00:00:00Z', payload: {
      type: 'function_call', call_id: 'own-call', name: 'exec_command', arguments: '{"cmd":"own-fixture-only"}' } }];
  async function writeSource(changed = false) {
    const handle = await fs.open(filePath, 'w');
    const hash = createHash('sha256');
    try {
      for (const row of header) await handle.write(JSON.stringify(row) + '\n');
      await handle.write('{"type":"response_item","timestamp":"2026-10-22T00:00:01Z","payload":{"type":"function_call_output","call_id":"own-call","output":"');
      for (let i = 0; i < LEAF_CHARS / 1024; i++) {
        const chunk = String.fromCharCode((changed ? 97 : 65) + Math.floor(i / 16)).repeat(1024);
        await handle.write(chunk); hash.update(chunk);
      }
      await handle.write('"}}\n');
    } finally { await handle.close(); }
    return hash.digest('hex');
  }
  const contentHash = await writeSource();
  const config = { sessionsDir: directory, cacheDirectory, memoryBudgetMb: 64,
    diagnosticReadPhases: true, diagnosticSlowMs: 0, onDiagnostic: event => events.push(event),
    createTransport: data => { const child = createNodeProcess(data); child.unref = () => {}; return child; } };
  let client = new HistoryReadClient(config);
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const owner = { toolType: 'codex', sessionId, cwd: directory, tabId: 'own-payload-tab' };
  const prepared = await client.call('getHistory', { ...owner, dehydrate: true,
    payloadPolicy: 'on-demand-v1', bounds: { last: 80 } });
  assert.equal(prepared.success, true, prepared.error);
  const entry = prepared.entries.find(row => row.actions?.some(action => action.rawTool?.resultRef));
  if (!entry) t.diagnostic(JSON.stringify({ ownFixtureHeaders: prepared.entries.map(row => ({ uuid: row.uuid,
    actionRefs: row.actions?.map(action => ({ tool: action.tool, toolUseId: action.rawTool?.toolUseId,
      resultRef: action.rawTool?.resultRef, actionRef: action.actionRef })) })) }));
  assert.ok(entry, 'actual canonical projection creates exact row/ref membership');
  const ref = entry.actions.find(action => action.rawTool?.resultRef).rawTool.resultRef;
  assert.equal(ref.payloadId, 'result:own-call:canonical:0', 'retain actual canonical identity, do not invent a raw call-ID ref');
  assert.equal(ref.contentHash, contentHash); assert.equal(ref.totalChars, LEAF_CHARS);
  await client.close();
  let bindings = 0, removed = 0;
  for (const version of await fs.readdir(cacheDirectory)) {
    const versionPath = path.join(cacheDirectory, version);
    if (!(await fs.stat(versionPath)).isDirectory()) continue;
    for (const name of await fs.readdir(versionPath)) {
      if (!name.endsWith('.sqlite')) continue;
      const db = new SQLite(path.join(versionPath, name));
      try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        if (tables.has('payload_bindings')) bindings += db.prepare('SELECT count(*) AS count FROM payload_bindings WHERE payload_id=?')
          .get(ref.payloadId).count;
        for (const table of ['payloads', 'payload_index', 'payload_chunks']) if (tables.has(table)) {
          removed += db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(ref.payloadId).changes;
        }
      } finally { db.close(); }
    }
  }
  assert.ok(bindings > 0); assert.ok(removed > 0, 'actual staged payload bodies removed while binding survives');
  client = new HistoryReadClient(config); events.length = 0;
  const request = { ...owner, payloadPolicy: 'on-demand-v1', payloadId: ref.payloadId,
    payloadGeneration: prepared.payloadGeneration, entryUuid: entry.uuid, contentHash,
    expectedContentHash: contentHash, offset: 0, limit: PAGE_CHARS };
  return { directory, filePath, contentHash, request, events, writeSource, get client() { return client; } };
}

test('actual worker lost payload body uses exact admitted source leaf; every delivered page includes physical source proof', { timeout: 15000 }, async t => {
  const f = await fixture(t), original = f.client.request.bind(f.client), hash = createHash('sha256');
  let responses = 0, chars = 0;
  f.client.request = async (method, ...args) => {
    const envelope = await original(method, ...args);
    if (method === 'getToolPayload') {
      responses++;
      assert.ok(envelope.readProof.some(source => source.filePath === f.filePath), 'prepare-before-scan registered the actual payload source');
    }
    return envelope;
  };
  for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
    const result = await f.client.call('getToolPayload', { ...f.request, offset: pageIndex * PAGE_CHARS });
    assert.equal(result.success, true, result.error);
    if (pageIndex === 0) assert.equal(result.source, 'source-leaf', 'forced miss reached new resolver');
    else assert.equal(result.source, 'disk', 'complete bounded refill serves later pages without rescanning the leaf');
    assert.equal(result.payload, String.fromCharCode(65 + pageIndex).repeat(PAGE_CHARS));
    assert.equal(result.payloadGeneration, f.request.payloadGeneration); assert.equal(result.entryUuid, f.request.entryUuid);
    assert.equal(result.contentHash, f.contentHash); assert.equal(result.totalChars, LEAF_CHARS);
    assert.equal(result.nextOffset, pageIndex === 15 ? null : (pageIndex + 1) * PAGE_CHARS);
    hash.update(result.payload); chars += result.payload.length;
  }
  assert.equal(responses, 16); assert.equal(chars, LEAF_CHARS); assert.equal(hash.digest('hex'), f.contentHash);
  const stats = await f.client.call('stats');
  assert.equal(stats.projector.sessions, 0, 'new miss path did not rebuild full canonical History');
  assert.ok(!f.events.some(event => event.side === 'worker' && event.event === 'work-phase-begin' && event.stage === 'history-projection'));
  t.diagnostic('Actual client→Node child→worker→service→source locator; SQLite bodies deliberately evicted, admitted binding retained; Node24 test SQLite adapter, not native E28.');
});

test('actual source-leaf payload reply is revoked if source rewrites before Main delivery; explicit read retries current generation', { timeout: 15000 }, async t => {
  const f = await fixture(t), original = f.client.request.bind(f.client); let responses = 0;
  f.client.request = async (method, ...args) => {
    const envelope = await original(method, ...args);
    if (method === 'getToolPayload') {
      responses++;
      assert.ok(envelope.readProof.some(source => source.filePath === f.filePath));
      if (responses === 1) {
        assert.equal(envelope.value.source, 'source-leaf');
        await f.writeSource(true); f.client.invalidate({ filePath: f.filePath });
      }
    }
    return envelope;
  };
  const result = await f.client.call('getToolPayload', f.request);
  assert.equal(responses, 2); assert.equal(result.success, false);
  assert.equal(result.error, 'history_payload_generation_changed');
  assert.equal(f.client.workerGeneration, 1); assert.equal(f.client.getReadDiagnosticHealth().counters.retries, 1);
});

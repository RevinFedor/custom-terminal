'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SessionTranscriptService } = require('./session-transcript-service');
const { _api: actual } = require('./ipc/codex-data');

const encode = records => records.map(record => JSON.stringify(record) + '\n').join('');
function recordsFor(id, parent, cwd) {
  return [
    { type: 'session_meta', payload: { id, cwd, forked_from_id: parent, history_mode: 'paginated',
      history_base: { thread_id: parent, end_byte_offset: 1, end_ordinal_exclusive: 1 } } },
    { type: 'compacted', timestamp: '2026-10-11T07:00:00Z', payload: { message: 'private compact fixture' } },
    { type: 'event_msg', timestamp: '2026-10-11T07:00:01Z', payload: { type: 'user_message', message: 'private user' } },
    { type: 'response_item', timestamp: '2026-10-11T07:00:02Z', payload: { type: 'message', role: 'assistant',
      phase: 'final_answer', content: [{ type: 'output_text', text: 'private answer' }] } },
  ];
}
function eventFor(id, parent, records) {
  const entries = actual.buildCodexTimeline(records.map((record, __line) => ({ ...record, __line })), id);
  assert.ok(entries.length > 0);
  return { eventType: 'fork', provider: 'codex', eventKey: `fork:codex:${parent}:${id}`,
    sessionId: id, childSessionId: id, sourceSessionId: parent, forkMode: 'latest_compact', origin: 'app',
    isDirect: true, snapshotComplete: true, entryUuids: entries.map(row => row.uuid),
    boundaryEntryUuid: entries.at(-1).uuid };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-compact-proof-unit-'));
  const id = randomUUID(), parent = randomUUID(), file = path.join(root, `rollout-${id}.jsonl`);
  const records = recordsFor(id, parent, root);
  await fs.writeFile(file, encode(records));
  const f = { root, id, parent, file, records, event: eventFor(id, parent, records), loads: 0 };
  f.api = { ...actual,
    findCodexSessionFile: async sid => sid === id ? { filePath: file } : null,
    loadSessionRecords: async (sid, cwd) => {
      f.loads++;
      return actual.loadSessionRecords(sid, cwd, { sessionsDir: root });
    },
  };
  f.makeService = () => new SessionTranscriptService({ codexData: { _api: f.api },
    sessionHistoryStore: { getSessionHistoryEvents: sid => sid === id ? [f.event] : [],
      saveSessionForkEvent: () => assert.fail('proof reuse must not persist lineage') } });
  f.service = f.makeService();
  f.check = (cwd = root) => f.service.ensureCodexProviderForkLineage({ childSessionId: id, cwd });
  t.after(async () => { actual.invalidateJsonlCache(file); await fs.rm(root, { recursive: true, force: true }); });
  return f;
}

test('positive compact proof reuses exact source, but not another service or external source epoch', async t => {
  const f = await fixture(t);
  let epoch = 0;
  actual.setCodexExternalReadVersion(() => epoch);
  t.after(() => actual.setCodexExternalReadVersion(null));
  const first = await f.check();
  assert.equal(first.reason, 'proven-app-materialized-compact-fork');
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 1, 'unchanged proof does not rebuild the raw Timeline');
  epoch++;
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 2, 'external epoch alone invalidates the certificate');
  actual.invalidateJsonlCache(f.file);
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 3, 'explicit source generation invalidation also rechecks');
  f.service = f.makeService();
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 4, 'a new service does not inherit proof authority');
});

for (const change of ['append', 'truncate', 'replace', 'same-size-rewrite', 'metadata']) {
  test(`compact proof revalidates ${change} even when mtime is restored`, async t => {
    const f = await fixture(t);
    // A removable padding row lets truncation leave a valid compact prefix.
    const padding = { type: 'fixture_padding', payload: 'padding-A' };
    await fs.appendFile(f.file, encode([padding]));
    const first = await f.check();
    assert.equal(first.success, true);
    const before = await fs.stat(f.file);
    if (change === 'append') await fs.appendFile(f.file, encode([padding]));
    if (change === 'truncate') await fs.truncate(f.file, before.size - Buffer.byteLength(encode([padding])));
    if (change === 'replace') {
      await fs.copyFile(f.file, f.file + '.new');
      await fs.rename(f.file + '.new', f.file);
    }
    if (change === 'same-size-rewrite') {
      const bytes = await fs.readFile(f.file, 'utf8');
      await fs.writeFile(f.file, bytes.replace('padding-A', 'padding-B'));
    }
    if (change === 'metadata') {
      f.records[0].payload.forked_from_id = randomUUID();
      await fs.writeFile(f.file, encode([...f.records, padding]));
    }
    await fs.utimes(f.file, before.atime, before.mtime);
    const changed = await f.check();
    assert.equal(f.loads, 2, 'source changes require the canonical proof, not just a header flag');
    if (change === 'metadata') {
      assert.notEqual(changed.reason, first.reason, 'changed physical fork metadata cannot use the old proof');
    } else assert.deepEqual(changed, first);
  });
}

test('fork event contents, including in-place prefix changes, are exact proof inputs; failures are not cached', async t => {
  const f = await fixture(t);
  assert.equal((await f.check()).success, true);
  const uuid = f.event.entryUuids[0];
  f.event.entryUuids[0] = 'foreign-prefix';
  assert.notEqual((await f.check()).reason, 'proven-app-materialized-compact-fork');
  assert.notEqual((await f.check()).reason, 'proven-app-materialized-compact-fork');
  assert.equal(f.loads, 3, 'failed proof cannot become a negative cache entry');
  f.event.entryUuids[0] = uuid;
  assert.equal((await f.check()).success, true);
  assert.equal(f.loads, 4, 'a failed recheck revokes the earlier positive entry');
  f.event = { ...f.event, occurredAt: 123 };
  assert.equal((await f.check()).success, true);
  assert.equal(f.loads, 5, 'even same-prefix replacement event gets its own verification');
});

test('unknown/read-error source guard never grants or retains a positive compact certificate', async t => {
  const f = await fixture(t);
  const first = await f.check();
  const begin = f.api.beginCodexSourceRead;
  f.api.beginCodexSourceRead = async () => { throw Object.assign(new Error('private stat failure'), { code: 'EACCES' }); };
  assert.deepEqual(await f.check(), first, 'guard failure falls back to the existing full proof');
  assert.equal(f.loads, 2);
  f.api.beginCodexSourceRead = begin;
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 3, 'unknown must remove an older certificate and cannot publish a new one');
  f.api.beginCodexSourceRead = undefined;
  assert.deepEqual(await f.check(), first);
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 5, 'minimal providers without the existing source fence retain full validation');
});

test('metadata-read failure falls back to canonical records and cannot retain the earlier proof', async t => {
  const f = await fixture(t);
  const first = await f.check();
  const metadata = f.api.readCodexSessionMetadata;
  f.api.readCodexSessionMetadata = async () => { throw Object.assign(new Error('private header failure'), { code: 'EIO' }); };
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 2);
  f.api.readCodexSessionMetadata = metadata;
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 3);
});

test('a source change during cached-proof validation retries the full current path', async t => {
  const f = await fixture(t);
  const first = await f.check();
  const validate = f.api.assertCodexSourceRead;
  f.api.assertCodexSourceRead = async read => {
    f.api.assertCodexSourceRead = validate;
    await fs.appendFile(f.file, encode([{ type: 'fixture_padding', payload: 'raced append' }]));
    return validate(read);
  };
  await assert.rejects(f.check(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(f.loads, 1, 'an invalidated ticket must enter the existing retry contract');
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 2, 'retry validates the new source before granting a certificate');
});

test('fork-event change during cache validation is not accepted as the old certificate', async t => {
  const f = await fixture(t);
  await f.check();
  const validate = f.api.assertCodexSourceRead;
  f.api.assertCodexSourceRead = async read => {
    f.api.assertCodexSourceRead = validate;
    f.event.entryUuids[0] = 'changed-during-await';
    return validate(read);
  };
  await assert.rejects(f.check(), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.notEqual((await f.check()).reason, 'proven-app-materialized-compact-fork');
  assert.equal(f.loads, 2, 'the current fork input must be checked after the source await');
});

for (const change of ['last-assert-fails', 'snapshot-not-current', 'replace-event-on-hit', 'mutate-event-on-full-read', 'replace-event-on-full-read', 'mutate-source-on-full-read']) {
  test(`returned compact proof rejects ${change} and retries current inputs`, async t => {
    const f = await fixture(t);
    if (change === 'replace-event-on-hit') await f.check();
    const validate = f.api.assertCodexSourceRead;
    const current = f.api.isCodexSourceSnapshotCurrent;
    const load = f.api.loadSessionRecords;
    if (change === 'last-assert-fails') f.api.assertCodexSourceRead = async read => {
      await validate(read);
      throw Object.assign(new Error('invalidated at publication'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    };
    if (change === 'snapshot-not-current') f.api.isCodexSourceSnapshotCurrent = () => false;
    if (change === 'replace-event-on-hit') f.api.assertCodexSourceRead = async read => {
      await validate(read);
      f.event = { ...f.event, entryUuids: ['replacement-event-prefix'] };
    };
    if (change.endsWith('on-full-read')) f.api.loadSessionRecords = async (...args) => {
      const result = await load(...args);
      if (change === 'mutate-source-on-full-read') await fs.appendFile(f.file, encode([{ type: 'fixture_padding', payload: 'raced full read' }]));
      else if (change.startsWith('replace')) f.event = { ...f.event, entryUuids: ['replacement-event-prefix'] };
      else f.event.entryUuids[0] = 'mutated-event-prefix';
      return result;
    };
    await assert.rejects(f.service.prepareCodexProviderForkLineage({ childSessionId: f.id, cwd: f.root }),
      { code: 'CODEX_SOURCE_READ_INVALIDATED' }, 'must reject the returned result, not merely decline caching');
    assert.equal(f.service.codexMaterializedCompactProofs.size, 0);
    f.api.assertCodexSourceRead = validate;
    f.api.isCodexSourceSnapshotCurrent = current;
    f.api.loadSessionRecords = load;
    const retried = await f.check();
    if (change.includes('event')) assert.notEqual(retried.reason, 'proven-app-materialized-compact-fork');
    else assert.equal(retried.reason, 'proven-app-materialized-compact-fork');
  });
}

test('public getTimeline uses HistoryReadClient retry and the replacement event', async t => {
  const f = await fixture(t);
  await f.check();
  const { HistoryReadClient } = require('./history-read-client');
  const client = new HistoryReadClient({});
  const validate = f.api.assertCodexSourceRead;
  f.api.assertCodexSourceRead = async read => {
    f.api.assertCodexSourceRead = validate;
    await validate(read);
    f.event = { ...f.event, entryUuids: ['replacement-event-prefix'] };
  };
  let attempts = 0;
  // Only the worker transport is substituted; service/public method and retry loop are real.
  client.request = async (method, payload) => {
    attempts++;
    return { value: await f.service[method](payload), readProof: [] };
  };
  const result = await client.call('getTimeline', { toolType: 'codex', sessionId: f.id, cwd: f.root });
  assert.equal(attempts, 2);
  assert.equal(result.success, false, 'replacement with an invalid prefix must not publish old physical success');
  assert.equal(result.error, 'lineage_unresolved');
});

test('canonical read errors propagate and do not resurrect a previous positive certificate', async t => {
  const f = await fixture(t);
  const first = await f.check();
  f.event = { ...f.event, occurredAt: 456 };
  const load = f.api.loadSessionRecords;
  f.api.loadSessionRecords = async () => { throw Object.assign(new Error('private raw failure'), { code: 'EIO' }); };
  await assert.rejects(f.check(), { code: 'EIO' });
  f.api.loadSessionRecords = load;
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, 2, 'a failed raw attempt cannot cache a successful outcome');
});

test('positive compact certificates have a small LRU bound and retain no raw history', async t => {
  const f = await fixture(t);
  const first = await f.check();
  for (let i = 0; i < 64; i++) assert.deepEqual(await f.check(path.join(f.root, 'scope-' + i)), first);
  const loads = f.loads;
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, loads + 1, 'the first scope must be evicted after 64 newer scopes');
  assert.deepEqual(await f.check(), first);
  assert.equal(f.loads, loads + 1, 'the fresh bounded entry is reusable');
});

test('actual worker: SSD Timeline after six-file raw LRU eviction avoids a second 77,849,898-byte parse', async t => {
  // Run this file with ELECTRON_RUN_AS_NODE=1 for the repository's SQLite ABI.
  // No Electron application, provider, native window or production data is used.
  const SQLite = require('better-sqlite3');
  const DatabaseManager = require('./database');
  const { HistoryReadClient } = require('./history-read-client');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-compact-proof-worker-'));
  const id = randomUUID(), parent = randomUUID(), file = path.join(root, `rollout-${id}.jsonl`);
  const records = recordsFor(id, parent, root);
  const handle = await fs.open(file, 'w');
  const size = 77_849_898;
  try {
    const prefix = encode(records);
    await handle.write(prefix);
    let remaining = size - Buffer.byteLength(prefix);
    const row = encode([{ type: 'fixture_padding', payload: 'x'.repeat(32 * 1024) }]);
    while (remaining > Buffer.byteLength(row) + 100) { await handle.write(row); remaining -= Buffer.byteLength(row); }
    const emptyRow = encode([{ type: 'fixture_padding', payload: '' }]);
    await handle.write(encode([{ type: 'fixture_padding', payload: 'x'.repeat(remaining - Buffer.byteLength(emptyRow)) }]));
  } finally { await handle.close(); }
  assert.equal((await fs.stat(file)).size, size);
  const db = new DatabaseManager({ existingConnection: new SQLite(path.join(root, 'application.db')) });
  db.db.pragma('journal_mode = WAL');
  db.initTables();
  db.saveSessionForkEvent(eventFor(id, parent, records));
  const diagnostics = [], logs = [];
  const config = { cacheDirectory: path.join(root, 'cache'), sessionsDir: root, databasePath: db.db.name,
    memoryBudgetMb: 64, diagnosticSlowMs: 0, onDiagnostic: event => diagnostics.push(event) };
  let client = new HistoryReadClient(config);
  const listen = () => client.start().on('message', message => { if (message.event === 'log') logs.push(message.text); });
  listen();
  t.after(async () => { await client.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const payload = { toolType: 'codex', sessionId: id, cwd: root, tabId: 'private-compact-tab', dehydrate: true };
  const history = await client.call('getHistory', payload);
  assert.equal(history.success, true, history.error);
  const first = await client.call('getTimeline', payload);
  assert.equal(first.success, true, first.error);
  for (let i = 0; i < 6; i++) {
    const other = randomUUID();
    await fs.writeFile(path.join(root, `rollout-${other}.jsonl`), encode([{ type: 'session_meta', payload: { id: other, cwd: root } }]));
    assert.equal((await client.call('getMessages', { ...payload, sessionId: other })).success, true);
  }
  await client.call('stats'); // Flush worker diagnostics already sent before this reply.
  assert.ok(logs.some(line => line.includes('[CodexJsonlCache] evict') && line.includes(id)), 'the real raw LRU must evict our 77MB source');
  const fullReads = () => logs.filter(line => line.includes('[CodexJsonlCache] full') && line.includes(id)).length;
  const before = fullReads();
  const next = await client.call('getTimeline', payload);
  const rereadHistory = await client.call('getHistory', payload);
  await client.call('stats');
  assert.deepEqual(next, first, 'Timeline DTO/revision/entries stay identical');
  assert.deepEqual(rereadHistory.entries, history.entries);
  assert.ok(diagnostics.some(event => event.event === 'request-complete' && event.method === 'getTimeline'
    && event.session === id && event.phases?.some(phase => phase.phase === 'readTimeline' && phase.reason === 'disk-hit')),
  'this is an actual SQLite Timeline hit, not a substituted projection');
  t.diagnostic(`private sourceBytes=${size}; raw full reads before=${before}; after=${fullReads()}; SSD Timeline verified`);
  assert.equal(fullReads(), before, 'positive proof survives real raw LRU eviction without another full 77MB read');
  await client.close();
  client = new HistoryReadClient(config); listen();
  const restartBefore = fullReads();
  assert.equal((await client.call('getTimeline', payload)).success, true);
  await client.call('stats');
  assert.equal(fullReads(), restartBefore + 1, 'worker restart clears the in-memory proof; canonical validation remains');
});

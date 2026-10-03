'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryReadClient, splitHistoryReadBudget } = require('./history-read-client');
const codexData = require('./ipc/codex-data');
const { applyHistoryRowWindow } = require('./history-entry-window');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');

const message = (text, n = 0) => ({ type: 'response_item', timestamp: new Date(Date.UTC(2026, 8, 25) + n * 1000).toISOString(),
  payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });
const encode = records => records.map(record => JSON.stringify(record) + '\n').join('');
test('moving reads into a worker does not duplicate the configured graph cache budget', () => {
  for (const mb of [64, 400, 2048]) {
    const parts = splitHistoryReadBudget(mb * 1024 * 1024);
    assert.equal(parts.mainGraphBytes + parts.indexBytes + parts.workerGraphBytes, mb * 1024 * 1024);
    assert.ok(parts.mainGraphBytes >= 1024 * 1024 && parts.workerGraphBytes >= 1024 * 1024);
  }
});
async function fixture(t, records, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-worker-'));
  const sessionId = options.sessionId || 'worker-fixture';
  const filePath = path.join(directory, 'rollout-' + sessionId + '.jsonl');
  await fs.writeFile(filePath, encode(records));
  let db = null;
  if (options.database) {
    db = new DatabaseManager({ existingConnection: new SQLite(path.join(directory, 'application.db')) });
    db.db.pragma('journal_mode = WAL');
    db.initTables();
  }
  const config = { cacheDirectory: path.join(directory, 'cache'), sessionsDir: directory, memoryBudgetMb: 64, ...options };
  if (db) config.databasePath = db.db.name;
  let client = new HistoryReadClient(config);
  const f = { directory, filePath, sessionId, config, db, get client() { return client; },
    payload: { toolType: 'codex', sessionId, cwd: directory, tabId: 'fixture-tab', dehydrate: true },
    async restart() { await client.close(); client = new HistoryReadClient(config); },
  };
  t.after(async () => { await client.close(); db?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return f;
}

test('SSD seek after RAM release reads only requested row bodies, equal to canonical window', async t => {
  const records = Array.from({ length: 1200 }, (_, i) => message('ROW-' + i + ' ' + 'x'.repeat(1200), i));
  const f = await fixture(t, records);
  const full = await f.client.call('getHistory', f.payload);
  assert.equal(full.success, true, JSON.stringify(full));
  assert.equal(full.entries.length, 1200);
  await f.client.call('releaseMemory');
  const before = await f.client.call('stats');
  const hydrate = { centerUuid: full.entries[120].uuid, radius: 4, alwaysHydrateTail: 2 };
  const result = await f.client.call('getHistory', { ...f.payload, hydrate });
  const after = await f.client.call('stats');
  assert.deepEqual(result.entries, applyHistoryRowWindow(full.entries, hydrate).entries);
  assert.equal(after.sourceBytes, before.sourceBytes);
  assert.equal(after.projector.sessions, 0, 'viewing old rows never restores whole parser graph');
  assert.equal(after.cache.pageRows - before.cache.pageRows, 11);
  assert.equal(after.cache.continuationBytes, before.cache.continuationBytes);
  assert.equal(result.payloadGeneration, full.payloadGeneration);
});

test('append after parser eviction restores continuation and reads only the suffix', async t => {
  const f = await fixture(t, Array.from({ length: 100 }, (_, i) => message('before ' + i, i)));
  const first = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  const before = await f.client.call('stats');
  const suffix = encode([message('appended', 101)]);
  await fs.appendFile(f.filePath, suffix);
  const next = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision });
  const after = await f.client.call('stats');
  assert.equal(next.entries.at(-1).content, 'appended');
  assert.equal(after.sourceBytes - before.sourceBytes, Buffer.byteLength(suffix));
  assert.equal(next.payloadGeneration, first.payloadGeneration);
  assert.ok(after.cache.continuationBytes > before.cache.continuationBytes);
});

test('proven own append keeps a warm parser rather than forcing an SSD restore', async t => {
  const f = await fixture(t, [message('before')]);
  const first = await f.client.call('getHistory', f.payload);
  const before = await f.client.call('stats');
  const suffix = encode([message('after', 1)]);
  await fs.appendFile(f.filePath, suffix);
  f.client.invalidate({ filePath: f.filePath, sourceAppend: true, readRefresh: false });
  const result = await f.client.call('getHistory', f.payload);
  const after = await f.client.call('stats');
  assert.equal(result.entries.at(-1).content, 'after');
  assert.equal(result.payloadGeneration, first.payloadGeneration);
  assert.equal(after.cache.continuationBytes, before.cache.continuationBytes);
  assert.equal(after.sourceBytes - before.sourceBytes, Buffer.byteLength(suffix));
});

test('full-payload client first after restart preserves the desktop source epoch', async t => {
  const f = await fixture(t, [message('same source')]);
  const first = await f.client.call('getHistory', f.payload);
  await f.restart();
  const full = await f.client.call('getHistory', { ...f.payload, dehydrate: false });
  assert.equal(full.entries[0].content, 'same source');
  const desktop = await f.client.call('getHistory', f.payload);
  assert.equal(desktop.payloadGeneration, first.payloadGeneration);
  assert.equal((await f.client.call('stats')).cache.continuationBytes, 0);
});

test('restart serves a disk page without parsing or restoring a continuation', async t => {
  const f = await fixture(t, Array.from({ length: 100 }, (_, i) => message('row ' + i, i)));
  const first = await f.client.call('getHistory', f.payload);
  await f.restart();
  const hydrate = { centerUuid: first.entries[3].uuid, radius: 2, alwaysHydrateTail: 1 };
  const next = await f.client.call('getHistory', { ...f.payload, hydrate });
  assert.deepEqual(next.entries, applyHistoryRowWindow(first.entries, hydrate).entries);
  const stats = await f.client.call('stats');
  assert.equal(stats.sourceBytes, 0);
  assert.equal(stats.cache.continuationBytes, 0);
  assert.equal(stats.projector.sessions, 0);
});

test('binary desktop transport preserves the public object response and source witness', async t => {
  const f = await fixture(t, [message('binary value 🌏')]);
  const plain = await f.client.call('getHistory', f.payload);
  const binary = await f.client.call('getHistory', f.payload, true);
  assert.equal(binary.__notedHistoryTransport, 'v8-1');
  assert.ok(binary.data instanceof Uint8Array);
  const decoded = require('node:v8').deserialize(Buffer.from(binary.data));
  assert.deepEqual(decoded, plain);
  assert.deepEqual(binary.proof.sourcePaths, [f.filePath]);
  const legacy = await f.client.call('getHistory', { ...f.payload, readTransport: 'v8-1' });
  assert.equal(legacy.__notedHistoryTransport, undefined, 'public read methods do not change transport from an untrusted payload field');
});

test('restart plus rewrite-and-growth rejects an old continuation prefix', async t => {
  const f = await fixture(t, [message('original')]);
  const first = await f.client.call('getHistory', f.payload);
  await f.restart();
  await fs.writeFile(f.filePath, encode([message('replaced'), message('tail', 1)]));
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.entries[0].content, 'replaced');
  assert.notEqual(result.payloadGeneration, first.payloadGeneration);
});

test('pending tool identity survives serialization and receives its later output', async t => {
  const f = await fixture(t, [{ type: 'response_item', timestamp: '2026-09-25T00:00:00Z', payload: { type: 'function_call', name: 'exec_command',
    call_id: 'call-1', arguments: JSON.stringify({ cmd: 'echo hello' }) } }]);
  await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  await fs.appendFile(f.filePath, encode([{ type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: {
    type: 'function_call_output', call_id: 'call-1', output: 'hello',
  } }]));
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.success, true);
  assert.ok(JSON.stringify(result.entries).includes('hello'));
  const raw = await codexData._api.parseJsonlFile(f.filePath);
  const expected = codexData._api.buildCodexFullHistory(raw, f.sessionId);
  assert.deepEqual(result.entries, expected);
});

test('full tool payload remains available on disk after a worker restart', async t => {
  const fullText = 'PAYLOAD-' + 'very long output '.repeat(2500);
  const f = await fixture(t, [
    { type: 'response_item', timestamp: '2026-09-25T00:00:00Z', payload: { type: 'function_call',
      name: 'exec_command', call_id: 'large-call', arguments: '{"cmd":"echo output"}' } },
    { type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: {
      type: 'function_call_output', call_id: 'large-call', output: fullText } },
  ]);
  const first = await f.client.call('getHistory', f.payload);
  const ref = first.entries[0].actions[0].rawTool.resultRef;
  assert.ok(ref);
  await f.restart();
  const result = await f.client.call('getToolPayload', { ...f.payload, payloadId: ref.payloadId, payloadGeneration: first.payloadGeneration });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.payload, fullText);
  assert.equal((await f.client.call('stats')).sourceBytes, 0);
});

test('Timeline after eviction uses prepared disk data without restoring parser', async t => {
  const records = Array.from({ length: 40 }, (_, i) => ({ type: 'event_msg', timestamp: '2026-09-25T00:00:00Z',
    payload: { type: 'user_message', message: 'prompt ' + i } }));
  const f = await fixture(t, records);
  await f.client.call('getHistory', f.payload);
  const first = await f.client.call('getTimeline', f.payload);
  await f.restart();
  const next = await f.client.call('getTimeline', f.payload);
  assert.deepEqual(next.entries, first.entries);
  const stats = await f.client.call('stats');
  assert.equal(stats.projector.sessions, 0);
  assert.equal(stats.sourceBytes, 0);
  assert.equal(stats.cache.continuationBytes, 0);
});

test('disk quota eviction is a cold miss, not loss of history', async t => {
  const f = await fixture(t, [message('intact')], { diskBudgetBytes: 1 });
  const first = await f.client.call('getHistory', f.payload);
  await f.restart();
  const next = await f.client.call('getHistory', f.payload);
  assert.deepEqual(next.entries, first.entries);
  assert.equal((await f.client.call('stats')).cache.diskBytes, 0);
});

for (const atomic of [false, true]) test(`disk pages reject ${atomic ? 'inode replacement' : 'same-size rewrite with restored mtime'}`, async t => {
  const f = await fixture(t, [message('before!')]);
  const first = await f.client.call('getHistory', f.payload);
  const previous = await fs.stat(f.filePath);
  await f.client.call('releaseMemory');
  if (atomic) {
    await fs.writeFile(f.filePath + '.replacement', encode([message('changed')]));
    await fs.rename(f.filePath + '.replacement', f.filePath);
  } else await fs.writeFile(f.filePath, encode([message('changed')]));
  await fs.utimes(f.filePath, previous.atimeMs / 1000, previous.mtimeMs / 1000);
  const result = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision });
  assert.equal(result.entries[0].content, 'changed');
  assert.notEqual(result.payloadGeneration, first.payloadGeneration);
});

test('corrupt positional index falls back to canonical data without adopting wrong identity', async t => {
  const f = await fixture(t, Array.from({ length: 20 }, (_, i) => message('exact row ' + i, i)));
  const first = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  const version = (await fs.readdir(f.config.cacheDirectory)).find(name => name.startsWith('v1-'));
  const filename = (await fs.readdir(path.join(f.config.cacheDirectory, version))).find(name => name.endsWith('.sqlite'));
  const corrupt = new SQLite(path.join(f.config.cacheDirectory, version, filename));
  corrupt.prepare('UPDATE rows SET stub=? WHERE pos=0').run('{"uuid":"wrong","rowStub":true}');
  corrupt.close();
  const result = await f.client.call('getHistory', f.payload);
  assert.deepEqual(result.entries, first.entries);
  assert.ok((await f.client.call('stats')).cache.errors > 0);
});

test('unterminated UTF-8 source record resumes at the exact physical offset', async t => {
  const f = await fixture(t, [message('one')]);
  const pending = Buffer.from(encode([message('хвост 🌏', 1)]));
  const split = pending.indexOf(Buffer.from('🌏')) + 2;
  await fs.appendFile(f.filePath, pending.subarray(0, split));
  const first = await f.client.call('getHistory', f.payload);
  assert.equal(first.entries.length, 1);
  await f.restart();
  await fs.appendFile(f.filePath, pending.subarray(split));
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].content, 'хвост 🌏');
  assert.equal(result.payloadGeneration, first.payloadGeneration);
});

test('foreign timing update invalidates disk pages and binds the offscreen final exactly', async t => {
  const f = await fixture(t, [message('first', 0), message('second', 3)], { database: true });
  const first = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  const start = Date.UTC(2026, 8, 25);
  const interval = f.db.saveActivityInterval({ tabId: f.payload.tabId, sessionId: f.sessionId, engine: 'codex', startTs: start, endTs: start + 500 });
  f.db.savePendingHistoryResponseTiming({ intervalId: interval.id, toolType: 'codex', tabId: f.payload.tabId, sessionId: f.sessionId });
  const result = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision,
    hydrate: { centerUuid: first.entries[1].uuid, radius: 1, alwaysHydrateTail: 1 } });
  assert.notEqual(result.unchanged, true);
  assert.equal(result.entries[0].responseTiming.intervalId, interval.id);
  assert.equal(f.db.db.prepare('SELECT entry_uuid FROM history_response_timings WHERE interval_id=?').get(interval.id).entry_uuid, first.entries[0].uuid);
  assert.equal(JSON.parse(result.revision.context).responseTimingRevision, f.db.getHistoryResponseTimingRevision('codex', f.sessionId, f.payload.tabId));
  const stats = await f.client.call('stats');
  assert.equal(stats.projector.sessions, 0, 'metadata-only binding reads canonical disk rows');
  assert.equal(stats.cache.continuationBytes, 0);
  assert.equal(stats.projector.budgetBytes + stats.virtual.budgetBytes, stats.workerGraphBudget,
    'virtual parser retention shares the same worker allocation');
});

test('foreign prompt sidecar edit cannot reuse a prepared page under a newer revision', async t => {
  const f = await fixture(t, [{ type: 'event_msg', timestamp: '2026-09-25T00:00:00Z', payload: { type: 'user_message', message: 'prompt' } }], { database: true });
  const first = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  f.db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId: f.sessionId, auditTimestamp: '2026-09-25T00:00:00Z',
    transportHash: '0123456789abcdef', entryUuid: first.entries[0].uuid, schemaVersion: 1,
    chips: [{ kind: 'prompt', id: 'chip', label: 'New label', text: 'instructions' }] });
  const result = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision });
  assert.notEqual(result.unchanged, true);
  assert.ok(JSON.stringify(result.entries).includes('New label'));
  assert.equal(JSON.parse(result.revision.context).promptPresentationRevision, f.db.getHistoryPromptPresentationRevision('codex', f.sessionId));
  assert.equal((await f.client.call('stats')).projector.sessions, 0);
  assert.equal((await f.client.call('stats')).cache.continuationBytes, 0);
});

test('concurrent History and Timeline requests consume the source once', async t => {
  const f = await fixture(t, Array.from({ length: 150 }, (_, i) => message('row ' + i, i)));
  const [history, timeline] = await Promise.all([
    f.client.call('getHistory', f.payload), f.client.call('getTimeline', f.payload),
  ]);
  assert.equal(history.success, true); assert.equal(timeline.success, true);
  assert.equal((await f.client.call('stats')).sourceBytes, (await fs.stat(f.filePath)).size);
});

test('read clients retain full messages, full-text search and export outside the visible page', async t => {
  const f = await fixture(t, [message('offscreen needle', 0), message('visible tail', 1)]);
  await f.client.call('getHistory', { ...f.payload, hydrate: { radius: 1, alwaysHydrateTail: 1 } });
  const messages = await f.client.call('getMessages', f.payload);
  assert.equal(messages.success, true);
  assert.ok(JSON.stringify(messages.messages).includes('offscreen needle'));
  const found = await f.client.call('searchHistory', { ...f.payload, query: 'needle' });
  assert.equal(found.success, true);
  assert.equal(found.matches.length, 1);
  const exported = await f.client.call('exportCodexSession', f.payload);
  assert.equal(exported.success, true);
  assert.match(exported.content, /offscreen needle/);
});

test('search images and text across the full cached history retains paging and Timeline ownership after RAM eviction', async t => {
  const user = (message, index) => ({type:'event_msg',timestamp:new Date(1700000000000+index).toISOString(),payload:{type:'user_message',message}});
  const records=[];
  for(let i=0;i<125;i++) {
    records.push({type:'response_item',timestamp:new Date(1700000000000+i).toISOString(),payload:{type:'message',role:'user',content:[
      {type:'input_image',image_url:'data:image/png;base64,AA'}, {type:'input_text',text:'photo '+i},
    ]}});
    records.push(user('[Image #1] photo '+i,i));
    records.push(message('answer needle '+i,i));
  }
  records.push(user('literal [Image #1] without attachment',999));
  const f=await fixture(t,records);
  const full=await f.client.call('getHistory',f.payload);
  assert.equal(full.success,true);
  const sourceBytes=(await f.client.call('stats')).sourceBytes;
  await f.client.call('releaseMemory');
  const images=await f.client.call('searchHistory',{...f.payload,query:'',type:'user-images',offset:100,limit:100});
  assert.equal(images.success,true);assert.equal(images.total,125);assert.equal(images.matches.length,25);
  assert.equal(images.matches[0].matchIndex,100);assert.equal(images.entryTotal,125);
  assert.ok(images.matches.every(m=>m.role==='user'&&m.hasImages));
  const answer=await f.client.call('searchHistory',{...f.payload,query:'needle',type:'assistant',limit:2});
  assert.equal(answer.total,125);assert.equal(answer.matches.length,2);assert.ok(answer.turnKeys.length>=125);
  assert.equal((await f.client.call('stats')).sourceBytes,sourceBytes,'search must use prepared SSD data after graph eviction');
});

test('unavailable cache directory retains the canonical history capability', async t => {
  const f = await fixture(t, [message('canonical')]);
  await fs.writeFile(f.config.cacheDirectory, 'not a directory');
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.entries[0].content, 'canonical');
  assert.ok((await f.client.call('stats')).cache.errors > 0);
});

test('writer invalidation during a cold read cannot republish the old source', async t => {
  const f = await fixture(t, Array.from({ length: 2600 }, (_, i) => message('old-' + i + 'x'.repeat(4096), i)));
  const worker = f.client.start();
  let receive;
  const began = new Promise(resolve => {
    receive = event => { if (event.event === 'preparation' && event.snapshot.operations.length) resolve(); };
    worker.on('message', receive);
  });
  const pending = f.client.call('getHistory', f.payload);
  await began;
  worker.off('message', receive);
  await fs.writeFile(f.filePath, encode([message('new-source')]));
  f.client.invalidate({ filePath: f.filePath, readRefresh: false, sourceAppend: false });
  const result = await pending;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].content, 'new-source');
  assert.equal(require('./history-preparation-activity').historyPreparationActivity.snapshot().operations.length, 0);
});



test('virtual frozen verification cannot publish after invalidation inside its read', async t => {
  const f = await virtualFixture(t);
  const { createCodexVirtualTranscriptStore } = require('./codex-virtual-transcript');
  const parentId = f.manifest.sourceSessionId;
  const readRange = codexData._api.readJsonlRange;
  let revoke = true;
  const store = createCodexVirtualTranscriptStore({ codexApi: { ...codexData._api,
    findCodexSessionFile: async id => ({ filePath: id === parentId ? f.parentFile : f.filePath }),
    readJsonlRange: async (...args) => {
      if (revoke && args[0] === f.parentFile) {
        revoke = false;
        codexData._api.invalidateJsonlCache(f.parentFile, { readRefresh: false });
      }
      return readRange(...args);
    },
  } });
  t.after(() => store.dispose());
  const descriptor = { viewOwnerSessionId: f.sessionId, eventKey: 'test-exact-fork', manifest: f.manifest };
  await assert.rejects(store.project(descriptor, f.directory), error => error.code === 'CODEX_SOURCE_READ_INVALIDATED');
  assert.equal(store.stats().views, 0, 'revoked graph is never retained');
  assert.equal((await store.project(descriptor, f.directory)).success, true);
});
test('foreign-session prompt edit after eviction redecorates base pages without restoring parser', async t => {
  const f = await fixture(t, [message('owner A')], { database: true });
  const first = await f.client.call('getHistory', f.payload);
  await f.client.call('releaseMemory');
  f.db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId: 'foreign-B', auditTimestamp: '2026-09-25T00:00:00Z',
    transportHash: '0123456789abcdef', entryUuid: 'foreign-user', schemaVersion: 1,
    chips: [{ kind: 'prompt', id: 'foreign', label: 'B', text: 'instructions' }] });
  const result = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision });
  assert.equal(result.entries[0].content, 'owner A');
  const stats = await f.client.call('stats');
  assert.equal(stats.projector.sessions, 0); assert.equal(stats.cache.continuationBytes, 0);
});

async function virtualFixture(t, parentExtra = []) {
  const { buildCodexForkLineageManifest } = require('./session-history-events');
  const parentId = '01a02eb0-f7dc-7910-9969-1bffae88d8d3';
  const childId = '01a02ed8-e41e-7522-97ad-dedf6e7233ac';
  const childRecords = [{ type: 'session_meta', payload: { id: childId } }];
  const f = await fixture(t, childRecords, { database: true, sessionId: childId });
  const parentRecords = [{ type: 'event_msg', timestamp: '2026-09-25T00:00:00Z',
    payload: { type: 'user_message', message: 'PARENT-BEFORE' } }, message('ANSWER-BEFORE')];
  parentRecords.push(...parentExtra);
  const parentFile = path.join(f.directory, 'rollout-' + parentId + '.jsonl');
  const bytes = encode(parentRecords), childBytes = encode(childRecords);
  await fs.writeFile(parentFile, bytes);
  const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: parentId, childSessionId: childId,
    sourceSegments: [{ physicalSessionId: parentId, fromByte: 0, toByte: Buffer.byteLength(bytes),
      startLine: 0, endLine: parentRecords.length, prefixDigest: digest(bytes) }],
    childTailStart: { byteOffset: Buffer.byteLength(childBytes), line: childRecords.length, prefixDigest: digest(childBytes) } });
  assert.ok(manifest);
  f.db.saveSessionForkEvent({ provider: 'codex', sourceSessionId: parentId, childSessionId: childId,
    entryUuids: [], snapshotComplete: true, isDirect: true, origin: 'app', lineageManifest: manifest });
  return { ...f, get client() { return f.client; }, parentFile, parentRecords, childRecords, manifest };
}
for (const change of ['replace', 'ctime', 'explicit-growth']) test('warm virtual prefix rejects changed parent: ' + change, async t => {
  const f = await virtualFixture(t);
  const first = await f.client.call('getHistory', f.payload);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.ok(JSON.stringify(first.entries).includes('PARENT-BEFORE'));
  const stat = await fs.stat(f.parentFile);
  const next = encode(f.parentRecords).replaceAll('BEFORE', 'AFTER!');
  if (change === 'replace') { await fs.writeFile(f.parentFile + '.new', next); await fs.rename(f.parentFile + '.new', f.parentFile); }
  else await fs.writeFile(f.parentFile, next + (change === 'explicit-growth' ? encode([message('added')]) : ''));
  await fs.utimes(f.parentFile, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  if (change !== 'ctime') f.client.invalidate({ filePath: f.parentFile });
  for (const method of ['getHistory', 'getTimeline', 'exportCodexSession']) {
    const result = await f.client.call(method, { ...f.payload, ifRevision: first.revision });
    assert.equal(result.success, false, method + ': ' + JSON.stringify(result));
    assert.equal(result.lineageReason, 'source-segment-digest-mismatch');
  }
});
test('virtual child replacement rebuilds tail while preserving the frozen prefix', async t => {
  const f = await virtualFixture(t);
  await fs.appendFile(f.filePath, encode([message('CHILD-BEFORE')]));
  const first = await f.client.call('getHistory', f.payload);
  await fs.writeFile(f.filePath + '.new', encode([...f.childRecords, message('CHILD-AFTER!')]));
  await fs.rename(f.filePath + '.new', f.filePath);
  const result = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(JSON.stringify(result.entries).includes('CHILD-AFTER!'));
  assert.ok(!JSON.stringify(result.entries).includes('CHILD-BEFORE'));
});
for (const method of ['getHistory', 'getTimeline', 'searchHistory', 'copyCodexVirtualRange', 'exportCodexSession', 'resolveCodexPhysicalRow']) {
  test('all composite replies are revoked by ancestor invalidation: ' + method, async t => {
    const f = await virtualFixture(t);
    const timeline = await f.client.call('getTimeline', f.payload);
    assert.equal(timeline.success, true, JSON.stringify(timeline));
    const ref = timeline.entries.find(row => row.type === 'user').entryRef;
    const request = f.client.request.bind(f.client); let count = 0;
    f.client.request = async (...args) => {
      const result = await request(...args); count++;
      assert.ok(result.readProof.some(source => source.filePath === f.parentFile));
      if (count === 1) {
        assert.equal(result.value.success, true, JSON.stringify(result.value));
        await fs.writeFile(f.parentFile, encode(f.parentRecords).replaceAll('BEFORE', 'AFTER!'));
        f.client.invalidate({ filePath: f.parentFile });
      }
      return result;
    };
    const result = await f.client.call(method, { ...f.payload, query: 'BEFORE',
      expectedContentRevision: timeline.contentRevision, entryRef: ref, startEntryRef: ref, endEntryRef: ref });
    assert.equal(count, 2);
    assert.equal(result.success, false);
    assert.equal(result.error, 'lineage_unresolved');
    if (method !== 'searchHistory') assert.equal(result.lineageReason, 'source-segment-digest-mismatch');
  });
}

const toolRecords = output => [
  { type: 'response_item', timestamp: '2026-09-25T00:00:00Z', payload: {
    type: 'function_call', name: 'exec_command', call_id: 'large-call', arguments: '{"cmd":"echo output"}' } },
  { type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: {
    type: 'function_call_output', call_id: 'large-call', output } },
];

test('virtual legacy payload cannot bypass an invalidated ancestor through RAM stash', async t => {
  const f = await virtualFixture(t, toolRecords('PARENT-PAYLOAD-' + 'x'.repeat(20000)));
  const first = await f.client.call('getHistory', f.payload);
  assert.equal(first.success, true, JSON.stringify(first));
  const ref = first.entries.flatMap(row => row.actions || []).find(a => a.rawTool?.resultRef).rawTool.resultRef;
  assert.equal((await f.client.call('getToolPayload', { ...f.payload, payloadId: ref.payloadId })).success, true);
  await fs.writeFile(f.parentFile, encode(f.parentRecords).replace('PARENT-PAYLOAD-', 'REWRITTEN-DATA-'));
  f.client.invalidate({ filePath: f.parentFile });
  const next = await f.client.call('getToolPayload', { ...f.payload, payloadId: ref.payloadId });
  assert.equal(next.success, false); assert.equal(next.lineageReason, 'source-segment-digest-mismatch');
});

test('on-demand action and result use the same virtual owner after restart, and reject changed frozen ancestry', async t => {
  const output = 'PARENT-PAYLOAD-' + 'x'.repeat(20000);
  const f = await virtualFixture(t, toolRecords(output));
  const request = { ...f.payload, payloadPolicy: 'on-demand-v1', bounds: { last: 80 } };
  const first = await f.client.call('getHistory', request);
  assert.equal(first.success, true, first.error);
  const action = first.entries.flatMap(row => row.actions || []).find(action => action.actionRef);
  const read = ref => f.client.call('getToolPayload', { ...f.payload, payloadPolicy: 'on-demand-v1',
    entryUuid: ref.rowUuid, payloadId: ref.payloadId, contentHash: ref.contentHash, payloadGeneration: first.payloadGeneration });
  await f.restart();
  const recovered = await read(action.actionRef);
  assert.equal(recovered.success, true, JSON.stringify({ error: recovered.error, reason: recovered.reason || recovered.lineageReason,
    generation: first.payloadGeneration }));
  const full = await read(action.rawTool.resultRef);
  assert.equal(full.success, true, full.error); assert.equal(full.payload, output);
  await fs.writeFile(f.parentFile, encode(f.parentRecords).replace('PARENT-PAYLOAD-', 'REWRITTEN-DATA-'));
  f.client.invalidate({ filePath: f.parentFile });
  const stale = await read(action.actionRef);
  assert.equal(stale.success, false); assert.equal(stale.lineageReason, 'source-segment-digest-mismatch');
});
test('ownership arriving before first read distinguishes the same call id at two physical offsets', async t => {
  const spawn = { type: 'response_item', timestamp: '2026-09-25T00:00:00Z', payload: {
    type: 'function_call', namespace: 'multi_agent_v1', name: 'spawn_agent', call_id: 'duplicate', arguments: '{"message":"work"}' } };
  const output = { type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: {
    type: 'function_call_output', call_id: 'duplicate', output: '{"agent_id":"first-agent"}' } };
  const f = await fixture(t, [spawn, output, { ...spawn, timestamp: '2026-09-25T00:00:02Z' }]);
  const offset = Buffer.byteLength(encode([spawn, output]));
  for (const [sourceByteOffset, lifecycleGeneration] of [[0, 'process-A'], [offset, 'process-B']]) {
    f.client.start().postMessage({ event: 'ownership', payload: { sessionId: f.sessionId, callId: 'duplicate', sourceByteOffset, lifecycleGeneration } });
  }
  const first = await f.client.call('getHistory', f.payload);
  const cards = first.entries.flatMap(row => row.actions || []).filter(a => a.tool === 'Task');
  assert.deepEqual(cards.map(a => a.processGeneration), ['process-A', 'process-B']);
  await f.client.call('releaseMemory');
  const prepared = await f.client.call('getHistory', f.payload);
  assert.deepEqual(prepared.entries.flatMap(row => row.actions || []).filter(a => a.tool === 'Task').map(a => a.processGeneration), ['process-A', 'process-B']);
});


for (const restart of [false, true]) test('virtual SSD page and Timeline survive ' + (restart ? 'worker restart' : 'RAM eviction') + ' without ancestor parser', async t => {
  const f = await virtualFixture(t, Array.from({ length: 80 }, (_, i) => message('ancestor row ' + i, i)));
  const first = await f.client.call('getHistory', { ...f.payload, hydrate: { radius: 2, alwaysHydrateTail: 1 } });
  assert.equal(first.success, true, JSON.stringify(first));
  const target = first.entries[12].uuid;
  const originalTimeline = await f.client.call('getTimeline', f.payload);
  if (restart) await f.restart(); else await f.client.call('releaseMemory');
  const before = await f.client.call('stats');
  const page = await f.client.call('getHistory', { ...f.payload,
    hydrate: { centerUuid: target, radius: 2, alwaysHydrateTail: 1 } });
  assert.equal(page.success, true, JSON.stringify(page));
  assert.equal(page.payloadGeneration, first.payloadGeneration);
  assert.equal(page.entries.find(row => row.uuid === target).rowStub, undefined);
  assert.equal(page.entries.length, first.entries.length);
  const timeline = await f.client.call('getTimeline', f.payload);
  assert.deepEqual(timeline.entries, originalTimeline.entries);
  const after = await f.client.call('stats');
  assert.equal(after.virtual.views || 0, 0);
  assert.equal(after.projector.sessions, 0);
  assert.equal(after.cache.continuationBytes, 0);
  assert.equal(after.cache.pageRows - before.cache.pageRows, 6);
  assert.equal(after.sourceBytes - before.sourceBytes, 0);
});
test('virtual SSD metadata refresh preserves inherited prompt edits without a graph', async t => {
  const f = await virtualFixture(t);
  const first = await f.client.call('getHistory', f.payload);
  const user = first.entries.find(row => row.role === 'user');
  await f.client.call('releaseMemory');
  f.db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId: f.manifest.sourceSessionId,
    auditTimestamp: user.timestamp, transportHash: '0123456789abcdef', entryUuid: user.uuid, schemaVersion: 1,
    chips: [{ kind: 'prompt', id: 'inherited', label: 'INHERITED-UPDATE', text: 'instructions' }] });
  const next = await f.client.call('getHistory', { ...f.payload, ifRevision: first.revision });
  assert.equal(next.success, true, JSON.stringify(next));
  assert.ok(JSON.stringify(next.entries).includes('INHERITED-UPDATE'));
  assert.equal((await f.client.call('stats')).virtual.views, 0);
});
test('full virtual client first after restart keeps the prepared physical generations', async t => {
  const f = await virtualFixture(t);
  const first = await f.client.call('getHistory', f.payload);
  await f.restart();
  await f.client.call('getHistory', { ...f.payload, dehydrate: false });
  const next = await f.client.call('getHistory', f.payload);
  assert.equal(next.payloadGeneration, first.payloadGeneration);
  assert.deepEqual(next.entries, first.entries);
});


for (const restart of [false, true]) test('virtual append restores saved state and parses only child suffix: restart=' + restart, async t => {
  const f = await virtualFixture(t, Array.from({ length: 120 }, (_, i) => message('long ancestor ' + i, i)));
  const first = await f.client.call('getHistory', f.payload);
  if (restart) await f.restart(); else await f.client.call('releaseMemory');
  const before = await f.client.call('stats');
  const suffix = encode([message('CHILD-APPENDED')]);
  await fs.appendFile(f.filePath, suffix);
  const result = await f.client.call('getHistory', f.payload);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.payloadGeneration, first.payloadGeneration);
  assert.ok(result.entries.some(row => row.content === 'CHILD-APPENDED'));
  const stats = await f.client.call('stats');
  assert.equal(stats.virtual.sourceBytes - (before.virtual.sourceBytes || 0), Buffer.byteLength(suffix));
  assert.equal(stats.virtual.continuationRestores, 1);
  assert.ok(stats.cache.virtualContinuationBytes > 0);
  assert.ok(stats.cache.writes - before.cache.writes <= 2,
    'a new composite revision must not rewrite the unchanged ancestor row bodies');
  const cached = await f.client.call('getHistory', f.payload);
  assert.equal(cached.entries[0].entryRef.contentRevision, result.contentRevision);
  assert.equal(cached.entries[0].contentRevision, result.contentRevision);
  const canonical = await f.client.call('getHistory', { ...f.payload, dehydrate: false });
  assert.deepEqual(result.entries, canonical.entries, 'resumed composite output equals the complete canonical projection');
});
test('virtual saved continuation rejects child rewrite plus growth after restart', async t => {
  const f = await virtualFixture(t);
  await fs.appendFile(f.filePath, encode([message('CHILD-OLD')]));
  await f.client.call('getHistory', f.payload);
  await f.restart();
  await fs.writeFile(f.filePath, encode([...f.childRecords, message('CHILD-NEW'), message('extra', 1)]));
  const next = await f.client.call('getHistory', f.payload);
  assert.equal(next.success, true, JSON.stringify(next));
  assert.ok(next.entries.some(row => row.content === 'CHILD-NEW'));
  assert.ok(!JSON.stringify(next.entries).includes('CHILD-OLD'));
  assert.equal((await f.client.call('stats')).virtual.continuationRestores, 0);
});


for (const phase of ['base-rows', 'view-rows']) test('invalidation during yielded ' + phase + ' cannot publish a partial cache', async t => {
  const f = await fixture(t, Array.from({ length: 2400 }, (_, i) => message('OLD-ROW-' + i + 'x'.repeat(1200), i)), { diagnosticStages: true });
  const worker = f.client.start();
  const began = new Promise(resolve => {
    const receive = event => { if (event.event === 'cache-stage' && event.phase === phase) { worker.off('message', receive); resolve(); } };
    worker.on('message', receive);
  });
  const pending = f.client.call('getHistory', f.payload);
  await began;
  await fs.writeFile(f.filePath, encode([message('CURRENT-ONLY')]));
  f.client.invalidate({ filePath: f.filePath });
  const result = await pending;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.entries.map(row => row.content), ['CURRENT-ONLY']);
  await f.restart();
  const disk = await f.client.call('getHistory', f.payload);
  assert.deepEqual(disk.entries.map(row => row.content), ['CURRENT-ONLY']);
});
test('failed native SQLite cache transaction rolls back and keeps canonical fallback available', async t => {
  const { HistoryPreparedCache } = require('./history-prepared-cache');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-cache-full-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cache = new HistoryPreparedCache({ directory });
  const owner = { sessionId: 'disk-full', cwd: directory };
  let code = null;
  const result = await cache.withAsyncDb(owner, async db => {
    db.pragma('max_page_count = 10');
    try { db.prepare('INSERT INTO payloads VALUES (?,?,?)').run('oversized', Buffer.alloc(2 * 1024 * 1024), 'test'); }
    catch (error) { code = error.code; throw error; }
    return true;
  });
  assert.equal(code, 'SQLITE_FULL');
  assert.equal(result, null);
  assert.equal(cache.activeFiles.size, 0);
  assert.equal(cache.readSource(owner), null);
  assert.equal(cache.withDb(owner, true, db => { cache.setMeta(db, 'probe', 'fresh'); return true; }), true);
});

for (const change of ['replace', 'rewrite', 'delete']) test('first legacy and strict payload after restart checks source: ' + change, async t => {
  const f = await fixture(t, toolRecords('OLD-' + 'x'.repeat(20000)));
  const first = await f.client.call('getHistory', f.payload);
  const payloadId = first.entries[0].actions[0].rawTool.resultRef.payloadId;
  await f.restart();
  if (change === 'delete') await fs.unlink(f.filePath);
  else if (change === 'replace') {
    await fs.writeFile(f.filePath + '.new', encode(toolRecords('NEW-' + 'x'.repeat(20000))));
    await fs.rename(f.filePath + '.new', f.filePath);
  } else await fs.writeFile(f.filePath, encode(toolRecords('NEW-' + 'x'.repeat(20000))));
  const legacy = await f.client.call('getToolPayload', { ...f.payload, payloadId });
  if (change === 'delete') assert.equal(legacy.success, false);
  else { assert.equal(legacy.success, true, JSON.stringify(legacy)); assert.ok(legacy.payload.startsWith('NEW-')); }
  const strict = await f.client.call('getToolPayload', { ...f.payload, payloadId, payloadGeneration: first.payloadGeneration });
  assert.equal(strict.error, 'history_payload_generation_changed');
});
test('legacy payload after restart and append verifies prefix without restoring parser', async t => {
  const text = 'PAYLOAD-' + 'x'.repeat(20000);
  const f = await fixture(t, toolRecords(text));
  const first = await f.client.call('getHistory', f.payload);
  await f.restart();
  await fs.appendFile(f.filePath, encode([message('later')]));
  const result = await f.client.call('getToolPayload', { ...f.payload,
    payloadId: first.entries[0].actions[0].rawTool.resultRef.payloadId, payloadGeneration: first.payloadGeneration });
  assert.equal(result.payload, text);
  const stats = await f.client.call('stats');
  assert.equal(stats.sourceBytes, 0);
  assert.ok(stats.sourceVerificationBytes > 20000);
  assert.equal(stats.cache.continuationBytes, 0);
});

for (const method of ['getHistory', 'getTimeline', 'searchHistory', 'getMessages', 'exportCodexSession', 'getToolPayload']) {
  for (const binary of method === 'getHistory' ? [false, true] : [false]) test('delivery fence: ' + method + ' binary=' + binary, async t => {
    const f = await fixture(t, [...toolRecords('OLD-' + 'x'.repeat(20000)), message('NEEDLE')]);
    const first = await f.client.call('getHistory', f.payload);
    const payload = { ...f.payload, query: 'NEEDLE', payloadId: first.entries[0].actions[0].rawTool.resultRef.payloadId };
    const request = f.client.request.bind(f.client);
    let requests = 0;
    f.client.request = async (...args) => {
      const actual = await request(...args); requests++;
      assert.ok(actual.readProof.some(source => source.filePath === f.filePath));
      if (requests === 1) {
        await fs.writeFile(f.filePath, encode([...toolRecords('NEW-' + 'x'.repeat(20000)), message('cleared')]));
        f.client.invalidate({ filePath: f.filePath });
      }
      return actual;
    };
    let result = await f.client.call(method, payload, binary);
    if (binary) result = require('node:v8').deserialize(Buffer.from(result.data));
    assert.equal(requests, 2, 'the stale real worker response must be retried');
    assert.equal(result.success, true, JSON.stringify(result));
    if (method === 'searchHistory') assert.equal(result.matches.length, 0);
    else assert.ok(!JSON.stringify(result).includes('OLD-'));
  });
}
test('unrelated invalidation does not restart a source-bound worker reply', async t => {
  const f = await fixture(t, [message('kept')]);
  const request = f.client.request.bind(f.client); let count = 0;
  f.client.request = async (...args) => {
    const result = await request(...args); count++;
    f.client.invalidate({ filePath: path.join(f.directory, 'unrelated.jsonl') }); return result;
  };
  assert.equal((await f.client.call('getHistory', f.payload)).entries[0].content, 'kept');
  assert.equal(count, 1);
});
test('runtime ownership overlays prepared/full/delta cards and cannot survive as stale disk proof', async t => {
  const records = [{ type: 'response_item', timestamp: '2026-09-25T00:00:00Z', payload: {
    type: 'function_call', namespace: 'multi_agent_v1', name: 'spawn_agent', call_id: 'spawn', arguments: '{"message":"do work"}' } }];
  const f = await fixture(t, records);
  const first = await f.client.call('getHistory', { ...f.payload, deltaOk: true });
  const card = first.entries.flatMap(row => row.actions || []).find(a => a.tool === 'Task');
  assert.ok(card); assert.equal(card.processGeneration, undefined);
  const proof = { sessionId: f.sessionId, callId: 'spawn', sourceByteOffset: 0, lifecycleGeneration: 'process-2' };
  f.client.start().postMessage({ event: 'ownership', payload: proof });
  const delta = await f.client.call('getHistory', { ...f.payload, deltaOk: true, ifRevision: first.revision });
  assert.notEqual(delta.unchanged, true);
  assert.equal(delta.changedEntries.flatMap(row => row.actions || []).find(a => a.tool === 'Task').processGeneration, 'process-2');
  const full = await f.client.call('getHistory', { ...f.payload, dehydrate: false });
  assert.equal(full.entries.flatMap(row => row.actions || []).find(a => a.tool === 'Task').processGeneration, 'process-2');
  assert.equal((await f.client.call('stats')).sourceBytes, Buffer.byteLength(encode(records)), 'ownership does not replay the parser');
  await f.restart();
  const restarted = await f.client.call('getHistory', f.payload);
  assert.equal(restarted.entries.flatMap(row => row.actions || []).find(a => a.tool === 'Task').processGeneration, undefined);
  f.client.start().postMessage({ event: 'ownership', payload: { ...proof, sourceByteOffset: 1, lifecycleGeneration: 'wrong-offset' } });
  const other = await f.client.call('getHistory', f.payload);
  assert.equal(other.entries.flatMap(row => row.actions || []).find(a => a.tool === 'Task').processGeneration, undefined);
});

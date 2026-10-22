'use strict';

// Entire CURRENT service/cache/parser implementations; only source discovery,
// generation authority and lineage metadata are finite fixture ports. No app,
// provider, user transcript or live database. Linux runs with the explicitly
// testing-only node:sqlite adapter, never claimed as native better-sqlite3.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SessionTranscriptService } = require('./session-transcript-service');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const { createReadControl, withReadControl } = require('./history-read-control');
const { historyPayloadStash } = require('./history-payload-dehydrate');
const hash = text => createHash('sha256').update(text).digest('hex');
const physical = (filePath, sessionId, generation) => {
  const stat = fs.statSync(filePath);
  return { filePath, sessionId, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    fileIdentity: stat.dev + ':' + stat.ino, sourceGeneration: generation };
};

async function fixture(t, kib = 16) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-miss-owned-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = { sessionId: 'own-payload', cwd: directory, tabId: 'own-tab' };
  const filePath = path.join(directory, 'own.jsonl'), digest = createHash('sha256');
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"');
    for (let i = 0; i < kib; i++) {
      const chunk = String.fromCharCode(65 + (i % 26)).repeat(1024);
      fs.writeSync(fd, chunk); digest.update(chunk);
    }
    fs.writeSync(fd, '"}}\n');
  } finally { fs.closeSync(fd); }
  const contentHash = digest.digest('hex'), source = physical(filePath, owner.sessionId, 'generation-1');
  const entry = { uuid: 'row-1', sessionId: owner.sessionId, role: 'assistant', content: '',
    actions: [{ tool: 'Read', rawTool: { toolUseId: 'call:canonical:0', resultSourceLine: 0, resultRef: { payloadId: 'result:call:canonical:0',
      totalChars: kib * 1024, contentHash } } }] };
  let cache = new HistoryPreparedCache({ directory: path.join(directory, 'cache'), indexBudgetBytes: 0 });
  assert.equal(await cache.savePrepared({ owner, source, context: 'synthetic-admitted-view', entries: [entry] }), true);
  // Reopen only committed state; no payload staging and no stash are seeded.
  cache.clearMemory();
  cache = new HistoryPreparedCache({ directory: cache.baseDirectory, indexBudgetBytes: 0 });
  const counters = { project: 0, raw: 0, prepared: 0, restore: 0, generation: 'generation-1' };
  const api = { findCodexSessionFile: async () => ({ filePath }),
    prepareCodexPayloadSource: async () => { counters.prepared++; },
    restoreCodexSourceSnapshot: () => { counters.restore++; return true; },
    getCodexPayloadGeneration: () => counters.generation,
    projectCodexFullHistoryFromFile: () => { counters.project++; throw Error('unexpected whole projector'); },
    loadSessionRecords: () => { counters.raw++; throw Error('unexpected raw records'); } };
  const service = new SessionTranscriptService({ codexData: { _api: api }, preparedHistoryStore: cache });
  const request = { ...owner, toolType: 'codex', payloadId: 'result:call:canonical:0', entryUuid: 'row-1',
    payloadGeneration: source.sourceGeneration, contentHash, expectedContentHash: contentHash,
    payloadPolicy: 'on-demand-v1', offset: 0, limit: 1024 };
  return { directory, owner, filePath, source, entry, cache, service, request, counters, contentHash };
}

test('MISS01 exact admitted row/ref survives cache reopen; full ordered pages/hash without canonical rebuild', async t => {
  const f = await fixture(t, 16);
  t.mock.method(historyPayloadStash, 'get', () => { throw Error('no whole stash lookup'); });
  const restored = createHash('sha256'); let chars = 0, pageCount = 0, offset = 0;
  for (;;) {
    const page = await f.service.getToolPayload({ ...f.request, offset });
    assert.equal(page.success, true); assert.equal(page.source, pageCount === 0 ? 'source-leaf' : 'disk');
    assert.equal(page.entryUuid, 'row-1'); assert.equal(page.contentHash, f.contentHash);
    assert.equal(page.payload.length <= 1024, true); assert.equal(page.offset, offset);
    assert.equal(page.payload, String.fromCharCode(65 + pageCount).repeat(1024));
    restored.update(page.payload); chars += page.payload.length; pageCount++;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(pageCount, 16); assert.equal(chars, 16 * 1024);
  assert.equal(restored.digest('hex'), f.contentHash);
  assert.equal(f.counters.project, 0); assert.equal(f.counters.raw, 0);
});

test('MISS02 binding rejects wrong row/hash/generation and same-generation append before source scan', async t => {
  const f = await fixture(t, 1), read = options => f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0',
    f.source, { entryUuid: 'row-1', contentHash: f.contentHash, ...options });
  assert.equal(read({}).entryUuid, 'row-1');
  assert.equal(read({ entryUuid: 'another-row' }), null);
  assert.equal(read({ contentHash: '0'.repeat(64) }), null);
  assert.equal(f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0', { ...f.source, sourceGeneration: 'other' },
    { entryUuid: 'row-1', contentHash: f.contentHash }), null);
  fs.appendFileSync(f.filePath, '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"new"}}\n');
  const appended = physical(f.filePath, f.owner.sessionId, f.source.sourceGeneration);
  f.cache.saveSourceHeader(f.owner, appended);
  assert.equal(f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0', appended,
    { entryUuid: 'row-1', contentHash: f.contentHash }), null, 'append does not make the earlier equal call ID current');
  assert.equal(await f.service._tryDirectCodexPayloadPage(f.request, { requireRow: true }), null);
});

test('MISS03 aborted replacement rolls back row/payload bindings together', async t => {
  const f = await fixture(t, 1), controller = new AbortController(); let checkpoints = 0;
  const control = createReadControl({ signal: controller.signal, schedule: async () => {
    checkpoints++; controller.abort();
  } });
  const changed = Array.from({ length: 100 }, (_, i) => ({ ...f.entry, uuid: 'new-' + i }));
  await assert.rejects(withReadControl(control, () => f.cache.savePrepared({ owner: f.owner,
    source: { ...f.source, sourceGeneration: 'new-generation' }, context: 'not-published', entries: changed, control })),
  { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  assert.ok(checkpoints > 0);
  const binding = f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0', f.source,
    { entryUuid: 'row-1', contentHash: f.contentHash });
  assert.equal(binding.entryUuid, 'row-1');
  assert.equal(f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0', f.source,
    { entryUuid: 'new-0', contentHash: f.contentHash }), null);
  assert.deepEqual(f.cache.readSource(f.owner), f.source);
  assert.equal(f.cache.activeFiles.size, 0); assert.equal(f.cache.asyncFileAdmissions.size, 0);
});

test('MISS04 actual service preserves generation mismatch and source invalidation, not empty success', async t => {
  const f = await fixture(t, 256);
  f.counters.generation = 'rewrite-generation';
  const old = await f.service.getToolPayload(f.request);
  assert.equal(old.success, false); assert.equal(old.error, 'history_payload_generation_changed');
  f.counters.generation = 'generation-1';
  let changed = false;
  const control = createReadControl({ schedule: async () => {
    if (!changed) { changed = true; fs.appendFileSync(f.filePath, '{}\n'); }
  } });
  await assert.rejects(withReadControl(control, () => f.service.getToolPayload(f.request)),
    { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(changed, true); assert.equal(f.counters.project, 0); assert.equal(f.counters.raw, 0);
});

test('MISS05 abort during actual source scan stops before fallback and preserves the committed binding', async t => {
  const f = await fixture(t, 256), controller = new AbortController(); let checkpoints = 0;
  const control = createReadControl({ signal: controller.signal, schedule: async () => { checkpoints++; controller.abort(); } });
  await assert.rejects(withReadControl(control, () => f.service.getToolPayload(f.request)),
    { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  assert.ok(checkpoints > 0); assert.equal(f.counters.project, 0); assert.equal(f.counters.raw, 0);
  assert.ok(f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0', f.source,
    { entryUuid: 'row-1', contentHash: f.contentHash }));
});

test('MISS06 composite lineage and transformed bodies retain the capable canonical fallback', async t => {
  const f = await fixture(t, 1); let fallbackReads = 0;
  f.service._resolveCodexLineage = () => ({ kind: 'virtual' });
  assert.equal(await f.service._tryDirectCodexPayloadPage(f.request, { requireRow: true }), null);
  f.service.getHistory = async () => { fallbackReads++; return { success: false, error: 'controlled-canonical-result' }; };
  const result = await f.service.getToolPayload(f.request);
  assert.equal(result.error, 'controlled-canonical-result'); assert.equal(fallbackReads, 1);
  f.service._resolveCodexLineage = () => ({ kind: 'physical' });
  // This fixture binding says the canonical row contains another transformed
  // value; raw output with this ID must not be returned as that value.
  const transformedHash = hash('normalized-output');
  const entry = { ...f.entry, actions: [{ rawTool: { toolUseId: 'call:canonical:0', resultSourceLine: 0, resultRef: { payloadId: 'result:call:canonical:0',
    contentHash: transformedHash, totalChars: 'normalized-output'.length } } }] };
  await f.cache.savePrepared({ owner: f.owner, source: f.source, entries: [entry], context: 'transformed' });
  assert.equal(await f.service._tryDirectCodexPayloadPage({ ...f.request, contentHash: transformedHash,
    expectedContentHash: transformedHash }, { requireRow: true }), null);
});

test('MISS07 wrong binding checksum is a disposable-cache miss, never a direct source authority', async t => {
  const f = await fixture(t, 1);
  f.cache.withDb(f.owner, true, db => db.prepare('UPDATE payload_bindings SET checksum=?').run('invalid'), 'savePrepared');
  assert.equal(f.cache.readPayloadBinding(f.owner, 'result:call:canonical:0', f.source,
    { entryUuid: 'row-1', contentHash: f.contentHash }), null);
  assert.equal(await f.service._tryDirectCodexPayloadPage(f.request, { requireRow: true }), null);
});

test('MISS08 unavailable optional staging still returns the exact bounded page from the same source', async t => {
  const f = await fixture(t, 1);
  t.mock.method(f.cache, 'createPendingPayloads', () => { throw Object.assign(Error('fixture storage unavailable'), { code: 'ENOSPC' }); });
  const page = await f.service.getToolPayload(f.request);
  assert.equal(page.success, true); assert.equal(page.source, 'source-leaf');
  assert.equal(page.payload, 'A'.repeat(1024)); assert.equal(page.contentHash, f.contentHash);
  assert.equal(f.counters.project, 0); assert.equal(f.counters.raw, 0);
});

test('MISS09 deletion after source admission is typed invalidation and cannot start canonical fallback', async t => {
  const f = await fixture(t, 256); let removed = false;
  const control = createReadControl({ schedule: async () => {
    if (!removed) { removed = true; fs.unlinkSync(f.filePath); }
  } });
  await assert.rejects(withReadControl(control, () => f.service.getToolPayload(f.request)),
    { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(removed, true); assert.equal(f.counters.project, 0); assert.equal(f.counters.raw, 0);
});

test('MISS10 direct miss preserves policy-specific hash authority across cold and warm legacy routes', async t => {
  const f = await fixture(t, 1), stale = '0'.repeat(64);
  t.mock.method(historyPayloadStash, 'get', () => 'A'.repeat(1024));
  // Legacy contract uses expectedContentHash. An unrelated contentHash must
  // not authorize the direct path when that expected hash is stale.
  const legacy = { ...f.request, payloadPolicy: undefined };
  const coldMismatch = await f.service.getToolPayload({ ...legacy, expectedContentHash: stale });
  assert.equal(coldMismatch.success, false);
  assert.equal(coldMismatch.error, 'history_payload_changed');
  // Conversely, the on-demand hash field must not override the valid legacy
  // field. This successful miss refills disk so the next case is a cache hit.
  const coldMatch = await f.service.getToolPayload({ ...legacy, contentHash: stale });
  assert.equal(coldMatch.success, true); assert.equal(coldMatch.source, 'source-leaf');
  assert.equal(coldMatch.contentHash, f.contentHash);
  const warmMismatch = await f.service.getToolPayload({ ...legacy, expectedContentHash: stale });
  assert.equal(warmMismatch.success, false);
  assert.equal(warmMismatch.error, 'history_payload_changed');
  // on-demand-v1 already uses contentHash. The extra legacy field does not
  // silently redefine that endpoint's existing identity contract.
  const onDemand = await f.service.getToolPayload({ ...f.request, expectedContentHash: stale });
  assert.equal(onDemand.success, true); assert.equal(onDemand.contentHash, f.contentHash);
  assert.equal(f.counters.project, 0); assert.equal(f.counters.raw, 0);
});

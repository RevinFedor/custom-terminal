'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const { HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES } = require('./history-cache-policy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'synthetic.jsonl');
  fs.writeFileSync(filePath, 'unchanged synthetic source');
  const stat = fs.statSync(filePath);
  const owner = { sessionId: 'retention-session', cwd: root, tabId: 'tab' };
  const source = { filePath, sessionId: owner.sessionId, size: stat.size, mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino, sourceGeneration: 'generation' };
  const directory = path.join(root, 'cache');
  const events = [];
  const cache = new HistoryPreparedCache({ directory, onDiagnostic: event => events.push(event) });
  const entries = [{ uuid: 'user-1', role: 'user', content: 'hello' },
    { uuid: 'assistant-1', role: 'assistant', content: 'ready '.repeat(15000) }];
  const timeline = [{ uuid: 'user-1', role: 'user', text: 'hello' }];
  const proof = [{ offset: 0, bytes: stat.size, hash: 'proof-for-fixture' }];
  return { root, directory, filePath, stat, owner, source, cache, entries, timeline, proof, events,
    async seed() {
      cache.saveContinuation(owner, source, { sourceProof: proof, graph: 'checkpoint '.repeat(100000) },
        new Map([['payload', 'tool result '.repeat(15000)]]));
      cache.saveTimeline(owner, source, timeline, { title: 'fixture' });
      await cache.savePrepared({ owner, source, context: 'ready', entries });
    },
    read: () => cache.readPrepared({ owner, filePath, stat, context: 'ready' }),
  };
}

test('worker default disk retention uses approved 20 GiB without increasing the RAM index', t => {
  const f = fixture(t);
  assert.equal(f.cache.maxBytes, 20 * 1024 ** 3);
  assert.equal(f.cache.maxBytes, HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES);
  assert.equal(f.cache.indexMemoryBudget, 32 * 1024 ** 2);
});

test('quota removes bulky checkpoint but keeps ready History and Timeline after RAM release', async t => {
  const f = fixture(t); await f.seed();
  // The finished lightweight views fit; the checkpoint plus them does not.
  f.cache.maxBytes = 400 * 1024;
  f.cache.prune(); f.cache.clearMemory();
  assert.ok(f.cache.stats().diskBytes <= f.cache.maxBytes);
  assert.equal(f.cache.readContinuation(f.owner, f.filePath, f.stat), null);
  assert.deepEqual(f.cache.readTimeline(f.owner, f.filePath, f.stat)?.entries, f.timeline,
    'opening Timeline must reuse its ready data after checkpoint eviction');
  assert.deepEqual(f.read()?.entries, f.entries, 'reading ready History must not depend on the bulky checkpoint');
  assert.deepEqual(f.cache.readSource(f.owner), f.source);
  assert.deepEqual(f.cache.readSourceProof(f.owner), f.proof);
});

test('compact Timeline and source certificate survive even when ready row bodies must be evicted', async t => {
  const f = fixture(t); await f.seed();
  const timelineFile = f.cache.filename(f.owner, 'timeline');
  fs.utimesSync(timelineFile, new Date(1), new Date(1));
  f.cache.maxBytes = fs.statSync(timelineFile).size;
  f.cache.prune(f.cache.filename(f.owner, 'state'));
  f.cache.clearMemory();
  assert.equal(f.read(), null);
  assert.deepEqual(f.cache.readTimeline(f.owner, f.filePath, f.stat).entries, f.timeline);
  assert.deepEqual(f.cache.readSource(f.owner), f.source);
  assert.deepEqual(f.cache.readSourceProof(f.owner), f.proof);
  const prune = f.events.filter(e => e.operation === 'prune').at(-1);
  assert.equal(prune.stateEvictedCount, 1); assert.equal(prune.rowsEvictedCount, 1);
  assert.ok(f.cache.stats().diskBytes <= f.cache.maxBytes);
  const restarted = new HistoryPreparedCache({ directory: f.directory, maxBytes: f.cache.maxBytes });
  assert.deepEqual(restarted.readTimeline(f.owner, f.filePath, f.stat).entries, f.timeline);
  assert.deepEqual(restarted.readSource(f.owner), f.source);
});

test('obsolete schema is removed before current data even when its mtime is newer', async t => {
  const f = fixture(t); await f.seed();
  const currentBytes = f.cache.stats().diskBytes;
  const oldDir = path.join(f.directory, 'v1-dead'); fs.mkdirSync(oldDir);
  const name = path.basename(f.cache.filename(f.owner));
  fs.copyFileSync(f.cache.filename(f.owner), path.join(oldDir, name));
  fs.utimesSync(path.join(oldDir, name), new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  f.cache.maxBytes = currentBytes; f.cache.prune();
  assert.equal(fs.existsSync(path.join(oldDir, name)), false);
  assert.ok(f.cache.readContinuation(f.owner, f.filePath, f.stat));
  assert.deepEqual(f.read().entries, f.entries);
  assert.equal(f.events.filter(e => e.operation === 'prune').at(-1).obsoleteEvictedCount, 1);
});

test('old ready rows do not continually evict a working owner new checkpoint', async t => {
  const f = fixture(t); await f.seed();
  f.cache.maxBytes = 400 * 1024; f.cache.prune();
  assert.ok(f.read());
  for (const name of fs.readdirSync(f.cache.directory)) fs.utimesSync(path.join(f.cache.directory, name), new Date(1), new Date(1));
  const owner = { ...f.owner, sessionId: 'working-owner' };
  const source = { ...f.source, sessionId: owner.sessionId };
  f.cache.maxBytes = 600 * 1024;
  assert.equal(f.cache.saveContinuation(owner, source, { sourceProof: [], graph: 'x'.repeat(480 * 1024) }), true);
  assert.ok(f.cache.readContinuation(owner, f.filePath, f.stat), 'new working checkpoint survives its own write');
  assert.deepEqual(f.cache.readTimeline(f.owner, f.filePath, f.stat).entries, f.timeline);
  assert.equal(f.read(), null, 'old bulky row bodies yield space before the working checkpoint');
  assert.ok(f.cache.stats().diskBytes <= f.cache.maxBytes);
});

test('targeted invalidation removes every tier and only the matching source', async t => {
  const f = fixture(t); await f.seed();
  const otherOwner = { ...f.owner, sessionId: 'independent' };
  const otherSource = { ...f.source, filePath: f.filePath + '-other' };
  f.cache.saveContinuation(otherOwner, otherSource, { sourceProof: [] });
  f.cache.saveTimeline(otherOwner, otherSource, f.timeline, {});
  f.cache.invalidate(f.filePath);
  assert.equal(f.read(), null);
  assert.equal(f.cache.readTimeline(f.owner, f.filePath, f.stat), null);
  assert.equal(f.cache.readContinuation(f.owner, f.filePath, f.stat), null);
  assert.equal(f.cache.readSource(f.owner), null);
  assert.deepEqual(f.cache.readSource(otherOwner), otherSource);
});

test('payload fetched again after checkpoint eviction keeps its exact source generation across restart', async t => {
  const f = fixture(t); await f.seed();
  f.cache.maxBytes = 400 * 1024; f.cache.prune();
  assert.equal(f.cache.readPayload(f.owner, 'payload', f.source), null);
  f.cache.savePayloads(f.owner, new Map([['payload', 'refetched exact body']]));
  const restarted = new HistoryPreparedCache({ directory: f.directory, maxBytes: f.cache.maxBytes });
  assert.equal(restarted.readPayload(f.owner, 'payload', f.source), 'refetched exact body');
  assert.equal(restarted.readPayload(f.owner, 'payload', { ...f.source, sourceGeneration: 'different' }), null);
});

test('surviving compact data still rejects replaced, rewritten and appended source files', async t => {
  const f = fixture(t); await f.seed(); f.cache.maxBytes = 400 * 1024; f.cache.prune();
  fs.appendFileSync(f.filePath, ' more');
  assert.equal(f.cache.readTimeline(f.owner, f.filePath, fs.statSync(f.filePath)), null);
  fs.writeFileSync(f.filePath + '.new', 'unchanged synthetic source');
  fs.renameSync(f.filePath + '.new', f.filePath);
  assert.equal(f.cache.readTimeline(f.owner, f.filePath, fs.statSync(f.filePath)), null);
  assert.equal(f.cache.readPrepared({ owner: f.owner, filePath: f.filePath, stat: fs.statSync(f.filePath), context: 'ready' }), null);
});

test('zero quota and one oversized tier are still bounded; no retention exemption', async t => {
  const f = fixture(t); await f.seed(); f.cache.maxBytes = 0; f.cache.prune();
  assert.equal(f.cache.stats().diskBytes, 0);
  assert.deepEqual(fs.readdirSync(f.cache.directory), []);
  assert.equal(f.cache.saveContinuation(f.owner, f.source, { graph: 'large'.repeat(10000) }), null);
  assert.equal(await f.cache.savePrepared({ owner: f.owner, source: f.source, context: 'ready', entries: f.entries }), null);
  assert.equal(f.cache.stats().diskBytes, 0);
});

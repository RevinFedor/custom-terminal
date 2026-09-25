'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const api = require('./codex-data')._api;
const { SessionTranscriptService } = require('../session-transcript-service');
const { fingerprintHistoryEntry } = require('../history-delta');

const record = content => ({ type: 'response_item', timestamp: '2026-09-25T00:00:00Z',
  payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: content }] } });
const encode = content => JSON.stringify(record(content)) + '\n';

async function fixture(t, content = 'before') {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-astra-regression-'));
  const sessionId = 'astra-source';
  const filePath = path.join(dir, 'rollout-' + sessionId + '.jsonl');
  await fs.promises.writeFile(filePath, encode(content));
  t.after(async () => { api.invalidateJsonlCache(filePath); await fs.promises.rm(dir, { recursive: true, force: true }); });
  const options = { sessionsDir: dir };
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: {
    ...api,
    findCodexSessionFile: async () => ({ filePath }),
    projectCodexFullHistoryFromFile: (id, cwd, opts) => api.projectCodexFullHistoryFromFile(id, cwd, { ...opts, ...options }),
    projectCodexTimelineFromFile: (id, cwd, opts) => api.projectCodexTimelineFromFile(id, cwd, { ...opts, ...options }),
  } } });
  return { dir, sessionId, filePath, options, service,
    payload: { toolType: 'codex', sessionId, cwd: dir, tabId: 'astra-tab', dehydrate: true, deltaOk: true } };
}

test('ifRevision includes effective entry bounds, not only the hydration window', async t => {
  const f = await fixture(t, 'first');
  await fs.promises.appendFile(f.filePath, encode('second'));
  const first = await f.service.getHistory({ ...f.payload, bounds: { last: 1 } });
  assert.equal(first.entries.length, 1);
  const second = await f.service.getHistory({ ...f.payload, bounds: { last: 2 }, ifRevision: first.revision });
  assert.notEqual(second.unchanged, true);
  assert.equal(second.entries?.length || second.order?.length, 2);
  const equivalent = await f.service.getHistory({ ...f.payload, bounds: { last: '2', radius: 17 }, ifRevision: second.revision });
  assert.equal(equivalent.unchanged, true, 'irrelevant radius and numeric spelling do not cause a refresh');
});

test('row stub grouping and reasoning metadata participates in delta freshness', () => {
  const base = { uuid: 'row', role: 'assistant', rowStub: true, sessionId: 'session',
    actionSummary: [{ toolName: 'Read', family: 'read', subject: 'a.txt', targetKey: 'a.txt' }] };
  for (const change of [
    { actionSummary: [{ ...base.actionSummary[0], subject: 'b.txt', targetKey: 'b.txt' }] },
    { hasContent: true }, { hasThinking: true }, { thinkingSeconds: 15 }, { textPhase: 'final_answer' },
  ]) assert.notEqual(fingerprintHistoryEntry(base), fingerprintHistoryEntry({ ...base, ...change }));
});

test('prepared writer witness cannot be replaced by a fresh stat of modified contents', async t => {
  const f = await fixture(t);
  await fs.promises.unlink(f.filePath);
  const written = await api.writeCodexJsonlExclusive(f.filePath, [record('before')]);
  const before = await fs.promises.stat(f.filePath);
  await new Promise(resolve => setTimeout(resolve, 10));
  await fs.promises.writeFile(f.filePath, encode('after!'));
  // Match the exact writer mtime, including the filesystem's sub-ms precision.
  await fs.promises.utimes(f.filePath, before.atimeMs / 1000, before.mtimeMs / 1000);
  const after = await fs.promises.stat(f.filePath);
  // The explicit witness is the writer's, with mtime normalized to the same
  // filesystem precision if utimes rounded it; ctime must remain original.
  written.mtimeMs = after.mtimeMs;
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  await api.publishCodexRewriteProjection({ sourceSessionId: 'source', loaded: { composite: true },
    result: { newSessionId: f.sessionId, filePath: f.filePath, written }, outputRecords: written.records });
  const fresh = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  assert.equal(fresh.entries[0].content, 'after!');
  assert.equal(fresh.mode, 'rebuild', 'invalid optional seed falls back to the real reader');
});

test('watcher notices ctime-only rewrite once and does not fan it out as an append', async t => {
  const f = await fixture(t);
  const fixed = Date.UTC(2026, 8, 25) / 1000;
  await fs.promises.utimes(f.filePath, fixed, fixed);
  const before = await fs.promises.stat(f.filePath);
  const state = { filePath: f.filePath, toolType: 'codex', sessionId: f.sessionId, cwd: f.dir,
    size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs,
    fileIdentity: before.dev + ':' + before.ino, version: 1, offset: before.size, leftover: '' };
  await new Promise(resolve => setTimeout(resolve, 10));
  await fs.promises.writeFile(f.filePath, encode('after!'));
  await fs.promises.utimes(f.filePath, fixed, fixed);
  assert.equal(await f.service._refreshFile(state), true);
  assert.equal(state.version, 2);
  assert.equal(await f.service._refreshFile(state), false);
  assert.equal(state.version, 2);
});

for (const atomic of [false, true]) {
  test(`detected ${atomic ? 'atomic' : 'same-inode'} rewrite must reach a renderer holding a delta baseline`, async t => {
    const before = 'A'.repeat(300) + 'X' + 'Z'.repeat(300);
    const after = 'A'.repeat(300) + 'Y' + 'Z'.repeat(300);
    const f = await fixture(t, before);
    const first = await f.service.getHistory(f.payload);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (atomic) {
      await fs.promises.writeFile(f.filePath + '.new', encode(after));
      await fs.promises.rename(f.filePath + '.new', f.filePath);
    } else await fs.promises.writeFile(f.filePath, encode(after));
    const second = await f.service.getHistory({ ...f.payload, ifRevision: first.revision });
    const rows = second.delta
      ? second.order.map(uuid => second.changedEntries.find(row => row.uuid === uuid) || first.entries.find(row => row.uuid === uuid))
      : second.entries;
    assert.equal(rows[0].content, after);
    assert.notEqual(second.payloadGeneration, first.payloadGeneration, 'old expanded payload caches cannot cross a rewrite');
  });
}

test('parser cache replacement and ordinary append do not masquerade as a source rewrite', async t => {
  const f = await fixture(t);
  const first = await f.service.getHistory(f.payload);
  api.invalidateCodexHistoryProjectors(f.filePath);
  await fs.promises.appendFile(f.filePath, encode('tail'));
  const restored = await f.service.getHistory({ ...f.payload, ifRevision: first.revision });
  assert.equal(restored.payloadGeneration, first.payloadGeneration);
  assert.equal(restored.delta, true);
  await api.parseJsonlFile(f.filePath, { forceFresh: true });
  const refreshed = await f.service.getHistory(f.payload);
  assert.equal(refreshed.payloadGeneration, first.payloadGeneration);
});

test('failed append feed discards its half-advanced graph before the next refresh', async t => {
  const fileName = require.resolve('./codex-data');
  const isolated = new Module(fileName, module);
  isolated.filename = fileName;
  isolated.paths = Module._nodeModulePaths(path.dirname(fileName));
  const originalRequire = isolated.require.bind(isolated);
  let throwCheckpoint = false;
  isolated.require = request => {
    const dependency = originalRequire(request);
    if (request !== '../codex-projection-checkpoint') return dependency;
    return { ...dependency, cloneProjectionGraphAsync: async (...args) => {
      if (throwCheckpoint) { throwCheckpoint = false; throw new Error('injected checkpoint failure'); }
      return dependency.cloneProjectionGraphAsync(...args);
    } };
  };
  isolated._compile(fs.readFileSync(fileName, 'utf8'), fileName);
  const local = isolated.exports._api;
  const f = await fixture(t);
  t.after(() => local.invalidateCodexHistoryProjectors());
  await fs.promises.writeFile(f.filePath, Array.from({ length: 2040 }, (_, i) => encode('row-' + i)).join(''));
  await local.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  await fs.promises.appendFile(f.filePath, Array.from({ length: 20 }, (_, i) => encode('tail-' + i)).join(''));
  throwCheckpoint = true;
  await assert.rejects(local.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options), /injected checkpoint failure/);
  const recovered = await local.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  const stat = await fs.promises.stat(f.filePath);
  const exact = await local.readJsonlRange(f.filePath, 0, stat.size - 1);
  assert.deepEqual(recovered.entries, local.buildCodexFullHistory(exact.records, f.sessionId));
  assert.equal(recovered.entries.length, 2060);
});

test('raw record provenance survives actual LRU eviction without taking a newer file stat', async t => {
  const f = await fixture(t);
  const records = await api.parseJsonlFile(f.filePath);
  const before = api.getCodexJsonlSourceSnapshot(f.filePath, f.sessionId, records);
  const others = [];
  for (let i = 0; i < 6; i += 1) {
    const file = path.join(f.dir, 'other-' + i + '.jsonl');
    others.push(file);
    await fs.promises.writeFile(file, encode('other'));
    await api.parseJsonlFile(file);
  }
  t.after(() => { for (const file of others) api.invalidateJsonlCache(file); });
  assert.ok(!api.getCodexJsonlCacheStats().filePaths.includes(f.filePath));
  await fs.promises.appendFile(f.filePath, encode('later'));
  const snapshot = api.getCodexJsonlSourceSnapshot(f.filePath, f.sessionId, records);
  assert.equal(snapshot.size, before.size);
  assert.ok(snapshot.size < (await fs.promises.stat(f.filePath)).size);
  assert.equal(records.length, 1);
});

test('a returned raw operation snapshot does not grow when another caller appends', async t => {
  const f = await fixture(t);
  const loaded = await api.loadSessionRecords(f.sessionId, f.dir, f.options);
  assert.equal(loaded.success, true);
  await fs.promises.appendFile(f.filePath, encode('later'));
  const latest = await api.parseJsonlFile(f.filePath);
  assert.equal(latest.length, 2);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.sourceSnapshot.size, Buffer.byteLength(encode('before')));
});

for (const kind of ['projection', 'raw']) {
  test(`${kind} reader checks the descriptor and pathname after a mid-read replacement`, async t => {
    const f = await fixture(t);
    const original = fs.createReadStream;
    let injected = false;
    fs.createReadStream = function (file, ...args) {
      const stream = original.call(this, file, ...args);
      if (file === f.filePath && !injected) stream.once('data', () => {
        injected = true;
        fs.writeFileSync(f.filePath + '.new', encode('after!'));
        fs.renameSync(f.filePath + '.new', f.filePath);
      });
      return stream;
    };
    t.after(() => { fs.createReadStream = original; });
    const entries = kind === 'projection'
      ? (await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options)).entries
      : api.buildCodexFullHistory(await api.parseJsonlFile(f.filePath), f.sessionId);
    assert.equal(injected, true);
    assert.equal(entries[0].content, 'after!');
  });
}

for (const kind of ['projection', 'raw']) {
  test(`${kind} read cannot republish an explicitly invalidated old prefix`, async t => {
    const f = await fixture(t);
    const original = fs.createReadStream;
    let injected = false;
    fs.createReadStream = function (file, ...args) {
      const stream = original.call(this, file, ...args);
      if (file === f.filePath && !injected) stream.once('data', () => {
        injected = true;
        fs.writeFileSync(f.filePath, encode('after!') + encode('tail'));
        api.invalidateJsonlCache(f.filePath);
      });
      return stream;
    };
    t.after(() => { fs.createReadStream = original; });
    if (kind === 'projection') {
      await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
      const next = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
      assert.deepEqual(next.entries.map(row => row.content), ['after!', 'tail']);
    } else {
      await api.parseJsonlFile(f.filePath);
      const next = await api.parseJsonlFile(f.filePath);
      assert.deepEqual(api.buildCodexFullHistory(next, f.sessionId).map(row => row.content), ['after!', 'tail']);
    }
    assert.equal(injected, true);
  });
}

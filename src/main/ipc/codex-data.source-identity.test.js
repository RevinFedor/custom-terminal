'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('./codex-data')._api;
const { buildHistoryRevision, validateHistoryRevision } = require('../history-revision');
const { SessionTranscriptService } = require('../session-transcript-service');

const encode = (text) => JSON.stringify({
  type: 'event_msg', timestamp: '2026-09-25T00:00:00Z',
  payload: { type: 'user_message', message: text },
}) + '\n';
const fixedTime = Date.UTC(2026, 8, 25, 2) / 1000;

async function fixture(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-source-identity-'));
  const sessionId = 'source-identity';
  const filePath = path.join(dir, `rollout-2026-09-25T00-00-00-${sessionId}.jsonl`);
  await fs.promises.writeFile(filePath, encode('before'));
  await fs.promises.utimes(filePath, fixedTime, fixedTime);
  const options = { sessionsDir: dir };
  const identity = { toolType: 'codex', sessionId, cwd: dir };
  t.after(async () => {
    api.invalidateJsonlCache(filePath);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return { dir, sessionId, filePath, options, identity };
}

for (const mutation of ['atomic replacement', 'in-place rewrite', 'larger atomic replacement']) {
  test(`both Codex caches and the revision reject ${mutation} with restored mtime`, async (t) => {
    const f = await fixture(t);
    const before = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
    await api.parseJsonlFile(f.filePath);
    const revision = buildHistoryRevision(f.identity, [before.sourceSnapshot]);
    const originalStat = await fs.promises.stat(f.filePath);
    const replacement = encode('after!') + (mutation.startsWith('larger') ? encode('second') : '');
    // ctime is maintained by the filesystem even when a writer restores mtime.
    await new Promise(resolve => setTimeout(resolve, 10));
    if (mutation === 'in-place rewrite') {
      await fs.promises.writeFile(f.filePath, replacement);
      await fs.promises.utimes(f.filePath, fixedTime, fixedTime);
    } else {
      await fs.promises.writeFile(f.filePath + '.new', replacement);
      await fs.promises.utimes(f.filePath + '.new', fixedTime, fixedTime);
      await fs.promises.rename(f.filePath + '.new', f.filePath);
    }
    const changedStat = await fs.promises.stat(f.filePath);
    assert.equal(changedStat.mtimeMs, originalStat.mtimeMs);
    if (mutation === 'in-place rewrite') {
      assert.equal(changedStat.ino, originalStat.ino);
      assert.notEqual(changedStat.ctimeMs, originalStat.ctimeMs);
    } else {
      assert.notEqual(changedStat.ino, originalStat.ino);
    }

    const validation = await validateHistoryRevision(revision, f.identity, {
      resolvePrimaryFile: async () => f.filePath,
    });
    const cacheOnly = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, {
      ...f.options, cacheOnly: true,
    });
    const after = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
    const timeline = await api.projectCodexTimelineFromFile(f.sessionId, f.dir, f.options);
    const raw = await api.parseJsonlFile(f.filePath);
    assert.deepEqual({ unchanged: validation.unchanged, cached: cacheOnly.success,
      mode: after.mode, text: after.entries[0].content, rawText: raw[0].payload.message }, {
      unchanged: false, cached: false, mode: 'rebuild', text: 'after!', rawText: 'after!',
    });
    assert.deepEqual(after.entries, api.buildCodexFullHistory(raw, f.sessionId));
    assert.deepEqual(timeline.entries, api.buildCodexTimeline(raw, f.sessionId));
    assert.equal(after.sourceSnapshot.fileIdentity, changedStat.dev + ':' + changedStat.ino);
    assert.equal(after.sourceSnapshot.ctimeMs, changedStat.ctimeMs);
  });
}

test('unchanged probes read no JSONL; genuine append reads only the suffix in each cache', async (t) => {
  const f = await fixture(t);
  const first = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  await api.parseJsonlFile(f.filePath);
  const revision = buildHistoryRevision(f.identity, [first.sourceSnapshot]);
  const streams = [];
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function (filePath, ...args) {
    const stream = createReadStream.call(this, filePath, ...args);
    if (filePath === f.filePath) streams.push(stream);
    return stream;
  };
  t.after(() => { fs.createReadStream = createReadStream; });
  assert.equal((await validateHistoryRevision(revision, f.identity)).unchanged, true);
  assert.equal((await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options)).mode, 'unchanged');
  await api.parseJsonlFile(f.filePath);
  assert.equal(streams.length, 0);

  const suffix = encode('new tail');
  await fs.promises.appendFile(f.filePath, suffix);
  const appended = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  await api.projectCodexTimelineFromFile(f.sessionId, f.dir, f.options);
  const raw = await api.parseJsonlFile(f.filePath);
  assert.equal(appended.mode, 'append');
  assert.equal(streams.length, 2, 'projector and raw cache each consume the new bytes once');
  assert.equal(streams.reduce((sum, stream) => sum + stream.bytesRead, 0), 2 * Buffer.byteLength(suffix));
  assert.deepEqual(appended.entries, api.buildCodexFullHistory(raw, f.sessionId));
});

test('projector revision names its consumed cursor when the source grows during I/O', async (t) => {
  const f = await fixture(t);
  const before = await fs.promises.stat(f.filePath);
  const createReadStream = fs.createReadStream;
  let appended = false;
  fs.createReadStream = function (filePath, ...args) {
    const stream = createReadStream.call(this, filePath, ...args);
    if (filePath === f.filePath && !appended) {
      stream.once('data', () => {
        appended = true;
        fs.appendFileSync(f.filePath, encode('later!'));
      });
    }
    return stream;
  };
  t.after(() => { fs.createReadStream = createReadStream; });
  const first = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  assert.equal(appended, true);
  assert.equal(first.entries.length, 1);
  assert.equal(first.sourceSnapshot.size, before.size);
  assert.equal(first.sourceSnapshot.ctimeMs, before.ctimeMs);
  const revision = buildHistoryRevision(f.identity, [first.sourceSnapshot]);
  assert.equal((await validateHistoryRevision(revision, f.identity)).unchanged, false);
  const second = await api.projectCodexFullHistoryFromFile(f.sessionId, f.dir, f.options);
  assert.equal(second.mode, 'append');
  assert.deepEqual(second.entries.map(row => row.content), ['before', 'later!']);
});

test('legacy revision without physical fields requires one refresh instead of proving unchanged', async (t) => {
  const f = await fixture(t);
  const stat = await fs.promises.stat(f.filePath);
  const sources = [{ filePath: f.filePath, size: stat.size, mtimeMs: stat.mtimeMs,
    sessionId: f.sessionId, parentSessionId: null, linkKind: 'end' }];
  const schema = 'history-files-v1';
  const identity = { toolType: 'codex', sessionId: f.sessionId, cwd: f.dir };
  const token = crypto.createHash('sha256').update(JSON.stringify({ schema, identity, sources, context: '' })).digest('hex');
  assert.equal((await validateHistoryRevision({ schema, ...identity, sources, context: '', token }, identity)).unchanged, false);
});

test('actual History and Timeline services cannot bypass replacement detection with ifRevision', async (t) => {
  const f = await fixture(t);
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    codexData: { _api: {
      ...api,
      findCodexSessionFile: async () => ({ filePath: f.filePath }),
      projectCodexFullHistoryFromFile: (id, cwd, options) => api.projectCodexFullHistoryFromFile(id, cwd, { ...options, ...f.options }),
      projectCodexTimelineFromFile: (id, cwd, options) => api.projectCodexTimelineFromFile(id, cwd, { ...options, ...f.options }),
    } },
  });
  const payload = { ...f.identity, dehydrate: true };
  const history = await service.getHistory(payload);
  const timeline = await service.getTimeline(payload);
  assert.equal(history.success, true);
  assert.equal(timeline.success, true);
  assert.equal((await service.getHistory({ ...payload, ifRevision: history.revision })).unchanged, true);
  await fs.promises.writeFile(f.filePath + '.new', encode('after!'));
  await fs.promises.utimes(f.filePath + '.new', fixedTime, fixedTime);
  await fs.promises.rename(f.filePath + '.new', f.filePath);
  const nextHistory = await service.getHistory({ ...payload, ifRevision: history.revision });
  const nextTimeline = await service.getTimeline({ ...payload, ifRevision: timeline.revision });
  assert.equal(nextHistory.success, true);
  assert.equal(nextTimeline.success, true);
  assert.notEqual(nextHistory.unchanged, true);
  assert.notEqual(nextTimeline.unchanged, true);
  assert.equal(nextHistory.entries[0].content, 'after!');
  assert.equal(nextTimeline.entries[0].content, 'after!');
  assert.notEqual(nextHistory.revision.token, history.revision.token);
  assert.notEqual(nextTimeline.revision.token, timeline.revision.token);
});

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { SessionTranscriptService } = require('./session-transcript-service');

test('Codex history returns unchanged before loading or projecting records', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-a.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  let loadCalls = 0;
  let projectionCalls = 0;
  const codexData = {
    _api: {
      findCodexSessionFile: async () => ({ filePath }),
      loadSessionRecords: async () => {
        loadCalls += 1;
        const stat = await fs.promises.stat(filePath);
        return {
          success: true,
          records: [{ type: 'record' }],
          filePath,
          sourceSnapshot: {
            filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sessionId: 'session-a',
            linkKind: 'end',
          },
        };
      },
      buildCodexFullHistory: () => {
        projectionCalls += 1;
        return [{ uuid: 'row-a' }];
      },
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
  });

  const first = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
  });
  assert.equal(first.success, true);
  assert.equal(first.unchanged, false);
  assert.ok(first.revision?.token);
  assert.equal(loadCalls, 1);
  assert.equal(projectionCalls, 1);

  const second = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.deepEqual(second, {
    success: true,
    unchanged: true,
    revision: first.revision,
  });
  assert.equal(loadCalls, 1);
  assert.equal(projectionCalls, 1);

  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  const third = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(third.unchanged, false);
  assert.equal(loadCalls, 2);
  assert.equal(projectionCalls, 2);
});

test('a transcript change received during an active read gets one trailing read', async () => {
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: null,
  });
  let releaseFirstRead;
  let firstReadStarted;
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const firstReadStartedGate = new Promise((resolve) => { firstReadStarted = resolve; });
  let refreshCalls = 0;
  let changedCalls = 0;
  service._refreshFile = async () => {
    refreshCalls += 1;
    if (refreshCalls === 1) {
      firstReadStarted();
      await firstReadGate;
    }
    return true;
  };
  service._emitChanged = () => {
    changedCalls += 1;
  };
  const state = {
    toolType: 'claude',
    sessionId: 'session-trailing',
    consumers: new Map([['consumer', { tabId: 'tab-1' }]]),
    inflight: false,
    trailingReadReason: null,
    size: 0,
  };

  const firstRead = service._readChange(state, 'first');
  await firstReadStartedGate;
  await service._readChange(state, 'second');
  releaseFirstRead();
  await firstRead;

  assert.equal(refreshCalls, 2);
  assert.equal(changedCalls, 2);
  assert.equal(state.inflight, false);
  assert.equal(state.trailingReadReason, null);
});

test('concurrent subscribers share one initialized state and one watcher', async () => {
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: null,
  });
  let releaseResolve;
  const resolveGate = new Promise((resolve) => { releaseResolve = resolve; });
  let resolveCalls = 0;
  let refreshCalls = 0;
  let watcherStarts = 0;
  let watcherStops = 0;

  service._resolveFilePath = async () => {
    resolveCalls += 1;
    await resolveGate;
    return '/tmp/shared-session.jsonl';
  };
  service._refreshFile = async (state) => {
    refreshCalls += 1;
    state.size = 42;
    state.mtimeMs = 7;
    return true;
  };
  service._startWatcher = (state) => {
    if (state.watcher) return;
    watcherStarts += 1;
    state.watcher = {
      close: () => {
        watcherStops += 1;
      },
    };
  };

  const base = {
    tabId: 'tab-shared',
    toolType: 'codex',
    sessionId: 'session-shared',
    cwd: '/tmp/project',
  };
  const historySubscription = service.subscribe({
    ...base,
    consumerId: 'history:tab-shared',
  });
  const timelineSubscription = service.subscribe({
    ...base,
    consumerId: 'timeline:tab-shared',
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolveCalls, 1);
  releaseResolve();
  const [historyResult, timelineResult] = await Promise.all([
    historySubscription,
    timelineSubscription,
  ]);

  assert.equal(historyResult.success, true);
  assert.equal(timelineResult.success, true);
  assert.equal(refreshCalls, 1);
  assert.equal(watcherStarts, 1);
  assert.equal(service.sessions.size, 1);
  const state = service.sessions.values().next().value;
  assert.equal(state.consumers.size, 2);
  assert.equal(service.sessionInitInflight.size, 0);

  await service.unsubscribe({ consumerId: 'history:tab-shared' });
  assert.equal(service.sessions.size, 1);
  assert.equal(watcherStops, 0);

  await service.unsubscribe({ consumerId: 'timeline:tab-shared' });
  assert.equal(service.sessions.size, 0);
  assert.equal(watcherStops, 1);
});

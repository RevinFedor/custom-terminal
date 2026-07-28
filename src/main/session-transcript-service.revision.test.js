const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  SessionTranscriptService,
  isClaudePendingThinkingRecord,
} = require('./session-transcript-service');

test('Claude thinking-only records are marked ephemeral before live History delivery', async (t) => {
  const record = {
    type: 'assistant',
    uuid: 'thinking-only',
    timestamp: '2026-07-28T05:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'temporary reasoning' }],
    },
  };
  assert.equal(isClaudePendingThinkingRecord(record), true);
  assert.equal(isClaudePendingThinkingRecord({
    ...record,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: 'visible answer' },
      ],
    },
  }), false);

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-live-thinking-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  const line = JSON.stringify(record) + '\n';
  await fs.promises.writeFile(filePath, line);
  const delivered = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => delivered.push({ channel, payload }),
      },
    }),
    webBroadcast: null,
    claudeData: null,
    codexData: null,
  });
  await service._broadcastClaudeDelta({
    filePath,
    size: Buffer.byteLength(line),
    offset: 0,
    leftover: '',
    sessionId: 'session-a',
    consumers: new Map([['history', { tabId: 'tab-a' }]]),
  }, 0);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'agent-transcript:live-message');
  assert.equal(delivered[0].payload.message.uuid, 'thinking-only');
  assert.equal(delivered[0].payload.message.livePendingThinking, true);
});

test('Codex Timeline durable revision skips unchanged full projection', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'timeline-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-timeline.jsonl');
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
            sessionId: 'session-timeline',
            linkKind: 'end',
          },
        };
      },
      buildCodexTimeline: () => {
        projectionCalls += 1;
        return [{ uuid: 'timeline-row' }];
      },
      getTimelineSessionMeta: () => ({ id: 'session-timeline' }),
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
  });

  const first = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'session-timeline',
    cwd: dir,
  });
  assert.equal(first.unchanged, false);
  assert.ok(first.revision?.token);

  const unchanged = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'session-timeline',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(loadCalls, 1);
  assert.equal(projectionCalls, 1);

  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  const changed = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'session-timeline',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(changed.unchanged, false);
  assert.equal(loadCalls, 2);
  assert.equal(projectionCalls, 2);
});

test('Codex Timeline projects semantic tags and invalidates cache when sidecar changes', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'timeline-presentation-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-timeline.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  let presentationRevision = 'presentation-1';
  let phase = 'completion';
  let loadCalls = 0;
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
            sessionId: 'session-timeline',
            linkKind: 'end',
          },
        };
      },
      buildCodexTimeline: () => [{
        uuid: 'timeline-row',
        role: 'user',
        content: 'notification',
        timestamp: '2026-07-27T00:00:00.000Z',
      }],
      getTimelineSessionMeta: () => ({ id: 'session-timeline' }),
    },
  };
  const promptPresentationStore = {
    getHistoryPromptPresentationRevision: () => presentationRevision,
    getHistoryPromptPresentations: () => [{
      entryUuid: 'timeline-row',
      auditTimestamp: '2026-07-27T00:00:00.000Z',
      transportHash: 'hash',
      chips: [{ kind: 'orchestration', runId: 'run-1', phase }],
    }],
    getHistoryPromptPresentationsForEntries: () => [],
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
    promptPresentationStore,
  });

  const first = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'session-timeline',
    cwd: dir,
  });
  assert.equal(first.entries[0].semanticTags[0].runId, 'run-1');
  assert.equal(first.entries[0].semanticTags[0].phase, 'completion');

  const unchanged = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'session-timeline',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(loadCalls, 1);

  presentationRevision = 'presentation-2';
  phase = 'failure';
  const refreshed = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'session-timeline',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(refreshed.unchanged, false);
  assert.equal(refreshed.entries[0].semanticTags[0].phase, 'failure');
  assert.notEqual(refreshed.revision.token, first.revision.token);
  assert.equal(loadCalls, 2);
});

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

test('Codex history revision changes when prompt presentation metadata changes', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-presentation-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-a.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  let presentationRevision = 'presentation-1';
  let loadCalls = 0;
  let changePresentationDuringValidation = false;
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
      buildCodexFullHistory: () => [{
        uuid: 'codex-user-session-a-1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-07-24T00:00:00.000Z',
      }],
    },
  };
  // The raced scenario: presentation metadata changes while validation is in
  // flight. The pre-validation read returns the OLD value, the post-validation
  // consistency re-read sees the NEW one. (Previously triggered from
  // findCodexSessionFile; the service now memoizes resolved paths, so the
  // trigger lives in the store getter — the only hook validation still calls.)
  let presentationReads = 0;
  const promptPresentationStore = {
    getHistoryPromptPresentationRevision: () => {
      presentationReads += 1;
      if (changePresentationDuringValidation && presentationReads > 1) {
        changePresentationDuringValidation = false;
        presentationRevision = 'presentation-raced';
      }
      return presentationRevision;
    },
    getHistoryPromptPresentations: () => [],
    getHistoryPromptPresentationsForEntries: () => [],
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
    promptPresentationStore,
  });

  const first = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
  });
  const unchanged = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(loadCalls, 1);

  presentationRevision = 'presentation-2';
  const refreshed = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    ifRevision: first.revision,
  });
  assert.equal(refreshed.unchanged, false);
  assert.equal(loadCalls, 2);
  assert.notEqual(refreshed.revision.token, first.revision.token);

  changePresentationDuringValidation = true;
  presentationReads = 0;
  const raced = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    ifRevision: refreshed.revision,
  });
  assert.equal(raced.unchanged, false);
  assert.equal(loadCalls, 3);
  assert.notEqual(raced.revision.token, refreshed.revision.token);
});

test('Codex history revision changes when response timing binds without a JSONL write', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-timing-revision-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-a.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  let timingRevision = 'timing-pending';
  let timingBound = false;
  let loadCalls = 0;
  const assistantEntry = {
    uuid: 'codex-assistant-session-a-4',
    sourceIdentity: 'codex-assistant:session-a:4',
    role: 'assistant',
    content: 'done',
    timestamp: '2026-07-24T00:00:04.000Z',
    sessionId: 'session-a',
  };
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
      buildCodexFullHistory: () => [assistantEntry],
    },
  };
  const timingStore = {
    getHistoryPromptPresentationRevision: () => 'none',
    getHistoryPromptPresentations: () => [],
    getHistoryPromptPresentationsForEntries: () => [],
    getHistoryResponseTimingRevision: () => timingRevision,
    getPendingHistoryResponseTimings: () => timingBound ? [] : [{
      intervalId: 1,
      tabId: 'tab-a',
      sessionId: 'session-a',
      startTs: Date.parse('2026-07-24T00:00:00.000Z'),
      endTs: Date.parse('2026-07-24T00:00:05.000Z'),
      durationMs: 5_000,
    }],
    bindHistoryResponseTimingEntry: ({ entryUuid }) => {
      assert.equal(entryUuid, assistantEntry.uuid);
      timingBound = true;
      timingRevision = 'timing-bound';
      return true;
    },
    getHistoryResponseTimingsForEntries: () => timingBound ? [{
      intervalId: 1,
      entryUuid: assistantEntry.uuid,
      startTs: Date.parse('2026-07-24T00:00:00.000Z'),
      endTs: Date.parse('2026-07-24T00:00:05.000Z'),
      durationMs: 5_000,
    }] : [],
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
    promptPresentationStore: timingStore,
  });

  const first = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    tabId: 'tab-a',
  });
  assert.equal(first.entries[0].responseTiming.durationMs, 5_000);
  assert.equal(timingBound, true);

  const unchanged = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    tabId: 'tab-a',
    ifRevision: first.revision,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(loadCalls, 1);

  timingRevision = 'timing-rebound';
  const refreshed = await service.getHistory({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    tabId: 'tab-a',
    ifRevision: first.revision,
  });
  assert.equal(refreshed.unchanged, false);
  assert.equal(loadCalls, 2);
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

test('transcript changes notify the main-process proof owner with exact session identity', () => {
  const observed = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    onChanged: (meta) => observed.push(meta),
    claudeData: null,
    codexData: null,
  });
  service._emitChanged({
    toolType: 'claude',
    sessionId: 'session-proof',
    version: 7,
    size: 4096,
    mtimeMs: 1234,
    filePath: '/tmp/session-proof.jsonl',
    consumers: new Map(),
  }, 'fs-watch');

  assert.deepEqual(observed, [{
    type: 'transcript-changed',
    toolType: 'claude',
    sessionId: 'session-proof',
    version: 7,
    size: 4096,
    mtimeMs: 1234,
    filePath: '/tmp/session-proof.jsonl',
    reason: 'fs-watch',
  }]);
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

test('Claude transcript watcher emits appended answer, tool, and exact prompt carriers as live messages', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-live-delta-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  const initial = JSON.stringify({ type: 'user', uuid: 'user-old', message: { role: 'user', content: 'old' } }) + '\n';
  await fs.promises.writeFile(filePath, initial);
  const sent = [];
  const ownerProbes = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    webBroadcast: null,
    resolveClaudePromptOwner: (probe) => {
      ownerProbes.push(probe);
      return probe.record?.uuid === 'queue-noise'
        ? { handoffId: 'history-handoff' }
        : null;
    },
    claudeData: null,
    codexData: null,
  });
  const appended = [
    {
      type: 'assistant',
      uuid: 'assistant-live',
      sessionId: 'session-claude',
      timestamp: '2026-07-28T02:21:17.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'live answer' }] },
    },
    {
      type: 'user',
      uuid: 'tool-result-live',
      sessionId: 'session-claude',
      timestamp: '2026-07-28T02:21:18.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    },
    {
      type: 'queue-operation',
      uuid: 'queue-noise',
      operation: 'enqueue',
      content: 'native queued prompt',
      sessionId: 'session-claude',
      timestamp: '2026-07-28T02:21:19.000Z',
    },
    {
      type: 'attachment',
      uuid: 'queued-command-live',
      sessionId: 'session-claude',
      timestamp: '2026-07-28T02:21:20.000Z',
      attachment: { type: 'queued_command', prompt: 'native queued prompt' },
    },
    {
      type: 'user',
      uuid: 'ordinary-user-live',
      sessionId: 'session-claude',
      timestamp: '2026-07-28T02:21:21.000Z',
      message: { role: 'user', content: 'ordinary native prompt' },
    },
    {
      type: 'user',
      uuid: 'meta-user-noise',
      isMeta: true,
      sessionId: 'session-claude',
      timestamp: '2026-07-28T02:21:22.000Z',
      message: { role: 'user', content: 'internal metadata' },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  await fs.promises.appendFile(filePath, appended);
  const stat = await fs.promises.stat(filePath);
  const state = {
    filePath,
    size: stat.size,
    offset: Buffer.byteLength(initial),
    leftover: '',
    sessionId: 'session-claude',
    consumers: new Map([
      ['history:tab-a', { consumerId: 'history:tab-a', tabId: 'tab-a' }],
      ['timeline:tab-a', { consumerId: 'timeline:tab-a', tabId: 'tab-a' }],
      ['controls:tab-a', { consumerId: 'controls:tab-a', tabId: 'tab-a' }],
    ]),
  };

  await service._broadcastClaudeDelta(state, Buffer.byteLength(initial));

  assert.deepEqual(sent.map((item) => item.channel), [
    'agent-transcript:live-message',
    'agent-transcript:live-message',
    'agent-transcript:live-message',
    'agent-transcript:live-message',
    'agent-transcript:live-message',
  ]);
  assert.deepEqual(sent.map((item) => item.payload.message.uuid), [
    'assistant-live',
    'tool-result-live',
    'queue-noise',
    'queued-command-live',
    'ordinary-user-live',
  ]);
  assert.equal(sent[0].payload.toolType, 'claude');
  assert.equal(sent[0].payload.tabId, 'tab-a');
  assert.equal(sent[2].payload.promptOwner.handoffId, 'history-handoff');
  assert.equal(Number.isFinite(sent[2].payload.recordByteOffset), true);
  assert.equal(ownerProbes.length, 3);
  assert.equal(ownerProbes[0].tabId, 'tab-a');
  assert.equal(Number.isFinite(ownerProbes[0].recordByteOffset), true);
});

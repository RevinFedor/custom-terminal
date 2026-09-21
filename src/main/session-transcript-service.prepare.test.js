'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { SessionTranscriptService } = require('./session-transcript-service');

test('preparation diagnostics isolate synchronous stages and preserve full/delta response semantics', async t => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(message));
  let version = 1;
  const rows = [
    { uuid: 'u1', sessionId: 'fixture', role: 'user', content: 'PRIVATE_CANARY', timestamp: '2026-09-19T16:00:00Z' },
    { uuid: 'a1', sessionId: 'fixture', role: 'assistant', content: 'answer' },
  ];
  const service = new SessionTranscriptService({
    getMainWindow: () => null, claudeData: null,
    codexData: { _api: { projectCodexFullHistoryFromFile: async () => {
      await new Promise(resolve => setImmediate(resolve));
      return { success: true, entries: rows, filePath: '/fixture/rollout',
        sourceSnapshot: { filePath: '/fixture/rollout', size: version, mtimeMs: version,
          sessionId: 'fixture', linkKind: 'end' } };
    } } },
    promptPresentationStore: { getHistoryPromptPresentations() {
      // Make one real synchronous stage measurable; no production DB/JSONL.
      const until = performance.now() + 28;
      while (performance.now() < until) {}
      return [];
    } },
  });
  const request = { toolType: 'codex', sessionId: 'fixture', tabId: 'tab-fixture', dehydrate: true, deltaOk: true };
  const first = await service.getHistory(request);
  version++;
  const second = await service.getHistory({ ...request, ifRevision: first.revision });
  assert.equal(first.success, true); assert.equal(first.entries.length, 2);
  assert.equal(second.delta, true); assert.deepEqual(second.changedEntries, []);
  const traces = logs.filter(line => line.startsWith('[TranscriptService:HistoryPrepare] '))
    .map(line => JSON.parse(line.slice('[TranscriptService:HistoryPrepare] '.length)));
  assert.deepEqual(traces.map(trace => trace.shape), ['full', 'delta']);
  for (const trace of traces) {
    assert.equal(trace.rows, 2);
    assert.ok(trace.phases.promptPresentation >= 27);
    for (const phase of ['dehydrate', 'responseTiming', 'revision', 'rowWindow', 'entryWindow', 'digest']) {
      assert.ok(Number.isFinite(trace.phases[phase]), phase);
    }
    assert.ok(trace.startAbs <= trace.endAbs);
    assert.ok(Math.abs(trace.endAbs - trace.startAbs - trace.syncMs) < 0.2);
    assert.ok(!JSON.stringify(trace).includes('PRIVATE_CANARY'));
  }
});

test('desktop history forwards the exact normalized row window to serialized metadata preparation', async () => {
  let received;
  const service = new SessionTranscriptService({
    getMainWindow: () => null, claudeData: null,
    codexData: { _api: { projectCodexFullHistoryFromFile: async (sessionId, cwd, options) => {
      received = { sessionId, cwd, options };
      return { success: true, entries: [{ uuid: 'u1', role: 'user', content: 'one' }],
        filePath: '/fixture/rollout', sourceSnapshot: { filePath: '/fixture/rollout', size: 1,
          mtimeMs: 1, sessionId, linkKind: 'end' } };
    } } },
  });
  const result = await service.getHistory({ toolType: 'codex', sessionId: 'fixture', cwd: '/fixture',
    tabId: 'tab-fixture', dehydrate: true, hydrate: { centerUuid: 'u1', radius: 3 } });
  assert.equal(result.success, true);
  assert.deepEqual(received, { sessionId: 'fixture', cwd: '/fixture', options: {
    cacheOnly: false, hydrate: { centerUuid: 'u1', radius: 3, alwaysHydrateTail: 200 },
  } });
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const codexData = require('./ipc/codex-data');
const { hashFileSegment } = require('./codex-virtual-transcript');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { SessionTranscriptService } = require('./session-transcript-service');

const SOURCE = '01a02eb0-f7dc-7910-9969-1bffae88d8d3';
const CHILD = '01a02ed8-e41e-7522-97ad-dedf6e7233ac';

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const meta = (id, parent = null) => ({
  type: 'session_meta',
  timestamp: '2026-08-23T13:00:00.000Z',
  payload: { id, cwd: '/fixture', ...(parent ? { forked_from_id: parent } : {}) },
});
const settings = () => ({ type: 'event_msg', payload: { type: 'thread_settings_applied' } });
const turn = (text, n) => [
  { type: 'event_msg', payload: { type: 'task_started', started_at: 1787490000 + n } },
  { type: 'event_msg', timestamp: `2026-08-23T13:00:0${n}.000Z`, payload: { type: 'user_message', message: text } },
  {
    type: 'response_item',
    timestamp: `2026-08-23T13:00:0${n}.500Z`,
    payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'answer-' + n }],
    },
  },
  { type: 'event_msg', payload: { type: 'task_complete' } },
];

test('SessionTranscriptService projects exact source prefix and child tail through every read surface', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-virtual-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const sourceRecords = [meta(SOURCE), settings(), ...turn('same prompt', 1), ...turn('same prompt', 2)];
  const childPrelude = [meta(CHILD, SOURCE), settings()];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));
  const sourceStat = await fs.promises.stat(sourcePath);
  const sourceDigest = await hashFileSegment(sourcePath, 0, sourceStat.size);
  const childStat = await fs.promises.stat(childPath);
  const childPrefixDigest = await hashFileSegment(childPath, 0, childStat.size);
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    sourceSegments: [{
      physicalSessionId: SOURCE,
      fromByte: 0,
      toByte: sourceStat.size,
      startLine: 0,
      endLine: sourceRecords.length,
      prefixDigest: sourceDigest.sha256,
    }],
    childTailStart: {
      byteOffset: childStat.size,
      line: childPrelude.length,
      prefixDigest: childPrefixDigest.sha256,
    },
  });
  const event = {
    eventKey: `fork:codex:${SOURCE}:${CHILD}`,
    eventType: 'fork',
    provider: 'codex',
    sessionId: CHILD,
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    snapshotComplete: true,
    isDirect: true,
    origin: 'app',
    lineageManifest: manifest,
  };
  const paths = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: {
      _api: {
        ...codexData._api,
        findCodexSessionFile: async (sessionId) => (
          paths.has(sessionId) ? { filePath: paths.get(sessionId) } : null
        ),
      },
    },
    sessionHistoryStore: {
      getSessionHistoryEvents: (sessionId) => sessionId === CHILD ? [event] : [],
    },
  });
  const base = { toolType: 'codex', sessionId: CHILD, cwd: dir, tabId: 'tab-678' };

  const timeline = await service.getTimeline(base);
  assert.equal(timeline.success, true);
  assert.equal(timeline.composite, true);
  assert.equal(timeline.viewOwnerSessionId, CHILD);
  assert.equal(timeline.entries.filter((entry) => entry.type === 'user').length, 2);
  assert.equal(timeline.entries.every((entry) => entry.physicalSessionId === SOURCE), true);
  assert.equal(new Set(timeline.entries.map((entry) => entry.uuid)).size, timeline.entries.length);

  const firstUser = timeline.entries.find((entry) => entry.type === 'user');
  const sourceCopy = await service.copyCodexVirtualRange({
    sessionId: CHILD,
    cwd: dir,
    expectedContentRevision: timeline.contentRevision,
    startEntryRef: firstUser.entryRef,
    endEntryRef: firstUser.entryRef,
  });
  assert.equal(sourceCopy.success, true);
  assert.match(sourceCopy.content, /same prompt/);

  const history = await service.getHistory({
    ...base,
    dehydrate: true,
    deltaOk: true,
    hydrate: { centerUuid: timeline.entries[0].uuid, radius: 1, alwaysHydrateTail: 1 },
  });
  assert.equal(history.success, true);
  assert.ok(history.entries.length > 0);
  assert.equal(history.composite, true);
  assert.ok(history.contentRevision);
  assert.equal(history.entries.every((entry) => (
    entry.entryRef?.viewOwnerSessionId === CHILD
      && entry.entryRef?.physicalSessionId === SOURCE
      && entry.entryRef?.contentRevision === history.contentRevision
  )), true, 'hydrated rows and identity stubs keep exact composite addressing');

  const sourceSearch = await service.searchHistory({ ...base, query: 'answer-2' });
  assert.equal(sourceSearch.success, true);
  assert.equal(sourceSearch.total, 1);
  assert.equal(sourceSearch.matches[0].physicalSessionId, SOURCE);

  await fs.promises.appendFile(childPath, jsonl(turn('child prompt', 3)));
  const appended = await service.getHistory({
    ...base,
    dehydrate: true,
    deltaOk: true,
    ifRevision: history.revision,
    hydrate: { centerUuid: timeline.entries[0].uuid, radius: 1, alwaysHydrateTail: 1 },
  });
  assert.equal(appended.success, true);
  assert.equal(appended.delta, true);
  assert.notEqual(appended.contentRevision, history.contentRevision);
  assert.equal(appended.changedEntries.some((entry) => entry.physicalSessionId === CHILD), true);
  assert.equal(appended.changedEntries.some((entry) => (
    entry.physicalSessionId === SOURCE && !entry.rowStub
  )), false, 'source rows are reused rather than resent as new physical rows');

  const staleTarget = await service.resolveCodexPhysicalRow({
    sessionId: CHILD,
    cwd: dir,
    expectedContentRevision: history.contentRevision,
    entryRef: timeline.entries[0].entryRef,
  });
  assert.equal(staleTarget.success, false);
  assert.equal(staleTarget.error, 'stale_transcript_revision');

  const currentTimeline = await service.getTimeline(base);
  const inheritedTarget = currentTimeline.entries.find((entry) => entry.type === 'user');
  const childTarget = [...currentTimeline.entries].reverse().find((entry) => entry.type === 'user');
  const resolvedTarget = await service.resolveCodexPhysicalRow({
    sessionId: CHILD,
    cwd: dir,
    expectedContentRevision: currentTimeline.contentRevision,
    entryRef: inheritedTarget.entryRef,
  });
  assert.equal(resolvedTarget.success, true);
  assert.equal(resolvedTarget.entry.physicalSessionId, SOURCE);

  const staleCopy = await service.copyCodexVirtualRange({
    sessionId: CHILD,
    cwd: dir,
    expectedContentRevision: timeline.contentRevision,
    startEntryRef: inheritedTarget.entryRef,
    endEntryRef: childTarget.entryRef,
  });
  assert.equal(staleCopy.error, 'stale_transcript_revision');
  const crossSegmentCopy = await service.copyCodexVirtualRange({
    sessionId: CHILD,
    cwd: dir,
    expectedContentRevision: currentTimeline.contentRevision,
    startEntryRef: inheritedTarget.entryRef,
    endEntryRef: childTarget.entryRef,
  });
  assert.equal(crossSegmentCopy.success, true);
  assert.match(crossSegmentCopy.content, /same prompt/);
  assert.match(crossSegmentCopy.content, /child prompt/);

  const childSearch = await service.searchHistory({ ...base, query: 'answer-3' });
  assert.equal(childSearch.total, 1);
  assert.equal(childSearch.matches[0].physicalSessionId, CHILD);

  await fs.promises.appendFile(sourcePath, jsonl(turn('future source append', 4)));
  const sourceGrowthIgnored = await service.getTimeline({ ...base, ifRevision: currentTimeline.revision });
  assert.equal(sourceGrowthIgnored.unchanged, true,
    'a source append after fork does not change the child composite revision');
});

test('legacy metadata-only child fails closed instead of source fallback or empty success', async () => {
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: {
      _api: {
        projectCodexTimelineFromFile: async () => ({
          success: true,
          entries: [],
          sessionMeta: { id: CHILD, forked_from_id: SOURCE },
          filePath: '/tmp/child.jsonl',
          sourceSnapshot: { filePath: '/tmp/child.jsonl', size: 1, mtimeMs: 1, sessionId: CHILD },
        }),
      },
    },
    sessionHistoryStore: {
      getSessionHistoryEvents: () => [{
        eventKey: `fork:codex:${SOURCE}:${CHILD}`,
        eventType: 'fork',
        provider: 'codex',
        sessionId: CHILD,
        sourceSessionId: SOURCE,
        childSessionId: CHILD,
        snapshotComplete: true,
        isDirect: true,
        entryUuids: ['legacy-only'],
      }],
    },
  });
  const result = await service.getTimeline({ toolType: 'codex', sessionId: CHILD, cwd: '/tmp' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'lineage_unresolved');
});

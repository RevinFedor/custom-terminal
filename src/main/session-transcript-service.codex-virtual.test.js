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
const GRAND = '01a02d00-1111-7111-8111-111111111111';

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const meta = (id, parent = null, extras = {}) => ({
  type: 'session_meta',
  timestamp: '2026-08-23T13:00:00.000Z',
  payload: {
    id,
    cwd: '/fixture',
    ...(parent ? { forked_from_id: parent } : {}),
    ...extras,
  },
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

  // Overview callers intentionally avoid retaining virtual raw records; an
  // addressable evidence pull must explicitly request the composite source.
  const overviewSource = await service.loadCodexOperationSource({
    sessionId: CHILD,
    cwd: dir,
    includeRecords: false,
  });
  assert.equal(overviewSource.success, true);
  assert.equal(overviewSource.composite, true);
  assert.equal(overviewSource.records, undefined);
  const evidenceSource = await service.loadCodexOperationSource({
    sessionId: CHILD,
    cwd: dir,
    includeRecords: true,
  });
  assert.equal(evidenceSource.success, true);
  assert.equal(evidenceSource.composite, true);
  assert.ok(Array.isArray(evidenceSource.records));
  assert.equal(evidenceSource.records.some((record) => record.__physicalSessionId === SOURCE), true);
  const evidenceUser = timeline.entries.find((entry) => entry.type === 'user');
  const evidence = codexData._api.buildCodexTurnEvidence(evidenceSource.records, CHILD, {
    userUuid: evidenceUser.uuid,
    providerTurnIndex: evidenceUser.turnIndex,
  });
  assert.equal(evidence.found, true, 'evidence resolves the selected user from the composite source, not child disk alone');
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
  const inheritedUsers = currentTimeline.entries.filter((entry) => entry.type === 'user');
  const inheritedTarget = inheritedUsers[0];
  const childTarget = [...currentTimeline.entries].reverse().find((entry) => entry.type === 'user');
  const resolvedTarget = await service.resolveCodexPhysicalRow({
    sessionId: CHILD,
    cwd: dir,
    expectedContentRevision: currentTimeline.contentRevision,
    entryRef: inheritedTarget.entryRef,
  });
  assert.equal(resolvedTarget.success, true);
  assert.equal(resolvedTarget.entry.physicalSessionId, SOURCE);

  const inheritedRewindTarget = inheritedUsers[1];
  const inheritedSnapshot = await service.captureCodexRewindSourceSnapshot({
    viewSessionId: CHILD,
    physicalSessionId: SOURCE,
    targetSourceLine: inheritedRewindTarget.sourceLine,
    cwd: dir,
  });
  assert.equal(inheritedSnapshot.sourceSessionId, CHILD);
  assert.equal(inheritedSnapshot.targetPhysicalSessionId, SOURCE);
  assert.equal(inheritedSnapshot.nextIterationIndex, 1);
  const rewindGrandchildId = '01a02ed8-e41e-7522-97ad-dedf6e7233ae';
  const rewindGrandchildPath = path.join(dir, rewindGrandchildId + '.jsonl');
  await fs.promises.writeFile(rewindGrandchildPath, jsonl([
    meta(rewindGrandchildId, CHILD, { history_mode: 'paginated' }),
    settings(),
  ]));
  paths.set(rewindGrandchildId, rewindGrandchildPath);
  const inheritedPrepared = await service.prepareCodexRewindLineageFromSnapshot({
    snapshot: inheritedSnapshot,
    childSessionId: rewindGrandchildId,
    childTabId: 'tab-inherited-rewind',
    cwd: dir,
  });
  assert.equal(inheritedPrepared.success, true);
  assert.equal(inheritedPrepared.event.sourceSessionId, CHILD);
  assert.deepEqual(
    inheritedPrepared.event.lineageManifest.sourceSegments.map((segment) => segment.physicalSessionId),
    [SOURCE],
    'the view owner and physical target remain separate across nested Rewind',
  );

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
  assert.match(crossSegmentCopy.content, new RegExp('Session: ' + CHILD));
  assert.match(crossSegmentCopy.content, new RegExp('Forked from: ' + SOURCE));
  assert.match(crossSegmentCopy.content, /same prompt/);
  assert.match(crossSegmentCopy.content, /child prompt/);
  const fullExport = await service.exportCodexSession({
    sessionId: CHILD,
    cwd: dir,
  });
  assert.equal(fullExport.success, true);
  assert.equal(fullExport.composite, true);
  assert.match(fullExport.content, /same prompt/);
  assert.match(fullExport.content, /child prompt/);

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

test('provider paginated history_base recovers an exact manifest before the first child turn', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-provider-lineage-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const retainedSource = [meta(SOURCE), settings(), ...turn('retained source prompt', 1)];
  const discardedSource = turn('discarded source prompt', 2);
  const sourceBoundary = Buffer.byteLength(jsonl(retainedSource));
  const childPrelude = [meta(CHILD, SOURCE, {
    history_mode: 'paginated',
    forked_from_ordinal_exclusive: 7,
    history_base: {
      thread_id: SOURCE,
      end_ordinal_exclusive: 7,
      end_byte_offset: sourceBoundary,
    },
  }), settings()];
  await fs.promises.writeFile(sourcePath, jsonl([...retainedSource, ...discardedSource]));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));

  const paths = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  let forkEvent = {
    eventKey: `fork:codex:${SOURCE}:${CHILD}`,
    eventType: 'fork',
    provider: 'codex',
    sessionId: CHILD,
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    snapshotComplete: false,
    isDirect: true,
    origin: 'transcript',
    forkMode: 'unknown',
    entryUuids: [],
  };
  let lineageSaveCount = 0;
  const sessionHistoryStore = {
    getSessionHistoryEvents: (sessionId) => sessionId === CHILD ? [forkEvent] : [],
    saveSessionForkEvent: (event) => {
      lineageSaveCount += 1;
      forkEvent = { ...forkEvent, ...event, eventKey: forkEvent.eventKey };
      return forkEvent;
    },
  };
  const makeService = () => new SessionTranscriptService({
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
    sessionHistoryStore,
  });

  const service = makeService();
  const base = { toolType: 'codex', sessionId: CHILD, cwd: dir, tabId: 'tab-native-rewind' };
  const [beforeFirstTurn, recoveredHistory] = await Promise.all([
    service.getTimeline(base),
    service.getHistory({ ...base, dehydrate: true }),
  ]);
  assert.equal(beforeFirstTurn.success, true);
  assert.equal(beforeFirstTurn.composite, true);
  assert.deepEqual(
    beforeFirstTurn.entries.filter((entry) => entry.type === 'user').map((entry) => entry.content),
    ['retained source prompt'],
  );
  assert.equal(forkEvent.origin, 'transcript');
  assert.equal(forkEvent.operationKind, 'provider');
  assert.equal(forkEvent.snapshotComplete, true);
  assert.ok(forkEvent.lineageManifest);
  assert.equal(forkEvent.lineageManifest.sourceSegments[0].toByte, sourceBoundary);
  assert.equal(lineageSaveCount, 1, 'History and Timeline share one lineage recovery flight');
  assert.equal(recoveredHistory.success, true);
  assert.equal(recoveredHistory.composite, true);
  const recoveredSearch = await service.searchHistory({
    ...base,
    query: 'retained source',
  });
  assert.equal(recoveredSearch.total, 1);
  const recoveredExport = await service.exportCodexSession({
    sessionId: CHILD,
    cwd: dir,
  });
  assert.match(recoveredExport.content, /retained source prompt/);
  assert.doesNotMatch(recoveredExport.content, /discarded source prompt/);

  await fs.promises.appendFile(childPath, jsonl(turn('first child prompt', 3)));
  const afterColdReopen = await makeService().getTimeline(base);
  assert.equal(afterColdReopen.success, true);
  assert.deepEqual(
    afterColdReopen.entries.filter((entry) => entry.type === 'user').map((entry) => entry.content),
    ['retained source prompt', 'first child prompt'],
    'a first child turn appends to the recovered prefix instead of replacing it',
  );
  assert.equal(
    afterColdReopen.entries.some((entry) => entry.content === 'discarded source prompt'),
    false,
  );
});

test('invalid provider history_base stays lineage_unresolved after the child gains rows', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-provider-lineage-invalid-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  await fs.promises.writeFile(sourcePath, jsonl([meta(SOURCE), settings(), ...turn('source', 1)]));
  await fs.promises.writeFile(childPath, jsonl([
    meta(CHILD, SOURCE, {
      history_mode: 'paginated',
      forked_from_ordinal_exclusive: 7,
      history_base: {
        thread_id: 'different-parent',
        end_ordinal_exclusive: 7,
        end_byte_offset: 100,
      },
    }),
    settings(),
    ...turn('child-only prompt', 2),
  ]));
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
      getSessionHistoryEvents: () => [{
        eventKey: `fork:codex:${SOURCE}:${CHILD}`,
        eventType: 'fork',
        provider: 'codex',
        sessionId: CHILD,
        sourceSessionId: SOURCE,
        childSessionId: CHILD,
        snapshotComplete: true,
        isDirect: true,
        origin: 'transcript',
        forkMode: 'unknown',
        entryUuids: [],
      }],
      saveSessionForkEvent: () => {
        throw new Error('invalid lineage must never be persisted');
      },
    },
  });

  const result = await service.getTimeline({
    toolType: 'codex', sessionId: CHILD, cwd: dir, tabId: 'tab-invalid-lineage',
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'lineage_unresolved');
  assert.equal(result.lineageReason, 'provider-history-base-invalid');
});

test('durable pre-Enter snapshot reconstructs a paginated Rewind child without provider history_base', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-rewind-snapshot-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const sourceRecords = [
    meta(SOURCE),
    settings(),
    ...turn('retained source prompt', 1),
    ...turn('discarded source prompt', 2),
  ];
  const childPrelude = [
    meta(CHILD, SOURCE, { history_mode: 'paginated' }),
    settings(),
  ];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));
  const paths = new Map([[SOURCE, sourcePath], [CHILD, childPath]]);
  const testCodexData = {
    _api: {
      ...codexData._api,
      findCodexSessionFile: async (sessionId) => (
        paths.has(sessionId) ? { filePath: paths.get(sessionId) } : null
      ),
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: testCodexData,
    sessionHistoryStore: { getSessionHistoryEvents: () => [] },
  });
  const discardedUserLine = sourceRecords.findIndex((record) => (
    record?.payload?.type === 'user_message'
    && record.payload.message === 'discarded source prompt'
  ));
  const snapshot = await service.captureCodexRewindSourceSnapshot({
    viewSessionId: SOURCE,
    physicalSessionId: SOURCE,
    targetSourceLine: discardedUserLine,
    cwd: dir,
  });
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.targetPhysicalSessionId, SOURCE);
  assert.equal(snapshot.targetSourceLine, discardedUserLine);
  assert.equal(snapshot.nextIterationIndex, 1);

  const prepared = await service.prepareCodexRewindLineageFromSnapshot({
    snapshot,
    childSessionId: CHILD,
    childTabId: 'tab-rewind-snapshot',
    cwd: dir,
  });
  assert.equal(prepared.required, true);
  assert.equal(prepared.success, true);
  assert.equal(prepared.storageMode, 'virtual');
  assert.equal(prepared.event.operationKind, 'rewind');
  assert.equal(prepared.event.lineageManifest.sourceSessionId, SOURCE);
  assert.equal(prepared.event.lineageManifest.childSessionId, CHILD);
  assert.equal(prepared.event.nextIterationIndex, 1);

  const corrupted = jsonl(sourceRecords).replace('retained source prompt', 'corrupted source prompt');
  await fs.promises.writeFile(sourcePath, corrupted);
  const rejected = await service.prepareCodexRewindLineageFromSnapshot({
    snapshot,
    childSessionId: CHILD,
    childTabId: 'tab-rewind-snapshot',
    cwd: dir,
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.reason, 'rewind-source-snapshot-digest-changed');
});

test('native Codex Fork distinguishes self-contained rollout from paginated thin child', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-native-fork-snapshot-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const materializedChildPath = path.join(dir, CHILD + '.jsonl');
  const paginatedChildId = '01a02ed8-e41e-7522-97ad-dedf6e7233ad';
  const paginatedChildPath = path.join(dir, paginatedChildId + '.jsonl');
  const copiedTurn = turn('copied source prompt', 1);
  copiedTurn.splice(2, 0, { type: 'response_item', timestamp: '2026-08-23T13:00:01.200Z',
    payload: { type: 'reasoning', id: 'reasoning-source', summary: [], encrypted_content: 'sealed-reasoning' } });
  const compactRecord = { type: 'compacted', timestamp: '2026-08-23T13:00:02.000Z',
    payload: { message: 'retained compact', encrypted_content: 'sealed-context' } };
  const sourceRecords = [meta(SOURCE), settings(), ...copiedTurn, compactRecord];
  const materializedChildRecords = [
    meta(CHILD, SOURCE, { history_mode: 'legacy' }),
    settings(),
    ...[...copiedTurn, compactRecord].map((record) => ({ ...record,
      timestamp: '2026-08-23T14:00:00.000Z',
      payload: record.payload?.type === 'reasoning'
        ? { ...record.payload, content: null } : record.payload,
    })),
  ];
  const paginatedChildRecords = [
    meta(paginatedChildId, SOURCE, { history_mode: 'paginated' }),
    settings(),
  ];
  await fs.promises.writeFile(sourcePath, jsonl(sourceRecords));
  await fs.promises.writeFile(materializedChildPath, jsonl(materializedChildRecords));
  await fs.promises.writeFile(paginatedChildPath, jsonl(paginatedChildRecords));
  const paths = new Map([
    [SOURCE, sourcePath],
    [CHILD, materializedChildPath],
    [paginatedChildId, paginatedChildPath],
  ]);
  const loadSessionRecords = async (sessionId) => {
    const filePath = paths.get(sessionId);
    if (!filePath) return { success: false, error: 'missing' };
    const stat = await fs.promises.stat(filePath);
    const parsed = await codexData._api.readJsonlRange(filePath, 0, stat.size - 1);
    return {
      success: parsed.errors === 0 && parsed.leftoverBuffer.length === 0,
      records: parsed.records,
      filePath,
      sourceSnapshot: { filePath, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  };
  const testCodexData = {
    _api: {
      ...codexData._api,
      findCodexSessionFile: async (sessionId) => (
        paths.has(sessionId) ? { filePath: paths.get(sessionId) } : null
      ),
      loadSessionRecords,
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: testCodexData,
    sessionHistoryStore: { getSessionHistoryEvents: () => [] },
  });
  const loadedSource = await loadSessionRecords(SOURCE);
  const snapshot = await service.captureCodexForkSourceSnapshot({
    sessionId: SOURCE,
    cwd: dir,
    loaded: loadedSource,
  });

  const materialized = await service.prepareCodexNativeForkLineageFromSnapshot({
    snapshot,
    childSessionId: CHILD,
    childTabId: 'tab-native-fork-full',
    cwd: dir,
  });
  assert.equal(materialized.success, true);
  assert.equal(materialized.storageMode, 'materialized');
  assert.equal(materialized.event.operationKind, 'fork');
  assert.equal(materialized.event.forkMode, 'full');
  assert.equal(materialized.event.lineageManifest, undefined);
  assert.ok(materialized.event.entryUuids.length > 0);

  const materializedRewind = await service.prepareCodexRewindLineageFromSnapshot({
    snapshot, childSessionId: CHILD, childTabId: 'tab-native-rewind-full', cwd: dir,
  });
  assert.equal(materializedRewind.required, true,
    'a full native Rewind child still needs its causal event before writer publication');
  assert.equal(materializedRewind.success, true);
  assert.equal(materializedRewind.storageMode, 'materialized');
  assert.equal(materializedRewind.event.operationKind, 'rewind');
  assert.equal(materializedRewind.event.forkMode, 'rewind');
  assert.equal(materializedRewind.event.snapshotComplete, true);
  assert.deepEqual(materializedRewind.event.entryUuids, materialized.event.entryUuids);

  await fs.promises.writeFile(materializedChildPath, jsonl([
    ...materializedChildRecords, ...turn('post-discovery child turn', 3),
  ]));
  const withSuffix = await service.prepareCodexNativeForkLineageFromSnapshot({
    snapshot, childSessionId: CHILD, cwd: dir,
  });
  assert.equal(withSuffix.success, true);
  assert.deepEqual(withSuffix.event.entryUuids, materialized.event.entryUuids,
    'a late child suffix must not move the original Fork boundary');

  for (const changedCarrier of ['assistant', 'compact']) {
    await fs.promises.writeFile(materializedChildPath, jsonl(materializedChildRecords.map((record) => {
      if (changedCarrier === 'assistant' && record.payload?.role === 'assistant') {
        return { ...record, payload: { ...record.payload, content: [{ type: 'output_text', text: 'wrong answer' }] } };
      }
      if (changedCarrier === 'compact' && record.type === 'compacted') {
        return { ...record, payload: { ...record.payload, encrypted_content: 'different-context' } };
      }
      return record;
    })));
    const altered = await service.prepareCodexRewindLineageFromSnapshot({ snapshot, childSessionId: CHILD, cwd: dir });
    assert.equal(altered.success, false, 'same prompts do not prove preserved ' + changedCarrier);
    assert.equal(altered.reason, 'rewind-materialized-prefix-mismatch');
  }

  await fs.promises.writeFile(materializedChildPath, jsonl([
    meta(CHILD, SOURCE, { history_mode: 'legacy' }), settings(),
    ...turn('different prompt with the same turn count', 1),
  ]));
  const wrongPrefix = await service.prepareCodexRewindLineageFromSnapshot({
    snapshot, childSessionId: CHILD, cwd: dir,
  });
  assert.equal(wrongPrefix.success, false, 'turn count alone is not a copied-prefix proof');
  assert.equal(wrongPrefix.reason, 'rewind-materialized-prefix-mismatch');

  const differentImage = materializedChildRecords.map((record) => (
    record.payload?.type === 'user_message'
      ? { ...record, payload: { ...record.payload, local_images: ['/fixture/different.png'] } }
      : record
  ));
  await fs.promises.writeFile(materializedChildPath, jsonl(differentImage));
  const wrongImage = await service.prepareCodexRewindLineageFromSnapshot({
    snapshot, childSessionId: CHILD, cwd: dir,
  });
  assert.equal(wrongImage.success, false, 'same text with a different image cannot prove the prefix');
  assert.equal(wrongImage.reason, 'rewind-materialized-prefix-mismatch');

  const paginated = await service.prepareCodexNativeForkLineageFromSnapshot({
    snapshot,
    childSessionId: paginatedChildId,
    childTabId: 'tab-native-fork-thin',
    cwd: dir,
  });
  assert.equal(paginated.success, true);
  assert.equal(paginated.storageMode, 'virtual');
  assert.equal(paginated.event.operationKind, 'fork');
  assert.equal(paginated.event.forkMode, 'direct-virtual');
  assert.ok(paginated.event.lineageManifest);
});

test('provider history_base flattens an already-virtual source at the exact parent byte boundary', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-provider-nested-lineage-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const grandPath = path.join(dir, GRAND + '.jsonl');
  const sourcePath = path.join(dir, SOURCE + '.jsonl');
  const childPath = path.join(dir, CHILD + '.jsonl');
  const grandRecords = [meta(GRAND), settings(), ...turn('grand retained prompt', 1)];
  const sourcePrelude = [meta(SOURCE, GRAND), settings()];
  const sourceRetained = turn('parent retained prompt', 2);
  const sourceDiscarded = turn('parent discarded prompt', 3);
  const childPrelude = [meta(CHILD, SOURCE, {
    history_mode: 'paginated',
    forked_from_ordinal_exclusive: 12,
    history_base: {
      thread_id: SOURCE,
      end_ordinal_exclusive: 12,
      end_byte_offset: Buffer.byteLength(jsonl([...sourcePrelude, ...sourceRetained])),
    },
  }), settings()];
  await fs.promises.writeFile(grandPath, jsonl(grandRecords));
  await fs.promises.writeFile(sourcePath, jsonl([...sourcePrelude, ...sourceRetained, ...sourceDiscarded]));
  await fs.promises.writeFile(childPath, jsonl(childPrelude));

  const grandStat = await fs.promises.stat(grandPath);
  const grandDigest = await hashFileSegment(grandPath, 0, grandStat.size);
  const sourcePreludeSize = Buffer.byteLength(jsonl(sourcePrelude));
  const sourcePreludeDigest = await hashFileSegment(sourcePath, 0, sourcePreludeSize);
  const parentManifest = buildCodexForkLineageManifest({
    sourceSessionId: GRAND,
    childSessionId: SOURCE,
    sourceSegments: [{
      physicalSessionId: GRAND,
      fromByte: 0,
      toByte: grandStat.size,
      startLine: 0,
      endLine: grandRecords.length,
      prefixDigest: grandDigest.sha256,
    }],
    childTailStart: {
      byteOffset: sourcePreludeSize,
      line: sourcePrelude.length,
      prefixDigest: sourcePreludeDigest.sha256,
    },
  });
  const parentEvent = {
    eventKey: `fork:codex:${GRAND}:${SOURCE}`,
    eventType: 'fork',
    provider: 'codex',
    sessionId: SOURCE,
    sourceSessionId: GRAND,
    childSessionId: SOURCE,
    snapshotComplete: true,
    isDirect: true,
    origin: 'app',
    forkMode: 'direct-virtual',
    lineageManifest: parentManifest,
    entryUuids: [],
  };
  let childEvent = {
    eventKey: `fork:codex:${SOURCE}:${CHILD}`,
    eventType: 'fork',
    provider: 'codex',
    sessionId: CHILD,
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    snapshotComplete: false,
    isDirect: true,
    origin: 'transcript',
    forkMode: 'unknown',
    entryUuids: [],
  };
  const paths = new Map([[GRAND, grandPath], [SOURCE, sourcePath], [CHILD, childPath]]);
  const store = {
    getSessionHistoryEvents: (sessionId) => {
      if (sessionId === SOURCE) return [parentEvent];
      if (sessionId === CHILD) return [childEvent];
      return [];
    },
    saveSessionForkEvent: (event) => {
      childEvent = { ...childEvent, ...event, eventKey: childEvent.eventKey };
      return childEvent;
    },
  };
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
    sessionHistoryStore: store,
  });

  const timeline = await service.getTimeline({
    toolType: 'codex', sessionId: CHILD, cwd: dir, tabId: 'tab-nested-native-rewind',
  });
  assert.equal(timeline.success, true);
  assert.deepEqual(
    timeline.entries.filter((entry) => entry.type === 'user').map((entry) => entry.content),
    ['grand retained prompt', 'parent retained prompt'],
  );
  assert.deepEqual(
    childEvent.lineageManifest.sourceSegments.map((segment) => segment.physicalSessionId),
    [GRAND, SOURCE],
  );
  assert.equal(
    timeline.entries.some((entry) => entry.content === 'parent discarded prompt'),
    false,
  );
});

test('real tab-678 637-record source and two-record child become non-empty at writer-ready', async (t) => {
  const sourceLoaded = await codexData._api.loadSessionRecords(
    SOURCE,
    '/Users/fedor/Desktop/sc-desktop',
  );
  const childLoaded = await codexData._api.loadSessionRecords(
    CHILD,
    '/Users/fedor/Desktop/sc-desktop',
  );
  if (!sourceLoaded?.success || !childLoaded?.success) {
    t.skip('production tab-678 fixture is not present on this machine');
    return;
  }
  assert.equal(sourceLoaded.records.length, 637);
  assert.equal(childLoaded.records.length, 2);

  const captureService = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
    sessionHistoryStore: { getSessionHistoryEvents: () => [] },
  });
  const sourceSnapshot = await captureService.captureCodexForkSourceSnapshot({
    sessionId: SOURCE,
    cwd: '/Users/fedor/Desktop/sc-desktop',
    loaded: sourceLoaded,
  });
  const childTailStart = await captureService.captureCodexForkChildTailStart({
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    cwd: '/Users/fedor/Desktop/sc-desktop',
  });
  assert.equal(sourceSnapshot.sourceSegments[0].toByte, 7067455);
  assert.deepEqual(
    { byteOffset: childTailStart.byteOffset, line: childTailStart.line },
    { byteOffset: 19336, line: 2 },
  );
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId: SOURCE,
    childSessionId: CHILD,
    sourceSegments: sourceSnapshot.sourceSegments,
    childTailStart,
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
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
    sessionHistoryStore: { getSessionHistoryEvents: () => [event] },
  });
  const timeline = await service.getTimeline({
    toolType: 'codex', sessionId: CHILD, cwd: '/Users/fedor/Desktop/sc-desktop', tabId: 'tab-678',
  });
  const history = await service.getHistory({
    toolType: 'codex', sessionId: CHILD, cwd: '/Users/fedor/Desktop/sc-desktop', tabId: 'tab-678',
    dehydrate: true,
  });
  assert.equal(timeline.success, true);
  assert.ok(timeline.entries.length > 0);
  assert.equal(history.success, true);
  assert.ok(history.entries.length > 0);
  assert.equal(timeline.entries.every((entry) => entry.viewOwnerSessionId === CHILD), true);
  assert.equal(timeline.entries.every((entry) => entry.physicalSessionId === SOURCE), true);
});

test('real tab-34 native Rewind history_base reconstructs its virtual parent prefix without mutation', async (t) => {
  const sourceSessionId = '01a04c0a-d097-7da3-83de-62cf94758707';
  const childSessionId = '01a05364-5bb1-7c11-9252-2622e6882c67';
  const grandSessionId = '01a045f3-e1e4-7e81-b0e4-07e2e891ef3c';
  const sourceLoaded = await codexData._api.loadSessionRecords(sourceSessionId, '/Users/fedor');
  const childLoaded = await codexData._api.loadSessionRecords(childSessionId, '/Users/fedor');
  if (!sourceLoaded?.success || !childLoaded?.success) {
    t.skip('production tab-34 fixture is not present on this machine');
    return;
  }
  const parentManifest = buildCodexForkLineageManifest({
    sourceSessionId: grandSessionId,
    childSessionId: sourceSessionId,
    sourceSegments: [{
      physicalSessionId: grandSessionId,
      fromByte: 0,
      toByte: 11_841_001,
      startLine: 0,
      endLine: 1_805,
      prefixDigest: '867929b0d95b90354f109dda36b5252da753988abf42cbc515ed316c9d4a9ee6',
    }],
    childTailStart: {
      byteOffset: 19_157,
      line: 2,
      prefixDigest: 'b8f0ce766e0e271d3ccb9a64dfecafd375a9b6a8d7000bb14168724055f0026c',
    },
  });
  const parentEvent = {
    eventKey: `fork:codex:${grandSessionId}:${sourceSessionId}`,
    eventType: 'fork',
    provider: 'codex',
    sessionId: sourceSessionId,
    sourceSessionId: grandSessionId,
    childSessionId: sourceSessionId,
    snapshotComplete: true,
    isDirect: true,
    origin: 'app',
    forkMode: 'direct-virtual',
    lineageManifest: parentManifest,
  };
  let childEvent = {
    eventKey: `fork:codex:${sourceSessionId}:${childSessionId}`,
    eventType: 'fork',
    provider: 'codex',
    sessionId: childSessionId,
    sourceSessionId,
    childSessionId,
    snapshotComplete: true,
    isDirect: true,
    origin: 'transcript',
    forkMode: 'unknown',
    entryUuids: [],
  };
  const store = {
    getSessionHistoryEvents: (sessionId) => {
      if (sessionId === sourceSessionId) return [parentEvent];
      if (sessionId === childSessionId) return [childEvent];
      return [];
    },
    saveSessionForkEvent: (event) => {
      childEvent = { ...childEvent, ...event, eventKey: childEvent.eventKey };
      return childEvent;
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
    sessionHistoryStore: store,
  });
  const preEnterSnapshot = await service.captureCodexRewindSourceSnapshot({
    viewSessionId: sourceSessionId,
    physicalSessionId: sourceSessionId,
    targetSourceLine: 1_878,
    cwd: '/Users/fedor',
  });
  assert.equal(preEnterSnapshot.snapshotComplete, true);
  assert.equal(preEnterSnapshot.targetTurnStartByteOffset, 15_911_314);
  assert.equal(preEnterSnapshot.nextIterationIndex, 47);
  assert.equal(preEnterSnapshot.sourceSegments.at(-1).toByte, 15_911_314);
  const prepared = await service.prepareCodexProviderForkLineage({
    childSessionId,
    cwd: '/Users/fedor',
    childTabId: '__noted_inbox__-tab-34',
  });
  assert.equal(prepared.success, true);
  assert.equal(prepared.providerHistoryBase.endByteOffset, 15_911_314);
  assert.deepEqual(
    prepared.event.lineageManifest.sourceSegments.map((segment) => segment.physicalSessionId),
    [grandSessionId, sourceSessionId],
  );
  assert.equal(
    prepared.event.nextIterationIndex,
    47,
    'the provider byte boundary reproduces the exact pre-target History coordinate from native Rewind',
  );

  const timeline = await service.getTimeline({
    toolType: 'codex',
    sessionId: childSessionId,
    cwd: '/Users/fedor',
    tabId: '__noted_inbox__-tab-34',
  });
  assert.equal(timeline.success, true);
  assert.equal(timeline.composite, true);
  // This is an appendable real child, not a frozen 48-turn fixture. Verify
  // the immutable inherited prefix exactly; later legitimate child messages
  // must neither break this regression nor be mistaken for inherited rows.
  const inheritedEntries = timeline.entries.filter((entry) => entry.physicalSessionId !== childSessionId);
  assert.deepEqual(inheritedEntries.map((entry) => entry.uuid), preEnterSnapshot.entryUuids);
  assert.equal(inheritedEntries.filter((entry) => entry.type === 'user').length, 47);
  assert.ok(timeline.entries.some((entry) => entry.physicalSessionId === childSessionId && entry.type === 'user'));
  const operationSource = await service.loadCodexOperationSource({ sessionId: childSessionId, cwd: '/Users/fedor' });
  assert.equal(operationSource.success, true);
  assert.equal(operationSource.composite, true);
  const compacts = operationSource.records.filter((record) => record.type === 'compacted');
  assert.equal(compacts.filter((record) => record.__physicalSessionId !== childSessionId).length, 2,
    'the frozen inherited prefix contains exactly two compacts; this live child may compact again');
  const compactFork = codexData._api.planCodexForkFromLatestCompact(operationSource.records, childSessionId);
  assert.equal(compactFork.success, true, 'nested fork finds the latest logical compact, inherited or appended by the child');
  assert.equal(compactFork.outputRecords.filter((record) => record.type === 'compacted').length, 1);
  assert.deepEqual(compactFork.outputRecords.find((record) => record.type === 'compacted').payload, compacts.at(-1).payload);
});

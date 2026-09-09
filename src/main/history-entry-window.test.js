'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyHistoryEntryWindow } = require('./history-entry-window');

const entries = Array.from({ length: 10 }, (_unused, index) => ({ uuid: `u${index}` }));
const uuids = (result) => result.entries.map((entry) => entry.uuid);

test('unbounded history preserves the original entries', () => {
  const result = applyHistoryEntryWindow(entries);
  assert.equal(result.boundsApplied, false);
  assert.equal(result.entries, entries);
  assert.equal(result.total, 10);
  assert.equal(result.startIndex, 0);
  assert.equal(result.hasMoreAbove, false);
  assert.equal(result.hasMoreBelow, false);
});

test('last is applied before expensive presentation transport', () => {
  const result = applyHistoryEntryWindow(entries, { last: 3 });
  assert.deepEqual(uuids(result), ['u7', 'u8', 'u9']);
  assert.equal(result.total, 10);
  assert.equal(result.dropped, 7);
  assert.equal(result.truncated, true);
  // A tail window knows there is more above and nothing below — the panel
  // needs both to decide whether to page up and whether to pin the bottom.
  assert.equal(result.startIndex, 7);
  assert.equal(result.hasMoreAbove, true);
  assert.equal(result.hasMoreBelow, false);
});

test('after, before and around use exact UUID identity', () => {
  assert.deepEqual(
    uuids(applyHistoryEntryWindow(entries, { afterUuid: 'u2', beforeUuid: 'u7' })),
    ['u3', 'u4', 'u5', 'u6'],
  );
  const around = applyHistoryEntryWindow(entries, { aroundUuid: 'u5', radius: 2 });
  assert.deepEqual(uuids(around), ['u3', 'u4', 'u5', 'u6', 'u7']);
  assert.equal(around.startIndex, 3);
  assert.equal(around.hasMoreAbove, true);
  assert.equal(around.hasMoreBelow, true);
});

test('window selectors also accept exact source identity aliases', () => {
  const addressed = entries.map((entry, index) => ({
    ...entry,
    sourceIdentity: 'source-' + index,
    sourceIdentityAliases: index === 5 ? ['response-source-5'] : [],
  }));
  assert.deepEqual(
    uuids(applyHistoryEntryWindow(addressed, { aroundUuid: 'response-source-5', radius: 1 })),
    ['u4', 'u5', 'u6'],
  );
  assert.deepEqual(
    uuids(applyHistoryEntryWindow(addressed, { afterUuid: 'source-5', last: 2 })),
    ['u8', 'u9'],
  );
});

test('a named row that no longer exists is reported, not answered with silence', () => {
  // Rollback/rewrite/wrong-branch: the caller must be able to tell "your
  // anchor is gone, fall back to the tail" from "this window is legitimately
  // empty", otherwise a stale anchor shows a blank screen forever.
  for (const bounds of [
    { aroundUuid: 'missing' },
    { fromUuid: 'missing' },
    { afterUuid: 'missing' },
    { beforeUuid: 'missing' },
  ]) {
    const result = applyHistoryEntryWindow(entries, bounds);
    assert.deepEqual(result.entries, [], JSON.stringify(bounds));
    assert.equal(result.anchorMissing, true, JSON.stringify(bounds));
    assert.equal(result.boundsApplied, true);
  }
});

test('fromUuid is inclusive — the caller names a row it is showing', () => {
  const result = applyHistoryEntryWindow(entries, { fromUuid: 'u6' });
  assert.deepEqual(uuids(result), ['u6', 'u7', 'u8', 'u9']);
  assert.equal(result.startIndex, 6);
  assert.equal(result.hasMoreAbove, true);
  assert.equal(result.hasMoreBelow, false);
  // Contrast with afterUuid, which skips the named row.
  assert.deepEqual(
    uuids(applyHistoryEntryWindow(entries, { afterUuid: 'u6' })),
    ['u7', 'u8', 'u9'],
  );
});

test('page-up window: last N rows ending before a held row', () => {
  const result = applyHistoryEntryWindow(entries, { beforeUuid: 'u6', last: 3 });
  assert.deepEqual(uuids(result), ['u3', 'u4', 'u5']);
  assert.equal(result.startIndex, 3);
  assert.equal(result.hasMoreAbove, true);
  assert.equal(result.hasMoreBelow, true);
});

test('a window at the very start reports nothing more above', () => {
  const result = applyHistoryEntryWindow(entries, { beforeUuid: 'u2', last: 50 });
  assert.deepEqual(uuids(result), ['u0', 'u1']);
  assert.equal(result.startIndex, 0);
  assert.equal(result.hasMoreAbove, false);
  assert.equal(result.hasMoreBelow, true);
});

test('around clamps at both edges without wrapping', () => {
  const head = applyHistoryEntryWindow(entries, { aroundUuid: 'u1', radius: 5 });
  assert.deepEqual(uuids(head), ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.equal(head.startIndex, 0);
  assert.equal(head.hasMoreAbove, false);
  const tail = applyHistoryEntryWindow(entries, { aroundUuid: 'u9', radius: 2 });
  assert.deepEqual(uuids(tail), ['u7', 'u8', 'u9']);
  assert.equal(tail.hasMoreBelow, false);
});

// ── Row-level windowing (stub rows outside the hydrated span) ───────────────
// The row LIST keeps its full length and order — that is the whole point:
// geometry, anchors, the mount wave and Timeline index lookup all address
// rows by position, and a shorter array would force index remapping into
// every one of them.

const { applyHistoryRowWindow, historyRowCarriesLiveWork } = require('./history-entry-window');

const heavyRow = (index, extra = {}) => ({
  uuid: `h${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  timestamp: '2026-08-07T10:00:00.000Z',
  sessionId: 's',
  viewOwnerSessionId: 'view-child',
  physicalSessionId: 's',
  transcriptSegmentId: 'segment-source',
  rawUuid: `h${index}`,
  recordByteOffset: index * 100,
  contentRevision: 'revision-1',
  entryRef: {
    viewOwnerSessionId: 'view-child',
    segmentId: 'segment-source',
    physicalSessionId: 's',
    rawUuid: `h${index}`,
    contentRevision: 'revision-1',
  },
  sourceIdentity: `codex-source-s-${index}`,
  sourceIdentityAliases: [`codex-response-source-s-${index}`],
  content: 'x'.repeat(500),
  thinking: 'y'.repeat(500),
  actions: [{ tool: '__raw__', rawTool: { toolUseId: `c${index}`, toolName: 'Bash', args: {}, result: 'ok' } }],
  ...extra,
});
const heavy = Array.from({ length: 100 }, (_u, index) => heavyRow(index));

test('row window keeps length and order, stubbing only outside the span', () => {
  const result = applyHistoryRowWindow(heavy, { radius: 10, alwaysHydrateTail: 5 });
  assert.equal(result.entries.length, heavy.length);
  assert.deepEqual(result.entries.map((entry) => entry.uuid), heavy.map((entry) => entry.uuid));
  // Tail-anchored span: last 10 rows hydrated, everything before stubbed.
  assert.equal(result.entries[90].rowStub, undefined, 'span start is hydrated');
  assert.equal(result.entries[89].rowStub, true, 'the row just above the span is a stub');
  assert.equal(result.entries[99].rowStub, undefined, 'tail is hydrated');
  assert.equal(result.entries[50].rowStub, true, 'mid-list row is a stub');
  assert.equal(result.entries[50].content, undefined, 'stub carries no content');
  assert.equal(result.entries[50].actions, undefined, 'stub carries no actions');
  assert.equal(result.entries[50].hasThinking, true, 'thinking identity survives without its heavy text');
  // Identity survives — this is what anchors, keys and live/durable matching
  // are built on.
  assert.equal(result.entries[50].uuid, 'h50');
  assert.equal(result.entries[50].role, heavy[50].role);
  assert.equal(result.entries[50].recordByteOffset, 5000);
  assert.equal(result.entries[50].timestamp, heavy[50].timestamp);
  assert.equal(result.entries[50].sourceIdentity, heavy[50].sourceIdentity);
  assert.deepEqual(result.entries[50].entryRef, heavy[50].entryRef,
    'identity stub keeps the exact physical action address and revision');
  assert.deepEqual(
    result.entries[50].sourceIdentityAliases,
    heavy[50].sourceIdentityAliases,
    'dehydration keeps exact Codex source aliases needed for local adoption',
  );
  assert.equal(result.hydratedCount, 10);
  assert.equal(result.stubbedCount, 90);
});

test('stub keeps action target/docs identity used by both grouping levels', () => {
  const rows = Array.from({ length: 20 }, (_u, index) => heavyRow(index));
  rows[2] = heavyRow(2, {
    messageId: 'msg-docs',
    thinkingSeconds: 7,
    actions: [{
      tool: '__raw__',
      rawTool: {
        toolUseId: 'docs-read',
        toolName: 'Read',
        args: { file_path: 'docs/knowledge/fact-history.md', offset: 10, limit: 20 },
        family: 'read',
        result: 'ok',
      },
    }],
  });
  const result = applyHistoryRowWindow(rows, { radius: 3, alwaysHydrateTail: 2 });
  const stub = result.entries[2];
  assert.equal(stub.rowStub, true);
  assert.equal(stub.messageId, 'msg-docs');
  assert.equal(stub.thinkingSeconds, 7);
  assert.equal(stub.actionSummary[0].targetKey, 'docs/knowledge/fact-history.md');
  assert.equal(stub.actionSummary[0].targetLabel, 'docs/knowledge/fact-history.md');
  assert.equal(stub.actionSummary[0].docsKind, 'search');
  assert.equal(stub.actionSummary[0].aggregateKey, 'read:docs');
});

test('row window centres on a named row and still keeps the tail hydrated', () => {
  const result = applyHistoryRowWindow(heavy, {
    centerUuid: 'h30', radius: 5, alwaysHydrateTail: 3,
  });
  assert.equal(result.entries[25].rowStub, undefined);
  assert.equal(result.entries[30].rowStub, undefined);
  assert.equal(result.entries[35].rowStub, undefined);
  assert.equal(result.entries[24].rowStub, true);
  assert.equal(result.entries[36].rowStub, true);
  // The tail is always readable: composer, tail-pin and the live projection
  // read it regardless of where the user is looking.
  assert.equal(result.entries[97].rowStub, undefined);
  assert.equal(result.entries[99].rowStub, undefined);
  assert.equal(result.hydratedFrom, 25);
  assert.equal(result.hydratedTo, 35);
});

test('row-window source identity survives stubbing and can hydrate its canonical row', () => {
  const result = applyHistoryRowWindow(heavy, {
    centerUuid: 'codex-response-source-s-30', radius: 2, alwaysHydrateTail: 2,
  });
  assert.equal(result.centerMissing, false);
  assert.equal(result.entries[30].rowStub, undefined);
  assert.equal(result.entries[30].uuid, 'h30');
  assert.equal(result.entries[0].rowStub, true);
  assert.equal(result.entries[0].sourceIdentity, 'codex-source-s-0');
  assert.deepEqual(result.entries[0].sourceIdentityAliases, ['codex-response-source-s-0']);
});

test('a centre that no longer exists falls back to the tail instead of failing', () => {
  const result = applyHistoryRowWindow(heavy, { centerUuid: 'gone', radius: 4, alwaysHydrateTail: 2 });
  assert.equal(result.centerMissing, true);
  assert.equal(result.entries[99].rowStub, undefined);
  assert.equal(result.entries[0].rowStub, true);
});

test('rows carrying live work are never stubbed, wherever they sit', () => {
  const withLive = heavy.map((entry, index) => {
    if (index === 5) {
      return heavyRow(index, {
        actions: [{ tool: 'Task', toolUseId: 't5', description: 'Researcher', subagentStatus: 'running' }],
      });
    }
    if (index === 6) {
      return heavyRow(index, {
        actions: [{ tool: '__raw__', rawTool: { toolUseId: 'c6', toolName: 'Bash', args: {}, backgroundStatus: 'running', result: '' } }],
      });
    }
    if (index === 7) {
      // In-flight call: no result and no result ref yet.
      return heavyRow(index, {
        actions: [{ tool: '__raw__', rawTool: { toolUseId: 'c7', toolName: 'Bash', args: {} } }],
      });
    }
    return entry;
  });
  const result = applyHistoryRowWindow(withLive, { radius: 3, alwaysHydrateTail: 2 });
  assert.equal(result.entries[5].rowStub, undefined, 'running subagent stays hydrated');
  assert.equal(result.entries[6].rowStub, undefined, 'background shell stays hydrated');
  assert.equal(result.entries[7].rowStub, undefined, 'in-flight call stays hydrated');
  assert.equal(result.entries[8].rowStub, true, 'a settled neighbour is still stubbed');

  assert.equal(historyRowCarriesLiveWork(withLive[5]), true);
  assert.equal(historyRowCarriesLiveWork(heavy[5]), false);
  assert.equal(historyRowCarriesLiveWork({ actions: [] }), false);
  assert.equal(historyRowCarriesLiveWork({}), false);
  // A completed subagent is settled and may be stubbed.
  assert.equal(historyRowCarriesLiveWork({
    actions: [{ tool: 'Task', subagentStatus: 'completed' }],
  }), false);
  // A dehydrated heavy result counts as settled (it has a payload ref).
  assert.equal(historyRowCarriesLiveWork({
    actions: [{ tool: '__raw__', rawTool: { resultRef: { payloadId: 'p', totalChars: 10 } } }],
  }), false);
});

test('no hydrate spec leaves every row untouched by identity', () => {
  const result = applyHistoryRowWindow(heavy, null);
  assert.equal(result.entries, heavy);
  assert.equal(result.rowWindowApplied, false);
  assert.equal(result.stubbedCount, 0);
});

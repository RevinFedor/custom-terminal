import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HISTORY_SNAPSHOT_CACHE_LIMITS,
  HistorySnapshotCache,
  HistoryVolatileOverlayCache,
  estimateHistoryEntriesBytesFast,
  estimateHistoryValueBytes,
  makeHistorySnapshotKey,
  type HistorySnapshotOwner,
} from './historySnapshotCache.ts';

const owner = (
  tabId: string,
  overrides: Partial<HistorySnapshotOwner> = {},
): HistorySnapshotOwner => ({
  tabId,
  toolType: 'codex',
  sessionId: `session-${tabId}`,
  cwd: `/tmp/project-${tabId}`,
  ...overrides,
});

const snapshot = (ids: string[], revision = 'revision-1') => ({
  entries: ids.map((uuid) => ({ uuid, content: `content-${uuid}` })),
  claudeMemoryBoundaryUuid: null,
  revision,
  capturedAt: 123,
});

test('owner key distinguishes tab, tool, session and cwd without delimiter collisions', () => {
  const base = owner('tab');
  const keys = new Set([
    makeHistorySnapshotKey(base),
    makeHistorySnapshotKey({ ...base, tabId: 'other' }),
    makeHistorySnapshotKey({ ...base, toolType: 'claude' }),
    makeHistorySnapshotKey({ ...base, sessionId: 'resume-child' }),
    makeHistorySnapshotKey({ ...base, cwd: '/tmp/other' }),
    makeHistorySnapshotKey(owner('a::b', { sessionId: 'c' })),
    makeHistorySnapshotKey(owner('a', { sessionId: 'b::c' })),
  ]);

  assert.equal(keys.size, 7);
});

test('default oversized pool protects three production-sized terminal owners', () => {
  assert.equal(DEFAULT_HISTORY_SNAPSHOT_CACHE_LIMITS.maxOversizedSnapshots, 3);
  assert.equal(
    DEFAULT_HISTORY_SNAPSHOT_CACHE_LIMITS.maxOversizedBytes,
    240 * 1024 * 1024,
  );
});

test('get promotes a snapshot so LRU eviction removes the untouched owner', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 100,
    maxSnapshots: 2,
  });
  cache.set(owner('a'), snapshot(['a']));
  cache.set(owner('b'), snapshot(['b']));

  assert.equal(cache.get<{ uuid: string }>(owner('a'))?.entries[0].uuid, 'a');
  cache.set(owner('c'), snapshot(['c']));

  assert.equal(cache.has(owner('a')), true);
  assert.equal(cache.has(owner('b')), false);
  assert.equal(cache.has(owner('c')), true);
});

test('total entry budget evicts whole least-recent snapshots without truncating one', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 3,
    maxSnapshots: 10,
  });
  cache.set(owner('a'), snapshot(['a1', 'a2']));
  const result = cache.set(owner('b'), snapshot(['b1', 'b2']));

  assert.equal(result.stored, true);
  assert.equal(cache.has(owner('a')), false);
  assert.equal(cache.has(owner('b')), true);
  assert.deepEqual(cache.stats(), {
    snapshots: 1,
    totalEntries: 2,
    approxBytes: cache.stats().approxBytes,
    keys: [makeHistorySnapshotKey(owner('b'))],
  });
});

test('oversized LRU retains the latest two large owners without copying their entries', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 2_000,
    maxEntries: 100,
    maxSnapshots: 2,
    maxOversizedBytes: 150_000,
    maxOversizedSnapshots: 2,
  });
  const target = owner('same');
  assert.equal(cache.set(target, snapshot(['small'])).stored, true);

  const hugeEntries = [{ uuid: 'huge', content: 'x'.repeat(20_000) }];
  const result = cache.set(target, {
    entries: hugeEntries,
    revision: 'revision-2',
  });

  assert.deepEqual(
    { stored: result.stored, invalidatedExisting: result.invalidatedExisting },
    { stored: true, invalidatedExisting: true },
  );
  assert.equal(cache.get(target)?.entries, hugeEntries);
  assert.ok(cache.stats().approxBytes > 2_000);

  const regular = owner('regular');
  cache.set(regular, snapshot(['regular']));
  assert.equal(cache.has(target), true);
  assert.equal(cache.has(regular), true);

  const latestOwner = owner('latest');
  const latestEntries = [{ uuid: 'latest', content: 'y'.repeat(20_000) }];
  const replacement = cache.set(latestOwner, {
    entries: latestEntries,
    revision: 'revision-3',
  });
  assert.deepEqual(replacement.evictedKeys, []);
  assert.equal(cache.has(target), true);
  assert.equal(cache.peek(latestOwner)?.entries, latestEntries);
  assert.equal(cache.has(regular), true);
  assert.equal(cache.stats().snapshots, 3);

  // Returning to the older large owner promotes it; a third large owner then
  // evicts the untouched one, not the owner the user just revisited.
  assert.equal(cache.get(target)?.entries, hugeEntries);
  const thirdOwner = owner('third');
  const thirdEntries = [{ uuid: 'third', content: 'z'.repeat(20_000) }];
  const thirdResult = cache.set(thirdOwner, {
    entries: thirdEntries,
    revision: 'revision-4',
  });
  assert.deepEqual(thirdResult.evictedKeys, [makeHistorySnapshotKey(latestOwner)]);
  assert.equal(cache.has(target), true);
  assert.equal(cache.has(latestOwner), false);
  assert.equal(cache.get(thirdOwner)?.entries, thirdEntries);
});

test('A → B → C → A keeps all three production-sized owners as cache hits', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 64 * 1024,
    maxEntries: 100,
    maxSnapshots: 2,
    maxOversizedBytes: 240 * 1024,
    maxOversizedSnapshots: 3,
  });
  const ownerA = owner('large-a');
  const ownerB = owner('large-b');
  const ownerC = owner('large-c');
  const entriesA = [{ uuid: 'a', content: 'a'.repeat(33 * 1024) }];
  const entriesB = [{ uuid: 'b', content: 'b'.repeat(33 * 1024) }];
  const entriesC = [{ uuid: 'c', content: 'c'.repeat(33 * 1024) }];

  assert.equal(cache.set(ownerA, { entries: entriesA }).stored, true);
  assert.equal(cache.set(ownerB, { entries: entriesB }).stored, true);
  assert.equal(cache.set(ownerC, { entries: entriesC }).stored, true);

  assert.equal(cache.get(ownerA)?.entries, entriesA);
  assert.equal(cache.get(ownerB)?.entries, entriesB);
  assert.equal(cache.get(ownerC)?.entries, entriesC);
  assert.equal(cache.stats().snapshots, 3);
  assert.ok(cache.stats().approxBytes > 192 * 1024);
  assert.ok(cache.stats().approxBytes <= 240 * 1024);
});

test('oversized byte pool stays hard bounded and rejects one snapshot beyond it', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 2_000,
    maxEntries: 100,
    maxSnapshots: 2,
    maxOversizedBytes: 25_000,
    maxOversizedSnapshots: 2,
  });
  const target = owner('too-large');
  cache.set(target, snapshot(['small']));

  const result = cache.set(target, {
    entries: [{ uuid: 'huge', content: 'x'.repeat(20_000) }],
    revision: 'revision-2',
  });

  assert.deepEqual(
    {
      stored: result.stored,
      reason: result.stored ? null : result.reason,
      invalidatedExisting: result.invalidatedExisting,
    },
    {
      stored: false,
      reason: 'snapshot-too-large',
      invalidatedExisting: true,
    },
  );
  assert.equal(cache.has(target), false);
  assert.equal(cache.stats().approxBytes, 0);
});

test('normal LRU limits remain bounded alongside the protected oversized snapshot', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 2_000,
    maxEntries: 100,
    maxSnapshots: 1,
  });
  const oversized = owner('oversized');
  cache.set(oversized, {
    entries: [{ uuid: 'huge', content: 'x'.repeat(20_000) }],
  });

  cache.set(owner('regular-a'), snapshot(['regular-a']));
  cache.set(owner('regular-b'), snapshot(['regular-b']));

  assert.equal(cache.has(oversized), true);
  assert.equal(cache.has(owner('regular-a')), false);
  assert.equal(cache.has(owner('regular-b')), true);
  assert.equal(cache.stats().snapshots, 2);
});

test('replacement updates byte and entry accounting instead of accumulating both values', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 100,
    maxSnapshots: 10,
  });
  const target = owner('same');
  cache.set(target, snapshot(['one']));
  const before = cache.stats();
  const result = cache.set(target, snapshot(['one', 'two'], 'revision-2'));
  const after = cache.stats();

  assert.equal(result.stored, true);
  assert.equal(result.invalidatedExisting, true);
  assert.equal(after.snapshots, 1);
  assert.equal(after.totalEntries, 2);
  assert.ok(after.approxBytes > before.approxBytes);
  assert.equal(cache.get(target)?.revision, 'revision-2');
});

test('revision mismatch invalidates stale data while a match promotes it', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 100,
    maxSnapshots: 3,
  });
  cache.set(owner('a'), snapshot(['a'], 'durable-a'));
  cache.set(owner('b'), snapshot(['b'], 'durable-b'));

  assert.equal(cache.getIfRevision(owner('a'), 'durable-a')?.entries.length, 1);
  assert.equal(cache.stats().keys.at(-1), makeHistorySnapshotKey(owner('a')));
  assert.equal(cache.getIfRevision(owner('a'), 'changed'), undefined);
  assert.equal(cache.has(owner('a')), false);
});

test('structured durable revisions compare by token and remain byte-accounted', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 100,
    maxSnapshots: 3,
  });
  const revision = {
    schema: 'history-files-v1',
    token: 'stable-token',
    sources: [{ filePath: '/tmp/a', size: 42 }],
  };
  cache.set(owner('structured'), snapshot(['a'], revision as any));

  const restored = cache.getIfRevision(owner('structured'), {
    ...revision,
    sources: [{ filePath: '/tmp/a', size: 42 }],
  });
  assert.equal(restored?.entries.length, 1);
  assert.ok(cache.stats().approxBytes > 0);
});

test('predicate invalidation is all-or-nothing when predicate evaluation throws', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 100,
    maxSnapshots: 10,
  });
  cache.set(owner('a'), snapshot(['a']));
  cache.set(owner('b'), snapshot(['b']));

  assert.throws(() => cache.invalidateWhere((candidate) => {
    if (candidate.tabId === 'b') throw new Error('predicate failed');
    return true;
  }), /predicate failed/);
  assert.equal(cache.stats().snapshots, 2);

  assert.equal(cache.invalidateTab('a'), 1);
  assert.equal(cache.has(owner('a')), false);
  assert.equal(cache.has(owner('b')), true);
});

test('iterative estimator handles cycles and deeply nested History payloads', () => {
  const cyclic: { text: string; self?: unknown } = { text: 'hello' };
  cyclic.self = cyclic;
  assert.ok(estimateHistoryValueBytes(cyclic) > 0);

  let deep: Record<string, unknown> = { leaf: 'done' };
  for (let index = 0; index < 20_000; index += 1) {
    deep = { next: deep };
  }
  assert.ok(estimateHistoryValueBytes(deep) > 0);
});

test('fast History estimate samples a bounded number of rows', () => {
  let inspected = 0;
  const entries = Array.from({ length: 10_000 }, (_, index) => new Proxy(
    { uuid: `row-${index}`, content: 'payload' },
    {
      ownKeys(target) {
        inspected += 1;
        return Reflect.ownKeys(target);
      },
    },
  ));

  const estimate = estimateHistoryEntriesBytesFast(entries);

  assert.ok(estimate > 0);
  assert.ok(inspected > 0);
  assert.ok(inspected <= 64);
});

test('cache insertion trusts a validated byte hint without walking entry payloads', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 1_000_000,
    maxEntries: 100,
    maxSnapshots: 2,
  });
  const entry = new Proxy(
    { uuid: 'hostile' },
    {
      ownKeys() {
        throw new Error('entry graph was traversed');
      },
    },
  );

  const result = cache.set(owner('hinted'), {
    entries: [entry],
    entriesApproxBytesHint: 1_024,
  });

  assert.equal(result.stored, true);
  assert.equal(cache.get(owner('hinted'))?.entries[0], entry);
  assert.throws(() => cache.set(owner('bad-hint'), {
    entries: [],
    entriesApproxBytesHint: -1,
  }), /non-negative safe integer/);
});

test('volatile overlay keeps only its small owner-local payload and is LRU bounded', () => {
  const cache = new HistoryVolatileOverlayCache({
    maxOwners: 2,
    maxItems: 6,
    maxBytes: 100_000,
  });
  const localA = [{ uuid: 'local-a' }];
  assert.equal(cache.set(owner('a'), {
    entries: localA,
    handoffs: [['handoff-a', { text: 'a' }]],
  }), true);
  assert.equal(cache.set(owner('b'), {
    entries: [{ uuid: 'local-b' }],
  }), true);

  const restoredA = cache.get<{ uuid: string }, { text: string }>(owner('a'));
  assert.equal(restoredA?.entries, localA);
  assert.equal(restoredA?.handoffs[0][1].text, 'a');

  cache.set(owner('c'), { entries: [{ uuid: 'local-c' }] });
  assert.equal(cache.get(owner('b')), undefined);
  assert.equal(cache.stats().owners, 2);
  assert.equal(cache.stats().items, 3);
  assert.ok(cache.stats().approxBytes > 0);
});

test('oversized volatile overlay is rejected without retaining an older stale value', () => {
  const cache = new HistoryVolatileOverlayCache({
    maxOwners: 2,
    maxItems: 2,
    maxBytes: 100_000,
  });
  const target = owner('overlay');
  assert.equal(cache.set(target, { entries: [{ uuid: 'one' }] }), true);
  assert.equal(cache.set(target, {
    entries: [{ uuid: 'one' }, { uuid: 'two' }, { uuid: 'three' }],
  }), false);
  assert.equal(cache.get(target), undefined);
  assert.deepEqual(cache.stats(), { owners: 0, items: 0, approxBytes: 0, keys: [] });
});

test('volatile overlay byte budget rejects one huge optimistic prompt', () => {
  const cache = new HistoryVolatileOverlayCache({
    maxOwners: 4,
    maxItems: 100,
    maxBytes: 2_000,
  });
  assert.equal(cache.set(owner('large'), {
    entries: [{ uuid: 'large', content: 'x'.repeat(20_000) }],
  }), false);
  assert.deepEqual(cache.stats(), { owners: 0, items: 0, approxBytes: 0, keys: [] });
});

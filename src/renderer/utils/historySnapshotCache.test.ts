import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HistorySnapshotCache,
  HistoryVolatileOverlayCache,
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

test('byte budget rejects a single oversized snapshot and invalidates an older replacement', () => {
  const cache = new HistorySnapshotCache({
    maxBytes: 2_000,
    maxEntries: 100,
    maxSnapshots: 10,
  });
  const target = owner('same');
  assert.equal(cache.set(target, snapshot(['small'])).stored, true);

  const result = cache.set(target, {
    entries: [{ uuid: 'huge', content: 'x'.repeat(20_000) }],
    revision: 'revision-2',
  });

  assert.deepEqual(
    { stored: result.stored, invalidatedExisting: result.invalidatedExisting },
    { stored: false, invalidatedExisting: true },
  );
  assert.equal(cache.has(target), false);
  assert.equal(cache.stats().totalEntries, 0);
  assert.equal(cache.stats().approxBytes, 0);
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

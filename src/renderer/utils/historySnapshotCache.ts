/**
 * A bounded, renderer-local cache for already projected History rows.
 *
 * History rows can contain large tool results, so this cache deliberately:
 * - keeps the original immutable-by-contract arrays (no second full clone);
 * - estimates memory without JSON.stringify;
 * - bounds the normal LRU by bytes, total row count, and owner count;
 * - retains exactly one latest oversized snapshot outside that normal budget;
 * - keys by every owner dimension that can select a different transcript.
 */

export interface HistorySnapshotOwner {
  tabId: string;
  toolType: string;
  sessionId: string;
  cwd: string;
}

/**
 * A stable token derived from durable source metadata (for example,
 * file path + size + mtime), not from an in-memory watcher counter.
 */
export type HistoryDurableRevision =
  | string
  | Readonly<Record<string, unknown>>;

export interface HistorySnapshot<TEntry> {
  entries: readonly TEntry[];
  claudeMemoryBoundaryUuid: string | null;
  revision: HistoryDurableRevision | null;
  capturedAt: number;
}

export interface HistorySnapshotInput<TEntry> {
  entries: readonly TEntry[];
  claudeMemoryBoundaryUuid?: string | null;
  revision?: HistoryDurableRevision | null;
  capturedAt?: number;
}

export interface HistorySnapshotCacheLimits {
  maxBytes: number;
  maxEntries: number;
  maxSnapshots: number;
}

export interface HistorySnapshotCacheStats {
  snapshots: number;
  totalEntries: number;
  approxBytes: number;
  /** Normal LRU first, then the protected oversized owner when present. */
  keys: readonly string[];
}

export interface HistoryVolatileOverlay<
  TEntry = unknown,
  THandoff = unknown,
  TSuppression = unknown,
> {
  /** Only optimistic/local rows. Durable server rows stay in HistorySnapshotCache. */
  entries: readonly TEntry[];
  handoffs: readonly (readonly [string, THandoff])[];
  suppressions: readonly (readonly [string, TSuppression])[];
  capturedAt: number;
}

export interface HistoryVolatileOverlayInput<
  TEntry = unknown,
  THandoff = unknown,
  TSuppression = unknown,
> {
  entries: readonly TEntry[];
  handoffs?: readonly (readonly [string, THandoff])[];
  suppressions?: readonly (readonly [string, TSuppression])[];
  capturedAt?: number;
}

export interface HistoryVolatileOverlayCacheLimits {
  maxOwners: number;
  maxItems: number;
  maxBytes: number;
}

export interface HistoryVolatileOverlayCacheStats {
  owners: number;
  items: number;
  approxBytes: number;
  /** Least-recently-used first. */
  keys: readonly string[];
}

export type HistorySnapshotCacheSetResult =
  | {
      stored: true;
      approxBytes: number;
      evictedKeys: readonly string[];
      invalidatedExisting: boolean;
    }
  | {
      stored: false;
      reason: 'snapshot-too-large';
      approxBytes: number;
      evictedKeys: readonly [];
      invalidatedExisting: boolean;
    };

export const DEFAULT_HISTORY_SNAPSHOT_CACHE_LIMITS: Readonly<HistorySnapshotCacheLimits> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 40_000,
  maxSnapshots: 8,
});

export const DEFAULT_HISTORY_VOLATILE_OVERLAY_CACHE_LIMITS:
  Readonly<HistoryVolatileOverlayCacheLimits> = Object.freeze({
  maxOwners: 8,
  maxItems: 512,
  maxBytes: 2 * 1024 * 1024,
});

const RECORD_OVERHEAD_BYTES = 192;
const OBJECT_OVERHEAD_BYTES = 32;
const ARRAY_OVERHEAD_BYTES = 24;
const STRING_OVERHEAD_BYTES = 16;

const encodeKeyPart = (value: string) => `${value.length}:${value}`;

/**
 * Length-prefixing prevents delimiter collisions (a field itself may contain
 * "::", newlines, or an absolute path with arbitrary punctuation).
 */
export const makeHistorySnapshotKey = (owner: HistorySnapshotOwner): string => {
  const fields = [owner.toolType, owner.tabId, owner.sessionId, owner.cwd];
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw new TypeError('History snapshot owner fields must be strings');
    }
  }
  return `history-snapshot-v1:${fields.map(encodeKeyPart).join('')}`;
};

const stringBytes = (value: string) => STRING_OVERHEAD_BYTES + value.length * 2;

const revisionsEqual = (
  left: HistoryDurableRevision | null,
  right: HistoryDurableRevision | null,
) => {
  if (left === right) return true;
  if (!left || !right || typeof left === 'string' || typeof right === 'string') return false;
  const leftToken = typeof left.token === 'string' ? left.token : null;
  const rightToken = typeof right.token === 'string' ? right.token : null;
  return !!leftToken && leftToken === rightToken;
};

/**
 * Iterative approximate retained-size estimator.
 *
 * History values are plain arrays/objects/strings in practice. Map, Set,
 * ArrayBuffer and typed arrays are handled as a defensive measure. WeakSet
 * cycle protection also avoids double-counting shared object references.
 * `stopAfterBytes` lets the cache reject an oversized snapshot without walking
 * the rest of a very large object graph.
 */
export const estimateHistoryValueBytes = (
  root: unknown,
  stopAfterBytes = Number.POSITIVE_INFINITY,
): number => {
  const stack: unknown[] = [root];
  const seen = new WeakSet<object>();
  let bytes = 0;

  while (stack.length > 0 && bytes <= stopAfterBytes) {
    const value = stack.pop();
    if (value == null) {
      bytes += 4;
      continue;
    }

    switch (typeof value) {
      case 'string':
        bytes += stringBytes(value);
        continue;
      case 'number':
      case 'bigint':
        bytes += 8;
        continue;
      case 'boolean':
        bytes += 4;
        continue;
      case 'undefined':
        bytes += 4;
        continue;
      case 'symbol':
      case 'function':
        bytes += 16;
        continue;
      case 'object':
        break;
      default:
        continue;
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);

    if (Array.isArray(value)) {
      bytes += ARRAY_OVERHEAD_BYTES + value.length * 8;
      for (let index = 0; index < value.length; index += 1) {
        stack.push(value[index]);
      }
      continue;
    }

    if (value instanceof Date) {
      bytes += OBJECT_OVERHEAD_BYTES + 8;
      continue;
    }

    if (value instanceof ArrayBuffer) {
      bytes += OBJECT_OVERHEAD_BYTES + value.byteLength;
      continue;
    }

    if (ArrayBuffer.isView(value)) {
      bytes += OBJECT_OVERHEAD_BYTES + value.byteLength;
      continue;
    }

    if (value instanceof Map) {
      bytes += OBJECT_OVERHEAD_BYTES + value.size * 16;
      for (const [key, mapValue] of value) {
        stack.push(key, mapValue);
      }
      continue;
    }

    if (value instanceof Set) {
      bytes += OBJECT_OVERHEAD_BYTES + value.size * 8;
      for (const setValue of value) stack.push(setValue);
      continue;
    }

    bytes += OBJECT_OVERHEAD_BYTES;
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      // A hostile Proxy is not expected in History, but it must not corrupt
      // cache accounting or make a tab switch throw.
      bytes += 64;
      continue;
    }
    bytes += keys.length * 8;
    for (const key of keys) {
      bytes += stringBytes(key);
      try {
        stack.push((value as Record<string, unknown>)[key]);
      } catch {
        bytes += 64;
      }
    }
  }

  return bytes;
};

interface CacheRecord {
  owner: Readonly<HistorySnapshotOwner>;
  snapshot: Readonly<HistorySnapshot<unknown>>;
  approxBytes: number;
}

const assertPositiveLimit = (name: keyof HistorySnapshotCacheLimits, value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};

export class HistorySnapshotCache {
  private readonly limits: Readonly<HistorySnapshotCacheLimits>;
  private readonly records = new Map<string, CacheRecord>();
  private oversizedRecord: { key: string; record: CacheRecord } | null = null;
  private boundedEntries = 0;
  private boundedBytes = 0;

  constructor(limits: HistorySnapshotCacheLimits = DEFAULT_HISTORY_SNAPSHOT_CACHE_LIMITS) {
    assertPositiveLimit('maxBytes', limits.maxBytes);
    assertPositiveLimit('maxEntries', limits.maxEntries);
    assertPositiveLimit('maxSnapshots', limits.maxSnapshots);
    this.limits = Object.freeze({ ...limits });
  }

  get<TEntry = unknown>(owner: HistorySnapshotOwner): Readonly<HistorySnapshot<TEntry>> | undefined {
    const key = makeHistorySnapshotKey(owner);
    if (this.oversizedRecord?.key === key) {
      return this.oversizedRecord.record.snapshot as Readonly<HistorySnapshot<TEntry>>;
    }
    const record = this.records.get(key);
    if (!record) return undefined;

    // Map insertion order is the LRU list. Reinsert to promote this record.
    this.records.delete(key);
    this.records.set(key, record);
    return record.snapshot as Readonly<HistorySnapshot<TEntry>>;
  }

  peek<TEntry = unknown>(owner: HistorySnapshotOwner): Readonly<HistorySnapshot<TEntry>> | undefined {
    const key = makeHistorySnapshotKey(owner);
    if (this.oversizedRecord?.key === key) {
      return this.oversizedRecord.record.snapshot as Readonly<HistorySnapshot<TEntry>>;
    }
    return this.records.get(key)?.snapshot as
      | Readonly<HistorySnapshot<TEntry>>
      | undefined;
  }

  /**
   * Returns a snapshot only when it represents the requested durable source
   * revision. A mismatch invalidates the stale owner atomically.
   */
  getIfRevision<TEntry = unknown>(
    owner: HistorySnapshotOwner,
    revision: HistoryDurableRevision | null,
  ): Readonly<HistorySnapshot<TEntry>> | undefined {
    const key = makeHistorySnapshotKey(owner);
    const isOversized = this.oversizedRecord?.key === key;
    const record = isOversized
      ? this.oversizedRecord?.record
      : this.records.get(key);
    if (!record) return undefined;
    if (!revisionsEqual(record.snapshot.revision, revision)) {
      this.deleteKey(key);
      return undefined;
    }
    if (!isOversized) {
      this.records.delete(key);
      this.records.set(key, record);
    }
    return record.snapshot as Readonly<HistorySnapshot<TEntry>>;
  }

  set<TEntry>(
    owner: HistorySnapshotOwner,
    input: HistorySnapshotInput<TEntry>,
  ): HistorySnapshotCacheSetResult {
    if (!Array.isArray(input.entries)) {
      throw new TypeError('History snapshot entries must be an array');
    }

    const key = makeHistorySnapshotKey(owner);
    const existing = this.hasKey(key);
    const entryCount = input.entries.length;
    const metadataBytes =
      RECORD_OVERHEAD_BYTES
      + stringBytes(key)
      + stringBytes(input.claudeMemoryBoundaryUuid || '')
      + estimateHistoryValueBytes(input.revision || '');
    const approxBytes =
      metadataBytes
      + estimateHistoryValueBytes(input.entries, this.limits.maxBytes - metadataBytes);
    const snapshot = Object.freeze({
      entries: input.entries as readonly unknown[],
      claudeMemoryBoundaryUuid: input.claudeMemoryBoundaryUuid || null,
      revision: input.revision ?? null,
      capturedAt: input.capturedAt ?? Date.now(),
    });
    const frozenOwner = Object.freeze({ ...owner });
    const record = { owner: frozenOwner, snapshot, approxBytes };
    const isOversized =
      entryCount > this.limits.maxEntries ||
      approxBytes > this.limits.maxBytes;

    if (isOversized) {
      const evictedKeys: string[] = [];
      if (this.records.has(key)) this.deleteBoundedKey(key);
      if (this.oversizedRecord) {
        if (this.oversizedRecord.key !== key) {
          evictedKeys.push(this.oversizedRecord.key);
        }
        this.oversizedRecord = null;
      }
      // This is the same immutable-by-contract array received from the caller.
      // Keeping one pointer avoids a permanent cache miss without cloning an
      // arbitrarily large History graph or allowing oversized owners to grow.
      this.oversizedRecord = { key, record };
      return {
        stored: true,
        approxBytes,
        evictedKeys,
        invalidatedExisting: existing,
      };
    }

    if (this.oversizedRecord?.key === key) this.oversizedRecord = null;
    if (this.records.has(key)) this.deleteBoundedKey(key);

    this.records.set(key, record);
    this.boundedEntries += entryCount;
    this.boundedBytes += approxBytes;

    const evictedKeys: string[] = [];
    while (
      this.records.size > this.limits.maxSnapshots
      || this.boundedEntries > this.limits.maxEntries
      || this.boundedBytes > this.limits.maxBytes
    ) {
      const lruKey = this.records.keys().next().value as string | undefined;
      if (!lruKey) break;
      this.deleteBoundedKey(lruKey);
      evictedKeys.push(lruKey);
    }

    return {
      // A snapshot that fits each individual limit cannot evict itself:
      // maxSnapshots is at least one and older records are always before it.
      stored: true,
      approxBytes,
      evictedKeys,
      invalidatedExisting: existing,
    };
  }

  has(owner: HistorySnapshotOwner): boolean {
    return this.hasKey(makeHistorySnapshotKey(owner));
  }

  delete(owner: HistorySnapshotOwner): boolean {
    return this.deleteKey(makeHistorySnapshotKey(owner));
  }

  invalidateTab(tabId: string): number {
    return this.invalidateWhere((owner) => owner.tabId === tabId);
  }

  /**
   * Predicate evaluation is completed before mutation. If a predicate throws,
   * no records have been removed and byte/entry accounting remains intact.
   */
  invalidateWhere(
    predicate: (
      owner: Readonly<HistorySnapshotOwner>,
      snapshot: Readonly<HistorySnapshot<unknown>>,
    ) => boolean,
  ): number {
    const keys: string[] = [];
    for (const [key, record] of this.records) {
      if (predicate(record.owner, record.snapshot)) keys.push(key);
    }
    if (
      this.oversizedRecord &&
      predicate(this.oversizedRecord.record.owner, this.oversizedRecord.record.snapshot)
    ) {
      keys.push(this.oversizedRecord.key);
    }
    for (const key of keys) this.deleteKey(key);
    return keys.length;
  }

  clear(): void {
    this.records.clear();
    this.oversizedRecord = null;
    this.boundedEntries = 0;
    this.boundedBytes = 0;
  }

  stats(): Readonly<HistorySnapshotCacheStats> {
    const oversizedEntries = this.oversizedRecord?.record.snapshot.entries.length || 0;
    const oversizedBytes = this.oversizedRecord?.record.approxBytes || 0;
    return Object.freeze({
      snapshots: this.records.size + (this.oversizedRecord ? 1 : 0),
      totalEntries: this.boundedEntries + oversizedEntries,
      approxBytes: this.boundedBytes + oversizedBytes,
      keys: Object.freeze([
        ...this.records.keys(),
        ...(this.oversizedRecord ? [this.oversizedRecord.key] : []),
      ]),
    });
  }

  private hasKey(key: string): boolean {
    return this.oversizedRecord?.key === key || this.records.has(key);
  }

  private deleteKey(key: string): boolean {
    if (this.oversizedRecord?.key === key) {
      this.oversizedRecord = null;
      return true;
    }
    return this.deleteBoundedKey(key);
  }

  private deleteBoundedKey(key: string): boolean {
    const record = this.records.get(key);
    if (!record) return false;
    this.records.delete(key);
    this.boundedEntries -= record.snapshot.entries.length;
    this.boundedBytes -= record.approxBytes;
    // Guard against floating/accounting drift if this code changes later.
    if (this.boundedEntries < 0) this.boundedEntries = 0;
    if (this.boundedBytes < 0) this.boundedBytes = 0;
    return true;
  }
}

interface VolatileOverlayRecord {
  overlay: Readonly<HistoryVolatileOverlay>;
  itemCount: number;
  approxBytes: number;
}

/**
 * Small LRU for state that has not reached the transcript yet.
 *
 * It intentionally never contains durable server rows, so keeping an optimistic
 * prompt across a tab switch cannot create a second retained copy of History.
 */
export class HistoryVolatileOverlayCache {
  private readonly limits: Readonly<HistoryVolatileOverlayCacheLimits>;
  private readonly records = new Map<string, VolatileOverlayRecord>();
  private items = 0;
  private approxBytes = 0;

  constructor(
    limits: HistoryVolatileOverlayCacheLimits =
      DEFAULT_HISTORY_VOLATILE_OVERLAY_CACHE_LIMITS,
  ) {
    if (!Number.isSafeInteger(limits.maxOwners) || limits.maxOwners <= 0) {
      throw new RangeError('maxOwners must be a positive safe integer');
    }
    if (!Number.isSafeInteger(limits.maxItems) || limits.maxItems <= 0) {
      throw new RangeError('maxItems must be a positive safe integer');
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    this.limits = Object.freeze({ ...limits });
  }

  get<TEntry = unknown, THandoff = unknown, TSuppression = unknown>(
    owner: HistorySnapshotOwner,
  ): Readonly<HistoryVolatileOverlay<TEntry, THandoff, TSuppression>> | undefined {
    const key = makeHistorySnapshotKey(owner);
    const record = this.records.get(key);
    if (!record) return undefined;
    this.records.delete(key);
    this.records.set(key, record);
    return record.overlay as Readonly<
      HistoryVolatileOverlay<TEntry, THandoff, TSuppression>
    >;
  }

  set<TEntry = unknown, THandoff = unknown, TSuppression = unknown>(
    owner: HistorySnapshotOwner,
    input: HistoryVolatileOverlayInput<TEntry, THandoff, TSuppression>,
  ): boolean {
    if (!Array.isArray(input.entries)) {
      throw new TypeError('History volatile overlay entries must be an array');
    }
    const handoffs = input.handoffs || [];
    const suppressions = input.suppressions || [];
    const itemCount = input.entries.length + handoffs.length + suppressions.length;
    const key = makeHistorySnapshotKey(owner);
    const approxBytes = RECORD_OVERHEAD_BYTES + stringBytes(key) +
      estimateHistoryValueBytes(
        [input.entries, handoffs, suppressions],
        this.limits.maxBytes,
      );

    this.deleteKey(key);
    if (itemCount === 0) return true;
    if (itemCount > this.limits.maxItems || approxBytes > this.limits.maxBytes) return false;

    const overlay = Object.freeze({
      // These arrays are already small, owner-local projections. Retain them
      // directly instead of cloning potentially nested entry payloads.
      entries: input.entries as readonly unknown[],
      handoffs: handoffs as readonly (readonly [string, unknown])[],
      suppressions: suppressions as readonly (readonly [string, unknown])[],
      capturedAt: input.capturedAt ?? Date.now(),
    });
    this.records.set(key, { overlay, itemCount, approxBytes });
    this.items += itemCount;
    this.approxBytes += approxBytes;

    while (
      this.records.size > this.limits.maxOwners ||
      this.items > this.limits.maxItems ||
      this.approxBytes > this.limits.maxBytes
    ) {
      const lruKey = this.records.keys().next().value as string | undefined;
      if (!lruKey) break;
      this.deleteKey(lruKey);
    }
    return this.records.has(key);
  }

  delete(owner: HistorySnapshotOwner): boolean {
    return this.deleteKey(makeHistorySnapshotKey(owner));
  }

  clear(): void {
    this.records.clear();
    this.items = 0;
    this.approxBytes = 0;
  }

  stats(): Readonly<HistoryVolatileOverlayCacheStats> {
    return Object.freeze({
      owners: this.records.size,
      items: this.items,
      approxBytes: this.approxBytes,
      keys: Object.freeze(Array.from(this.records.keys())),
    });
  }

  private deleteKey(key: string): boolean {
    const record = this.records.get(key);
    if (!record) return false;
    this.records.delete(key);
    this.items = Math.max(0, this.items - record.itemCount);
    this.approxBytes = Math.max(0, this.approxBytes - record.approxBytes);
    return true;
  }
}

/**
 * Shared across HistoryPanel remounts. Callers specify the entry type at get():
 * `historySnapshotCache.get<FullHistoryEntry>(owner)`.
 */
export const historySnapshotCache = new HistorySnapshotCache();
export const historyVolatileOverlayCache = new HistoryVolatileOverlayCache();

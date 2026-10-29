// Root capability retention for primary callers. No transcript DTOs or row
// indexes are cached here. Every active view exclusively owns its reader.
import { historyRootIdentity, checkedHistoryRootOpenHeader } from './historyRootReadClient.mjs';
const error = code => Object.assign(new Error(code), { code });
const noAbort = signal => { if (signal?.aborted) throw error('HISTORY_READ_CANCELLED'); };
const rootDescriptor = value => {
  if (value?.protocol !== 'history-root-v1' || value.kind !== 'array'
    || !Number.isSafeInteger(value.length) || value.length < 0
    || typeof value.nodeToken !== 'string' || !value.nodeToken || value.nodeToken.length > 8192) {
    throw error('HISTORY_ROOT_POOL_DESCRIPTOR');
  }
  return Object.freeze({ protocol: value.protocol, ...historyRootIdentity(value),
    kind: 'array', nodeToken: value.nodeToken, length: value.length });
};
export class HistoryRootSnapshotPool {
  constructor({ open, maxIdle = 8 } = {}) {
    if (typeof open !== 'function' || !Number.isSafeInteger(maxIdle) || maxIdle < 0 || maxIdle > 64) {
      throw error('HISTORY_ROOT_POOL_CONFIGURATION');
    }
    this.open = open; this.maxIdle = maxIdle; this.idle = new Map();
    this.active = new Set(); this.pending = new Set(); this.closed = false;
    this.metrics = { opens: 0, hits: 0, evictions: 0, releases: 0, closeErrors: 0 };
  }
  assertOpen() { if (this.closed) throw error('HISTORY_ROOT_POOL_CLOSED'); }
  key(owner) {
    if (!owner || typeof owner !== 'object') throw error('HISTORY_ROOT_POOL_OWNER');
    const names = ['tabId', 'toolType', 'sessionId', 'cwd', 'view'];
    const parts = names.map(name => {
      const value = owner[name] ?? '';
      if (typeof value !== 'string' || value.length > 4096 || (name !== 'cwd' && !value)) {
        throw error('HISTORY_ROOT_POOL_OWNER');
      }
      return value;
    });
    return JSON.stringify(parts);
  }
  async closeResource(resource) {
    if (resource.closePromise) return resource.closePromise;
    resource.invalid = true; resource.closing = true;
    // The reader already preserves its one mutation attempt after a lost ACK.
    resource.closePromise = Promise.resolve().then(() => resource.reader.close())
      .catch(failure => { this.metrics.closeErrors++; throw failure; });
    return resource.closePromise;
  }
  async acquire(owner, revision, { signal } = {}) {
    this.assertOpen(); noAbort(signal);
    if (revision != null && (typeof revision !== 'string' || !revision || revision.length > 4096)) {
      throw error('HISTORY_ROOT_POOL_REVISION');
    }
    const key = this.key(owner), frozenOwner = Object.freeze({
      tabId: owner.tabId, toolType: owner.toolType, sessionId: owner.sessionId,
      cwd: owner.cwd || '', view: owner.view,
    });
    // Admission is visible to invalidate/clear before the first retirement
    // await as well as during the opener itself.
    const creation = new AbortController(), pending = { key, creation, invalid: false };
    const abort = () => creation.abort();
    signal?.addEventListener('abort', abort, { once: true }); this.pending.add(pending);
    try {
    let resource = this.idle.get(key);
    if (resource) {
      this.idle.delete(key);
      if (revision == null || resource.revision !== revision || resource.reader.closed || resource.invalid) {
        await this.closeResource(resource); resource = null;
      } else this.metrics.hits++;
    }
    if (this.closed || pending.invalid) throw error('HISTORY_READ_CANCELLED');
    noAbort(signal);
    if (!resource) {
      let result;
      try {
        this.assertOpen(); noAbort(signal);
        result = await this.open(frozenOwner, { revision, signal: creation.signal });
        if (result?.kind === 'legacy') {
          noAbort(signal);
          if (this.closed || pending.invalid) throw error('HISTORY_READ_CANCELLED');
          // Explicit unmigrated route, never retained or called memory-bounded.
          return Object.freeze({ kind: 'legacy', result: result.result, producerBounded: false });
        }
        if (result?.kind !== 'root' || !result.reader?.close || !result.reader?.rowWindow
          || result.root?.kind !== 'array' || !Number.isSafeInteger(result.root.length) || result.root.length < 0) {
          throw error('HISTORY_ROOT_POOL_DESCRIPTOR');
        }
        const root = rootDescriptor(result.root);
        const header = Object.hasOwn(result, 'header')
          ? checkedHistoryRootOpenHeader(result.header, { sessionId: frozenOwner.sessionId }) : null;
        if (header && ['leaseId','ownerKey','revision','generation','nodeToken','length']
          .some(name => header.root?.[name] !== root[name])) throw error('HISTORY_ROOT_POOL_DESCRIPTOR');
        resource = { key, owner: frozenOwner, revision, reader: result.reader, root, header,
          invalid: false, closePromise: null, closing: false };
        noAbort(signal);
        if (this.closed || pending.invalid) throw error('HISTORY_READ_CANCELLED');
        this.metrics.opens++;
      } catch (failure) {
        if (result?.kind === 'root' && result.reader?.close) {
          resource ||= { reader: result.reader, invalid: true, closePromise: null };
          try { await this.closeResource(resource); } catch { /* Preserve the primary failure. */ }
        }
        throw failure;
      }
    }
    try { this.assertOpen(); noAbort(signal); }
    catch (failure) {
      try { await this.closeResource(resource); } catch { /* Preserve the admission failure. */ }
      throw failure;
    }
    this.active.add(resource);
    let released = false, reading = false;
    const current = () => {
      if (released || resource.invalid || resource.reader.closed || this.closed) throw error('HISTORY_READ_CANCELLED');
      noAbort(signal);
    };
    const release = async ({ keep = true } = {}) => {
      if (released) return; released = true; this.active.delete(resource); this.metrics.releases++;
      signal?.removeEventListener('abort', releaseOnAbort);
      if (!keep || this.closed || resource.invalid || resource.reader.closed || reading
        || signal?.aborted || resource.revision == null || this.maxIdle === 0) {
        await this.closeResource(resource); return;
      }
      // Publish the entire ownership change synchronously. Cleanup may await a
      // peer, but a later invalidation must not be followed by stale insertion.
      const closing = [];
      const previous = this.idle.get(key);
      if (previous && previous !== resource) {
        this.idle.delete(key); closing.push(this.closeResource(previous));
      }
      this.idle.set(key, resource);
      while (this.idle.size > this.maxIdle) {
        const [oldKey, old] = this.idle.entries().next().value;
        this.idle.delete(oldKey); this.metrics.evictions++; closing.push(this.closeResource(old));
      }
      const settled = await Promise.allSettled(closing);
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const releaseOnAbort = () => { void release({ keep: false }).catch(() => {}); };
    signal?.addEventListener('abort', releaseOnAbort, { once: true });
    return Object.freeze({
      kind: 'root', owner: frozenOwner, root: resource.root, header: resource.header, totalEntries: resource.root.length,
      // A cached root is immutable; callers separately establish source freshness.
      frozen: true, sourceFreshnessProven: false,
      async rowWindow(options = {}) {
        current();
        if (reading) throw error('HISTORY_ROOT_CONCURRENT_PULL');
        reading = true;
        try {
          const result = await resource.reader.rowWindow(resource.root, { ...options, signal: options.signal || signal });
          current(); return result;
        } finally { reading = false; }
      },
      release,
    });
    } finally {
      this.pending.delete(pending); signal?.removeEventListener('abort', abort);
    }
  }
  async invalidate(owner) {
    const key = this.key(owner), jobs = [];
    for (const request of this.pending) if (request.key === key) {
      request.invalid = true; request.creation.abort();
    }
    for (const resource of this.active) if (resource.key === key) resource.invalid = true;
    const idle = this.idle.get(key);
    if (idle) { this.idle.delete(key); jobs.push(this.closeResource(idle)); }
    await Promise.all(jobs);
  }
  async clear() {
    for (const request of this.pending) { request.invalid = true; request.creation.abort(); }
    for (const resource of this.active) resource.invalid = true;
    const values = [...this.idle.values()]; this.idle.clear();
    await Promise.all(values.map(resource => this.closeResource(resource)));
  }
  async dispose() { if (this.closed) return; this.closed = true; await this.clear(); }
  stats() {
    return Object.freeze({ ...this.metrics, idle: this.idle.size, active: this.active.size,
      pending: this.pending.size, transcriptRowsRetained: 0, retainedWholeFields: 0,
      globalMemoryMeasured: false });
  }
}


'use strict';

// Ordinary reducer ownership. Each resource is an explicitly ref-counted
// arena/store, not a session cache. The registry contains only resource handles
// so a same-process V8 checkpoint can acquire a lease after serialization.
// No row, pending call, source record or decoded text lives in this registry.
const crypto = require('node:crypto');
const { HistoryPagedStore, materializeHistoryCursorSync,
  materializeHistoryCursorSteps } = require('./history-paged-store');
const { HistoryProjectionArena } = require('./history-projection-arena');
const resources = new Map();
const snapshots = new WeakMap();
const nodes = new WeakMap();
const failure = code => Object.assign(new Error(code), { code });
const STATE = 'codex-history-checkpoint-v1';

// Explicit close/release is the normal path. Process exit is a last-resort
// cleanup for older synchronous consumers which did not have a close method.
// It neither substitutes a finalizer nor grants replay/recovery authority.
process.once('exit', () => {
  for (const resource of resources.values()) {
    if (resource.owned && !resource.store.closed) resource.store.close();
  }
  resources.clear();
});

function resourceFor(store) {
  const resource = { id: crypto.randomUUID(), store: store || new HistoryPagedStore(),
    owned: !store, refs: 0, closed: false };
  resources.set(resource.id, resource);
  return resource;
}
function retain(resource) {
  if (resource.closed || resource.store.closed) throw failure('codex_history_owner_closed');
  resource.refs++;
}
function release(resource) {
  if (--resource.refs !== 0) return;
  resource.closed = true; resources.delete(resource.id);
  if (resource.owned) resource.store.close();
}
function ownedLease(resource, lease) {
  retain(resource);
  let released = false;
  const assert = () => { if (released) throw failure('history_lease_released'); };
  return Object.freeze({
    descriptor: lease.descriptor,
    cursor() { assert(); return lease.cursor(); },
    fork() { assert(); return ownedLease(resource, lease.fork()); },
    release() {
      if (released) return; released = true;
      try { lease.release(); } finally { release(resource); }
    },
  });
}
function cursorOf(node) {
  const cursor = nodes.get(node);
  if (!cursor) throw failure('codex_history_cursor_required');
  // Touch the lease even for an otherwise empty iterator.
  cursor.kind; return cursor;
}

class HistoryCanonicalText {
  constructor(cursor) {
    const info = cursor.textInfo();
    nodes.set(this, cursor);
    Object.assign(this, { $historyLeaf: 'v1', length: info.length,
      digest: info.digest, encoding: info.encoding });
    Object.freeze(this);
  }
  *chunks() { yield* cursorOf(this).textChunks(); }
  read(offset = 0, count = 1536) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count)
      || count < 0 || count > 1536) throw failure('codex_history_leaf_credit');
    let text = ''; for (const part of cursorOf(this).textRange(offset, count)) text += part;
    return text;
  }
  toString() { throw failure('codex_history_explicit_text_sink_required'); }
}

function value(cursor) {
  if (cursor.kind === 'text') {
    if (cursor.length > 64) return new HistoryCanonicalText(cursor);
    let text = ''; for (const part of cursor.textChunks()) text += part; return text;
  }
  if (['scalar', 'scalar-root', 'number', 'bigint', 'undefined'].includes(cursor.kind)) return cursor.scalar();
  return new HistoryCanonicalNode(cursor);
}

// An explicit cursor, not a whole-object Proxy. The finite row vocabulary is
// for existing predicates such as entries.find(row => row.role === 'assistant').
// Arbitrary fields, nested args and raw pending records remain fully accessible
// through field()/fields(); iteration never materializes their descendants.
class HistoryCanonicalNode {
  constructor(cursor) { nodes.set(this, cursor); Object.freeze(this); }
  get kind() { return cursorOf(this).kind; }
  get length() { return cursorOf(this).length; } // Logical length, never a fake resident count.
  identity() { return cursorOf(this).identity(); }
  field(name) { return value(cursorOf(this).field(name)); }
  at(index) { return value(cursorOf(this).at(index)); }
  *rows(from = 0, count = this.length - from) {
    for (const row of cursorOf(this).rows(from, count)) yield value(row);
  }
  [Symbol.iterator]() { return this.rows(); }
  find(predicate, self) {
    let index = 0; for (const row of this.rows()) {
      if (predicate.call(self, row, index++, this)) return row;
    }
    return undefined;
  }
  *fields() { for (const [key, item] of cursorOf(this).fields()) yield [value(key), value(item)]; }
  *entries() { for (const [key, item] of cursorOf(this).pairs()) yield [value(key), value(item)]; }
  *values() { for (const [, item] of cursorOf(this).pairs()) yield value(item); }
  get(key) {
    for (const [candidate, item] of this.entries()) {
      if (Object.is(candidate, key) || candidate === key) return item;
      if (candidate instanceof HistoryCanonicalNode && key instanceof HistoryCanonicalNode
        && candidate.identity() === key.identity()) return item;
      if (candidate instanceof HistoryCanonicalText && typeof key === 'string' && candidate.length === key.length) {
        let offset = 0, equal = true;
        for (const part of candidate.chunks()) {
          if (part !== key.slice(offset, offset + part.length)) { equal = false; break; }
          offset += part.length;
        }
        if (equal) return item;
      }
    }
    return undefined;
  }
  get role() { return this.field('role'); }
  get uuid() { return this.field('uuid'); }
  get content() { return this.field('content'); }
  get thinking() { return this.field('thinking'); }
  get turnIndex() { return this.field('turnIndex'); }
}

function snapshot(resource, lease) {
  retain(resource);
  let released = false;
  const state = new HistoryCanonicalState(resource.id, lease.descriptor);
  snapshots.set(state, { resource, lease,
    assert() { if (released) throw failure('codex_history_checkpoint_released'); resource.store.assertOpen(); },
    release() {
      if (released) return; released = true;
      try { lease.release(); } finally { release(resource); }
    } });
  return Object.freeze(state);
}
function resolve(state) {
  const held = snapshots.get(state);
  if (held) { held.assert(); return held; }
  // Serialized same-process checkpoints retain the exact immutable descriptor.
  // A missing owner is an error, not permission to create empty canonical state.
  const resource = resources.get(state?.resourceId);
  if (state?.$codexHistoryState !== STATE || !resource || resource.closed
    || state.root?.filename !== resource.store.filename) throw failure('codex_history_checkpoint_owner_missing');
  return { resource, lease: { descriptor: state.root } };
}
class HistoryCanonicalState {
  constructor(resourceId, root) {
    Object.assign(this, { $codexHistoryState: STATE, resourceId, root });
  }
  cursor() { const held = resolve(this); return held.lease.cursor(); }
  field(name) { return value(this.cursor().field(name)); }
  get entries() { return this.field('entries'); }
  get pendingCalls() { return this.field('pendingCalls'); }
  fork() { const { resource, lease } = resolve(this); return snapshot(resource, resource.store.open(lease.descriptor)); }
  release() { snapshots.get(this)?.release(); }
  materializeLegacy() { return materializeHistoryCursorSync(this.cursor()); }
}
const isOwnedHistoryState = state => state?.$codexHistoryState === STATE;
function materializeOwnedHistoryState(state) {
  const held = resolve(state), lease = held.resource.store.open(held.lease.descriptor);
  try { return materializeHistoryCursorSync(lease.cursor()); } finally { lease.release(); }
}
function forkOwnedHistoryState(state) {
  const held = resolve(state); return snapshot(held.resource, held.resource.store.open(held.lease.descriptor));
}

function createOwnedCodexHistoryProjector(factory, sessionId, seed = {}, options = {}) {
  const held = isOwnedHistoryState(seed) ? resolve(seed) : null;
  const resource = held?.resource || resourceFor(options.canonicalStore);
  retain(resource);
  let arena, reducer, closed = false;
  try {
    arena = new HistoryProjectionArena(resource.store, held?.lease.descriptor);
    if (!held && seed && Object.keys(seed).length) arena.step(() => {
      // Explicit import of an old native checkpoint; aliases and cycles are
      // encoded once. This input bridge is measured by the existing arena.
      const imported = arena.own(seed), target = arena.state();
      for (const key in imported) target[key] = imported[key];
      if (seed.userMetadata) {
        target.discardedUserOwners ||= arena.make('set');
        target.sourceUuidAliasesByUser ||= arena.make('map');
        for (const entry of imported.userMetadata) {
          if (entry.discarded) target.discardedUserOwners.add(entry.owner);
          if (entry.aliases?.length) target.sourceUuidAliasesByUser.set(entry.owner, entry.aliases);
        }
      }
    });
    reducer = factory(sessionId, {}, { ...options, rooted: arena });
  } catch (error) { arena?.close(); release(resource); throw error; }
  const assert = () => { if (closed) throw failure('codex_history_projector_closed'); };
  const exportState = () => { assert(); return snapshot(resource, arena.checkpoint()); };
  function* finalizeRootSteps(finalOptions) {
    assert();
    const steps = reducer.finalizeRootSteps(finalOptions);
    try {
      for (;;) {
        const next = steps.next();
        if (next.done) return ownedLease(resource, next.value);
        yield;
      }
    } finally { steps.return?.(); }
  }
  function* finalizeSteps(finalOptions) {
    assert();
    const steps = reducer.finalizeRootSteps(finalOptions);
    let lease;
    try {
      for (;;) { const next = steps.next(); if (next.done) { lease = next.value; break; } yield; }
      // The old full DTO is an explicit compatibility sink, not canonical
      // storage. Ordinary cursor readers use finalizeRootSteps instead.
      return yield* materializeHistoryCursorSteps(lease.cursor());
    } finally { steps.return?.(); lease?.release(); }
  }
  return {
    feed(record) { assert(); return reducer.feed(record); },
    finalizeSteps,
    finalize(finalOptions) {
      const steps = finalizeSteps(finalOptions);
      try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
      finally { steps.return?.(); }
    },
    finalizeRootSteps,
    finalizeRoot(finalOptions) {
      const steps = finalizeRootSteps(finalOptions);
      try { for (;;) { const next = steps.next(); if (next.done) return next.value; } }
      finally { steps.return?.(); }
    },
    exportState,
    fork() {
      const state = exportState();
      try { return createOwnedCodexHistoryProjector(factory, sessionId, state, options); }
      finally { state.release(); }
    },
    exportLegacyState() {
      const state = exportState(); try { return state.materializeLegacy(); } finally { state.release(); }
    },
    peekEntries() { assert(); return new HistoryCanonicalNode(arena.pin.cursor().field('entries')); },
    retainedCost() {
      assert(); const stats = reducer.rootStats();
      // Conservative JS bookkeeping estimate; disk and native SQL are
      // reported separately. This is not an aggregate RSS measurement.
      return { estimatedJsBytes: 4096 + stats.handleCache * 128 + stats.store.indexBytes,
        logicalRows: arena.pin.cursor().field('entries').length,
        ownerCountOnDisk: stats.ownerCountOnDisk, backingBytes: stats.store.diskBytes,
        nativeMemoryMeasured: false };
    },
    rootStats: () => { assert(); return { ...reducer.rootStats(), resourceReferences: resource.refs }; },
    getConsumedRecords: () => { assert(); return reducer.getConsumedRecords(); },
    close() {
      if (closed) return; closed = true;
      try { reducer.close(); } finally { release(resource); }
    },
  };
}

module.exports = { createOwnedCodexHistoryProjector, isOwnedHistoryState,
  forkOwnedHistoryState, materializeOwnedHistoryState, HistoryCanonicalState, HistoryCanonicalNode, HistoryCanonicalText };

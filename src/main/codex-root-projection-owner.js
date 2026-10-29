'use strict';

const fs = require('node:fs');
const { HistoryProjectionArena } = require('./history-projection-arena');
const text = require('./history-paged-text');
const error = code => Object.assign(new Error(code), { code });

// The existing reader/cache supplies its store and owns its disk allocation.
// No database, global cache, worker or hidden temporary directory is created.
class CodexRootProjectionOwner {
  constructor(store, { namespace = 'codex-canonical-v1', checkpointEvery = 2048 } = {}) {
    if (!store?.openPin || store.closed) throw error('codex_root_store_required');
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1) throw error('codex_root_checkpoint_interval');
    this.store = store; this.namespace = namespace; this.checkpointEvery = checkpointEvery;
    this.closed = false;
  }
  assertOpen() { if (this.closed) throw error('codex_root_owner_closed'); this.store.assertOpen(); }
  key(sessionId, cwd) {
    this.assertOpen();
    // The durable lookup key is exact. A digest collision must not alias two
    // sessions' current/checkpoint pins or let eviction remove the wrong one.
    return JSON.stringify([this.namespace,sessionId,cwd || '']);
  }
  read(sessionId, cwd, checkpoint = null) {
    const base = this.key(sessionId,cwd);
    return this.store.openPin(base + (checkpoint === null ? ':current' : ':checkpoint:' + checkpoint));
  }
  commit(sessionId, cwd, lease, expectedPage, checkpoints, assertCurrent) {
    const base = this.key(sessionId,cwd);
    return this.store.transaction(() => {
      assertCurrent();
      const previous = this.store.openPin(base + ':current');
      try {
        if ((previous?.descriptor.page || 0) !== expectedPage) throw error('CODEX_SOURCE_READ_INVALIDATED');
      } finally { previous?.release(); }
      this.store.replaceRootPin(base + ':current',lease.descriptor);
      for (let i = 0; i < 4; i++) {
        if (checkpoints[i]) this.store.replaceRootPin(base + ':checkpoint:' + i,checkpoints[i].descriptor);
        else this.store.removePin(base + ':checkpoint:' + i);
      }
      assertCurrent();
    });
  }
  evict(sessionId, cwd) {
    const base = this.key(sessionId,cwd);
    this.store.transaction(() => {
      this.store.removePin(base + ':current');
      for (let i = 0; i < 4; i++) this.store.removePin(base + ':checkpoint:' + i);
    });
  }
  close() { this.closed = true; } // Caller owns store.close(); durable cache pins survive restart.
}

function appendRootSourceProof(arena, chunk) {
  arena.step(() => {
    const state = arena.state();
    state.sourceProof ||= arena.make('array');
    // Exact bytes, not just a collision-prone admission hash. Each scalar is
    // at most one page's base64 and never a full source/record string.
    for (let at = 0; at < chunk.length; at += arena.store.pageBytes) {
      state.sourceProof.push(chunk.subarray(at,at + arena.store.pageBytes).toString('base64'));
    }
  });
}

function trimRootSourceProof(arena, bytes) {
  arena.step(() => {
    const proof = arena.state().sourceProof;
    if (!proof) { if (bytes) throw error('codex_root_source_proof_missing'); return; }
    let offset = 0;
    for (let index = 0; index < proof.length; index++) {
      const part = Buffer.from(text.small(proof[index],arena.store.pageBytes*2),'base64');
      if (offset + part.length >= bytes) {
        const keep = bytes - offset;
        if (keep) proof[index] = part.subarray(0,keep).toString('base64');
        proof.length = index + (keep ? 1 : 0); return;
      }
      offset += part.length;
    }
    if (offset !== bytes) throw error('codex_root_source_proof_missing');
  });
}

async function verifyRootSourcePrefix(arena, filePath, bytes, stat, control) {
  const proof = arena.state().sourceProof;
  if (!proof && bytes) throw error('codex_root_source_proof_missing');
  const handle = await fs.promises.open(filePath,'r');
  let offset = 0;
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size
      || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw error('CODEX_SOURCE_READ_INVALIDATED');
    for (let index = 0; offset < bytes && index < (proof?.length || 0); index++) {
      control.assertCurrent();
      const expected = Buffer.from(text.small(proof[index],arena.store.pageBytes*2),'base64');
      const size = Math.min(expected.length,bytes-offset);
      const actual = Buffer.alloc(size);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await handle.read(actual,filled,size-filled,offset+filled);
        if (!bytesRead) return { valid: false, bytes: offset + filled };
        filled += bytesRead;
      }
      if (!actual.equals(expected.subarray(0,size))) return { valid: false, bytes: offset + size };
      offset += size;
      if (index % 64 === 63) await control.schedule();
    }
    const after = await handle.stat(), named = await fs.promises.stat(filePath);
    for (const observed of [after,named]) {
      if (observed.dev !== stat.dev || observed.ino !== stat.ino || observed.size !== stat.size
        || observed.mtimeMs !== stat.mtimeMs || observed.ctimeMs !== stat.ctimeMs) throw error('CODEX_SOURCE_READ_INVALIDATED');
    }
    if (offset !== bytes) throw error('codex_root_source_proof_missing');
    return { valid: true, bytes: offset };
  } finally { await handle.close(); }
}

function checkpointRootAt(arena, file, timeline, toByte, nextLine) {
  const fork = arena.fork();
  try {
    trimRootSourceProof(fork,toByte);
    fork.step(() => {
      fork.state().file = { ...file, fileSize: toByte, lineCount: nextLine, leftover: '', timeline };
    });
    return fork.checkpoint();
  } finally { fork.close(); }
}

module.exports = { CodexRootProjectionOwner, appendRootSourceProof,
  trimRootSourceProof, verifyRootSourcePrefix, checkpointRootAt };

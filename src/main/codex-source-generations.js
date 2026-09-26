'use strict';

const { randomBytes } = require('node:crypto');

// Small physical-source witnesses outlive the heavyweight parser cache.
// Rebuilding an evicted parser is not a file rewrite and must not reset a
// retained renderer. The metadata is charged to the existing projector budget.
class CodexSourceGenerations {
  constructor({ maxBytes = 1024 * 1024, pinned = () => false } = {}) {
    this.maxBytes = maxBytes;
    this.pinned = pinned;
    this.entries = new Map();
    this.bytes = 0;
    this.prefix = randomBytes(8).toString('hex');
    this.sequence = 0;
  }

  get(filePath) { return this.entries.get(filePath) || null; }

  // Only a caller which verified the durable cache against the physical
  // source may adopt this epoch. RAM eviction/restart is not a source rewrite.
  restore(filePath, snapshot, sessionId) {
    const existing = this.entries.get(filePath);
    if (existing?.rewritePending) return false;
    if (existing && existing.generation !== snapshot.sourceGeneration) return false;
    if (!snapshot.sourceGeneration || !snapshot.fileIdentity) return false;
    const [dev, ino] = snapshot.fileIdentity.split(':').map(Number);
    this.observe(filePath, { dev, ino, size: snapshot.size, mtimeMs: snapshot.mtimeMs, ctimeMs: snapshot.ctimeMs }, sessionId);
    this.entries.get(filePath).generation = snapshot.sourceGeneration;
    return true;
  }

  invalidate(filePath) {
    const entry = this.entries.get(filePath);
    if (entry) entry.rewritePending = true;
  }

  observe(filePath, stat, sessionId = null) {
    let entry = this.entries.get(filePath);
    const fileIdentity = stat.dev + ':' + stat.ino;
    const previous = entry?.stat;
    const olderAppendSnapshot = previous?.fileIdentity === fileIdentity
      && stat.size < previous.size && stat.ctimeMs <= previous.ctimeMs;
    const rewritten = !!entry && (entry.rewritePending
      || (previous && !olderAppendSnapshot && (previous.fileIdentity !== fileIdentity
        || stat.size < previous.size
        || (stat.size === previous.size
          && (stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs)))));
    if (!entry) {
      entry = { generation: '', stat: null, sessions: new Set(), bytes: 256 + filePath.length * 2 };
      this.bytes += entry.bytes;
    }
    if (!entry.generation || rewritten) entry.generation = fileIdentity + ':' + this.prefix + ':' + (++this.sequence);
    entry.rewritePending = false;
    if (!olderAppendSnapshot || rewritten) entry.stat = {
      fileIdentity, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    };
    // Alias bytes share the same metadata budget; no alias is silently
    // excluded from payload invalidation just because a count was reached.
    if (sessionId && !entry.sessions.has(sessionId)) {
      const addedBytes = 32 + String(sessionId).length * 2;
      entry.sessions.add(sessionId); entry.bytes += addedBytes; this.bytes += addedBytes;
    }
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
    this.prune();
    return { generation: entry.generation, rewritten, sessions: entry.sessions };
  }

  prune() {
    for (const [filePath, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (this.pinned(filePath)) continue;
      this.entries.delete(filePath);
      this.bytes -= entry.bytes;
    }
  }
}

module.exports = { CodexSourceGenerations };

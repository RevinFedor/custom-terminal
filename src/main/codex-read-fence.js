'use strict';

const INVALIDATED = 'CODEX_SOURCE_READ_INVALIDATED';

// Only in-flight reads are retained. Cache eviction is deliberately separate
// from a writer invalidating a source while an older read is still running.
class CodexReadFence {
  constructor() { this.active = new Map(); }

  begin(filePath, kind) {
    const ticket = { filePath, kind, invalidated: false };
    let readers = this.active.get(filePath);
    if (!readers) this.active.set(filePath, readers = new Set());
    readers.add(ticket);
    return ticket;
  }

  invalidate(filePath = null, kind = null, except = null) {
    const groups = filePath ? [this.active.get(filePath)] : this.active.values();
    for (const readers of groups) {
      if (!readers) continue;
      for (const ticket of readers) {
        if (ticket !== except && (!kind || ticket.kind === kind)) ticket.invalidated = true;
      }
    }
  }

  assertCurrent(ticket) {
    if (ticket.invalidated) {
      throw Object.assign(new Error('Codex source changed during read'), { code: INVALIDATED });
    }
  }

  finish(ticket) {
    const readers = this.active.get(ticket.filePath);
    if (!readers) return;
    readers.delete(ticket);
    if (!readers.size) this.active.delete(ticket.filePath);
  }
}

async function retryInvalidatedCodexRead(read) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await read(); }
    catch (error) { if (error.code !== INVALIDATED || attempt >= 2) throw error; }
  }
}

module.exports = { CodexReadFence, retryInvalidatedCodexRead };

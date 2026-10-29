'use strict';

const fs = require('node:fs');

const DEFAULT_CODEX_CONTEXT_TAIL_BYTES = 16 * 1024 * 1024;
const DEFAULT_CODEX_CONTEXT_TAIL_CHUNK_BYTES = 64 * 1024;

// A reverse read may split one large record over many chunks. Keep fixed-size
// blocks instead of concatenating the complete carry on every preceding read.
// Even one-byte reads retain at most ceil(lineBytes / blockBytes) blocks.
class ReverseLineCarry {
  constructor(budget, stats) {
    this.blockBytes = Math.max(1, Math.floor(Math.min(64 * 1024, budget)));
    this.blocks = []; this.length = 0; this.stats = null;
    try {
      if (stats && typeof stats === 'object') {
        Object.assign(stats, { copiedBytes: 0, maxCarryBytes: 0, maxCarryBlocks: 0, lineAssemblies: 0 });
        this.stats = stats;
      }
    } catch { /* Optional work counters cannot fail the read. */ }
  }
  prepend(bytes) {
    let end = bytes.length;
    while (end > 0) {
      let head = this.blocks[this.blocks.length - 1];
      if (!head || head.start === 0) {
        head = { bytes: Buffer.allocUnsafe(this.blockBytes), start: this.blockBytes };
        this.blocks.push(head);
      }
      const count = Math.min(end, head.start);
      bytes.copy(head.bytes, head.start - count, end - count, end);
      head.start -= count; end -= count; this.length += count;
      if (this.stats) try { this.stats.copiedBytes += count; } catch { this.stats = null; }
    }
    if (this.stats) {
      try {
        this.stats.maxCarryBytes = Math.max(this.stats.maxCarryBytes, this.length);
        this.stats.maxCarryBlocks = Math.max(this.stats.maxCarryBlocks, this.blocks.length);
      } catch { this.stats = null; }
    }
  }
  take(prefix) {
    if (!this.length) return prefix;
    const joined = Buffer.allocUnsafe(prefix.length + this.length);
    prefix.copy(joined);
    let offset = prefix.length;
    for (let index = this.blocks.length - 1; index >= 0; index--) {
      const block = this.blocks[index];
      offset += block.bytes.copy(joined, offset, block.start);
    }
    if (this.stats) try { this.stats.copiedBytes += joined.length; this.stats.lineAssemblies++; } catch { this.stats = null; }
    this.blocks.length = 0; this.length = 0;
    return joined;
  }
}

function finiteNonNegative(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function codexContextPctFromTokenInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const last = info.last_token_usage;
  if (!last || typeof last !== 'object' || !Object.hasOwn(last, 'total_tokens')) return null;
  const usedTokens = finiteNonNegative(last.total_tokens);
  const windowSize = finiteNonNegative(info.model_context_window);
  if (usedTokens == null || windowSize == null || windowSize <= 0) return null;
  return Math.min(100, Math.max(0, (usedTokens / windowSize) * 100));
}

function codexContextObservationFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'compacted') {
    return {
      kind: 'invalidated',
      reason: 'compacted',
      timestamp: record.timestamp || null,
    };
  }
  const payload = record.payload || null;
  if (record.type !== 'event_msg' || payload?.type !== 'token_count') return null;
  const contextPct = codexContextPctFromTokenInfo(payload.info);
  if (contextPct == null) return null;
  return {
    kind: 'value',
    reason: 'token_count',
    contextPct,
    usedTokens: finiteNonNegative(payload.info.last_token_usage.total_tokens),
    windowSize: finiteNonNegative(payload.info.model_context_window),
    timestamp: record.timestamp || null,
  };
}

/**
 * Read only the bounded JSONL tail and stop at the newest authoritative
 * context event. A compact boundary wins over every older token_count; until
 * Codex writes a newer token_count, the previous percentage is unknown.
 */
async function readLatestCodexContextObservation(filePath, {
  endOffset = null,
  maxBytes = DEFAULT_CODEX_CONTEXT_TAIL_BYTES,
  chunkBytes = DEFAULT_CODEX_CONTEXT_TAIL_CHUNK_BYTES,
  framingStats = null,
} = {}) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    return { kind: 'unknown', reason: 'empty-file', scannedBytes: 0 };
  }
  const boundedEnd = endOffset != null && Number.isSafeInteger(Number(endOffset))
    ? Math.max(0, Math.min(stat.size, Number(endOffset)))
    : stat.size;
  if (boundedEnd <= 0) return { kind: 'unknown', reason: 'empty-range', scannedBytes: 0 };
  const budget = Math.max(1, Math.min(boundedEnd, Number(maxBytes) || DEFAULT_CODEX_CONTEXT_TAIL_BYTES));
  const chunkSize = Math.max(1, Math.min(budget, Number(chunkBytes) || DEFAULT_CODEX_CONTEXT_TAIL_CHUNK_BYTES));
  const handle = await fs.promises.open(filePath, 'r');
  let position = boundedEnd;
  let scannedBytes = 0;
  const carry = new ReverseLineCarry(budget, framingStats);
  let parseErrors = 0;

  const inspectCompleteLines = (buffer) => {
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        parseErrors += 1;
        continue;
      }
      const observation = codexContextObservationFromRecord(record);
      if (observation) return observation;
    }
    return null;
  };

  try {
    while (position > 0 && scannedBytes < budget) {
      const length = Math.min(chunkSize, position, budget - scannedBytes);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      if (bytesRead <= 0) break;
      const data = chunk.subarray(0, bytesRead);
      scannedBytes += bytesRead;
      position = start;
      let end = data.length;
      for (let newline = data.lastIndexOf(0x0a); newline >= 0;
        newline = newline > 0 ? data.lastIndexOf(0x0a, newline - 1) : -1) {
        const observation = inspectCompleteLines(carry.take(data.subarray(newline + 1, end)));
        if (observation) {
          return {
            ...observation,
            source: 'rollout-tail',
            scannedBytes,
            parseErrors,
          };
        }
        end = newline;
      }
      const prefix = data.subarray(0, end);
      if (start === 0) {
        const observation = inspectCompleteLines(carry.take(prefix));
        if (observation) return { ...observation, source: 'rollout-tail', scannedBytes, parseErrors };
        break;
      }
      carry.prepend(prefix);
    }
  } finally {
    await handle.close();
  }
  return {
    kind: 'unknown',
    reason: position > 0 || carry.length > 0
      ? 'no-context-observation-in-bounded-tail'
      : 'no-context-observation',
    scannedBytes,
    parseErrors,
  };
}

module.exports = {
  DEFAULT_CODEX_CONTEXT_TAIL_BYTES,
  DEFAULT_CODEX_CONTEXT_TAIL_CHUNK_BYTES,
  codexContextPctFromTokenInfo,
  codexContextObservationFromRecord,
  readLatestCodexContextObservation,
};

'use strict';

const fs = require('node:fs');

const DEFAULT_CODEX_CONTEXT_TAIL_BYTES = 16 * 1024 * 1024;
const DEFAULT_CODEX_CONTEXT_TAIL_CHUNK_BYTES = 64 * 1024;

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
  let carry = Buffer.alloc(0);
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
      const combined = carry.length > 0
        ? Buffer.concat([chunk.subarray(0, bytesRead), carry])
        : chunk.subarray(0, bytesRead);
      scannedBytes += bytesRead;
      position = start;

      if (start === 0) {
        const observation = inspectCompleteLines(combined);
        if (observation) {
          return {
            ...observation,
            source: 'rollout-tail',
            scannedBytes,
            parseErrors,
          };
        }
        carry = Buffer.alloc(0);
        break;
      }

      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline < 0) {
        carry = combined;
        continue;
      }
      const complete = combined.subarray(firstNewline + 1);
      const observation = inspectCompleteLines(complete);
      if (observation) {
        return {
          ...observation,
          source: 'rollout-tail',
          scannedBytes,
          parseErrors,
        };
      }
      carry = Buffer.from(combined.subarray(0, firstNewline));
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

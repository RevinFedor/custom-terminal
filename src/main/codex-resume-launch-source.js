'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createCodexSourceSettingsReducer, extractCodexSettingsCandidate } = require('./codex-source-settings');

// Launch needs the latest settings and a positive history witness, NOT an
// exact whole-conversation turn count. These are byte limits, not line counts:
// a tool result or an image can occupy one enormous JSONL line.
const HEADER_BYTES = 64 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const statKey = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function* completeRecords(bytes, start) {
  // Treat the first tail byte as a boundary guard: without an observed LF we
  // cannot prove the first line is complete. Discard that fragment (including
  // a split UTF-8 code point) BEFORE decoding. An unterminated last line is ignored,
  // exactly like the canonical reader. Never parse an arbitrary clipped JSON.
  let cursor = start === 0 ? 0 : bytes.indexOf(10) + 1;
  if (start > 0 && cursor === 0) return;
  while (cursor < bytes.length) {
    const end = bytes.indexOf(10, cursor);
    if (end < 0) break;
    const text = bytes.subarray(cursor, end).toString('utf8').trim();
    try {
      if (text) yield { ...JSON.parse(text), __byteOffset: start + cursor };
    } catch { /* Canonical JSONL readers ignore malformed complete lines too. */ }
    cursor = end + 1;
  }
}

async function readCodexResumeLaunchWindow(filePath, stat, sessionId, {
  createTimelineProjector, onBytes = () => {},
} = {}) {
  const handle = await fs.promises.open(filePath, 'r');
  let bytesRead = 0;
  const miss = reason => ({ matched: false, reason, bytesRead });
  const read = async (start, length) => {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, start + offset);
      bytesRead += result.bytesRead; onBytes(result.bytesRead);
      if (!result.bytesRead) return null;
      offset += result.bytesRead;
    }
    return bytes;
  };
  try {
    if (statKey(await handle.stat()) !== statKey(stat)) return miss('source-changed');
    const header = await read(0, Math.min(HEADER_BYTES, stat.size));
    if (!header) return miss('source-short-read');
    let metadata = null;
    for (const record of completeRecords(header, 0)) {
      if (record.type === 'session_meta') { metadata = record; break; }
    }
    if (!metadata) return miss('header-metadata-unavailable');
    const settings = createCodexSourceSettingsReducer(sessionId);
    settings.feed(metadata);
    if (settings.finalize().status === 'invalid' || metadata.payload?.id !== sessionId) {
      return miss('header-metadata-invalid');
    }
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = await read(start, stat.size - start);
    if (!tail) return miss('source-short-read');
    // A user AFTER the last rollback cannot have been removed by an omitted
    // earlier rollback. Use the SAME Timeline carrier/service classifier, not
    // "payload.role=user" or a substring heuristic. Do not export suffix-local
    // UUIDs, ordinals, bodies, counts, or a new History/writer authority.
    const newTimeline = () => {
      const projector = createTimelineProjector(sessionId, {}, { mutationOnly: true });
      projector.feed({ ...metadata, __line: 0 });
      return projector;
    };
    let timeline = newTimeline(), witnessed = false, parsed = 0, candidateByteOffset = null;
    let lastYield = performance.now();
    for (const record of completeRecords(tail, start)) {
      parsed++;
      settings.feed(record);
      if (extractCodexSettingsCandidate(record, parsed)) candidateByteOffset = record.__byteOffset;
      const payload = record.payload;
      if (record.type === 'event_msg' && payload?.type === 'thread_rolled_back') {
        timeline = newTimeline(); witnessed = false;
      }
      const user = record.type === 'event_msg' && payload?.type === 'user_message'
        || record.type === 'response_item' && payload?.type === 'message' && payload.role === 'user';
      if (!witnessed && (user || record.type === 'event_msg' && payload?.type === 'task_started')) {
        timeline.feed({ ...record, __line: parsed });
        witnessed = timeline.peekEntries().some(entry => entry.type === 'user');
      }
      if (parsed % 64 === 0 && performance.now() - lastYield >= 8) {
        await new Promise(resolve => setImmediate(resolve)); lastYield = performance.now();
      }
    }
    if (candidateByteOffset === null) return miss('tail-settings-unavailable');
    if (!witnessed) return miss('tail-history-unproven');
    if (statKey(await handle.stat()) !== statKey(stat)) return miss('source-changed');
    const proof = settings.finalize();
    return { matched: true, bytesRead, sourceMetadata: metadata.payload,
      sourceSettingsProof: { ...proof, recordIndex: null, recordByteOffset: candidateByteOffset },
      sourceMaterialization: { materialized: true, metadataOnly: false, userRecords: null, userTurns: null,
        reason: 'user-history-present' },
      // These fields have always denoted whole-file counts. Preserve that
      // meaning: unknown is null, never an invented zero or suffix count.
      parsedRecords: null, parseErrors: null, partialBytes: null,
      launchWindow: { headerBytes: header.length, tailBytes: tail.length, tailFromByte: start,
        parsedTailRecords: parsed, witness: 'canonical-user-after-last-rollback' } };
  } finally { await handle.close(); }
}

module.exports = { readCodexResumeLaunchWindow, HEADER_BYTES, TAIL_BYTES, completeRecords };

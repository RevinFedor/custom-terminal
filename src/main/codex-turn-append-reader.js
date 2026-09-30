'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  codexUserMessageAuditText,
  isCodexTurnAbortedUserText,
  selectCodexPreferredUserMessageAuditRecords,
} = require('./codex-prompt-audit');

const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value || '', 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

// One fixed append, two bounded passes. The first pass chooses the SAME user
// carrier across the whole append as the old all-at-once parser. Otherwise a
// response_item/event_msg pair split at an I/O boundary changes sent identity.
// Keep only normalized user text/coordinates, never tool bodies or image data.
// The second pass applies original bytes in order. Compact/lifecycle release
// remains the caller's operation at the end of the entire successful scan.
async function readCodexTurnAppend({
  filePath, start, end, partial = '', partialStartOffset = start,
  isCurrent = () => true, onBatch, onPrepared = () => {},
  chunkBytes = 256 * 1024,
}) {
  const chunkSize = Math.max(1, Math.min(256 * 1024, chunkBytes));
  const carried = bytes(partial);
  const origin = carried.length ? partialStartOffset : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
    || !Number.isSafeInteger(origin) || origin < 0 || origin + carried.length !== start) {
    throw new Error('codex-append-invalid-range');
  }
  const stats = { bytes: end - start, readBytes: 0, batches: 0, maxBatchBytes: 0,
    maxRecordBytes: 0, candidateTextBytes: 0, yields: 0, maxSliceMs: 0 };
  const summary = { lines: 0, parseErrors: 0, eventCounts: new Map(), responseItems: 0,
    compacted: 0, otherTypes: new Map(), lastEvent: '-', lastResponseItem: '-' };
  const candidates = [];
  const proofs = [];
  let turnSegment = 0, taskStartedSeen = false, sliceStart = performance.now();
  const check = () => { if (!isCurrent()) throw new Error('codex-append-owner-changed'); };
  const tick = async (force = false) => {
    const elapsed = performance.now() - sliceStart;
    stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
    if (force || elapsed >= 8) { stats.yields += 1; await yieldTurn(); sliceStart = performance.now(); check(); }
  };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const initial = await handle.stat();
    if (initial.size < end) throw new Error('codex-append-short-read');
    async function* batches() {
      let position = start, batchStart = origin, parts = carried.length ? [carried] : [], length = carried.length;
      while (position < end) {
        check();
        const buffer = Buffer.allocUnsafe(Math.min(chunkSize, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw new Error('codex-append-short-read');
        stats.readBytes += bytesRead;
        position += bytesRead;
        const data = buffer.subarray(0, bytesRead);
        const newline = data.lastIndexOf(0x0a);
        if (newline < 0) { parts.push(data); length += data.length; continue; }
        const complete = data.subarray(0, newline + 1);
        parts.push(complete); length += complete.length;
        const batch = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
        yield { buffer: batch, start: batchStart, end: batchStart + length };
        batchStart += length;
        const tail = data.subarray(newline + 1);
        parts = tail.length ? [tail] : []; length = tail.length;
      }
      if (length) yield { buffer: parts.length === 1 ? parts[0] : Buffer.concat(parts, length), start: batchStart, end };
    }
    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    for await (const batch of batches()) {
      proofs.push({ start: batch.start, end: batch.end, hash: digest(batch.buffer) });
      stats.maxBatchBytes = Math.max(stats.maxBatchBytes, batch.buffer.length);
      let lineStart = 0, newline;
      while ((newline = batch.buffer.indexOf(0x0a, lineStart)) >= 0) {
        stats.maxRecordBytes = Math.max(stats.maxRecordBytes, newline - lineStart);
        const text = batch.buffer.subarray(lineStart, newline).toString('utf8').trim();
        const byteOffset = batch.start + lineStart;
        lineStart = newline + 1;
        if (!text) continue;
        summary.lines += 1;
        let record;
        try { record = JSON.parse(text); } catch { summary.parseErrors += 1; continue; }
        const event = record?.type === 'event_msg' ? record.payload?.type : null;
        if (record.type === 'event_msg') {
          bump(summary.eventCounts, event || 'unknown');
          summary.lastEvent = (event || 'unknown') + '@' + (record.timestamp || 'n/a');
        } else if (record.type === 'response_item') {
          summary.responseItems += 1;
          const item = record.payload || record.item || record.response_item || {};
          summary.lastResponseItem = (item.type || 'response_item') + '@' + (record.timestamp || 'n/a');
        } else if (record.type === 'compacted') summary.compacted += 1;
        else bump(summary.otherTypes, record.type || 'unknown');
        if (event === 'task_started') {
          if (taskStartedSeen) turnSegment += 1;
          taskStartedSeen = true;
        } else if (event === 'task_complete' || event === 'turn_aborted') {
          turnSegment += 1; taskStartedSeen = false;
        }
        const userText = codexUserMessageAuditText(record);
        if (userText !== null && !isCodexTurnAbortedUserText(userText)) {
          stats.candidateTextBytes += Buffer.byteLength(userText);
          candidates.push({ byteOffset, turnSegment, record: { type: record.type,
            payload: record.type === 'event_msg'
              ? { type: 'user_message', message: userText }
              : { type: 'message', role: 'user', text: userText } } });
        }
        await tick();
      }
      await tick(true);
    }
    check();
    const fmt = map => Array.from(map, ([key, value]) => key + ':' + value).join(',') || '-';
    const prepared = {
      summary: { lines: summary.lines, parseErrors: summary.parseErrors,
        events: fmt(summary.eventCounts), responseItems: summary.responseItems,
        compacted: summary.compacted, other: fmt(summary.otherTypes),
        lastEvent: summary.lastEvent, lastResponseItem: summary.lastResponseItem },
      preferredUserAuditOffsets: new Set(selectCodexPreferredUserMessageAuditRecords(candidates)
        .map(candidate => candidate.byteOffset)),
      stats,
    };
    candidates.length = 0;
    await onPrepared(prepared);
    check();
    const validate = async () => {
      const [fdStat, pathStat] = await Promise.all([handle.stat(), fs.promises.stat(filePath)]);
      if (fdStat.dev !== initial.dev || fdStat.ino !== initial.ino
        || pathStat.dev !== initial.dev || pathStat.ino !== initial.ino
        || fdStat.size < end || pathStat.size < end
        || (fdStat.size === initial.size && (fdStat.mtimeMs !== initial.mtimeMs || fdStat.ctimeMs !== initial.ctimeMs))) {
        throw new Error('codex-append-source-changed');
      }
    };
    await validate();
    let index = 0;
    for await (const batch of batches()) {
      check();
      const proof = proofs[index++];
      if (!proof || proof.start !== batch.start || proof.end !== batch.end || proof.hash !== digest(batch.buffer)) {
        throw new Error('codex-append-source-changed');
      }
      await onBatch(batch, prepared);
      stats.batches += 1;
      await tick(true);
    }
    if (index !== proofs.length) throw new Error('codex-append-short-read');
    await validate();
    check();
    return prepared;
  } finally { await handle.close(); }
}

module.exports = { readCodexTurnAppend };

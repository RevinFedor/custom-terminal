'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CLAUDE_AUDIT_READ_BYTES = 2 * 1024 * 1024;

function extractClaudeUserText(record) {
  if (record?.type !== 'user') return null;
  const message = record.message;
  if (!message || message.role !== 'user') return null;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return null;
  const textPart = message.content.find(part => (
    part && part.type === 'text' && typeof part.text === 'string'
  ));
  return textPart?.text ?? null;
}

function normalizeReadLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CLAUDE_AUDIT_READ_BYTES;
  }
  return Math.max(1, Math.floor(parsed));
}

async function readRange(handle, start, length) {
  const safeLength = Math.max(0, Math.floor(Number(length) || 0));
  if (safeLength === 0) return { buffer: Buffer.alloc(0), bytesRead: 0 };
  const buffer = Buffer.allocUnsafe(safeLength);
  const result = await handle.read(buffer, 0, safeLength, Math.max(0, start));
  return {
    buffer: buffer.subarray(0, result.bytesRead),
    bytesRead: result.bytesRead,
  };
}

async function readBoundedTail(handle, fileSize, maxReadBytes) {
  const limit = normalizeReadLimit(maxReadBytes);
  const dataStart = Math.max(0, fileSize - limit);
  // One byte before the bounded window tells us whether the first byte begins
  // a JSONL line. It is diagnostic framing, not part of the read budget.
  const probeStart = dataStart > 0 ? dataStart - 1 : dataStart;
  const requested = Math.min(
    fileSize - probeStart,
    limit + (dataStart > 0 ? 1 : 0),
  );
  const read = await readRange(handle, probeStart, requested);
  const hasProbe = dataStart > 0 && read.buffer.length > 0;
  const startsAtLineBoundary = dataStart === 0
    || (hasProbe && read.buffer[0] === 0x0a);
  const buffer = hasProbe ? read.buffer.subarray(1) : read.buffer;
  return {
    buffer,
    baseOffset: dataStart,
    skipLeadingPartial: !startsAtLineBoundary,
    bytesRead: read.bytesRead,
  };
}

function readLastClaudeUserRecordFromBuffer(
  buffer,
  transcriptPath = null,
  {
    baseOffset = 0,
    skipLeadingPartial = false,
    bytesRead = null,
    readMode = 'buffer',
  } = {},
) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  let parseStart = 0;
  if (skipLeadingPartial) {
    const firstNewline = source.indexOf(0x0a);
    if (firstNewline < 0) return null;
    parseStart = firstNewline + 1;
  }

  const candidates = [];
  let lineStart = parseStart;
  while (lineStart < source.length) {
    const newline = source.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const rawLine = source.subarray(lineStart, lineEnd).toString('utf8').trim();
    if (rawLine) {
      try {
        const record = JSON.parse(rawLine);
        const text = extractClaudeUserText(record);
        if (text !== null) {
          candidates.push({
            record,
            text,
            byteOffset: Number(baseOffset) + lineStart,
            transcriptPath: transcriptPath ? path.resolve(transcriptPath) : null,
            bytesRead: Number.isFinite(bytesRead) ? bytesRead : source.length,
            readMode,
          });
        }
      } catch {
        // A partial final line is intentionally ignored. The next file event
        // or audit retry reads the same bounded range after it is completed.
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return candidates[candidates.length - 1] || null;
}

async function readLastClaudeUserRecord(
  transcriptPath,
  boundary = null,
  { maxReadBytes = DEFAULT_CLAUDE_AUDIT_READ_BYTES } = {},
) {
  const resolvedPath = path.resolve(transcriptPath);
  const handle = await fs.promises.open(resolvedPath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = Number(stat.size || 0);
    const boundaryPath = boundary?.transcriptPath
      ? path.resolve(boundary.transcriptPath)
      : null;
    const sameFileBoundary = boundary?.available === true
      && boundaryPath === resolvedPath
      && Number.isFinite(Number(boundary.fileSize));

    if (sameFileBoundary) {
      const start = Math.max(0, Number(boundary.fileSize));
      if (fileSize <= start) return null;
      const length = Math.min(fileSize - start, normalizeReadLimit(maxReadBytes));
      const read = await readRange(handle, start, length);
      return readLastClaudeUserRecordFromBuffer(read.buffer, resolvedPath, {
        baseOffset: start,
        skipLeadingPartial: boundary.endedWithNewline !== true,
        bytesRead: read.bytesRead,
        readMode: 'post-boundary-offset',
      });
    }

    const tail = await readBoundedTail(handle, fileSize, maxReadBytes);
    return readLastClaudeUserRecordFromBuffer(tail.buffer, resolvedPath, {
      baseOffset: tail.baseOffset,
      skipLeadingPartial: tail.skipLeadingPartial,
      bytesRead: tail.bytesRead,
      readMode: 'bounded-tail',
    });
  } finally {
    await handle.close();
  }
}

async function captureClaudePromptAuditBoundary(
  transcriptPath,
  { maxReadBytes = DEFAULT_CLAUDE_AUDIT_READ_BYTES } = {},
) {
  if (!transcriptPath) {
    return {
      available: false,
      reason: 'transcript-unresolved',
      transcriptPath: null,
      fileSize: null,
      lastUserUuid: null,
      endedWithNewline: null,
      bytesRead: 0,
    };
  }
  const resolvedPath = path.resolve(transcriptPath);
  let handle;
  try {
    handle = await fs.promises.open(resolvedPath, 'r');
    const stat = await handle.stat();
    const fileSize = Number(stat.size || 0);
    const tail = await readBoundedTail(handle, fileSize, maxReadBytes);
    const lastUser = readLastClaudeUserRecordFromBuffer(
      tail.buffer,
      resolvedPath,
      {
        baseOffset: tail.baseOffset,
        skipLeadingPartial: tail.skipLeadingPartial,
        bytesRead: tail.bytesRead,
        readMode: 'pre-boundary-tail',
      },
    );
    const lastByte = tail.buffer.length > 0
      ? tail.buffer[tail.buffer.length - 1]
      : null;
    return {
      available: true,
      reason: null,
      transcriptPath: resolvedPath,
      fileSize,
      lastUserUuid: lastUser?.record?.uuid || null,
      endedWithNewline: fileSize === 0 || lastByte === 0x0a,
      bytesRead: tail.bytesRead,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        available: true,
        reason: null,
        transcriptPath: resolvedPath,
        fileSize: 0,
        lastUserUuid: null,
        endedWithNewline: true,
        bytesRead: 0,
      };
    }
    return {
      available: false,
      reason: error?.code || error?.message || 'transcript-read-failed',
      transcriptPath: resolvedPath,
      fileSize: null,
      lastUserUuid: null,
      endedWithNewline: null,
      bytesRead: 0,
    };
  } finally {
    if (handle) await handle.close();
  }
}

function classifyClaudeAuditRecordAfterBoundary(candidate, boundary) {
  if (!boundary?.available) {
    return { causal: false, reason: boundary?.reason || 'boundary-unavailable' };
  }
  if (!candidate?.record) {
    return { causal: false, reason: 'candidate-missing' };
  }
  const candidatePath = candidate.transcriptPath
    ? path.resolve(candidate.transcriptPath)
    : null;
  const boundaryPath = boundary.transcriptPath
    ? path.resolve(boundary.transcriptPath)
    : null;
  if (candidatePath && boundaryPath && candidatePath === boundaryPath) {
    const byteOffset = Number(candidate.byteOffset);
    const fileSize = Number(boundary.fileSize);
    if (!Number.isFinite(byteOffset) || !Number.isFinite(fileSize)) {
      return { causal: false, reason: 'byte-boundary-missing' };
    }
    return byteOffset >= fileSize
      ? { causal: true, reason: 'record-after-byte-boundary' }
      : { causal: false, reason: 'record-before-byte-boundary' };
  }

  // Claude resume may hand the hook a linked child transcript while the
  // pre-submit owner still resolved to its source file. The child copies the
  // source tail with stable UUIDs; a copied identical prompt therefore keeps
  // the pre-submit UUID, while the newly submitted record has a new UUID.
  const candidateUuid = candidate.record.uuid || null;
  if (!candidateUuid) return { causal: false, reason: 'cross-file-uuid-missing' };
  if (!boundary.lastUserUuid) {
    return { causal: false, reason: 'cross-file-source-uuid-unavailable' };
  }
  if (candidateUuid === boundary.lastUserUuid) {
    return { causal: false, reason: 'copied-source-tail' };
  }
  return { causal: true, reason: 'new-child-record-uuid' };
}

module.exports = {
  DEFAULT_CLAUDE_AUDIT_READ_BYTES,
  captureClaudePromptAuditBoundary,
  classifyClaudeAuditRecordAfterBoundary,
  extractClaudeUserText,
  readLastClaudeUserRecord,
  readLastClaudeUserRecordFromBuffer,
};

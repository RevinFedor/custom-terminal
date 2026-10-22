'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { LEAF, readProjectedJsonlRange } = require('./codex-json-projection');
const { isSourceLeaf } = require('./history-source-leaf');

// Compatibility repair for a LOST payload cache entry, not a new canonical
// reducer. Only an exact direct output string is recoverable this way. Exec
// multi-part normalization, Task results, args and composed thinking keep the
// capable legacy path until their canonical ref operations are implemented.
// The service must independently prove payloadId/entry membership and source
// generation. No client-supplied path or byte offset enters this resolver.
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const equals = (ref, text) => isSourceLeaf(ref) && ref.totalChars === text.length && ref.contentHash === digest(text);
const physical = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino });
const samePhysical = (left, right) => ['size', 'mtimeMs', 'ctimeMs', 'fileIdentity'].every(key => left[key] === right[key]);
const changed = () => Object.assign(Error('History payload source changed'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });

async function findDirectCodexPayloadSourceLeaf({ filePath, payloadId, expectedContentHash, totalChars = null,
  sourceCallId = null, sourceRecordLine = null,
  sourceSnapshot = null, control = null, assertCurrent = null, validateSource = null,
  chunkBytes = 64 * 1024, selectedTokenBytes = 64 * 1024, metrics = null } = {}) {
  if (typeof payloadId !== 'string' || !payloadId.startsWith('result:')
    || !/^[a-f0-9]{64}$/.test(expectedContentHash || '')) return null;
  const callId = sourceCallId ?? payloadId.slice('result:'.length);
  if (typeof callId !== 'string' || !callId || totalChars !== null && (!Number.isSafeInteger(totalChars) || totalChars < 0)
    || sourceRecordLine !== null && (!Number.isSafeInteger(sourceRecordLine) || sourceRecordLine < 0)) return null;
  // The service supplies the physical ID from its checksumed backend row
  // binding. Do not strip another suffix here: a provider ID can itself
  // contain ':canonical:N'. Direct legacy callers keep an exact-ID lookup.
  const check = () => { control?.assertCurrent(); assertCurrent?.(); };
  const verify = async () => {
    check(); if (validateSource && await validateSource() === false) throw changed(); check();
  };
  const statSource = async admitted => {
    try { return physical(await fs.promises.stat(filePath)); }
    catch (error) {
      if (admitted && ['ENOENT', 'ENOTDIR'].includes(error?.code)) throw changed();
      throw error;
    }
  };
  await verify();
  const before = await statSource(!!sourceSnapshot); check();
  if (sourceSnapshot && !samePhysical(before, sourceSnapshot)) throw changed();
  let selected = null;
  const scanMetrics = metrics || {};
  const result = await readProjectedJsonlRange(filePath, 0, before.size - 1, {
    // Even unrecognized oversized type/ID strings remain bounded leaves.
    schema: { type: LEAF, payload: { type: LEAF, call_id: LEAF, id: LEAF, output: LEAF } },
    highWaterMark: chunkBytes, selectedTokenBytes, control, assertCurrent: check, metrics: scanMetrics,
    onRecord(record, location) {
      check();
      if (sourceRecordLine !== null && location.startLine !== sourceRecordLine) return;
      const payload = record.payload;
      if (!equals(record.type, 'response_item') || !payload
        || !(equals(payload.type, 'function_call_output') || equals(payload.type, 'custom_tool_call_output'))
        || !(equals(payload.call_id, callId)
          || (!payload.call_id || equals(payload.call_id, '')) && equals(payload.id, callId))
        || !isSourceLeaf(payload.output) || payload.output.contentHash !== expectedContentHash
        || totalChars !== null && payload.output.totalChars !== totalChars) return;
      selected = { ...payload.output, recordLine: location.startLine, recordFrom: location.fromByte, recordTo: location.toByte };
    },
  });
  check();
  const after = await statSource(true); check();
  if (!samePhysical(before, after)) throw changed();
  await verify();
  // An unfinished unrelated physical tail remains excluded exactly as in the
  // canonical JSONL reader. A malformed record can never yield a locator.
  return selected ? { ref: selected, sourceSnapshot: { ...sourceSnapshot, filePath, ...before },
    parsed: result.parsed, errors: result.errors, partialBytes: result.partialBytes } : null;
}

module.exports = { findDirectCodexPayloadSourceLeaf };

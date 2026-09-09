// Identities are translated only in identity fields. Text, prompts, tool
// arguments and image paths are data, even if they contain an ancestor UUID.
function createProjectionIdentityMap(sourceSessionId, sessionId, records) {
  const lines = new Map();
  const offsets = new Map();
  const ends = new Map();
  for (const { source, target } of records) {
    if (!source || !target) continue;
    lines.set(source.__line, target.__line);
    if (Number.isFinite(source.__byteOffset)) offsets.set(source.__byteOffset, target.__byteOffset);
    if (Number.isFinite(source.__byteEndOffset)) ends.set(source.__byteEndOffset, target.__byteEndOffset);
  }
  const identity = (value) => {
    if (typeof value !== 'string') return value;
    const marker = '-' + sourceSessionId + '-';
    const split = value.lastIndexOf(marker);
    if (split < 0) return value;
    const prefix = value.slice(0, split);
    const position = Number(value.slice(split + marker.length));
    if (!/^(?:(?:thinking|compact):|codex-thinking-projection:)?codex-[a-z-]+$/.test(prefix)
      || !Number.isInteger(position)) return value;
    const positions = prefix.endsWith('-source') ? offsets : lines;
    if (!positions.has(position)) throw new Error('checkpoint_identity_outside_prefix');
    return prefix + '-' + sessionId + '-' + positions.get(position);
  };
  const transform = (key, value) => {
    if (['sessionId', 'physicalSessionId', '__physicalSessionId'].includes(key)
      && value === sourceSessionId) return sessionId;
    if (['uuid', 'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases', 'aliases',
      'payloadId', 'callId', 'toolUseId'].includes(key)) return identity(value);
    const positions = ['sourceLine', '__line', 'line', 'sourceRecordLine', 'resultSourceLine', 'recordLine'].includes(key) ? lines
      : ['__byteOffset', 'byteOffset', 'recordByteOffset'].includes(key) ? offsets
        : key === '__byteEndOffset' ? ends : null;
    if (positions && Number.isFinite(value)) {
      if (!positions.has(value)) throw new Error('checkpoint_coordinate_outside_prefix');
      return positions.get(value);
    }
    // Process action capability is not inherited by a newly created process.
    if (key === 'processGeneration') return undefined;
    return value;
  };
  return { identity, transform };
}

// Public History rows are JSON-shaped DAGs. Only changed identity paths are
// copied; text/actions/args which did not change keep their object identity.
function remapHistoryRowIdentity(row, mapping) {
  const visit = (value, key = '') => {
    if (!value || typeof value !== 'object') return mapping.transform(key, value);
    if (['args', 'payload', 'diffHunks'].includes(key)) return value;
    const result = Array.isArray(value) ? [] : {};
    let same = true;
    for (const childKey of Object.keys(value)) {
      result[childKey] = visit(value[childKey], Array.isArray(value) ? key : childKey);
      if (result[childKey] !== value[childKey]) same = false;
    }
    return same ? value : result;
  };
  return visit(row);
}

function historyRowPayloadRefs(row) {
  return [row.thinkingRef, row.compactSummaryRef, ...(row.actions || []).map((action) => action.rawTool?.resultRef)].filter(Boolean);
}
function hasProvenRewritePayloads(row) {
  return historyRowPayloadRefs(row).every((ref) => Number.isInteger(ref.recordLine));
}

module.exports = { createProjectionIdentityMap, remapHistoryRowIdentity, historyRowPayloadRefs, hasProvenRewritePayloads };

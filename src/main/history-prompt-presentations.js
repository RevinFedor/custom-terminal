const crypto = require('crypto');

function promptTransportHash(text) {
  return crypto
    .createHash('sha1')
    .update(String(text || ''))
    .digest('hex')
    .slice(0, 16);
}

function normalizeCodexPromptIdentityText(text) {
  if (typeof text !== 'string') return null;
  // Codex can serialize the copied transcript on another platform. Treat only
  // newline encoding as presentation-neutral; spaces and Unicode bytes remain
  // significant so two visually similar prompts cannot be conflated.
  return text.replace(/\r\n?/g, '\n');
}

function normalizeCodexPromptIdentityTimestamp(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp.trim()) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function codexPromptIdentityHash(text) {
  const normalized = normalizeCodexPromptIdentityText(text);
  if (normalized === null) return null;
  return crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex');
}

function codexUserRecordIdentity(record, sessionId) {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'user_message') {
    return null;
  }
  const line = Number.isInteger(record.__line) ? record.__line : Number.NaN;
  const rawTimestamp = typeof record.timestamp === 'string'
    ? record.timestamp.trim()
    : '';
  const timestamp = normalizeCodexPromptIdentityTimestamp(rawTimestamp);
  const text = typeof record.payload.message === 'string'
    ? record.payload.message
    : null;
  const identityHash = codexPromptIdentityHash(text);
  if (!Number.isInteger(line) || line < 0 || !timestamp || !identityHash || !text) {
    return {
      valid: false,
      line: Number.isInteger(line) ? line : null,
      reason: !timestamp
        ? 'timestamp-missing'
        : !identityHash || !text
          ? 'text-missing'
          : 'source-line-missing',
    };
  }
  return {
    valid: true,
    line,
    timestamp,
    rawTimestamp,
    text,
    identityHash,
    signature: `${timestamp}\u0000${identityHash}`,
    entryUuid: `codex-user-${sessionId}-${line}`,
    transportHash: promptTransportHash(text),
  };
}

/**
 * Build a fail-closed projection for records that a proven Codex child copied
 * from its source rollout. Exact timestamp + normalized text identity finds
 * survivors even when an app-authored edit removed a middle range. Duplicate
 * cardinality and global order must still agree; otherwise that group is not
 * mapped.
 *
 * This function never edits either transcript. It only returns exact source →
 * child sidecar keys for the DB layer.
 */
function buildCodexPromptPresentationRemap({
  sourceSessionId,
  childSessionId,
  sourceRecords,
  childRecords,
} = {}) {
  const source = String(sourceSessionId || '').trim();
  const child = String(childSessionId || '').trim();
  if (!source || !child || source === child) {
    return {
      mappings: [],
      matchedRecordCount: 0,
      matchedPrefixLength: 0,
      stoppedReason: 'session-identity-invalid',
    };
  }

  const collectProvenUsers = (records, sessionId) => {
    const entries = [];
    const lines = new Set();
    let previousLine = -1;
    let invalid = false;
    for (const record of Array.isArray(records) ? records : []) {
      const identity = codexUserRecordIdentity(record, sessionId);
      if (!identity) continue;
      if (
        !identity.valid
        || identity.line <= previousLine
        || lines.has(identity.line)
      ) {
        // Once user-message order itself is no longer provable, later
        // occurrence numbers cannot be trusted. Earlier complete records
        // remain safe candidates.
        invalid = true;
        break;
      }
      lines.add(identity.line);
      previousLine = identity.line;
      entries.push(identity);
    }
    return { entries, invalid };
  };
  const sourceProjection = collectProvenUsers(sourceRecords, source);
  const childProjection = collectProvenUsers(childRecords, child);
  const sourceUsers = sourceProjection.entries;
  const childUsers = childProjection.entries;
  if (sourceUsers.length === 0 || childUsers.length === 0) {
    return {
      mappings: [],
      matchedRecordCount: 0,
      matchedPrefixLength: 0,
      stoppedReason: sourceProjection.invalid || childProjection.invalid
        ? 'identity-metadata-missing'
        : 'no-shared-user-records',
    };
  }

  const groupBySignature = (entries) => {
    const groups = new Map();
    for (const entry of entries) {
      const group = groups.get(entry.signature) || [];
      group.push(entry);
      groups.set(entry.signature, group);
    }
    return groups;
  };
  const sourceGroups = groupBySignature(sourceUsers);
  const childGroups = groupBySignature(childUsers);
  const candidates = [];
  let skippedAmbiguousGroups = 0;
  for (const [signature, sourceGroup] of sourceGroups) {
    const childGroup = childGroups.get(signature) || [];
    if (childGroup.length === 0) continue;
    // Equal cardinality makes duplicate occurrence numbers stable. A deleted
    // or extra identical duplicate cannot be distinguished, so skip the whole
    // signature instead of guessing which copy survived.
    if (childGroup.length !== sourceGroup.length) {
      skippedAmbiguousGroups += 1;
      continue;
    }
    for (let index = 0; index < sourceGroup.length; index += 1) {
      candidates.push({
        sourceEntry: sourceGroup[index],
        childEntry: childGroup[index],
        occurrence: index + 1,
      });
    }
  }
  candidates.sort((left, right) => left.sourceEntry.line - right.sourceEntry.line);
  let previousChildLine = -1;
  for (const candidate of candidates) {
    if (candidate.childEntry.line <= previousChildLine) {
      return {
        mappings: [],
        matchedRecordCount: 0,
        matchedPrefixLength: 0,
        stoppedReason: 'record-order-ambiguous',
      };
    }
    previousChildLine = candidate.childEntry.line;
  }

  const mappings = candidates.map(({ sourceEntry, childEntry, occurrence }) => ({
    sourceEntryUuid: sourceEntry.entryUuid,
    childEntryUuid: childEntry.entryUuid,
    sourceAuditTimestamp: sourceEntry.rawTimestamp,
    childAuditTimestamp: childEntry.rawTimestamp,
    sourceTransportHash: sourceEntry.transportHash,
    childTransportHash: childEntry.transportHash,
    identityHash: sourceEntry.identityHash,
    occurrence,
  }));
  const stoppedReason = sourceProjection.invalid || childProjection.invalid
    ? 'identity-metadata-missing'
    : skippedAmbiguousGroups > 0
      ? 'duplicate-occurrence-ambiguous'
      : mappings.length < sourceUsers.length
        ? 'partial-projection'
        : 'projection-complete';
  return {
    mappings,
    matchedRecordCount: mappings.length,
    // Compatibility for the first in-session caller draft.
    matchedPrefixLength: mappings.length,
    stoppedReason,
  };
}

function cloneCodexPromptPresentationsForProvenChild(db, options = {}) {
  const remap = buildCodexPromptPresentationRemap(options);
  if (!db?.cloneCodexHistoryPromptPresentations || remap.mappings.length === 0) {
    return {
      ...remap,
      cloned: 0,
      updated: 0,
      unchanged: 0,
      skipped: remap.mappings.length,
    };
  }
  const databaseResult = db.cloneCodexHistoryPromptPresentations({
    sourceSessionId: options.sourceSessionId,
    childSessionId: options.childSessionId,
    entryMappings: remap.mappings,
  });
  return {
    ...remap,
    cloned: Number(databaseResult?.inserted || 0),
    updated: Number(databaseResult?.updated || 0),
    unchanged: Number(databaseResult?.unchanged || 0),
    skipped: Number(databaseResult?.skipped || 0),
  };
}

function normalizePromptPresentationSnapshot(snapshot) {
  const chips = Array.isArray(snapshot?.promptChips) ? snapshot.promptChips : [];
  const promptChips = chips.flatMap((chip, index) => {
    if (chip?.kind !== 'prompt') return [];
    const text = String(chip.text || '');
    if (!text) return [];
    const label = String(chip.label || 'PROMPT').trim() || 'PROMPT';
    return [{
      id: String(chip.id || `durable-prompt-chip-${index}`),
      kind: 'prompt',
      label,
      text,
      ...(typeof chip.sourceKey === 'string' && chip.sourceKey.trim()
        ? { sourceKey: chip.sourceKey.trim() }
        : {}),
    }];
  });
  return promptChips.length > 0
    ? { version: 1, promptChips }
    : null;
}

function saveAuditedPromptPresentation(db, {
  toolType,
  sessionId,
  entryUuid = null,
  auditTimestamp,
  actualText,
  actualHash = null,
  snapshot,
} = {}) {
  const normalized = normalizePromptPresentationSnapshot(snapshot);
  if (!normalized || !db?.saveHistoryPromptPresentation) return false;
  const hash = String(actualHash || promptTransportHash(actualText)).trim();
  if (!toolType || !sessionId || !auditTimestamp || !hash) return false;
  return db.saveHistoryPromptPresentation({
    toolType,
    sessionId,
    entryUuid,
    auditTimestamp,
    transportHash: hash,
    schemaVersion: normalized.version,
    chips: normalized.promptChips,
  });
}

function decorateHistoryPromptPresentations(db, {
  toolType,
  sessionId,
  entries,
} = {}) {
  const source = Array.isArray(entries) ? entries : [];
  if (!db?.getHistoryPromptPresentations || !toolType || !sessionId || source.length === 0) {
    return source;
  }
  const sessionRows = db.getHistoryPromptPresentations(toolType, sessionId);
  const exactRows = db.getHistoryPromptPresentationsForEntries
    ? db.getHistoryPromptPresentationsForEntries(
        toolType,
        source.map(entry => entry?.uuid).filter(Boolean),
      )
    : [];
  const rows = [...exactRows, ...sessionRows];
  if (!Array.isArray(rows) || rows.length === 0) return source;

  const exact = new Map();
  const pending = new Map();
  for (const row of rows) {
    if (row.entryUuid) exact.set(row.entryUuid, row);
    pending.set(`${row.auditTimestamp}\u0000${row.transportHash}`, row);
  }

  let changed = false;
  const decorated = source.map((entry) => {
    if (entry?.role !== 'user' || !entry.uuid) return entry;
    let row = exact.get(entry.uuid) || null;
    if (!row) {
      const timestamp = String(entry.timestamp || '');
      const hash = promptTransportHash(entry.content || '');
      row = pending.get(`${timestamp}\u0000${hash}`) || null;
      if (row && !row.entryUuid && db.bindHistoryPromptPresentationEntry) {
        db.bindHistoryPromptPresentationEntry({
          toolType,
          sessionId,
          auditTimestamp: row.auditTimestamp,
          transportHash: row.transportHash,
          entryUuid: entry.uuid,
        });
      }
    }
    if (!row || !Array.isArray(row.chips) || row.chips.length === 0) return entry;
    changed = true;
    return {
      ...entry,
      promptChips: row.chips,
    };
  });
  return changed ? decorated : source;
}

module.exports = {
  buildCodexPromptPresentationRemap,
  cloneCodexPromptPresentationsForProvenChild,
  codexPromptIdentityHash,
  decorateHistoryPromptPresentations,
  normalizePromptPresentationSnapshot,
  promptTransportHash,
  saveAuditedPromptPresentation,
};

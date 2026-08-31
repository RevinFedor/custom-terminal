const crypto = require('crypto');
const path = require('path');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const PRESENTATION_IMAGE_ASSET_RE = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const HISTORY_IMAGE_PATH_RE_SOURCE = String.raw`(?<!\\)\[imagePath:\s*([^\]\r\n]+?)\s*\]`;
const PASTED_CONTENT_OPEN = '<pasted_content>';
const PASTED_CONTENT_CLOSE = '</pasted_content>';

function promptTransportHash(text) {
  return promptAuditFingerprint(text);
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
      ...(Number.isInteger(chip.inheritanceDepth) && Number(chip.inheritanceDepth) > 0
        ? { inheritanceDepth: Number(chip.inheritanceDepth) }
        : {}),
      ...(typeof chip.inheritanceParentLabel === 'string' && chip.inheritanceParentLabel.trim()
        ? { inheritanceParentLabel: chip.inheritanceParentLabel.trim() }
        : {}),
      ...(chip.attachmentKind === 'file' ? { attachmentKind: 'file' } : {}),
      ...(chip.attachmentKind === 'file'
        && typeof chip.filePath === 'string'
        && path.isAbsolute(chip.filePath.trim())
        ? { filePath: chip.filePath.trim() }
        : {}),
      ...(chip.attachmentKind === 'file'
        && (chip.role === 'source' || chip.role === 'instructions')
        ? { role: chip.role }
        : {}),
      ...(chip.attachmentKind === 'file'
        && typeof chip.sha256 === 'string'
        && /^[a-f0-9]{64}$/i.test(chip.sha256.trim())
        ? { sha256: chip.sha256.trim().toLowerCase() }
        : {}),
      ...(chip.attachmentKind === 'file'
        && Number.isFinite(Number(chip.bytes))
        && Number(chip.bytes) >= 0
        ? { bytes: Math.floor(Number(chip.bytes)) }
        : {}),
    }];
  });
  const tags = Array.isArray(snapshot?.semanticTags) ? snapshot.semanticTags : [];
  const semanticTags = tags.flatMap((tag, index) => {
    if (tag?.kind === 'prompt-origin') {
      const source = String(tag.source || '').trim();
      if (source !== 'loop') return [];
      return [{
        id: String(tag.id || `durable-prompt-origin-tag-${index}`),
        kind: 'prompt-origin',
        source,
      }];
    }
    if (tag?.kind !== 'orchestration') return [];
    const runId = String(tag.runId || '').trim();
    const phase = String(tag.phase || '').trim();
    if (!runId || !['request', 'completion', 'failure'].includes(phase)) return [];
    const optionalString = (value) => {
      const text = String(value || '').trim();
      return text || undefined;
    };
    return [{
      id: String(tag.id || `durable-orchestration-tag-${index}`),
      kind: 'orchestration',
      runId,
      phase,
      ...(optionalString(tag.parentRunId) ? { parentRunId: optionalString(tag.parentRunId) } : {}),
      ...(optionalString(tag.sourceTabId) ? { sourceTabId: optionalString(tag.sourceTabId) } : {}),
      ...(optionalString(tag.targetTabId) ? { targetTabId: optionalString(tag.targetTabId) } : {}),
      ...(optionalString(tag.outcome) ? { outcome: optionalString(tag.outcome) } : {}),
    }];
  });
  const imageRefs = [];
  const seenImageIds = new Set();
  for (const [index, ref] of (Array.isArray(snapshot?.imagePaths) ? snapshot.imagePaths : []).entries()) {
    const id = Number(ref?.id);
    if (!Number.isInteger(id) || id <= 0 || seenImageIds.has(id)) continue;
    const filePath = typeof ref?.path === 'string' && path.isAbsolute(ref.path.trim())
      ? ref.path.trim()
      : '';
    const rawAssetId = typeof ref?.assetId === 'string' ? path.basename(ref.assetId.trim()) : '';
    const assetId = PRESENTATION_IMAGE_ASSET_RE.test(rawAssetId) ? rawAssetId.toLowerCase() : '';
    if (!filePath && !assetId) continue;
    const mediaType = typeof ref?.mediaType === 'string' && /^image\//i.test(ref.mediaType.trim())
      ? ref.mediaType.trim()
      : '';
    const size = Number(ref?.size);
    const availability = ref?.availability === 'missing' ? 'missing' : 'available';
    const error = typeof ref?.error === 'string' && ref.error.trim() ? ref.error.trim() : '';
    seenImageIds.add(id);
    imageRefs.push({
      kind: 'image-ref',
      id,
      ...(filePath ? { path: filePath } : {}),
      ...(assetId ? { assetId } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      availability,
      ...(error ? { error } : {}),
      presentationIndex: index,
    });
  }
  return promptChips.length > 0 || semanticTags.length > 0 || imageRefs.length > 0
    ? {
        version: imageRefs.length > 0 ? 3 : 2,
        promptChips,
        semanticTags,
        imagePaths: imageRefs,
      }
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
    // The legacy column is named chips_json, but schema v2 also stores
    // presentation-neutral semantic tags. Readers split the two kinds before
    // exposing them to History/Timeline.
    chips: [
      ...normalized.promptChips,
      ...normalized.semanticTags,
      ...normalized.imagePaths,
    ],
  });
}

function collectHistoryImagePathMarkersOutsidePastedContent(value) {
  const text = String(value || '');
  const paths = [];
  let cursor = 0;
  while (cursor < text.length) {
    const openAt = text.indexOf(PASTED_CONTENT_OPEN, cursor);
    const segmentEnd = openAt < 0 ? text.length : openAt;
    const segment = text.slice(cursor, segmentEnd);
    const markerRe = new RegExp(HISTORY_IMAGE_PATH_RE_SOURCE, 'gi');
    let match;
    while ((match = markerRe.exec(segment)) !== null) {
      const filePath = String(match[1] || '').trim();
      if (filePath) paths.push(filePath);
    }
    if (openAt < 0) break;
    const closeAt = text.indexOf(
      PASTED_CONTENT_CLOSE,
      openAt + PASTED_CONTENT_OPEN.length,
    );
    // An incomplete pasted-content wrapper is ambiguous. Do not reinterpret
    // anything after it as an attachment marker.
    if (closeAt < 0) break;
    cursor = closeAt + PASTED_CONTENT_CLOSE.length;
  }
  return paths;
}

function splitPromptPresentationRow(row) {
  const chips = Array.isArray(row?.chips) ? row.chips : [];
  return {
    promptChips: chips.filter(item => item?.kind === 'prompt'),
    semanticTags: chips.filter(item => (
      item?.kind === 'orchestration' || item?.kind === 'prompt-origin'
    )),
    imagePaths: chips
      .filter(item => item?.kind === 'image-ref')
      .map(({ kind: _kind, presentationIndex: _presentationIndex, ...ref }) => ref),
  };
}

function recoverManagedHistoryImageRefs({
  entry,
  imagePaths,
  resolveManagedImageRef,
} = {}) {
  if (typeof resolveManagedImageRef !== 'function') {
    return { imagePaths, recovered: 0 };
  }
  const markerPaths = collectHistoryImagePathMarkersOutsidePastedContent(entry?.content);
  if (markerPaths.length === 0) return { imagePaths, recovered: 0 };

  const refs = Array.isArray(imagePaths) ? imagePaths.map(ref => ({ ...ref })) : [];
  const indexesByPath = new Map();
  const usedIds = new Set();
  for (const [index, ref] of refs.entries()) {
    const filePath = typeof ref?.path === 'string' ? ref.path.trim() : '';
    if (filePath) indexesByPath.set(filePath, index);
    const id = Number(ref?.id);
    if (Number.isInteger(id) && id > 0) usedIds.add(id);
  }
  let nextId = 1;
  const allocateId = () => {
    while (usedIds.has(nextId)) nextId += 1;
    const id = nextId;
    usedIds.add(id);
    nextId += 1;
    return id;
  };

  let recovered = 0;
  for (const markerPath of markerPaths) {
    const existingIndex = indexesByPath.get(markerPath);
    const existing = existingIndex === undefined ? null : refs[existingIndex];
    if (existing?.path && existing.availability !== 'missing') continue;
    let resolved = null;
    try {
      resolved = resolveManagedImageRef({ path: markerPath });
    } catch {
      resolved = null;
    }
    const resolvedPath = typeof resolved?.path === 'string' && path.isAbsolute(resolved.path.trim())
      ? resolved.path.trim()
      : '';
    if (!resolvedPath || resolved?.availability === 'missing') continue;
    const id = Number(existing?.id);
    const recoveredRef = {
      ...resolved,
      id: Number.isInteger(id) && id > 0 ? id : allocateId(),
      path: resolvedPath,
      availability: 'available',
      error: undefined,
    };
    if (existingIndex === undefined) {
      indexesByPath.set(markerPath, refs.length);
      indexesByPath.set(resolvedPath, refs.length);
      refs.push(recoveredRef);
    } else {
      refs[existingIndex] = recoveredRef;
      indexesByPath.set(resolvedPath, existingIndex);
    }
    recovered += 1;
  }
  return { imagePaths: refs, recovered };
}

function decorateHistoryPromptPresentations(db, {
  toolType,
  sessionId,
  entries,
  recoverManagedImageRef = null,
  logger = console,
} = {}) {
  const source = Array.isArray(entries) ? entries : [];
  if (!toolType || !sessionId || source.length === 0) {
    return source;
  }
  const canReadRows = !!db?.getHistoryPromptPresentations;
  if (!canReadRows && typeof recoverManagedImageRef !== 'function') return source;
  const sessionRows = canReadRows
    ? db.getHistoryPromptPresentations(toolType, sessionId)
    : [];
  const exactRows = canReadRows && db.getHistoryPromptPresentationsForEntries
    ? db.getHistoryPromptPresentationsForEntries(
        toolType,
        source.map(entry => entry?.uuid).filter(Boolean),
      )
    : [];
  const rows = [...exactRows, ...sessionRows];

  const exact = new Map();
  const pending = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.entryUuid) exact.set(row.entryUuid, row);
    pending.set(`${row.auditTimestamp}\u0000${row.transportHash}`, row);
  }

  let changed = false;
  const decorated = source.map((entry) => {
    const isPromptEntry = entry?.role === 'user'
      || entry?.role === 'queued'
      || entry?.type === 'user'
      || entry?.kind === 'user';
    if (!isPromptEntry || !entry.uuid) return entry;
    let row = exact.get(entry.uuid) || null;
    if (!row) {
      const candidates = [{
        auditTimestamp: String(
          entry.promptPresentationAuditTimestamp || entry.timestamp || '',
        ),
        transportHash: String(entry.promptPresentationTransportHash || '')
          || promptTransportHash(entry.content || ''),
      }, ...(
        Array.isArray(entry.promptPresentationAuditAliases)
          ? entry.promptPresentationAuditAliases
          : []
      )];
      for (const candidate of candidates) {
        const auditTimestamp = String(candidate?.auditTimestamp || '');
        const transportHash = String(candidate?.transportHash || '');
        if (!auditTimestamp || !transportHash) continue;
        row = pending.get(`${auditTimestamp}\u0000${transportHash}`) || null;
        if (row) break;
      }
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
    const presentation = splitPromptPresentationRow(row);
    const recovery = recoverManagedHistoryImageRefs({
      entry,
      imagePaths: presentation.imagePaths,
      resolveManagedImageRef: recoverManagedImageRef,
    });
    const { promptChips, semanticTags } = presentation;
    const imagePaths = recovery.imagePaths;
    if (recovery.recovered > 0) {
      const recoverySessionId = row?.sessionId || sessionId;
      const auditTimestamp = row?.auditTimestamp || String(entry.timestamp || '');
      const transportHash = row?.transportHash || promptTransportHash(entry.content || '');
      const presentationSaved = saveAuditedPromptPresentation(db, {
        toolType,
        sessionId: recoverySessionId,
        entryUuid: entry.uuid,
        auditTimestamp,
        actualText: entry.content || '',
        actualHash: transportHash,
        snapshot: {
          promptChips,
          semanticTags,
          imagePaths,
        },
      });
      logger?.info?.('[HistoryPromptPresentation:ImageRecovery] tool=' + toolType
        + ' session=' + String(recoverySessionId).slice(0, 8)
        + ' entry=' + String(entry.uuid).slice(0, 8)
        + ' images=' + recovery.recovered
        + ' saved=' + presentationSaved);
    }
    if (promptChips.length === 0 && semanticTags.length === 0 && imagePaths.length === 0) return entry;
    changed = true;
    return {
      ...entry,
      ...(promptChips.length > 0 ? { promptChips } : {}),
      ...(semanticTags.length > 0 ? { semanticTags } : {}),
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
    };
  });
  return changed ? decorated : source;
}

module.exports = {
  buildCodexPromptPresentationRemap,
  cloneCodexPromptPresentationsForProvenChild,
  codexPromptIdentityHash,
  collectHistoryImagePathMarkersOutsidePastedContent,
  decorateHistoryPromptPresentations,
  normalizePromptPresentationSnapshot,
  promptTransportHash,
  recoverManagedHistoryImageRefs,
  saveAuditedPromptPresentation,
};

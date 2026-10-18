const crypto = require('crypto');
const path = require('path');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { readOwnedAttachmentProjection, validateOwnedAttachmentSnapshot,
  renderOwnedAttachmentTransport } = require('./owned-mobile-attachments');
const { findPastedContentEnvelope } = require('../shared/pasted-content.cjs');
const { claudeNativePastedPromptText } = require('./claude-prompt-audit');
const { prepareClaudePromptTransport } = require('./claude-prompt-transport');
const { validateClaudePromptRequestProjection } = require('./claude-prompt-request-projection');
const { historyAuthoringProjectionFromReceipt, normalizeHistoryAuthoringProjection,
  projectHistoryAuthoringEntry } = require('./history-authoring-projection');
const { resolveForkOperation } = require('../shared/fork-operation.cjs');
const {
  systemPromptSource,
  promptOriginTagForSource,
  withPromptOriginPresentation,
} = require('../shared/prompt-origin.cjs');

const PRESENTATION_IMAGE_ASSET_RE = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const HISTORY_IMAGE_PATH_RE_SOURCE = String.raw`(?<!\\)\[imagePath:\s*([^\]\r\n]+?)\s*\]`;

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
  // A pre-upgrade child may itself still lack the service sidecars. Carry
  // its proven inherited READ tags into the new child using this operation's
  // stronger raw-record remap, so another Rewind cannot lose them again.
  const sourceEntries = (options.sourceRecords || []).flatMap(record => record?.type === 'event_msg'
    && record.payload?.type === 'user_message' && Number.isInteger(record.__line)
    ? [{ role: 'user', uuid: `codex-user-${options.sourceSessionId}-${record.__line}`,
      timestamp: record.timestamp, content: record.payload.message }] : []);
  const inherited = mappedCodexServicePresentations(db, options.sourceSessionId, sourceEntries, null);
  let inheritedCloned = 0;
  if (inherited.length && db.getHistoryPromptPresentationByAudit && db.saveHistoryPromptPresentation) {
    const childByUuid = new Map((options.childRecords || []).flatMap(record => record?.type === 'event_msg'
      && record.payload?.type === 'user_message' && Number.isInteger(record.__line)
      ? [[`codex-user-${options.childSessionId}-${record.__line}`, record.payload.message]] : []));
    const copy = () => {
      for (const row of inherited) {
        const mapping = remap.mappings.find(item => item.sourceEntryUuid === row.entryUuid);
        if (!mapping || db.getHistoryPromptPresentationByAudit('codex', options.childSessionId,
          mapping.childAuditTimestamp, mapping.childTransportHash)
          || db.getHistoryPromptPresentationsForEntries?.('codex', [mapping.childEntryUuid]).length) continue;
        const text = childByUuid.get(mapping.childEntryUuid);
        if (typeof text !== 'string' || !row.chips.some(tag => tag.bodyProjectionHash
          === crypto.createHash('sha256').update(text).digest('hex'))) continue;
        if (saveAuditedPromptPresentation(db, { toolType: 'codex', sessionId: options.childSessionId,
          entryUuid: mapping.childEntryUuid, auditTimestamp: mapping.childAuditTimestamp,
          actualHash: mapping.childTransportHash, actualText: text,
          snapshot: { semanticTags: row.chips }, trustedContextPrefix: true })) inheritedCloned++;
      }
    };
    if (db.db?.transaction) db.db.transaction(copy)();
    else copy();
  }
  return {
    ...remap,
    cloned: Number(databaseResult?.inserted || 0) + inheritedCloned,
    updated: Number(databaseResult?.updated || 0),
    unchanged: Number(databaseResult?.unchanged || 0),
    skipped: Math.max(0, Number(databaseResult?.skipped || 0) - inheritedCloned),
  };
}

function normalizePromptPresentationSnapshot(snapshot, { storedAuthoring = false, contextProof = false } = {}) {
  const chips = Array.isArray(snapshot?.promptChips) ? snapshot.promptChips : [];
  const promptChips = chips.flatMap((chip, index) => {
    // Opaque snapshot retention only. The shared codec remains the parser in
    // every editor/navigation boundary; malformed metadata never changes text.
    if (chip?.kind === 'paste' && typeof chip.text === 'string' && chip.text
      && chip.messageReference?.detailsText === chip.text) {
      return [{ id: String(chip.id || `durable-message-chip-${index}`), kind: 'paste', text: chip.text,
        label: String(chip.label || 'Вставка'), messageReference: chip.messageReference }];
    }
    if (chip?.kind !== 'prompt') return [];
    const text = String(chip.text || '');
    if (!text && chip.attachmentKind !== 'file') return [];
    const label = String(chip.label || 'PROMPT').trim() || 'PROMPT';
    return [{
      id: String(chip.id || `durable-prompt-chip-${index}`),
      kind: 'prompt',
      ...(typeof chip.contextUpdateId === 'string' ? { contextUpdateId: chip.contextUpdateId } : {}),
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
    if (tag?.kind === 'context-prefix') {
      if ((!storedAuthoring && !contextProof) || tag.contextKind !== 'orchestration-state' || tag.envelopeStart !== 0
        || !Number.isSafeInteger(tag.bodyStart) || tag.bodyStart < 1
        || !Number.isSafeInteger(tag.bodyEnd) || tag.bodyEnd <= tag.bodyStart
        || typeof tag.envelopeText !== 'string' || tag.envelopeText.length !== tag.bodyStart || tag.envelopeText.length > 16000
        || typeof tag.bodyProjectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(tag.bodyProjectionHash)) return [];
      return [{ id: String(tag.id || `durable-context-prefix-${index}`), kind: 'context-prefix', contextKind: tag.contextKind,
        envelopeStart: 0, envelopeText: tag.envelopeText, bodyStart: tag.bodyStart, bodyEnd: tag.bodyEnd,
        bodyProjectionHash: tag.bodyProjectionHash }];
    }
    if (tag?.kind === 'tab-message') {
      const messageId = typeof tag.messageId === 'string' ? tag.messageId.trim() : '';
      if (!messageId || !['question', 'reply'].includes(tag.phase)) return [];
      const value = { id: String(tag.id || `durable-tab-message-tag-${index}`),
        kind: 'tab-message', messageId, phase: tag.phase };
      for (const key of ['replyTo', 'sourceTabId', 'sourceTabName', 'sourceProjectId',
        'targetTabId', 'targetTabName', 'targetProjectId']) {
        if (typeof tag[key] === 'string' && tag[key].trim()) value[key] = tag[key].trim();
      }
      if (Number.isSafeInteger(tag.bodyStart) && tag.bodyStart >= 0
        && Number.isSafeInteger(tag.bodyEnd) && tag.bodyEnd >= tag.bodyStart) {
        value.bodyStart = tag.bodyStart;
        value.bodyEnd = tag.bodyEnd;
        if (Number.isSafeInteger(tag.envelopeStart) && tag.envelopeStart >= 0 && tag.envelopeStart <= tag.bodyStart) {
          value.envelopeStart = tag.envelopeStart;
        }
        if (typeof tag.envelopeText === 'string' && tag.envelopeText.length <= 16000) value.envelopeText = tag.envelopeText;
        if (typeof tag.bodyProjectionHash === 'string' && /^[a-f0-9]{64}$/.test(tag.bodyProjectionHash)) {
          value.bodyProjectionHash = tag.bodyProjectionHash;
        }
      }
      return [value];
    }
    if (tag?.kind === 'prompt-origin') {
      const source = String(tag.source || '').trim();
      const systemSource = source === 'system' ? systemPromptSource(tag.systemSource) : null;
      if (source !== 'loop' && source !== 'terminal-mcp' && !systemSource) return [];
      return [{
        id: String(tag.id || `durable-prompt-origin-tag-${index}`),
        kind: 'prompt-origin',
        source,
        ...(systemSource ? { systemSource } : {}),
        ...((systemSource || source === 'terminal-mcp') && typeof tag.auditSourceIdentity === 'string' && tag.auditSourceIdentity.trim()
          ? { auditSourceIdentity: tag.auditSourceIdentity.trim() }
          : {}),
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
      ...(Number.isSafeInteger(tag.bodyStart) && tag.bodyStart >= 0
        && Number.isSafeInteger(tag.bodyEnd) && tag.bodyEnd >= tag.bodyStart
        ? { bodyStart: tag.bodyStart, bodyEnd: tag.bodyEnd,
          ...(typeof tag.envelopeText === 'string' && tag.envelopeText.length <= 16000 ? { envelopeText: tag.envelopeText } : {}),
          ...(typeof tag.bodyProjectionHash === 'string' && /^[a-f0-9]{64}$/.test(tag.bodyProjectionHash)
            ? { bodyProjectionHash: tag.bodyProjectionHash } : {}),
          ...(Number.isSafeInteger(tag.envelopeStart) && tag.envelopeStart >= 0 && tag.envelopeStart <= tag.bodyStart
            ? { envelopeStart: tag.envelopeStart } : {}) } : {}),
      ...(optionalString(tag.sourceTabName) ? { sourceTabName: optionalString(tag.sourceTabName) } : {}),
      ...(optionalString(tag.targetTabName) ? { targetTabName: optionalString(tag.targetTabName) } : {}),
      ...(optionalString(tag.sourceProjectId) ? { sourceProjectId: optionalString(tag.sourceProjectId) } : {}),
      ...(optionalString(tag.targetProjectId) ? { targetProjectId: optionalString(tag.targetProjectId) } : {}),
      ...(optionalString(tag.runKind) ? { runKind: optionalString(tag.runKind) } : {}),
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
  // Never accept a caller's purported canonical proof. Only internal DB-copy
  // validation opts in; creation is from an exact confirmed durable receipt.
  const authoringProjection = storedAuthoring
    ? normalizeHistoryAuthoringProjection(snapshot?.authoringProjection) : null;
  const historySendStartedAt = Number.isFinite(snapshot?.historySendStartedAt) && snapshot.historySendStartedAt > 0
    ? snapshot.historySendStartedAt : null;
  return promptChips.length > 0 || semanticTags.length > 0 || imageRefs.length > 0 || authoringProjection || historySendStartedAt
    ? {
        version: authoringProjection ? 4 : imageRefs.length > 0 ? 3 : 2,
        promptChips,
        semanticTags,
        imagePaths: imageRefs,
        ...(historySendStartedAt ? { historySendStartedAt } : {}),
        ...(authoringProjection ? { authoringProjection } : {}),
      }
    : null;
}

function promptPresentationHistorySessionId(snapshot) {
  const sessionId = typeof snapshot?.historySessionId === 'string'
    ? snapshot.historySessionId.trim()
    : '';
  return sessionId || null;
}

function saveAuditedPromptPresentation(db, {
  toolType,
  sessionId,
  entryUuid = null,
  auditTimestamp,
  actualText,
  actualHash = null,
  snapshot,
  trustedContextPrefix = false,
} = {}) {
  const normalized = normalizePromptPresentationSnapshot(snapshot, { contextProof: trustedContextPrefix });
  if (!normalized || !db?.saveHistoryPromptPresentation) return false;
  const hash = String(actualHash || promptTransportHash(actualText)).trim();
  if (!toolType || !sessionId || !auditTimestamp || !hash) return false;
  // A late ordinary audit/semantic-tag update must not erase the already
  // proven canonical authoring sidecar after its receipt has expired.
  const existing = toolType === 'codex' || toolType === 'claude'
    ? readPromptPresentationByAudit(db, toolType, sessionId, auditTimestamp, hash) : null;
  const authoringProjection = storedAuthoringProjection(existing);
  const requestPresentation = storedClaudeRequestPresentation(existing);
  const savedContexts = normalizePromptPresentationSnapshot({ semanticTags: (existing?.chips || [])
    .filter(tag => tag.kind === 'context-prefix') }, { contextProof: true })?.semanticTags || [];
  const contextTags = normalized.semanticTags.filter(tag => tag.kind === 'context-prefix');
  if (savedContexts.length && contextTags.length && JSON.stringify(savedContexts) !== JSON.stringify(contextTags)) return false;
  const semanticTags = [...normalized.semanticTags, ...(!contextTags.length ? savedContexts : [])];
  if (requestPresentation && entryUuid && entryUuid !== requestPresentation.binding.entryUuid) return false;
  return db.saveHistoryPromptPresentation({
    toolType,
    sessionId,
    entryUuid,
    auditTimestamp,
    transportHash: hash,
    schemaVersion: requestPresentation ? 5 : authoringProjection ? 4 : normalized.version,
    // The legacy column is named chips_json, but schema v2 also stores
    // presentation-neutral semantic tags. Readers split the two kinds before
    // exposing them to History/Timeline.
    chips: [
      ...normalized.promptChips,
      ...semanticTags,
      ...(authoringProjection ? splitPromptPresentationRow(existing).imagePaths
        .map((ref, index) => ({ ...ref, kind: 'image-ref', presentationIndex: index })) : normalized.imagePaths),
      ...(authoringProjection ? [authoringProjection] : []),
      ...(requestPresentation ? [requestPresentation] : []),
    ],
  });
}

function collectHistoryImagePathMarkersOutsidePastedContent(value) {
  const text = String(value || '');
  const paths = [];
  let cursor = 0;
  while (cursor < text.length) {
    const envelope = findPastedContentEnvelope(text, cursor);
    const openAt = envelope?.start ?? -1;
    const segmentEnd = openAt < 0 ? text.length : openAt;
    const segment = text.slice(cursor, segmentEnd);
    const markerRe = new RegExp(HISTORY_IMAGE_PATH_RE_SOURCE, 'gi');
    let match;
    while ((match = markerRe.exec(segment)) !== null) {
      const filePath = String(match[1] || '').trim();
      if (filePath) paths.push(filePath);
    }
    if (openAt < 0) break;
    // An incomplete pasted-content wrapper is ambiguous. Do not reinterpret
    // anything after it as an attachment marker.
    if (!envelope.valid) break;
    cursor = envelope.end;
  }
  return paths;
}

function splitPromptPresentationRow(row) {
  const chips = Array.isArray(row?.chips) ? row.chips : [];
  return {
    promptChips: chips.filter(item => item?.kind === 'prompt' || item?.kind === 'paste' && item?.messageReference),
    semanticTags: chips.filter(item => (
      item?.kind === 'orchestration' || item?.kind === 'prompt-origin' || item?.kind === 'tab-message' || item?.kind === 'context-prefix'
    )),
    imagePaths: chips
      .filter(item => item?.kind === 'image-ref')
      .map(({ kind: _kind, presentationIndex: _presentationIndex, ...ref }) => ref),
  };
}

function readPromptPresentationByAudit(db, toolType, sessionId, auditTimestamp, transportHash) {
  if (db?.getHistoryPromptPresentationByAudit) {
    return db.getHistoryPromptPresentationByAudit(toolType, sessionId, auditTimestamp, transportHash);
  }
  // Compatibility for lightweight older stores/tests; production has an exact
  // PK lookup and never scans a whole session per audit write.
  return db?.getHistoryPromptPresentations?.(toolType, sessionId)?.find(row =>
    row.auditTimestamp === auditTimestamp && row.transportHash === transportHash) || null;
}

function storedAuthoringProjection(row) {
  const items = (row?.chips || []).filter(item => item?.kind === 'authoring-projection');
  return items.length === 1 ? normalizeHistoryAuthoringProjection(items[0]) : null;
}

// This is persisted only from a confirmed receipt, never from caller-supplied
// display text. It restores the app's request representation for one exact
// History row; transport wrappers are not evidence that the user made a chip.
function normalizeClaudeRequestPresentation(value) {
  const transportText = value?.transportText ?? value?.requestText;
  if (value?.kind !== 'claude-request-presentation' || value.version !== 1
    || typeof value.requestText !== 'string' || typeof transportText !== 'string'
    || value.requestText.length > 8 * 1024 * 1024 || transportText.length > 8 * 1024 * 1024) return null;
  const origin = value.origin, binding = value.binding;
  const nonempty = value => typeof value === 'string' && value.length > 0;
  if (!origin || ['tabId', 'handoffId', 'operationKey', 'attemptId'].some(key => !nonempty(origin[key]))
    || !binding || ['sessionId', 'auditTimestamp'].some(key => !nonempty(binding[key]))
    || (!nonempty(binding.entryUuid) && !nonempty(binding.sourceIdentity))
    || !Number.isFinite(Date.parse(binding.auditTimestamp))
    || !/^[a-f0-9]{16}$/.test(binding.transportHash || '')) return null;
  let prepared;
  try {
    let source = value.requestText;
    if (value.ownedAttachments) {
      if (!validateOwnedAttachmentSnapshot(value.ownedAttachments, source, origin)) return null;
      source = renderOwnedAttachmentTransport(value.ownedAttachments, source, 'claude', value.ownedPaths).text;
    }
    prepared = prepareClaudePromptTransport(source);
  } catch { return null; }
  if (prepared.transport.text !== transportText
    || promptAuditFingerprint(value.requestText) !== value.requestHash
    || prepared.transport.auditHash !== value.preparedHash
    || (binding.transportHash === value.preparedHash && !binding.sourceIdentity && !value.ownedAttachments)) return null;
  return { kind: value.kind, version: 1,
    origin: Object.fromEntries(['tabId', 'handoffId', 'operationKey', 'attemptId'].map(key => [key, origin[key]])),
    binding: { sessionId: binding.sessionId,
      ...(nonempty(binding.entryUuid) ? { entryUuid: binding.entryUuid } : {}),
      ...(nonempty(binding.sourceIdentity) ? { sourceIdentity: binding.sourceIdentity } : {}),
      auditTimestamp: binding.auditTimestamp, transportHash: binding.transportHash },
    requestText: value.requestText,
    ...(transportText !== value.requestText ? { transportText } : {}),
    requestHash: value.requestHash, preparedHash: value.preparedHash,
    ...(value.ownedAttachments ? { ownedAttachments: value.ownedAttachments, ownedPaths: value.ownedPaths } : {}) };
}

function storedClaudeRequestPresentation(row) {
  const items = (row?.chips || []).filter(item => item?.kind === 'claude-request-presentation');
  return items.length === 1 ? normalizeClaudeRequestPresentation(items[0]) : null;
}

function claudeRequestPresentationFromReceipt(record) {
  const receipt = record?.receipt, audit = record?.auditIdentity;
  const directReason = ['claude_owned_composer_provider_transform',
    'claude_request_transport_exact', 'owned_mobile_attachment_paths'].includes(receipt?.canonicalReason);
  const queuedReason = ['provider-queue-dequeue', 'provider-queue-remove'].includes(
    receipt?.canonicalReason,
  );
  const queuedSourceIdentity = queuedReason
    && typeof audit?.sourceIdentity === 'string'
    && audit.sourceIdentity
    && receipt?.sourceIdentity === audit.sourceIdentity
    && receipt?.providerQueue?.sourceIdentity === audit.sourceIdentity
    ? audit.sourceIdentity : null;
  if (record?.provider !== 'claude' || record.state !== 'confirmed'
    || receipt?.exactAuditConfirmed !== true || receipt.canonicalized !== true
    || (!directReason && !queuedReason)
    || !audit || audit.provider !== 'claude' || audit.attemptId !== record.attemptId
    || (!directReason && !queuedSourceIdentity)
    || (directReason && (!audit.entryUuid || receipt.entryUuid !== audit.entryUuid))
    || !audit.sessionId || audit.sessionId !== record.sessionId
    || receipt.sessionId !== audit.sessionId
    || receipt.auditTimestamp !== audit.auditTimestamp || receipt.actualHash !== audit.promptHash) return null;
  const transport = typeof receipt.transportText === 'string' ? receipt.transportText : '';
  const checked = validateClaudePromptRequestProjection({ tabId: record.tabId, record, audit: {
    handoffId: record.handoffId, sendOperationKey: record.operationKey, sendAttemptId: record.attemptId,
    expectedText: transport, expectedHash: promptTransportHash(transport), expectedLen: transport.length,
  } });
  if (!checked.valid) return null;
  const owned = receipt.ownedAttachmentProjection ? readOwnedAttachmentProjection(record) : null;
  if (owned && !owned.valid) return null;
  return normalizeClaudeRequestPresentation({ kind: 'claude-request-presentation', version: 1,
    origin: { tabId: record.tabId, handoffId: record.handoffId,
      operationKey: record.operationKey, attemptId: record.attemptId },
    binding: { sessionId: audit.sessionId,
      ...(directReason ? { entryUuid: audit.entryUuid } : { sourceIdentity: queuedSourceIdentity }),
      auditTimestamp: audit.auditTimestamp, transportHash: audit.promptHash },
    requestText: receipt.promptText, transportText: transport,
    requestHash: owned ? record.promptHash : checked.requestHash, preparedHash: checked.transportHash,
    ...(owned ? { ownedAttachments: receipt.ownedAttachments, ownedPaths: owned.proof.paths } : {}) });
}

function projectClaudeRequestPresentation(row, entry) {
  const projection = storedClaudeRequestPresentation(row);
  if (!projection || row?.toolType !== 'claude') return null;
  const proof = projection.binding;
  const entrySourceIdentities = new Set([entry.sourceIdentity,
    ...(Array.isArray(entry.sourceIdentityAliases) ? entry.sourceIdentityAliases : [])].filter(Boolean));
  const exactEntry = proof.entryUuid ? entry.uuid === proof.entryUuid : true;
  const exactSource = proof.sourceIdentity ? entrySourceIdentities.has(proof.sourceIdentity) : true;
  if (row.sessionId !== proof.sessionId || (entry.physicalSessionId || entry.sessionId) !== proof.sessionId
    || !exactEntry || !exactSource || row.entryUuid !== entry.uuid
    || row.auditTimestamp !== proof.auditTimestamp || entry.timestamp !== proof.auditTimestamp
    || row.transportHash !== proof.transportHash
    || (!proof.sourceIdentity && entry.promptPresentationTransportHash !== proof.transportHash)) return null;
  const content = typeof entry.fullText === 'string' ? entry.fullText : entry.content;
  const transportText = projection.transportText ?? projection.requestText;
  if (typeof content !== 'string'
    || (!(projection.ownedAttachments && content === transportText)
      && claudeNativePastedPromptText(content, transportText) !== transportText)) return null;
  // Remove only the extra proven outer envelope. Any app-authored saved/paste
  // wrappers INSIDE the original request retain their existing representation.
  return { ...entry, content: projection.requestText,
    ...(typeof entry.fullText === 'string' ? { fullText: projection.requestText } : {}) };
}

function backfillConfirmedClaudeRequestPresentations(db, records) {
  if (!db?.saveHistoryPromptPresentation) return 0;
  let saved = 0;
  const candidates = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const projection = claudeRequestPresentationFromReceipt(record);
    if (!projection) continue;
    const key = JSON.stringify([projection.binding.sessionId,
      projection.binding.auditTimestamp, projection.binding.transportHash]);
    const signature = JSON.stringify(projection);
    const previous = candidates.get(key);
    if (previous && previous.signature !== signature) previous.conflict = true;
    else if (!previous) candidates.set(key, { record, projection, signature });
  }
  for (const { record, projection, conflict } of candidates.values()) {
    if (conflict) continue;
    const proof = projection.binding;
    const existing = readPromptPresentationByAudit(db, 'claude', proof.sessionId, proof.auditTimestamp, proof.transportHash);
    if (existing?.entryUuid && existing.entryUuid !== proof.entryUuid) continue;
    if ((existing?.chips || []).some(item => item.kind === 'claude-request-presentation')) continue;
    const snapshot = normalizePromptPresentationSnapshot(record.receipt.presentationSnapshot);
    const chips = existing?.chips || (snapshot
      ? [...snapshot.promptChips, ...snapshot.semanticTags, ...snapshot.imagePaths] : []);
    if (db.saveHistoryPromptPresentation({ toolType: 'claude', sessionId: proof.sessionId,
      entryUuid: proof.entryUuid || null, auditTimestamp: proof.auditTimestamp, transportHash: proof.transportHash,
      schemaVersion: 5, chips: [...chips, projection] })) {
      saved++;
      console.log('[ClaudeRequestPresentation] persisted'
        + ' tab=' + record.tabId.slice(-12)
        + ' handoff=' + record.handoffId
        + ' attempt=' + record.attemptId
        + ' session=' + proof.sessionId.slice(0, 8)
        + ' binding=' + (proof.entryUuid ? 'entry-uuid' : 'queue-source'));
    }
  }
  return saved;
}

function backfillConfirmedCanonicalAuthoringPresentations(db, records) {
  if (!db?.saveHistoryPromptPresentation) return 0;
  const candidates = new Map(); let saved = backfillConfirmedClaudeRequestPresentations(db, records);
  for (const record of Array.isArray(records) ? records : []) {
    const projection = historyAuthoringProjectionFromReceipt(record);
    if (!projection) continue;
    const key = JSON.stringify([projection.binding.sessionId, projection.binding.auditTimestamp, projection.binding.transportHash]);
    const signature = JSON.stringify([projection.origin, projection.requestSha256, projection.transportSha256]);
    const previous = candidates.get(key);
    if (previous && previous.signature !== signature) previous.conflict = true;
    else if (!previous) candidates.set(key, { record, projection, signature });
  }
  for (const { record, projection, conflict } of candidates.values()) {
    if (conflict) continue;
    const { sessionId, auditTimestamp, transportHash } = projection.binding;
    const existing = readPromptPresentationByAudit(db, 'codex', sessionId, auditTimestamp, transportHash);
    const authoredItems = (existing?.chips || []).filter(item => item?.kind === 'authoring-projection');
    if (authoredItems.length) continue; // never overwrite a different/corrupt prior claim
    const nativeSlots = projection.carrier === 'native-image-slots';
    if (existing?.entryUuid && existing.entryUuid !== projection.binding.entryUuid) continue;
    const normalized = normalizePromptPresentationSnapshot(record.receipt.presentationSnapshot)
      || (nativeSlots ? normalizePromptPresentationSnapshot({ imagePaths:
        record.receipt.expectedImageRefs.map((ref, index) => ({ ...ref, id: index + 1 })) }) : null)
      || (projection.parts.some(part => part.kind === 'file') ? { promptChips: [], semanticTags: [], imagePaths: [] } : null);
    if (!normalized) continue;
    let chips = existing?.chips || [...normalized.promptChips, ...normalized.semanticTags, ...normalized.imagePaths];
    let refs = splitPromptPresentationRow({ chips }).imagePaths;
    const images = projection.parts.filter(part => part.kind === 'image');
    if (nativeSlots) {
      // Replace only the refs admitted by this exact canonical audit, keeping
      // chips/tags and deliberate duplicate image occurrences in their order.
      if (refs.length && (refs.length !== images.length || images.some((image, index) =>
        refs[index]?.id !== image.id || ![image.sourcePath, image.transportPath].includes(refs[index]?.path)))) continue;
      const original = normalizePromptPresentationSnapshot({ imagePaths:
        record.receipt.expectedImageRefs.map((ref, index) => ({ ...ref, id: index + 1 })) });
      if (!original) continue;
      chips = [...chips.filter(item => item.kind !== 'image-ref'), ...original.imagePaths];
      refs = splitPromptPresentationRow({ chips }).imagePaths;
    }
    if (refs.length !== images.length || images.some(image => !refs.some(ref => ref.id === image.id && ref.path === image.sourcePath))) continue;
    if (db.saveHistoryPromptPresentation({ toolType: 'codex', sessionId, auditTimestamp, transportHash,
      entryUuid: existing?.entryUuid || projection.binding.entryUuid,
      schemaVersion: 4, chips: [...chips, projection] })) {
      saved++;
      console.log('[HistoryAuthoringProjection] persisted'
        + ' tab=' + projection.origin.tabId.slice(-12)
        + ' handoff=' + projection.origin.handoffId
        + ' attempt=' + projection.origin.attemptId
        + ' session=' + sessionId + ' images=' + images.length);
    }
  }
  return saved;
}

/**
 * Restore app-owned service provenance from a confirmed send, never its text.
 * Older audits may know only the physical source identity, not canonical UUID;
 * keep that proof on the pending sidecar until the transcript matches it.
 * Idempotent and bounded by the existing receipt store's retention/capacity.
 */
function backfillConfirmedSystemPromptPresentations(db, records) {
  // Legacy entry point also restores MCP origins from exact confirmed receipts.
  // Both are service metadata; neither creates an orchestration run.
  // Reuse the existing startup pass over confirmed receipts. This persists
  // canonical authoring before any new send can prune TTL-settled receipts.
  backfillConfirmedCanonicalAuthoringPresentations(db, records);
  if (!db?.getHistoryPromptPresentations || !db?.saveHistoryPromptPresentation) return 0;
  const rowsBySession = new Map();
  let saved = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const receipt = record?.receipt;
    const audit = record?.auditIdentity;
    const tag = promptOriginTagForSource(receipt?.source);
    if (!['system', 'terminal-mcp'].includes(tag?.source) || record.state !== 'confirmed'
      || receipt?.exactAuditConfirmed !== true || !audit
      || !record.attemptId || audit.attemptId !== record.attemptId
      || receipt.attemptId !== record.attemptId
      || !audit.provider || audit.provider !== record.provider
      || (receipt.provider && receipt.provider !== audit.provider)
      || !audit.sessionId || receipt.sessionId !== audit.sessionId
      || !audit.promptHash || receipt.actualHash !== audit.promptHash
      || !audit.auditTimestamp || receipt.auditTimestamp !== audit.auditTimestamp
      || (!audit.entryUuid && !audit.sourceIdentity)
      || (receipt.sourceIdentity && receipt.sourceIdentity !== audit.sourceIdentity)
      || (receipt.entryUuid && receipt.entryUuid !== audit.entryUuid)) continue;
    const key = `${audit.provider}\u0000${audit.sessionId}`;
    if (!rowsBySession.has(key)) {
      rowsBySession.set(key, db.getHistoryPromptPresentations(audit.provider, audit.sessionId));
    }
    const rows = rowsBySession.get(key);
    const row = rows.find(candidate => candidate.auditTimestamp === audit.auditTimestamp
      && candidate.transportHash === audit.promptHash);
    // A pre-existing bound sidecar cannot serve as proof for a different send.
    // When an old receipt knows only sourceIdentity, do not assume its UUID
    // from another sidecar that happens to share the timestamp/hash tuple.
    if (row?.entryUuid && row.entryUuid !== audit.entryUuid) continue;
    const snapshot = splitPromptPresentationRow(row);
    if (snapshot.semanticTags.some(item => item.kind === tag.kind
      && item.source === tag.source && item.systemSource === tag.systemSource)) continue;
    const semanticTag = {
      ...tag,
      ...(audit.sourceIdentity ? { auditSourceIdentity: audit.sourceIdentity } : {}),
    };
    const entryUuid = row?.entryUuid || audit.entryUuid || null;
    const nextSnapshot = { ...snapshot, semanticTags: [...snapshot.semanticTags, semanticTag] };
    if (!saveAuditedPromptPresentation(db, {
      toolType: audit.provider,
      sessionId: audit.sessionId,
      entryUuid,
      auditTimestamp: audit.auditTimestamp,
      actualHash: audit.promptHash,
      snapshot: nextSnapshot,
    })) continue;
    // Avoid duplicate writes even if a caller supplied repeated records.
    rows.push({
      toolType: audit.provider, sessionId: audit.sessionId, entryUuid,
      auditTimestamp: audit.auditTimestamp, transportHash: audit.promptHash,
      chips: [...snapshot.promptChips, ...nextSnapshot.semanticTags,
        ...snapshot.imagePaths.map(image => ({ ...image, kind: 'image-ref' }))],
    });
    if (row) row.chips = rows[rows.length - 1].chips;
    saved += 1;
  }
  return saved;
}

function matchesPendingPromptPresentationIdentity(row, entry) {
  const bindings = (Array.isArray(row?.chips) ? row.chips : []).filter(item => (
    item?.kind === 'prompt-origin' && ['system', 'terminal-mcp'].includes(item.source) && item.auditSourceIdentity
  ));
  const requestBinding = storedClaudeRequestPresentation(row)?.binding?.sourceIdentity;
  if (requestBinding) bindings.push({ auditSourceIdentity: requestBinding });
  if (bindings.length === 0 || row.entryUuid === entry.uuid) return true;
  const identities = new Set([
    entry.sourceIdentity,
    ...(Array.isArray(entry.sourceIdentityAliases) ? entry.sourceIdentityAliases : []),
  ].filter(Boolean));
  return bindings.every(tag => identities.has(tag.auditSourceIdentity));
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
  const refs = Array.isArray(imagePaths) ? imagePaths.map(ref => ({ ...ref })) : [];
  // Native Codex records carry paths beside the text, not in [imagePath: …].
  // A persisted app presentation wins for the same slot; otherwise retain the
  // provider's exact slot/path and resolve it through the existing asset store.
  let recovered = 0;
  for (const ref of Array.isArray(entry?.imagePaths) ? entry.imagePaths : []) {
    if (!ref?.path || refs.some(existing => Number(existing.id) === Number(ref.id))) continue;
    let managed = null;
    try { managed = resolveManagedImageRef(ref); } catch {}
    refs.push(managed ? { ...managed, id: ref.id, availability: 'available' } : { ...ref });
    if (managed) recovered += 1;
  }
  if (markerPaths.length === 0) return { imagePaths: refs, recovered };
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

// Older app COW commits copied the transcript/lineage but omitted prompt
// sidecars. Recover only service tags, through that immutable lineage and an
// exact full-text proof; raw text, delivery receipts and attachment owners stay
// untouched. New commits copy the complete sidecar in their transaction.
function mappedCodexServicePresentations(db, sessionId, entries, logger) {
  if (!db?.getSessionHistoryContext || !db?.getHistoryPromptPresentations) return [];
  let pending = entries.filter(entry => entry?.uuid && typeof entry.content === 'string'
    && ['user', 'queued'].includes(entry.role));
  const recovered = [];
  const visited = new Set();
  let owner = sessionId;
  for (let depth = 0; pending.length && depth < 16 && !visited.has(owner); depth++) {
    visited.add(owner);
    const fork = db.getSessionHistoryContext(owner)?.fork;
    if (fork?.provider !== 'codex' || fork.sessionId !== owner || fork.snapshotComplete !== true
      || !['app', 'terminal-mcp', 'orchestration'].includes(fork.origin)
      || !['rewind', 'edit', 'delete'].includes(resolveForkOperation(fork))
      || !fork.sourceSessionId || visited.has(fork.sourceSessionId)) break;
    const parent = fork.sourceSessionId;
    const membership = new Set(Array.isArray(fork.entryUuids) ? fork.entryUuids : []);
    const parentRows = new Map(db.getHistoryPromptPresentations('codex', parent)
      .map(row => [`${row.auditTimestamp}\u0000${row.transportHash}`, row]));
    const next = [];
    for (const entry of pending) {
      // The first event proves that this physical child row was copied, not
      // appended later. Older ancestors must also predate this audited row.
      if (depth === 0 && (!membership.has(entry.uuid)
        || !entry.uuid.startsWith('codex-user-' + owner + '-'))) continue;
      const occurredAt = Number(fork.occurredAt);
      const forkTime = occurredAt > 1e12 ? occurredAt : occurredAt * 1000;
      const auditTime = Date.parse(entry.promptPresentationAuditTimestamp || entry.timestamp);
      if (depth > 0 && (!Number.isFinite(forkTime) || !Number.isFinite(auditTime)
        || Math.floor(auditTime / 1000) > Math.floor(forkTime / 1000))) continue;
      const timestamp = normalizeCodexPromptIdentityTimestamp(entry.promptPresentationAuditTimestamp || entry.timestamp);
      const transportHash = String(entry.promptPresentationTransportHash || '') || promptTransportHash(entry.content);
      const row = parentRows.get(`${entry.promptPresentationAuditTimestamp || entry.timestamp}\u0000${transportHash}`);
      if (!row) { next.push(entry); continue; }
      const fullHash = crypto.createHash('sha256').update(entry.content).digest('hex');
      if (!timestamp || row.sessionId !== parent
        || !row.entryUuid?.startsWith('codex-user-' + parent + '-')
        || normalizeCodexPromptIdentityTimestamp(row.auditTimestamp) !== timestamp
        || row.transportHash !== transportHash
        || !splitPromptPresentationRow(row).semanticTags.some(tag => (
          ['tab-message', 'orchestration', 'context-prefix'].includes(tag.kind) && tag.bodyProjectionHash === fullHash
        ))) continue;
      // Rebase the READ projection, never the source's durable receipt/row.
      recovered.push({ ...row, sessionId, entryUuid: entry.uuid,
        auditTimestamp: entry.promptPresentationAuditTimestamp || entry.timestamp,
        transportHash, chips: splitPromptPresentationRow(row).semanticTags });
    }
    pending = next;
    owner = parent;
  }
  if (recovered.length) logger?.info?.('[HistoryPromptPresentation:CodexLineage] child='
    + String(sessionId).slice(0, 8) + ' restored=' + recovered.length + ' mode=read-only-exact');
  return recovered;
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
  const directRows = [...exactRows, ...sessionRows];
  const directUuids = new Set(directRows.map(row => row.entryUuid).filter(Boolean));
  const inheritedRows = toolType === 'codex' ? mappedCodexServicePresentations(db, sessionId,
    source.filter(entry => !directUuids.has(entry?.uuid)), logger) : [];
  const rows = [...inheritedRows, ...directRows];

  const exact = new Map();
  const pending = new Map();
  const pendingBySourceIdentity = new Map();
  const nativeBySourceIdentity = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.entryUuid) exact.set(row.entryUuid, row);
    pending.set(`${row.auditTimestamp}\u0000${row.transportHash}`, row);
    const sourceIdentity = storedClaudeRequestPresentation(row)?.binding?.sourceIdentity;
    if (sourceIdentity) {
      pendingBySourceIdentity.set(sourceIdentity,
        pendingBySourceIdentity.has(sourceIdentity) ? null : row);
    }
    const nativeProjection = storedAuthoringProjection(row);
    const nativeSource = nativeProjection?.carrier === 'native-image-slots' ? nativeProjection.binding?.sourceIdentity : null;
    if (nativeSource) {
      const prior = nativeBySourceIdentity.get(nativeSource);
      const same = prior && prior.entryUuid === row.entryUuid && prior.sessionId === row.sessionId
        && prior.auditTimestamp === row.auditTimestamp && prior.transportHash === row.transportHash
        && JSON.stringify(storedAuthoringProjection(prior)) === JSON.stringify(nativeProjection);
      if (!nativeBySourceIdentity.has(nativeSource)) nativeBySourceIdentity.set(nativeSource, row);
      else if (!same) nativeBySourceIdentity.set(nativeSource, null);
    }
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
      for (const identity of [entry.sourceIdentity, ...(entry.sourceIdentityAliases || [])].filter(Boolean)) {
        const candidate = nativeBySourceIdentity.get(identity);
        if (candidate && projectHistoryAuthoringEntry(storedAuthoringProjection(candidate), candidate, entry,
          splitPromptPresentationRow(candidate).imagePaths)) { row = candidate; break; }
      }
    }
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
        if (row && !matchesPendingPromptPresentationIdentity(row, entry)) row = null;
        if (row) break;
      }
      if (!row) {
        const sourceIdentities = [entry.sourceIdentity,
          ...(Array.isArray(entry.sourceIdentityAliases) ? entry.sourceIdentityAliases : [])]
          .filter(Boolean);
        for (const sourceIdentity of sourceIdentities) {
          const candidate = pendingBySourceIdentity.get(sourceIdentity);
          if (!candidate || !matchesPendingPromptPresentationIdentity(candidate, entry)) continue;
          row = candidate;
          break;
        }
      }
      if (row && !row.entryUuid && db.bindHistoryPromptPresentationEntry) {
        const bound = db.bindHistoryPromptPresentationEntry({
          toolType,
          sessionId,
          auditTimestamp: row.auditTimestamp,
          transportHash: row.transportHash,
          entryUuid: entry.uuid,
        });
        if (bound) row = { ...row, entryUuid: entry.uuid };
      }
    }
    const presentation = splitPromptPresentationRow(row);
    const requestPresentation = projectClaudeRequestPresentation(row, entry);
    const presentationEntry = requestPresentation || entry;
    const exactAuthoring = projectHistoryAuthoringEntry(storedAuthoringProjection(row), row, entry, presentation.imagePaths);
    const rejectedNativeProjection = !exactAuthoring && (row?.chips || []).some(item =>
      item?.kind === 'authoring-projection' && item.carrier === 'native-image-slots');
    // Typed authoring already supplies the complete image set. A literal
    // imagePath marker in one of its text parts must not be scavenged as a
    // second attachment by the compatibility recovery parser.
    const recovery = exactAuthoring ? { imagePaths: presentation.imagePaths, recovered: 0 } : recoverManagedHistoryImageRefs({
      entry: presentationEntry,
      imagePaths: rejectedNativeProjection ? [] : presentation.imagePaths,
      resolveManagedImageRef: recoverManagedImageRef,
    });
    const { promptChips, semanticTags } = presentation;
    const imagePaths = recovery.imagePaths;
    const authoredEntry = exactAuthoring || projectHistoryAuthoringEntry(storedAuthoringProjection(row), row, entry, imagePaths);
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
    if (promptChips.length === 0 && semanticTags.length === 0 && imagePaths.length === 0 && !requestPresentation && !authoredEntry) return entry;
    changed = true;
    return {
      ...(authoredEntry || presentationEntry),
      ...(promptChips.length > 0 ? { promptChips } : {}),
      ...(semanticTags.length > 0 ? { semanticTags } : {}),
      ...(imagePaths.length > 0 ? { imagePaths: authoredEntry?.imagePaths || imagePaths } : {}),
    };
  });
  return changed ? decorated : source;
}

module.exports = {
  backfillConfirmedCanonicalAuthoringPresentations,
  backfillConfirmedSystemPromptPresentations,
  buildCodexPromptPresentationRemap,
  cloneCodexPromptPresentationsForProvenChild,
  codexPromptIdentityHash,
  collectHistoryImagePathMarkersOutsidePastedContent,
  decorateHistoryPromptPresentations,
  normalizePromptPresentationSnapshot,
  normalizeClaudeRequestPresentation,
  promptPresentationHistorySessionId,
  promptTransportHash,
  recoverManagedHistoryImageRefs,
  saveAuditedPromptPresentation,
  withPromptOriginPresentation,
};

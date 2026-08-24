'use strict';

function collectCodexPayloadImagePaths(payload) {
  const paths = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) paths.push(trimmed);
  };
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.local_images)) payload.local_images.forEach(add);
    if (Array.isArray(payload.images)) payload.images.forEach(add);
  }
  return paths;
}

const CODEX_PROVIDER_IMAGE_BLOCK_RE = /<image\s+name\s*=\s*["']?\[Image(?:\s+#?(\d+))?\]["']?\s+path\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>\s*(?:<<ImageDisplayed>>|\[Image(?:\s+#?(\d+))?\])\s*<\/image\s*>/gi;

function collectCodexProviderImageBlocks(text) {
  const blocks = [];
  const pattern = new RegExp(CODEX_PROVIDER_IMAGE_BLOCK_RE.source, 'gi');
  for (const match of String(text || '').matchAll(pattern)) {
    const nameSlot = match[1] ? Number(match[1]) : null;
    const bodySlot = match[5] ? Number(match[5]) : null;
    blocks.push({
      match: match[0],
      index: match.index,
      nameSlot,
      bodySlot,
      path: match[2] || match[3] || match[4] || '',
      slotsAgree: nameSlot === null || bodySlot === null || nameSlot === bodySlot,
    });
  }
  return blocks;
}

function codexProviderImageIdentityMatches(text, expectedImagePaths) {
  const blocks = collectCodexProviderImageBlocks(text);
  if (blocks.length === 0) return { present: false, valid: true };
  const expected = (Array.isArray(expectedImagePaths) ? expectedImagePaths : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  if (expected.length === 0) {
    return { present: true, valid: false, reason: 'provider-image-without-expected-identity' };
  }

  const claimedSlots = new Set();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block.slotsAgree) {
      return { present: true, valid: false, reason: 'provider-image-slot-disagrees' };
    }
    const slot = block.nameSlot || block.bodySlot || (index + 1);
    if (!Number.isInteger(slot) || slot < 1 || slot > expected.length) {
      return { present: true, valid: false, reason: 'provider-image-slot-out-of-range' };
    }
    if (claimedSlots.has(slot)) {
      return { present: true, valid: false, reason: 'provider-image-slot-repeated' };
    }
    claimedSlots.add(slot);
    if (block.path !== expected[slot - 1]) {
      return { present: true, valid: false, reason: 'provider-image-path-mismatch' };
    }
  }
  return { present: true, valid: true };
}

function normalizeCodexProviderImageMarkup(text, imagePaths = [], {
  allowProviderMarkup = false,
} = {}) {
  const allowedPathCounts = new Map();
  for (const value of Array.isArray(imagePaths) ? imagePaths : []) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const path = value.trim();
    allowedPathCounts.set(path, (allowedPathCounts.get(path) || 0) + 1);
  }
  if (allowedPathCounts.size === 0 && allowProviderMarkup !== true) return String(text || '');

  const source = String(text || '');
  // Codex 0.147 moves the provider image envelope to the beginning of the
  // materialized user_message while leaving `[Image #N]` where that same
  // attachment occurred in the submitted text. The carriers are therefore
  // not necessarily adjacent. Determine duplicate slots after removing every
  // provider envelope, then omit only the envelope whose numbered placeholder
  // still exists elsewhere. A provider-only image remains one visible slot.
  const withoutProviderBlocks = source.replace(CODEX_PROVIDER_IMAGE_BLOCK_RE, ' ');
  const referencedSlots = new Map();
  for (const match of withoutProviderBlocks.matchAll(/\[Image\s+#?(\d+)\]/gi)) {
    referencedSlots.set(match[1], (referencedSlots.get(match[1]) || 0) + 1);
  }
  const usedPathCounts = new Map();
  const normalizedBlocks = source.replace(
    CODEX_PROVIDER_IMAGE_BLOCK_RE,
    (match, slot, doubleQuotedPath, singleQuotedPath, barePath, bodySlot) => {
      if (slot && bodySlot && slot !== bodySlot) return match;
      const path = doubleQuotedPath || singleQuotedPath || barePath || '';
      const allowed = Number(allowedPathCounts.get(path) || 0);
      const used = Number(usedPathCounts.get(path) || 0);
      const exactPathAdmitted = allowed > used;
      if (allowedPathCounts.size > 0 && !exactPathAdmitted) return match;
      if (allowedPathCounts.size === 0 && allowProviderMarkup !== true) return match;
      if (exactPathAdmitted) usedPathCounts.set(path, used + 1);
      if (slot && Number(referencedSlots.get(slot) || 0) > 0) {
        referencedSlots.set(slot, referencedSlots.get(slot) - 1);
        return ' ';
      }
      return ` [Image${slot ? ` #${slot}` : ''}] `;
    },
  );
  // Codex 0.14x can materialize one transported image as both the provider
  // block and the immediately following numbered placeholder. They are two
  // carriers for the same slot, not two attachments. Only collapse an exact
  // adjacent duplicate number; `[Image #1][Image #2]` remains two images.
  return normalizedBlocks.replace(
    /(\[Image\s+#?(\d+)\])\s*\[Image\s+#?\2\]/gi,
    '$1',
  );
}

function isCodexUserMessageAuditRecord(record) {
  const payload = record?.payload || {};
  return (record?.type === 'event_msg' && payload.type === 'user_message')
    || (
      record?.type === 'response_item'
      && payload.type === 'message'
      && payload.role === 'user'
    );
}

// Reserved model-input envelope emitted by Codex itself. Keep this classifier
// beside the canonical user-carrier reader so durable History, Timeline, live
// History and compatibility projections cannot drift on whether it is a real
// user-authored turn.
function isCodexEnvironmentContextUserText(text) {
  const value = String(text || '').trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(value);
}

// Codex persists automatically attached project instructions as role=user.
// They are useful model context and stay visible in History as a chip, but a
// clean conversation export must not pretend the user authored them.
function isCodexProjectInstructionsUserText(text) {
  const value = String(text || '').trim();
  return /^#\s+(?:AGENTS\.md|CLAUDE\.md)\s+instructions\s+for\s+[^\r\n]+(?:\r?\n|$)/i.test(value)
    && /<(?:INSTRUCTIONS|instructions)>/i.test(value.slice(0, 2000));
}

// Reserved control envelope emitted by Codex when an active persistent goal
// starts its next automatic turn. It is model input, but not user-authored
// text; presentation layers render a compact Goal status instead.
function isCodexGoalContinuationUserText(text) {
  return /^<codex_internal_context\s+source=["']goal["']\s*>[\s\S]*<\/codex_internal_context>$/i
    .test(String(text || '').trim());
}

function codexUserMessageAuditText(record, {
  preserveProviderImageMarkup = false,
} = {}) {
  if (!isCodexUserMessageAuditRecord(record)) return null;
  const payload = record?.payload || {};
  const imagePaths = collectCodexPayloadImagePaths(payload);
  if (typeof payload.message === 'string') {
    return preserveProviderImageMarkup
      ? payload.message
      : normalizeCodexProviderImageMarkup(payload.message, imagePaths);
  }
  if (typeof payload.text === 'string') {
    return preserveProviderImageMarkup
      ? payload.text
      : normalizeCodexProviderImageMarkup(payload.text, imagePaths);
  }
  if (!Array.isArray(payload.content)) return null;
  const parts = [];
  let imageIndex = 0;
  for (const item of payload.content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const type = String(item?.type || '').toLowerCase();
    if (
      type.includes('image')
      || typeof item?.image_url === 'string'
      || typeof item?.imageUrl === 'string'
    ) {
      // response_item can be the only durable carrier for an image prompt.
      // Preserve the exact content order without retaining its huge data URL.
      imageIndex += 1;
      parts.push(` [Image #${imageIndex}] `);
    } else if (typeof item?.text === 'string') {
      parts.push(item.text);
    } else if (typeof item?.value === 'string') {
      parts.push(item.value);
    } else if (typeof item?.message === 'string') {
      parts.push(item.message);
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join('');
  return preserveProviderImageMarkup
    ? joined
    : normalizeCodexProviderImageMarkup(joined, imagePaths);
}

// A persisted Codex user carrier can contain provider-owned image transport
// markup even when this particular protocol generation omitted local_images.
// Audit keeps that ambiguity byte-exact; every user-facing projection uses
// this explicit presentation contract and collapses the transport envelope to
// the single numbered image marker stored at the prompt position.
function codexUserMessagePresentationText(record) {
  const raw = codexUserMessageAuditText(record) || '';
  return normalizeCodexProviderImageMarkup(
    raw,
    collectCodexPayloadImagePaths(record?.payload || {}),
    { allowProviderMarkup: true },
  );
}

function codexUserCarrierTextsMatch(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a || !b) return false;
  if (a === b) return true;
  return !!codexCanonicalUserMessageMatch({
    expectedText: a,
    allowUnprovenImageCarrier: true,
  }, b)
    || !!codexCanonicalUserMessageMatch({
      expectedText: b,
      allowUnprovenImageCarrier: true,
    }, a);
}

function codexUserCarrierCandidatePosition(candidate) {
  const byteOffset = Number(candidate?.byteOffset ?? candidate?.record?.__byteOffset);
  if (Number.isFinite(byteOffset)) return byteOffset;
  const index = Number(candidate?.index ?? candidate?.record?.__line);
  return Number.isFinite(index) ? index : Number.POSITIVE_INFINITY;
}

// Codex can persist one physical prompt twice: an early response_item user
// carrier and a later canonical event_msg user carrier. Consumers that need
// exact identity must keep the early carrier as an alias instead of either
// drawing two turns or forgetting the identity used by a live delivery audit.
function groupCodexPreferredUserMessageAuditRecords(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const events = source
    .filter((candidate) => candidate?.record?.type === 'event_msg')
    .map((candidate) => ({
      candidate,
      text: codexUserMessageAuditText(candidate.record),
      claimed: false,
      aliases: [],
    }));
  const selected = [...events];
  for (const candidate of source) {
    if (candidate?.record?.type !== 'response_item') continue;
    const text = codexUserMessageAuditText(candidate.record);
    const responseOffset = codexUserCarrierCandidatePosition(candidate);
    const paired = events.find((event) => {
      if (event.claimed || !codexUserCarrierTextsMatch(text, event.text)) return false;
      if (candidate.turnSegment != null
        && event.candidate.turnSegment != null
        && candidate.turnSegment !== event.candidate.turnSegment) return false;
      const eventOffset = codexUserCarrierCandidatePosition(event.candidate);
      return !Number.isFinite(responseOffset)
        || !Number.isFinite(eventOffset)
        || eventOffset >= responseOffset;
    });
    if (paired) {
      paired.claimed = true;
      paired.aliases.push(candidate);
      continue;
    }
    selected.push({ candidate, text, claimed: true, aliases: [] });
  }
  return selected
    .map(({ candidate, aliases }) => ({
      candidate,
      aliases,
      firstIndex: Math.min(
        codexUserCarrierCandidatePosition(candidate),
        ...aliases.map(codexUserCarrierCandidatePosition),
      ),
    }))
    .sort((left, right) => left.firstIndex - right.firstIndex);
}

function selectCodexPreferredUserMessageAuditRecords(candidates) {
  return groupCodexPreferredUserMessageAuditRecords(candidates)
    .map((group) => group.candidate);
}

function codexPromptHasImageMarker(text) {
  return /\[(?:Image(?:\s+#?\d+)?|imagePath:\s*[^\]\r\n]+?|imageError:\s*[^\]\r\n]+?|image:\s*[^\]\r\n]+?)\]/i.test(String(text || ''));
}

function normalizeCodexPromptImageSlots(text, imagePaths = []) {
  let value = normalizeCodexProviderImageMarkup(text, imagePaths, {
    // This helper is entered only by the image-aware canonical comparison.
    // Startup recovery can have the exact transported prompt but no retained
    // structured path array, so the provider block itself remains admissible.
    allowProviderMarkup: true,
  });
  value = value
    // Older/self-closing provider carriers have no body. Full provider blocks
    // were normalized above so their label and path remain one image slot.
    .replace(/<image\s+name\s*=\s*["']?\[Image(?:\s+#?\d+)?\]["']?\s+path\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)\s*\/\s*>/gi, ' [Image] ')
    .replace(/\[imagePath:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[imageError:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[image:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[Image(?:\s+#?\d+)?\]/gi, ' [Image] ');
  const sortedPaths = [...new Set((imagePaths || []).filter(Boolean))]
    .sort((a, b) => String(b).length - String(a).length);
  for (const imagePath of sortedPaths) {
    value = value.split(String(imagePath)).join(' [Image] ');
  }
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

function codexCanonicalUserMessageMatch(audit, actualText) {
  const expected = String(audit?.expectedText || '');
  const actual = String(actualText || '');
  if (!expected) return null;

  // The Codex PTY materializes each byte of a Windows CRLF pasted through its
  // composer as a line break of its own. The rollout therefore contains LF+LF
  // for every CRLF while preserving the exact string length. This is a narrow,
  // observed provider transformation: do not generalize it to whitespace
  // collapsing or to the more common CRLF -> LF normalization.
  const ptyMaterializedExpected = expected.replace(/\r\n/g, '\n\n');
  if (ptyMaterializedExpected !== expected && actual === ptyMaterializedExpected) {
    return { reason: 'codex_pty_crlf_materialized_as_double_lf' };
  }

  // Codex normalizes only boundary whitespace when materializing user_message.
  // Accept that exact transformation, but never collapse or rewrite whitespace
  // inside the prompt: an interior difference remains delivery corruption.
  const boundaryTrimmedExpected = expected.trim();
  if (boundaryTrimmedExpected !== expected && actual === boundaryTrimmedExpected) {
    return { reason: 'codex_trimmed_boundary_whitespace' };
  }

  const payload = audit?.actualPayload || null;
  const expectedImagePaths = (Array.isArray(audit?.expectedImagePaths)
    ? audit.expectedImagePaths
    : []).filter((value) => typeof value === 'string' && value.trim());
  const payloadImagePaths = collectCodexPayloadImagePaths(payload);
  const imagePaths = expectedImagePaths.length > 0 ? expectedImagePaths : payloadImagePaths;
  const providerIdentity = codexProviderImageIdentityMatches(actual, expectedImagePaths);
  if (providerIdentity.present && expectedImagePaths.length > 0 && !providerIdentity.valid) {
    return null;
  }
  const imageCarrierAdmitted = imagePaths.length > 0
    || audit?.allowUnprovenImageCarrier === true;
  if (imageCarrierAdmitted
    && (codexPromptHasImageMarker(expected) || codexPromptHasImageMarker(actual) || imagePaths.length > 0)
    && normalizeCodexPromptImageSlots(expected, imagePaths) === normalizeCodexPromptImageSlots(actual, imagePaths)) {
    return { reason: 'codex_image_placeholder_canonical' };
  }
  return null;
}

function codexAuditRecordIsAfterBoundary(
  audit,
  {
    sessionId = null,
    filePath = null,
    byteOffset = null,
    timestamp = null,
  } = {},
) {
  const boundary = audit?.preSubmitBoundary || null;
  const sentAt = Number(audit?.sentAt || 0);
  const recordAt = Date.parse(String(timestamp || ''));

  if (!boundary) {
    // Older/non-file-backed callers have no byte boundary. A real rollout
    // timestamp is still useful, but absence of both signals must preserve the
    // previous matcher contract rather than rejecting every record.
    return !Number.isFinite(recordAt) || !Number.isFinite(sentAt) || recordAt >= sentAt;
  }

  const sameWriterFile = !!boundary.sessionId
    && !!boundary.filePath
    && String(sessionId || '') === String(boundary.sessionId)
    && String(filePath || '') === String(boundary.filePath);
  if (sameWriterFile) {
    return Number.isFinite(byteOffset)
      && Number.isFinite(boundary.fileSize)
      && Number(byteOffset) >= Number(boundary.fileSize);
  }

  // A resume/compact can hand the writer to a linked child rollout whose
  // beginning contains copied historical records. Those records retain their
  // old timestamps, so only a record materialized after Enter is causal.
  return Number.isFinite(recordAt)
    && Number.isFinite(sentAt)
    && recordAt >= sentAt;
}

function selectCodexPendingPromptAudit(
  audits,
  {
    actualText = '',
    actualHash = '',
    actualPayload = null,
    actualIdentity = null,
  } = {},
) {
  const pending = (Array.isArray(audits) ? audits : [])
    .filter((audit) => codexAuditRecordIsAfterBoundary(audit, actualIdentity || {}));
  const text = String(actualText || '');
  const exact = pending.find((audit) =>
    Number(audit?.expectedLen) === text.length
    && String(audit?.expectedHash || '') === String(actualHash || '')
  );
  if (exact) {
    return { audit: exact, canonicalMatch: null };
  }
  for (const audit of pending) {
    const canonicalMatch = codexCanonicalUserMessageMatch(
      { ...audit, actualPayload },
      text,
    );
    if (canonicalMatch) {
      return { audit, canonicalMatch };
    }
  }
  return null;
}

function partitionCodexPendingPromptAuditsForRetention(
  audits,
  {
    now = Date.now(),
    maxAgeMs,
    maxPending,
  } = {},
) {
  const source = Array.isArray(audits) ? audits : [];
  const ageBound = Number.isFinite(maxAgeMs) ? Math.max(0, Number(maxAgeMs)) : Infinity;
  const countBound = Number.isSafeInteger(maxPending) ? Math.max(0, Number(maxPending)) : Infinity;
  const evicted = [];
  const retained = [];
  for (const audit of source) {
    const sentAt = Number(audit?.sentAt);
    const ageMs = Number.isFinite(sentAt) ? Number(now) - sentAt : 0;
    if (ageMs >= ageBound) evicted.push({ audit, reason: 'age-bound' });
    else retained.push(audit);
  }
  while (retained.length > countBound) {
    evicted.push({ audit: retained.shift(), reason: 'count-bound' });
  }
  return { retained, evicted };
}

// A provisional Resume watcher intentionally withholds normal lifecycle
// processing until writer ownership is proven. The first post-Enter
// user carrier is itself part of that proof, so it needs a narrow parser that
// can inspect only audit records without publishing busy/history state. Codex
// normally writes event_msg/user_message, but image-bearing turns can persist
// only response_item/message(role=user). Both are exact provider-owned input
// records. Keep a
// separate partial buffer from the normal turn parser: once ownership is
// accepted, the held byte range is replayed through the full parser.
function consumeCodexUserMessageAuditChunk({
  chunk = '',
  incomingStartOffset = 0,
  partial = '',
  partialStartOffset = null,
} = {}) {
  const incoming = Buffer.from(String(chunk || ''), 'utf8');
  const carried = Buffer.from(String(partial || ''), 'utf8');
  const combined = carried.length > 0
    ? Buffer.concat([carried, incoming])
    : incoming;
  const combinedStartOffset = carried.length > 0 && Number.isFinite(partialStartOffset)
    ? Number(partialStartOffset)
    : Math.max(0, Number(incomingStartOffset) || 0);
  const records = [];
  let turnSegment = 0;
  let taskStartedSeen = false;
  let lineStart = 0;
  let newlineIndex = combined.indexOf(0x0a, lineStart);
  while (newlineIndex >= 0) {
    const text = combined.subarray(lineStart, newlineIndex).toString('utf8').trim();
    if (text) {
      try {
        const record = JSON.parse(text);
        const lifecycleType = record?.type === 'event_msg' ? record?.payload?.type : null;
        if (lifecycleType === 'task_started') {
          // Codex may persist the user carrier immediately before its first
          // task_started. Keep that pair together, but a second start without a
          // terminal record is still a hard boundary to a new provider turn.
          if (taskStartedSeen) turnSegment += 1;
          taskStartedSeen = true;
        } else if (lifecycleType === 'task_complete' || lifecycleType === 'turn_aborted') {
          turnSegment += 1;
          taskStartedSeen = false;
        }
        if (isCodexUserMessageAuditRecord(record)) {
          records.push({
            record,
            byteOffset: combinedStartOffset + lineStart,
            turnSegment,
          });
        }
      } catch {
        // A complete newline-delimited record that does not parse is not
        // delivery proof. The full watcher owns diagnostics for malformed
        // rollout rows; this narrow reader only extracts positive evidence.
      }
    }
    lineStart = newlineIndex + 1;
    newlineIndex = combined.indexOf(0x0a, lineStart);
  }
  const remaining = combined.subarray(lineStart);
  return {
    records,
    partial: remaining.toString('utf8'),
    partialStartOffset: combinedStartOffset + lineStart,
  };
}

module.exports = {
  codexUserMessageAuditText,
  codexUserMessagePresentationText,
  codexUserCarrierTextsMatch,
  codexAuditRecordIsAfterBoundary,
  codexCanonicalUserMessageMatch,
  codexPromptHasImageMarker,
  collectCodexPayloadImagePaths,
  consumeCodexUserMessageAuditChunk,
  isCodexEnvironmentContextUserText,
  isCodexGoalContinuationUserText,
  isCodexProjectInstructionsUserText,
  isCodexUserMessageAuditRecord,
  normalizeCodexProviderImageMarkup,
  normalizeCodexPromptImageSlots,
  partitionCodexPendingPromptAuditsForRetention,
  groupCodexPreferredUserMessageAuditRecords,
  selectCodexPendingPromptAudit,
  selectCodexPreferredUserMessageAuditRecords,
};

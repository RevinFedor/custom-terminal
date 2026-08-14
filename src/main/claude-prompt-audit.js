'use strict';

const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const fs = require('node:fs');
const path = require('node:path');
const { extractClaudePromptCarrier } = require('./claude-prompt-carriers');

const DEFAULT_CLAUDE_AUDIT_READ_BYTES = 2 * 1024 * 1024;

async function waitForClaudeTranscriptMaterialization(
  transcriptPath,
  { timeoutMs = 8000, fileSystem = fs } = {},
) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) {
    return { materialized: false, reason: 'transcript-path-unavailable' };
  }
  const resolvedPath = path.resolve(transcriptPath);
  const targetDirectory = path.dirname(resolvedPath);
  const exists = async () => {
    try {
      await fileSystem.promises.access(resolvedPath, fileSystem.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists()) {
    return { materialized: true, reason: 'already-present', transcriptPath: resolvedPath };
  }

  const deepestExistingDirectory = async () => {
    let candidate = targetDirectory;
    while (true) {
      try {
        const stat = await fileSystem.promises.stat(candidate);
        if (stat.isDirectory()) return candidate;
      } catch {}
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  };

  return await new Promise((resolve) => {
    let settled = false;
    let watcher = null;
    let watchedDirectory = null;
    let timer = null;
    let refreshRunning = false;
    let refreshRequested = false;
    const finish = (materialized, reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { watcher?.close(); } catch {}
      resolve({ materialized, reason, transcriptPath: resolvedPath });
    };
    const refreshWatch = async () => {
      if (settled) return;
      if (refreshRunning) {
        refreshRequested = true;
        return;
      }
      refreshRunning = true;
      try {
        do {
          refreshRequested = false;
          if (await exists()) {
            finish(true, 'file-created');
            return;
          }
          if (settled) return;
          const nextDirectory = await deepestExistingDirectory();
          if (settled) return;
          if (!nextDirectory) {
            finish(false, 'watch-root-unavailable');
            return;
          }
          if (nextDirectory !== watchedDirectory || !watcher) {
            try { watcher?.close(); } catch {}
            watcher = null;
            watchedDirectory = null;
            try {
              const nextWatcher = fileSystem.watch(nextDirectory, { persistent: false }, () => {
                void refreshWatch().catch(() => finish(false, 'watch-refresh-failed'));
              });
              nextWatcher.on('error', () => finish(false, 'watch-error'));
              watcher = nextWatcher;
              watchedDirectory = nextDirectory;
            } catch (error) {
              finish(false, error?.code || 'watch-start-failed');
              return;
            }
          }
          // Close both races: the exact file or another directory level may
          // materialize between discovery and watcher installation.
          if (await exists()) {
            finish(true, 'file-created');
            return;
          }
          if (settled) return;
          const deepestAfterWatch = await deepestExistingDirectory();
          if (settled) return;
          if (deepestAfterWatch && deepestAfterWatch !== watchedDirectory) {
            refreshRequested = true;
          }
        } while (!settled && refreshRequested);
      } finally {
        refreshRunning = false;
        if (settled) {
          try { watcher?.close(); } catch {}
          watcher = null;
          watchedDirectory = null;
          return;
        }
        if (!settled && refreshRequested) {
          void refreshWatch().catch(() => finish(false, 'watch-refresh-failed'));
        }
      }
    };

    timer = setTimeout(
      () => finish(false, 'materialization-timeout'),
      Math.max(1, Number(timeoutMs) || 8000),
    );
    // A first session in a new cwd may not have its project directory yet.
    // Start at the nearest existing ancestor and move the exact-path watcher
    // down as Claude creates each directory level. Unrelated events can only
    // trigger another exact access check; they never prove materialization.
    void refreshWatch().catch(() => finish(false, 'watch-start-failed'));
  });
}

function shouldStageClaudeUserPromptAudit({
  fast = false,
  broadcastTabId = null,
  submit = false,
  submitSequence = '\r',
  isCodexPasteSource = false,
  content = '',
} = {}) {
  return !fast
    && !!broadcastTabId
    && submit === true
    && submitSequence !== '\t'
    && !isCodexPasteSource
    && !String(content || '').trimStart().startsWith('/');
}

/**
 * A materialized transcript must provide a byte boundary before Enter. The
 * only supported exception is Claude's very first prompt: no JSONL path exists
 * until UserPromptSubmit creates it, so causality comes from the exact live
 * Claude process already bound to this tab and the later hook payload.
 */
function classifyClaudePromptAuditAdmission({
  boundary = null,
  hookRoute = null,
  expectedTabId = null,
} = {}) {
  if (boundary?.available === true) {
    return { allowed: true, mode: 'transcript-boundary', reason: null };
  }

  const routePid = Number(hookRoute?.pid);
  const freshRouteProven = boundary?.reason === 'transcript-unresolved'
    && !boundary?.transcriptPath
    && hookRoute?.bound === true
    && !!expectedTabId
    && hookRoute?.tabId === expectedTabId
    && Number.isSafeInteger(routePid)
    && routePid > 0;
  if (freshRouteProven) {
    return {
      allowed: true,
      mode: 'fresh-hook-route',
      reason: 'first-prompt-awaits-exact-user-prompt-submit',
    };
  }

  return {
    allowed: false,
    mode: 'unavailable',
    reason: boundary?.reason || 'audit-boundary-unavailable',
  };
}

function isFreshClaudePromptAudit(audit) {
  const boundary = audit?.preSubmitBoundary;
  return boundary?.available !== true
    && boundary?.reason === 'transcript-unresolved'
    && !boundary?.transcriptPath;
}

function classifyClaudePromptSubmitRouteAdmission(
  audit,
  {
    hookTabId = null,
    hookPpid = null,
    hookPidTabId = null,
  } = {},
) {
  if (!isFreshClaudePromptAudit(audit)) {
    return { allowed: true, mode: 'route-not-required', reason: null };
  }

  const proofPid = Number(audit?.preSubmitRouteProof?.pid);
  const eventPid = Number(hookPpid);
  const exact = !!hookTabId
    && audit?.preSubmitRouteProof?.tabId === hookTabId
    && hookPidTabId === hookTabId
    && Number.isSafeInteger(proofPid)
    && proofPid > 0
    && Number.isSafeInteger(eventPid)
    && eventPid === proofPid;
  if (exact) {
    return {
      allowed: true,
      mode: 'fresh-exact-hook-route',
      reason: 'hook-tab-and-pid-match-pre-submit-proof',
    };
  }

  return {
    allowed: false,
    mode: 'fresh-hook-route-unproven',
    reason: 'hook-tab-or-pid-mismatch',
  };
}

function extractClaudeUserText(record) {
  return extractClaudePromptCarrier(record)?.text ?? null;
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

function readClaudeUserRecordsFromBuffer(
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
    if (firstNewline < 0) return [];
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
        const carrier = extractClaudePromptCarrier(record);
        const text = carrier?.text ?? null;
        if (text !== null) {
          candidates.push({
            record,
            text,
            promptCarrierKind: carrier.kind,
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
  return candidates;
}

function readLastClaudeUserRecordFromBuffer(buffer, transcriptPath = null, options = {}) {
  const candidates = readClaudeUserRecordsFromBuffer(buffer, transcriptPath, options);
  return candidates[candidates.length - 1] || null;
}

async function readClaudeUserRecords(
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
      if (fileSize <= start) return [];
      const length = Math.min(fileSize - start, normalizeReadLimit(maxReadBytes));
      const read = await readRange(handle, start, length);
      return readClaudeUserRecordsFromBuffer(read.buffer, resolvedPath, {
        baseOffset: start,
        skipLeadingPartial: boundary.endedWithNewline !== true,
        bytesRead: read.bytesRead,
        readMode: 'post-boundary-offset',
      });
    }

    const tail = await readBoundedTail(handle, fileSize, maxReadBytes);
    return readClaudeUserRecordsFromBuffer(tail.buffer, resolvedPath, {
      baseOffset: tail.baseOffset,
      skipLeadingPartial: tail.skipLeadingPartial,
      bytesRead: tail.bytesRead,
      readMode: 'bounded-tail',
    });
  } finally {
    await handle.close();
  }
}

async function readLastClaudeUserRecord(
  transcriptPath,
  boundary = null,
  options = {},
) {
  const candidates = await readClaudeUserRecords(transcriptPath, boundary, options);
  return candidates[candidates.length - 1] || null;
}

/**
 * UserPromptSubmit carries Claude's exact accepted prompt, but not our handoff
 * id. Bind the new execution turn only when that payload identifies one
 * already-submitted pending audit. Identical concurrent sends stay unbound;
 * JSONL confirmation keeps its separate oldest-first ownership contract.
 */
function selectUniqueClaudePromptSubmitAudit(
  audits,
  submittedPrompt,
  {
    hashText = promptAuditFingerprint,
    hookTabId = null,
    hookPpid = null,
    hookPidTabId = null,
  } = {},
) {
  if (typeof submittedPrompt !== 'string') {
    return {
      audit: null,
      matchingAudits: [],
      reason: 'hook-prompt-unavailable',
    };
  }
  const submittedHash = hashText(submittedPrompt);
  const submittedLen = submittedPrompt.length;
  const textMatchingAudits = (Array.isArray(audits) ? audits : []).filter((audit) => (
    audit
    && audit.finished !== true
    && audit.submitWritten === true
    && Number(audit.expectedLen) === submittedLen
    && String(audit.expectedHash || '') === submittedHash
  ));
  const routeAdmissions = new Map(textMatchingAudits.map((audit) => [
    audit,
    classifyClaudePromptSubmitRouteAdmission(audit, {
      hookTabId,
      hookPpid,
      hookPidTabId,
    }),
  ]));
  const matchingAudits = textMatchingAudits.filter((audit) => (
    routeAdmissions.get(audit)?.allowed === true
  ));
  if (matchingAudits.length === 1) {
    return {
      audit: matchingAudits[0],
      matchingAudits,
      routeAdmission: routeAdmissions.get(matchingAudits[0]),
      reason: 'unique-exact-pending-audit',
    };
  }
  return {
    audit: null,
    matchingAudits,
    routeAdmission: null,
    reason: matchingAudits.length > 1
      ? 'ambiguous-identical-pending-audits'
      : (textMatchingAudits.length > 0
        ? 'fresh-hook-route-mismatch'
        : 'no-exact-pending-audit'),
  };
}

/**
 * Ordered multi-audit selection, mirroring selectCodexPendingPromptAudit: given
 * every prompt carrier found after the shared read boundary, match each pending
 * audit by exact len+hash against a causal (post-its-own-boundary) record.
 * Text equality alone is not identity — causality comes first, and one record
 * confirms at most one audit (earliest expectation wins).
 */
function selectClaudePendingPromptAudit(
  audits,
  candidates,
  {
    classify = classifyClaudeAuditRecordAfterBoundary,
    hashText = promptAuditFingerprint,
    claimedByteOffsets = new Set(),
  } = {},
) {
  const source = Array.isArray(audits) ? audits : [];
  const records = Array.isArray(candidates) ? candidates : [];
  for (const audit of source) {
    if (!audit || audit.finished === true) continue;
    // Oldest-first: the earliest causal record after this audit's boundary is
    // its own submit; newer matching records belong to later expectations.
    for (let i = 0; i < records.length; i += 1) {
      const candidate = records[i];
      if (!candidate || claimedByteOffsets.has(candidate.byteOffset)) continue;
      if (candidate.text.length !== Number(audit.expectedLen)) continue;
      if (hashText(candidate.text) !== String(audit.expectedHash || '')) continue;
      const causality = classify(candidate, audit.preSubmitBoundary, audit);
      if (!causality.causal) continue;
      return { audit, candidate, causality };
    }
  }
  return null;
}

/**
 * Assigns a live prompt carrier to the exact app-owned send without treating
 * text equality as ownership. A queue-operation first claims the oldest
 * causal audit after its byte boundary. The first later canonical carrier is
 * then joined to that exact queue claim in FIFO order; replays keep the same
 * owner. Manual xterm prompts have no audit and therefore remain unowned.
 */
function selectClaudeLivePromptOwner(
  audits,
  candidate,
  {
    classify = classifyClaudeAuditRecordAfterBoundary,
    hashText = promptAuditFingerprint,
  } = {},
) {
  if (!candidate?.record || typeof candidate.text !== 'string') return null;
  const source = (Array.isArray(audits) ? audits : [])
    .filter((audit) => audit && audit.finished !== true);
  const candidateHash = hashText(candidate.text);
  const candidateLen = candidate.text.length;
  const candidateOffset = Number(candidate.byteOffset);
  const candidateUuid = String(candidate.record?.uuid || '');
  const candidateKind = String(candidate.promptCarrierKind || '');

  // Exact replay of an already claimed canonical record.
  for (const audit of source) {
    if (candidateUuid && audit.liveCanonicalPromptUuid === candidateUuid) {
      return { audit, candidate, reason: 'canonical-replay' };
    }
    const queueClaim = audit.liveQueuePromptClaim;
    if (
      candidateKind === 'queue-operation'
      && queueClaim
      && Number.isFinite(candidateOffset)
      && Number(queueClaim.byteOffset) === candidateOffset
      && queueClaim.hash === candidateHash
    ) {
      return { audit, candidate, reason: 'queue-replay' };
    }
  }

  const matchesAuditPayload = (audit) => (
    candidateLen === Number(audit.expectedLen)
    && candidateHash === String(audit.expectedHash || '')
  );

  // A queue carrier has already established the app-owned FIFO position.
  // The first matching canonical record after that exact byte offset belongs
  // to this audit; later identical prompts cannot steal it.
  if (candidateKind !== 'queue-operation') {
    for (const audit of source) {
      const queueClaim = audit.liveQueuePromptClaim;
      if (!queueClaim || audit.liveCanonicalPromptUuid || !matchesAuditPayload(audit)) continue;
      const claimOffset = Number(queueClaim.byteOffset);
      if (
        Number.isFinite(candidateOffset)
        && Number.isFinite(claimOffset)
        && candidateOffset < claimOffset
      ) continue;
      audit.liveCanonicalPromptUuid = candidateUuid || null;
      return { audit, candidate, reason: 'canonical-after-exact-queue-claim' };
    }
  }

  // Once an audit has claimed a queue position it cannot claim a second
  // enqueue with identical text. That second carrier belongs to another send.
  const unclaimed = source.filter((audit) => !audit.liveQueuePromptClaim && !audit.liveCanonicalPromptUuid);
  const selection = selectClaudePendingPromptAudit(unclaimed, [candidate], {
    classify,
    hashText,
  });
  if (!selection) return null;
  if (candidateKind === 'queue-operation') {
    selection.audit.liveQueuePromptClaim = {
      byteOffset: Number.isFinite(candidateOffset) ? candidateOffset : null,
      timestamp: candidate.record?.timestamp || null,
      sessionId: candidate.record?.sessionId || null,
      hash: candidateHash,
    };
    return { ...selection, reason: 'causal-queue-claim' };
  }
  selection.audit.liveCanonicalPromptUuid = candidateUuid || null;
  return { ...selection, reason: 'causal-canonical-claim' };
}

/**
 * Converts an exact live canonical carrier into the same audit proof normally
 * produced by the UserPromptSubmit hook. Claude does not emit that hook for a
 * prompt accepted while another turn is streaming: it writes an enqueue and,
 * later, a queued_command attachment instead. The enqueue proves queue order;
 * only the canonical record (with its UUID) is strong enough to finish the
 * History handoff.
 */
function buildClaudeLivePromptAuditConfirmation(
  selection,
  candidate,
  {
    sessionId = null,
    hashText = promptAuditFingerprint,
  } = {},
) {
  const audit = selection?.audit || null;
  const record = candidate?.record || null;
  const kind = String(candidate?.promptCarrierKind || '');
  const actualText = typeof candidate?.text === 'string' ? candidate.text : '';
  const entryUuid = typeof record?.uuid === 'string' ? record.uuid : '';
  if (
    !audit?.handoffId
    || audit.finished === true
    || (kind !== 'user' && kind !== 'queued_command')
    || !actualText
    || !entryUuid
  ) return null;

  const actualHash = hashText(actualText);
  if (
    actualText.length !== Number(audit.expectedLen)
    || actualHash !== String(audit.expectedHash || '')
  ) return null;

  const auditSessionId = record.sessionId
    || record.session_id
    || sessionId
    || audit.historySessionId
    || null;
  return {
    audit,
    result: {
      success: true,
      actualLen: actualText.length,
      actualHash,
      sessionId: auditSessionId,
      entryUuid,
      auditTimestamp: record.timestamp || new Date(audit.sentAt).toISOString(),
      ...(Number.isFinite(Number(candidate.byteOffset))
        ? { recordByteOffset: Number(candidate.byteOffset) }
        : {}),
      expectedLen: audit.expectedLen,
      expectedHash: audit.expectedHash,
      canonicalized: true,
      canonicalReason: selection.reason || selection.causality?.reason || 'live-canonical-carrier',
    },
    actualText,
    recordByteOffset: Number.isFinite(Number(candidate.byteOffset))
      ? Number(candidate.byteOffset)
      : null,
  };
}

async function captureClaudePromptAuditBoundary(
  transcriptPath,
  {
    maxReadBytes = DEFAULT_CLAUDE_AUDIT_READ_BYTES,
    sessionId = null,
  } = {},
) {
  const exactSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : null;
  if (!transcriptPath) {
    return {
      available: false,
      reason: 'transcript-unresolved',
      sessionId: exactSessionId,
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
      sessionId: exactSessionId,
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
        sessionId: exactSessionId,
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
      sessionId: exactSessionId,
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

function classifyClaudeAuditRecordAfterBoundary(candidate, boundary, audit = null) {
  if (!boundary?.available) {
    // A fresh Claude session has no JSONL path before its first Enter. The
    // UserPromptSubmit hook supplies that path only after the record exists,
    // so a byte boundary is impossible for exactly this first prompt. Keep
    // the fallback narrow: only the unresolved-path case may use the staged
    // send timestamp. Read failures for a known transcript remain unknown.
    const isFreshTranscriptPending = boundary?.reason === 'transcript-unresolved'
      && !boundary?.transcriptPath;
    const candidateAt = Date.parse(candidate?.record?.timestamp || '');
    const sentAt = Number(audit?.sentAt);
    const candidatePath = typeof candidate?.transcriptPath === 'string'
      ? path.resolve(candidate.transcriptPath)
      : null;
    const hookPath = typeof audit?.freshHookTranscriptPath === 'string'
      ? path.resolve(audit.freshHookTranscriptPath)
      : null;
    const hookSessionId = String(audit?.freshHookSessionId || '');
    const candidateSessionId = String(candidate?.record?.sessionId || '');
    if (
      isFreshTranscriptPending
      && audit?.freshHookRouteConfirmed === true
      && !!hookPath
      && candidatePath === hookPath
      && (!hookSessionId || candidateSessionId === hookSessionId)
      && Number.isFinite(candidateAt)
      && Number.isFinite(sentAt)
      && candidateAt >= sentAt
    ) {
      return { causal: true, reason: 'record-after-send-with-unresolved-transcript' };
    }
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
  classifyClaudePromptAuditAdmission,
  classifyClaudeAuditRecordAfterBoundary,
  classifyClaudePromptSubmitRouteAdmission,
  extractClaudeUserText,
  readClaudeUserRecords,
  readClaudeUserRecordsFromBuffer,
  readLastClaudeUserRecord,
  readLastClaudeUserRecordFromBuffer,
  buildClaudeLivePromptAuditConfirmation,
  selectClaudeLivePromptOwner,
  selectClaudePendingPromptAudit,
  selectUniqueClaudePromptSubmitAudit,
  shouldStageClaudeUserPromptAudit,
  waitForClaudeTranscriptMaterialization,
};

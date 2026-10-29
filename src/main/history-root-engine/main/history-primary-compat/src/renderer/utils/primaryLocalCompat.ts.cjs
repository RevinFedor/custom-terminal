// GENERATED frozen Current pure compatibility. See manifest.json.
'use strict';
const { buildHistoryLivePresentation } = require('./historyLiveProjection.mjs.cjs');
const { projectNativeRewindPreview } = require('./historyRewindPreviewOwner.ts.cjs');
const { normalizePromptImageIdentity } = require('./promptImageAttachments.mjs.cjs');
const { matchesHistoryPromptExactProof, matchesHistoryPromptAdoption, matchesHistoryPromptSuppression } = require('./historyPromptPresentation.mjs.cjs');
// Diagnostic output belongs to the host; the selected pure predicates stay verbatim.
const historyDiag = (_message) => {};

const HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS = 15_000;

// Payload caches are bounded; expiry is not consumption of a Main-owned
// accepted intent. All three local projections use this same retention rule.

function historyPromptFailureHasRecoveryOwner(value   
                                                            
 ) {
  return Number.isSafeInteger(value.applicationQueueId) && Number(value.applicationQueueId) > 0
    || value.statusReason === 'history-preparation-interrupted';
}

const ORCHESTRATION_COMPLETION_HANDOFF_PREFIX = 'orchestration-complete:';

const ORCHESTRATION_COMPLETION_SOURCE_PREFIX = 'orchestration-completion:';

/**
 * Legacy completion notifications predate desktop History receipts. Their
 * durable presentation still carries the exact orchestration run identity, so
 * that tag can retire the old local SENT projection without falling back to
 * equal text or timestamps.
 */

function legacyOrchestrationCompletionMatchesCanonicalEntry(
  handoff                                                                        
                                     
                                  
   ,
  entry                                    ,
) {
  if (handoff?.queueStatus !== 'sent') return false;
  if (handoff?.sendOperationKey || handoff?.sendAttemptId) return false;
  const handoffId = String(handoff?.handoffId || '');
  if (!handoffId.startsWith(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX)) return false;
  const runId = handoffId.slice(ORCHESTRATION_COMPLETION_HANDOFF_PREFIX.length).trim();
  if (!runId) return false;
  const source = String(handoff?.source || '');
  if (source && source !== ORCHESTRATION_COMPLETION_SOURCE_PREFIX + runId) return false;
  return (Array.isArray(entry?.semanticTags) ? entry.semanticTags : []).some((tag) => (
    tag?.kind === 'orchestration'
    && tag?.runId === runId
    && (tag?.phase === 'completion' || tag?.phase === 'failure')
  ));
}

const LOCAL_PROMPT_PREFIX = 'local-prompt-';

const LOCAL_REWIND_PREFIX = 'local-rewind-';

const LOCAL_COMPACT_ERROR_PREFIX = 'local-compact-error-';

const LOCAL_PROMPT_FAILURE_TTL_MS = HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS;
// An in-flight local rewind row whose completion event was lost (crash mid-op)
// may survive at most this long in the persisted overlay. Long enough for any
// legitimate Rewind (AI mode deadline is 170s), short enough that a stale
// "REWINDING…" cannot haunt the owner across sessions.

const normalizeHistoryPromptText = (text        ) => String(text || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '').replace(/~\]/g, '').trim();

const normalizeHistoryPromptIdentityText = (text        ) =>
  normalizePromptImageIdentity(normalizeHistoryPromptText(text));

const isLocalPromptEntry = (entry                  ) =>
  entry.role === 'queued' && entry.uuid.startsWith(LOCAL_PROMPT_PREFIX);

const isLocalRewindEntry = (entry                  ) =>
  entry.role === 'rewind' && entry.uuid.startsWith(LOCAL_REWIND_PREFIX);

const isLocalCompactErrorEntry = (entry                  ) =>
  entry.role === 'compact-error' && entry.uuid.startsWith(LOCAL_COMPACT_ERROR_PREFIX);

const findServerPromptEntry = (
  serverEntries                    ,
  localEntry                  ,
  excludedUuids              = new Set(),
) => {
  const normalized = normalizeHistoryPromptIdentityText(localEntry.content);
  const localAt = localEntry.optimisticAt || Date.parse(localEntry.timestamp) || Date.now();
  return serverEntries.find((entry) => {
    if (excludedUuids.has(entry.uuid)) return false;
    // Old orchestration completion rows can outlive the renderer-local handoff
    // that created them. Their app-owned run tag is the only durable identity
    // available after such a restart; never fall back to equal text or time.
    if (legacyOrchestrationCompletionMatchesCanonicalEntry({
      handoffId: localEntry.handoffId || '',
      source: '',
      queueStatus: localEntry.queueStatus || 'sending',
      sendOperationKey: null,
      sendAttemptId: null,
    }, entry)) {
      return true;
    }
    if (localEntry.auditEntryUuid || localEntry.sourceIdentity) {
      return matchesHistoryPromptExactProof(entry, {
        entryUuid: localEntry.auditEntryUuid,
        sourceIdentity: localEntry.sourceIdentity,
      });
    }
    const durableIdentity = {
      role: entry.role,
      normalizedText: normalizeHistoryPromptIdentityText(entry.content),
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      sourceIdentity: entry.sourceIdentity,
      sourceIdentityAliases: entry.sourceIdentityAliases,
    };
    const localIdentity = {
      normalizedText: normalized,
      localAt,
      requiresAuditIdentity: localEntry.requiresAuditIdentity === true,
      auditTimestamp: localEntry.auditTimestamp,
      auditSessionId: localEntry.auditSessionId,
      sourceIdentity: localEntry.sourceIdentity,
      queueStatus: localEntry.queueStatus,
      statusReason: localEntry.statusReason,
      sessionId: localEntry.auditSessionId || localEntry.sessionId,
    };
    return matchesHistoryPromptAdoption(durableIdentity, localIdentity);
  });
};

const serverHasPromptEntry = (serverEntries                    , localEntry                  ) =>
  !!findServerPromptEntry(serverEntries, localEntry);

const mergeServerAndLocalEntries = (serverEntries                    , currentEntries                    ) => {
  const now = Date.now();
  const consumedServerUuids = new Set        ();
  const promptChipsByServerUuid = new Map                                  ();
  const imagePathsByServerUuid = new Map                                      ();
  const locals                     = [];
  for (const entry of currentEntries) {
    if (isLocalCompactErrorEntry(entry)) {
      locals.push(entry);
      continue;
    }
    if (isLocalRewindEntry(entry)) {
      locals.push(entry);
      continue;
    }
    if (!isLocalPromptEntry(entry)) continue;
    const matched = findServerPromptEntry(serverEntries, entry, consumedServerUuids);
    if (matched) {
      const localAt = entry.optimisticAt || Date.parse(entry.timestamp || '');
      const serverAt = Date.parse(matched.timestamp || '');
      historyDiag('PROMPT_ADOPT'
        + ' local=' + entry.uuid
        + ' handoff=' + (entry.handoffId || '-')
        + ' server=' + matched.uuid
        + ' localAt=' + (Number.isFinite(localAt) ? localAt : -1)
        + ' serverAt=' + (Number.isFinite(serverAt) ? serverAt : -1)
        + ' deltaMs=' + (
          Number.isFinite(localAt) && Number.isFinite(serverAt)
            ? serverAt - localAt
            : 'unknown'
        )
        + ' matchMode=' + (
          entry.auditEntryUuid || entry.sourceIdentity
            ? 'exact-audit-identity'
            : 'legacy-or-text-boundary'
        )
        + ' chips=' + (entry.promptChips?.length || 0));
      consumedServerUuids.add(matched.uuid);
      if ((entry.promptChips?.length || 0) > 0 && !(matched.promptChips?.length || 0)) {
        promptChipsByServerUuid.set(matched.uuid, entry.promptChips || []);
      }
      if ((entry.imagePaths?.length || 0) > 0 && !(matched.imagePaths?.length || 0)) {
        imagePathsByServerUuid.set(matched.uuid, entry.imagePaths || []);
      }
      continue;
    }
    const ageMs = now - (
      entry.statusChangedAt
      || entry.optimisticAt
      || Date.parse(entry.timestamp || '')
      || now
    );
    if (
      (entry.queueStatus === 'cancelled' || entry.queueStatus === 'failed')
      && !historyPromptFailureHasRecoveryOwner(entry)
      && ageMs >= LOCAL_PROMPT_FAILURE_TTL_MS
    ) {
      continue;
    }
    locals.push(entry);
  }
  const decoratedServerEntries = promptChipsByServerUuid.size > 0 || imagePathsByServerUuid.size > 0
    ? serverEntries.map((entry) => {
        const chips = promptChipsByServerUuid.get(entry.uuid);
        const imagePaths = imagePathsByServerUuid.get(entry.uuid);
        return chips || imagePaths
          ? {
              ...entry,
              ...(chips ? { promptChips: chips } : {}),
              ...(imagePaths ? { imagePaths } : {}),
            }
          : entry;
      })
    : serverEntries;
  // Confirmed local rows already carry the exact transcript position. Feed
  // them through the same ordered projection used by live rows instead of
  // appending them after a newer durable answer.
  return locals.length > 0
    ? buildHistoryLivePresentation(decoratedServerEntries, locals)                      
    : decoratedServerEntries;
};

const entryClockMs = (entry                  ) => {
  if (entry.optimisticAt && Number.isFinite(entry.optimisticAt)) return entry.optimisticAt;
  const parsed = Date.parse(entry.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const shouldCarryAfterRewindTarget = (entry                  , preview                      ) => {
  if (isLocalRewindEntry(entry) && entry.uuid.includes(preview.opId)) return true;
  if (isLocalPromptEntry(entry)) return true;
  return entryClockMs(entry) >= preview.startedAt - 1000;
};

const buildRewindPreviewEntries = (rawEntries                    , preview                             ) => {
  if (!preview) return { entries: rawEntries, hiddenCount: 0, hiddenTurnCount: 0 };
  return projectNativeRewindPreview(
    rawEntries,
    preview.targetUuid,
    (entry) => shouldCarryAfterRewindTarget(entry, preview),
    (entry) => entry.role === 'user' && !isLocalPromptEntry(entry),
  );
};

const entryMatchesSuppressedPrompt = (entry                  , suppressed                  ) => {
  return matchesHistoryPromptSuppression({
    role: entry.role,
    isLocal: isLocalPromptEntry(entry),
    normalizedText: normalizeHistoryPromptIdentityText(entry.content),
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    sourceIdentity: entry.sourceIdentity,
    sourceIdentityAliases: entry.sourceIdentityAliases,
  }, {
    normalizedText: normalizeHistoryPromptIdentityText(suppressed.text),
    requiresAuditIdentity: suppressed.requiresAuditIdentity,
    auditTimestamp: suppressed.auditTimestamp,
    auditSessionId: suppressed.auditSessionId,
    sourceIdentity: suppressed.sourceIdentity,
    since: suppressed.since,
    until: suppressed.until,
  });
};

const filterSuppressedPromptEntries = (
  entries                    ,
  suppressions                            ,
) => {
  const active = Array.from(suppressions);
  if (active.length === 0) return { entries, hidden: 0 };
  const filtered = entries.filter((entry) =>
    !active.some((suppressed) => entryMatchesSuppressedPrompt(entry, suppressed))
  );
  return { entries: filtered, hidden: entries.length - filtered.length };
};

module.exports = { HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS, historyPromptFailureHasRecoveryOwner,
  legacyOrchestrationCompletionMatchesCanonicalEntry, isLocalPromptEntry, findServerPromptEntry,
  serverHasPromptEntry, mergeServerAndLocalEntries, buildRewindPreviewEntries, filterSuppressedPromptEntries };

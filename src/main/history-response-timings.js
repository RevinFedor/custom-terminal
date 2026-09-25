const crypto = require('crypto');

const RESPONSE_TIMING_EDGE_SKEW_MS = 2000;
const timingBoundObservers = new Set();

// Read consumers observe the existing exact binding; they never create an
// interval or choose an assistant row themselves. Renderer IPC remains intact.
function observeHistoryResponseTimingBindings(listener) {
  timingBoundObservers.add(listener);
  return () => timingBoundObservers.delete(listener);
}

function normalizeHistoryResponseToolType(value) {
  if (value === 'codex') return 'codex';
  if (value === 'claude') return 'claude';
  return null;
}

function shouldCreateHistoryResponseTiming({
  toolType,
  event = null,
  reason = null,
  outcome = null,
} = {}) {
  const normalizedToolType = normalizeHistoryResponseToolType(toolType);
  if (normalizedToolType === 'claude') {
    if (event) return event === 'Stop';
    return reason !== 'local-command' && reason !== 'command-finished';
  }
  if (normalizedToolType === 'codex') {
    return outcome?.hasFinalResult === true;
  }
  return false;
}

function resolveActivitySessionIdForEngine(engine, {
  bridgeSessionId = null,
  codexRuntimeSessionId = null,
  claudeSessionId = null,
  geminiSessionId = null,
  codexSessionId = null,
  sdkSessionId = null,
} = {}) {
  if (engine === 'codex') return codexRuntimeSessionId || codexSessionId || null;
  if (engine === 'claude') return bridgeSessionId || claudeSessionId || null;
  if (engine === 'gemini') return geminiSessionId || null;
  if (engine === 'claude-sdk') return sdkSessionId || claudeSessionId || null;
  return bridgeSessionId
    || codexRuntimeSessionId
    || claudeSessionId
    || geminiSessionId
    || codexSessionId
    || sdkSessionId
    || null;
}

function entryTimestampMs(entry) {
  const value = entry?.timestamp;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isEligibleHistoryResponseEntry(entry) {
  return entry?.role === 'assistant'
    && !!(
      String(entry.content || '').trim()
      || String(entry.thinking || '').trim()
      || (Array.isArray(entry.actions) && entry.actions.length > 0)
    );
}

function isContentfulHistoryResponseEntry(entry) {
  return entry?.role === 'assistant'
    && !!String(entry.content || '').trim();
}

function selectHistoryResponseTimingTarget(entries, timing) {
  const source = Array.isArray(entries) ? entries : [];
  const startTs = Number(timing?.startTs);
  const endTs = Number(timing?.endTs);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return null;

  const candidates = source.filter((entry) => {
    // Tool/thinking rows can materialize before the final assistant response.
    // Binding to one of them would make an incomplete snapshot permanent.
    if (!isContentfulHistoryResponseEntry(entry) || !entry.uuid) return false;
    // Codex explicitly labels commentary and the final answer. A commentary
    // row is not a competing completed response (physical37DE…: commentary16
    // + final26 kept interval3 unbound forever). Untyped legacy/Claude rows keep
    // the old unique-candidate rule; two real finals still remain ambiguous.
    if (entry.textPhase && entry.textPhase !== 'final_answer') return false;
    const timestamp = entryTimestampMs(entry);
    return Number.isFinite(timestamp)
      // A row before the loader started belongs to the previous turn. Clock
      // skew is possible only at the completion edge because both timestamps
      // are produced on this machine.
      && timestamp >= startTs
      && timestamp <= endTs + RESPONSE_TIMING_EDGE_SKEW_MS;
  });
  if (candidates.length === 0) return null;

  const sessionId = String(timing?.sessionId || '').trim();
  const routedCandidates = sessionId
    ? candidates.filter((entry) => (
      String(entry.sessionId || '').trim() === sessionId
    ))
    : candidates;
  // The sidecar has no exact response UUID yet. More than one contentful row
  // inside the interval is therefore ambiguity, not permission to pick "last".
  return routedCandidates.length === 1 ? routedCandidates[0] : null;
}

function responseTimingRevision(rows) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length === 0) return 'none';
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(source.map((row) => ({
      intervalId: Number(row.intervalId || 0),
      sessionId: row.sessionId || null,
      entryUuid: row.entryUuid || null,
      sourceIdentity: row.sourceIdentity || null,
      updatedAt: Number(row.updatedAt || 0),
    }))))
    .digest('hex')
    .slice(0, 24);
}

function historyResponseCloneSignature(entry) {
  if (!isEligibleHistoryResponseEntry(entry)) return null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      timestamp: entry?.timestamp || null,
      content: String(entry?.content || ''),
      thinking: String(entry?.thinking || ''),
      actions: Array.isArray(entry?.actions) ? entry.actions : [],
    }))
    .digest('hex');
}

function buildHistoryResponseEntryCloneMappings(sourceEntries, childEntries) {
  const collectUnique = (entries) => {
    const bySignature = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const signature = historyResponseCloneSignature(entry);
      if (!signature || !entry?.uuid) continue;
      const group = bySignature.get(signature) || [];
      group.push(entry);
      bySignature.set(signature, group);
    }
    return bySignature;
  };
  const sourceBySignature = collectUnique(sourceEntries);
  const childBySignature = collectUnique(childEntries);
  const mappings = [];
  for (const [signature, sourceGroup] of sourceBySignature) {
    const childGroup = childBySignature.get(signature);
    // Duplicate indistinguishable rows are not sufficient proof of identity.
    if (sourceGroup.length !== 1 || childGroup?.length !== 1) continue;
    const sourceEntry = sourceGroup[0];
    const childEntry = childGroup[0];
    mappings.push({
      sourceEntryUuid: sourceEntry.uuid,
      childEntryUuid: childEntry.uuid,
      childSourceIdentity: childEntry.sourceIdentity || null,
    });
  }
  return mappings;
}

function pendingTimingWitness(row) {
  return JSON.stringify([row.intervalId, row.toolType, row.tabId, row.sessionId,
    row.startTs, row.endTs, row.durationMs, row.updatedAt]);
}

function bindPendingHistoryResponseTimings(db, {
  toolType,
  sessionId,
  tabId = null,
  entries,
  onBound = null,
} = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const normalizedToolType = normalizeHistoryResponseToolType(toolType);
  const observedPending = new Set();
  if (!db || !normalizedToolType) return { sessionIds: [], observedPending };

  const sessionIds = Array.from(new Set([
    String(sessionId || '').trim(),
    ...source.map((entry) => String(entry?.sessionId || '').trim()),
  ].filter(Boolean)));
  if (db.getPendingHistoryResponseTimings && db.bindHistoryResponseTimingEntry) {
    const pending = db.getPendingHistoryResponseTimings({
      toolType: normalizedToolType,
      sessionIds,
      tabId,
    });
    for (const timing of Array.isArray(pending) ? pending : []) {
      observedPending.add(pendingTimingWitness(timing));
      const target = selectHistoryResponseTimingTarget(source, timing);
      if (!target) continue;
      const bound = db.bindHistoryResponseTimingEntry({
        intervalId: timing.intervalId,
        toolType: normalizedToolType,
        sessionId: target.sessionId || timing.sessionId || sessionId || null,
        entryUuid: target.uuid,
        sourceIdentity: target.sourceIdentity || null,
      });
      if (bound && typeof onBound === 'function') {
        onBound(timing, target);
      }
      if (bound) {
        for (const listener of timingBoundObservers) {
          try { listener({ tabId: timing.tabId || tabId, toolType: normalizedToolType,
            sessionId: target.sessionId || sessionId, intervalId: timing.intervalId }); }
          catch (error) { console.warn('[HistoryResponseTiming] observer failed:', error.message); }
        }
        console.log('[HistoryResponseTiming] bound'
          + ' tool=' + normalizedToolType
          + ' interval=' + timing.intervalId
          + ' session=' + String(target.sessionId || timing.sessionId || sessionId || '-').slice(0, 12)
          + ' entry=' + String(target.uuid).slice(0, 20)
          + ' start=' + timing.startTs
          + ' end=' + timing.endTs);
      }
    }
  }

  return { sessionIds, observedPending };
}

function decorateBoundHistoryResponseTimings(db, { toolType, entries } = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const normalizedToolType = normalizeHistoryResponseToolType(toolType);
  if (!db || !normalizedToolType || source.length === 0) return source;
  // This entrypoint cannot read pending rows, bind a target or notify an
  // observer. Giving it a partial viewport never changes candidate selection.
  if (!db.getHistoryResponseTimingsForEntries) return source;
  const timings = db.getHistoryResponseTimingsForEntries(
    normalizedToolType,
    source.map((entry) => entry?.uuid).filter(Boolean),
  );
  if (!Array.isArray(timings) || timings.length === 0) return source;
  const byEntry = new Map();
  for (const timing of timings) {
    if (!timing?.entryUuid) continue;
    const current = byEntry.get(timing.entryUuid);
    if (!current || Number(timing.endTs || 0) > Number(current.endTs || 0)) {
      byEntry.set(timing.entryUuid, timing);
    }
  }
  let changed = false;
  const decorated = source.map((entry) => {
    const timing = byEntry.get(entry?.uuid);
    if (!timing) return entry;
    changed = true;
    return {
      ...entry,
      responseTiming: {
        intervalId: timing.intervalId,
        startTs: timing.startTs,
        endTs: timing.endTs,
        durationMs: timing.durationMs,
      },
    };
  });
  return changed ? decorated : source;
}

function decorateHistoryResponseTimings(db, options = {}) {
  if (!Array.isArray(options.entries) || options.entries.length === 0) return Array.isArray(options.entries) ? options.entries : [];
  bindPendingHistoryResponseTimings(db, options);
  return decorateBoundHistoryResponseTimings(db, options);
}

function prepareHistoryResponseTimingWindow(db, {
  toolType, sessionId, tabId = null, entries, fullEntries, onBound = null,
} = {}) {
  if (!Array.isArray(fullEntries)) throw new TypeError('Full History projection is required for pending timing binding');
  const source = Array.isArray(entries) ? entries : [];
  const indices = [];
  const hydrated = [];
  source.forEach((row, index) => {
    if (!row?.rowStub) { indices.push(index); hydrated.push(row); }
  });
  const revision = () => db?.getHistoryResponseTimingRevision?.(toolType, sessionId, tabId) || 'none';
  const hasSnapshot = typeof db?.withHistoryResponseTimingSnapshot === 'function';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Binding sees the FULL projection and commits before any observers run.
    // It is deliberately outside the following READ-only SQLite snapshot.
    const binding = bindPendingHistoryResponseTimings(db, {
      toolType, sessionId, tabId, entries: fullEntries, onBound,
    });
    const capture = () => {
      const before = hasSnapshot ? null : revision();
      const pending = db?.getPendingHistoryResponseTimings?.({ toolType,
        sessionIds: binding.sessionIds, tabId }) || [];
      const decorated = decorateBoundHistoryResponseTimings(db, { toolType, entries: hydrated });
      const token = revision();
      return { pending, decorated, token, stable: hasSnapshot || before === token };
    };
    const captured = hasSnapshot ? db.withHistoryResponseTimingSnapshot(capture) : capture();
    const settled = captured.stable && captured.pending.every(row => binding.observedPending.has(pendingTimingWitness(row)));
    if (!settled && attempt < 2) continue;
    const result = captured.decorated === hydrated ? source : source.slice();
    if (result !== source) indices.forEach((index, position) => { result[index] = captured.decorated[position]; });
    return {
      entries: result,
      // A continuously changing foreign writer cannot make an unprocessed
      // pending interval look fresh. The next ifRevision must reconcile it.
      revision: settled ? captured.token : 'pending-binding:' + captured.token,
    };
  }
}

module.exports = {
  observeHistoryResponseTimingBindings,
  RESPONSE_TIMING_EDGE_SKEW_MS,
  buildHistoryResponseEntryCloneMappings,
  decorateHistoryResponseTimings,
  bindPendingHistoryResponseTimings,
  decorateBoundHistoryResponseTimings,
  prepareHistoryResponseTimingWindow,
  historyResponseCloneSignature,
  isEligibleHistoryResponseEntry,
  normalizeHistoryResponseToolType,
  responseTimingRevision,
  resolveActivitySessionIdForEngine,
  selectHistoryResponseTimingTarget,
  shouldCreateHistoryResponseTiming,
};

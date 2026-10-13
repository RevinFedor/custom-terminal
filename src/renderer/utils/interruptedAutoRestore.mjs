export function resolveInterruptedRestoreTargets(snapshot, projects = []) {
  const rowsByTab = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    for (const tab of Array.isArray(project?.tabs) ? project.tabs : []) {
      const tabId = String(tab?.tabId || tab?.id || '');
      if (!tabId) continue;
      const list = rowsByTab.get(tabId) || [];
      list.push({ ...tab, tabId, projectId: project.projectId || project.id || tab.projectId });
      rowsByTab.set(tabId, list);
    }
  }
  const targets = [];
  const unresolved = Array.isArray(snapshot?.unresolved) ? [...snapshot.unresolved] : [];
  for (const target of Array.isArray(snapshot?.targets) ? snapshot.targets : []) {
    const tabId = String(target?.tabId || '');
    const engine = target?.provider === 'codex' || target?.engine === 'codex'
      ? 'codex'
      : target?.provider === 'claude' || target?.engine === 'claude'
        ? 'claude'
        : null;
    const sessionId = String(target?.sessionId || '');
    const rows = rowsByTab.get(tabId) || [];
    if (!tabId || !engine || !sessionId || rows.length !== 1) {
      unresolved.push({ tabId, reason: rows.length > 1 ? 'duplicate-renderer-tab' : 'target-not-restored' });
      continue;
    }
    const row = rows[0];
    const currentSessionId = engine === 'codex' ? row.codexSessionId : row.claudeSessionId;
    if (row.wasInterrupted !== true || row.overlayDismissed === true || currentSessionId !== sessionId) {
      unresolved.push({ tabId, engine, sessionId, reason: 'renderer-identity-changed' });
      continue;
    }
    targets.push({ tabId, projectId: row.projectId, sessionId, engine });
  }
  return { targets, unresolved, source: snapshot?.source || 'unavailable' };
}

export const DEFAULT_INTERRUPTED_RESTORE_PARALLELISM = 2;
export const MAX_INTERRUPTED_RESTORE_PARALLELISM = 3;
export const INTERRUPTED_RESTORE_LOOKUP_RETRY_DELAYS_MS = Object.freeze([1000, 2500, 5000]);

/**
 * A failed process lookup is not evidence that the shell is busy.  During a
 * large restore macOS can time out `ps` while terminal/history/model requests
 * are still settling.  It remains unsafe to launch, but it is also wrong to
 * turn that temporary lack of proof into a permanent failed restore.
 */
export function isTransientInterruptedRestoreAdmission(result) {
  const error = String(result?.error || '');
  const reason = String(result?.reason || result?.detail || '');
  const lookupStatus = String(result?.lookupStatus || '');
  return result?.success === false && result?.accepted === false && result?.launchWritten === false
    && result?.acceptancePending !== true && result?.joined !== true
    && result?.suppressed !== true
    && result?.cancelled !== true && result?.deliveryUnknown !== true
    && result?.sendReceipt?.deliveryUnknown !== true && result?.status !== 'delivery-unknown'
    && result?.launchOutcomeUnknown !== true && (
    error === 'process_lookup_failed'
    || reason === 'process_lookup_unknown'
    || lookupStatus === 'unknown'
  );
}

export async function retryInterruptedRestoreAdmission(
  runAttempt,
  {
    retryDelaysMs = INTERRUPTED_RESTORE_LOOKUP_RETRY_DELAYS_MS,
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    onRetry = () => {},
  } = {},
) {
  if (typeof runAttempt !== 'function') throw new TypeError('runAttempt is required');
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  let result = null;
  for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
    result = await runAttempt(attempt);
    if (!isTransientInterruptedRestoreAdmission(result)) {
      return { ...result, admissionAttempts: attempt };
    }
    const delayMs = Number(delays[attempt - 1]);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return { ...result, admissionAttempts: attempt, retryExhausted: true };
    }
    onRetry({ attempt, nextAttempt: attempt + 1, delayMs, result });
    await wait(delayMs);
  }
  return {
    ...(result || {}),
    admissionAttempts: delays.length + 1,
    retryExhausted: true,
  };
}

export function normalizeInterruptedRestoreParallelism(value) {
  // SQLite app-state returns null for a missing key. Number(null) is 0, which
  // would silently turn a fresh install into conservative mode `1` instead of
  // the product default `2`.
  if (value === null || value === undefined) return DEFAULT_INTERRUPTED_RESTORE_PARALLELISM;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_INTERRUPTED_RESTORE_PARALLELISM;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULT_INTERRUPTED_RESTORE_PARALLELISM;
  return Math.max(1, Math.min(MAX_INTERRUPTED_RESTORE_PARALLELISM, parsed));
}

/**
 * Restore the workflow the user can currently see before warming background
 * workspaces.  The shutdown snapshot remains the authority for *what* may be
 * resumed; this only changes scheduling order after the renderer has restored
 * the exact workflow/window placement.
 */
export function prioritizeInterruptedRestoreTargets(items, {
  focusedTabId = null,
  visibleTabIds = [],
  activeWorkflowTabIds = [],
} = {}) {
  const queue = Array.isArray(items) ? items : [];
  const visible = new Set(visibleTabIds || []);
  const activeWorkflow = new Set(activeWorkflowTabIds || []);
  const rank = (tabId) => {
    if (tabId && tabId === focusedTabId) return 0;
    if (visible.has(tabId)) return 1;
    if (activeWorkflow.has(tabId)) return 2;
    return 3;
  };
  return queue
    .map((item, index) => ({ item, index, rank: rank(item?.tabId) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

const failedRestoreResult = (error) => ({
  success: false,
  accepted: false,
  ready: false,
  settled: false,
  error: error?.code || 'interrupted_restore_failed',
  detail: error?.message || String(error),
});

/**
 * Bounded restore pipeline.
 *
 * Only one launch admission runs at a time.  Once that launch has either been
 * accepted or rejected, another admission may begin while the accepted agent
 * continues warming its TUI/MCP servers.  `parallelism` caps those warmups, so
 * boot can overlap real provider startup without returning to the old
 * all-at-once launch storm.
 *
 * `restoreOne` receives `releaseAdmission()`.  Call it when the main-owned
 * launch request has settled; callers that do not know about the hook retain
 * safe sequential behaviour because completion releases it as a fallback.
 */
export async function restoreInterruptedSessionsWithConcurrency(
  items,
  restoreOne,
  { parallelism = DEFAULT_INTERRUPTED_RESTORE_PARALLELISM, onStep = () => {} } = {},
) {
  if (typeof restoreOne !== 'function') throw new TypeError('restoreOne is required');
  const queue = Array.isArray(items) ? items : [];
  const limit = normalizeInterruptedRestoreParallelism(parallelism);
  const results = new Array(queue.length);
  let nextIndex = 0;
  let active = 0;
  let admissionAvailable = true;
  let blocked = false;

  return await new Promise((resolve) => {
    const finishIfDone = () => {
      if (active !== 0) return false;
      if (!blocked && nextIndex < queue.length) return false;
      resolve(results.filter(Boolean));
      return true;
    };

    const pump = () => {
      if (finishIfDone() || blocked || !admissionAvailable || active >= limit) return;
      if (nextIndex >= queue.length) {
        finishIfDone();
        return;
      }

      const index = nextIndex;
      nextIndex += 1;
      const item = queue[index];
      active += 1;
      admissionAvailable = false;
      let admissionReleased = false;
      const releaseAdmission = () => {
        if (admissionReleased) return;
        admissionReleased = true;
        admissionAvailable = true;
        onStep({ phase: 'admitted', index, total: queue.length, item });
        queueMicrotask(pump);
      };

      onStep({ phase: 'start', index, total: queue.length, item });
      Promise.resolve()
        .then(() => restoreOne(item, index, { releaseAdmission }))
        .catch(failedRestoreResult)
        .then((result) => {
          results[index] = { item, result };
          onStep({ phase: 'settled', index, total: queue.length, item, result });
          if (result?.settled === false) {
            blocked = true;
            onStep({ phase: 'blocked', index, total: queue.length, item, result });
          }
        })
        .finally(() => {
          // Rejected/pre-existing/custom restore implementations may not have a
          // separate admission edge. Completion is the safe fallback release.
          releaseAdmission();
          active -= 1;
          if (!finishIfDone()) pump();
        });
    };

    pump();
  });
}

export async function restoreInterruptedSessionsSequentially(
  items,
  restoreOne,
  { onStep = () => {} } = {},
) {
  if (typeof restoreOne !== 'function') throw new TypeError('restoreOne is required');
  const queue = Array.isArray(items) ? items : [];
  const results = [];
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    onStep({ phase: 'start', index, total: queue.length, item });
    let result;
    try {
      result = await restoreOne(item, index);
    } catch (error) {
      result = {
        success: false,
        accepted: false,
        ready: false,
        error: error?.code || 'interrupted_restore_failed',
        detail: error?.message || String(error),
      };
    }
    results.push({ item, result });
    onStep({ phase: 'settled', index, total: queue.length, item, result });
    if (result?.settled === false) {
      onStep({ phase: 'blocked', index, total: queue.length, item, result });
      break;
    }
  }
  return results;
}

const LIVE_RESTORE_STATUSES = new Set(['starting', 'active', 'busy']);

const cleanText = (value) => typeof value === 'string' ? value.trim() : '';

/**
 * Classify one fresh, main-owned runtime snapshot against the exact shutdown
 * target. The saved session id alone is not enough: it may describe History
 * while another process owns the PTY. An already-restored verdict therefore
 * requires a live lifecycle plus either the adopted writer or the exact
 * in-flight Resume source of this tab.
 */
export function classifyInterruptedRestoreRuntime({ engine, sessionId, runtime } = {}) {
  const expectedSessionId = cleanText(sessionId);
  if (!expectedSessionId || (engine !== 'codex' && engine !== 'claude')) {
    return { state: 'unknown', reason: 'invalid-restore-identity', observedSessionId: null };
  }
  if (!runtime || typeof runtime !== 'object' || runtime.success === false) {
    return { state: 'unknown', reason: 'runtime-snapshot-unavailable', observedSessionId: null };
  }

  if (engine === 'codex') {
    const status = cleanText(runtime.sessionStatus || runtime.status) || 'unknown';
    const writerSessionId = cleanText(runtime.provenWriterSessionId)
      || (runtime.writerConfirmed === true ? cleanText(runtime.sessionId) : '');
    const resumeSourceSessionId = runtime.readIdentitySource === 'resume-source'
      ? cleanText(runtime.readSessionId)
      : cleanText(runtime.resumeSourceSessionId);
    const observedSessionId = writerSessionId || resumeSourceSessionId || null;
    const live = runtime.liveLifecycle === true && LIVE_RESTORE_STATUSES.has(status);
    const exactWriter = writerSessionId === expectedSessionId;
    const exactResume = !writerSessionId && resumeSourceSessionId === expectedSessionId;

    if (live && (exactWriter || exactResume)) {
      return {
        state: status === 'starting' ? 'joining' : 'ready',
        reason: exactWriter ? 'exact-live-writer' : 'exact-resume-in-flight',
        observedSessionId: expectedSessionId,
        status,
      };
    }
    if (live) {
      return {
        state: observedSessionId ? 'conflict' : 'unknown',
        reason: observedSessionId
          ? 'live-codex-session-mismatch'
          : 'live-codex-owner-unresolved',
        observedSessionId,
        status,
      };
    }
    if (runtime.liveLifecycle === false || status === 'inactive') {
      return { state: 'launch', reason: 'codex-runtime-absent', observedSessionId, status };
    }
    return { state: 'unknown', reason: 'codex-runtime-unresolved', observedSessionId, status };
  }

  const status = cleanText(runtime.status || runtime.sessionStatus) || 'unknown';
  const observedSessionId = cleanText(runtime.sessionId) || null;
  if (LIVE_RESTORE_STATUSES.has(status) && observedSessionId === expectedSessionId) {
    return {
      state: status === 'starting' ? 'joining' : 'ready',
      reason: 'exact-live-claude-session',
      observedSessionId,
      status,
    };
  }
  if (LIVE_RESTORE_STATUSES.has(status)) {
    return {
      state: observedSessionId ? 'conflict' : 'unknown',
      reason: observedSessionId
        ? 'live-claude-session-mismatch'
        : 'live-claude-owner-unresolved',
      observedSessionId,
      status,
    };
  }
  if (status === 'inactive') {
    return { state: 'launch', reason: 'claude-runtime-absent', observedSessionId, status };
  }
  return { state: 'unknown', reason: 'claude-runtime-unresolved', observedSessionId, status };
}

export function reconcileRestoredInterruptedTab(store, tabId, runtime) {
  for (const workspace of store.openProjects.values()) {
    const tab = workspace.tabs.get(tabId);
    if (!tab?.wasInterrupted || !tab.codexSessionId) continue;
    // An old shutdown marker is not the outcome of a new Goal turn. Only a
    // current exact live writer + ready input can consume it; no saved SID,
    // ready-looking historical text or mere launch acceptance suffices.
    if (runtime?.writerConfirmed !== true || runtime.inputReady !== true) return false;
    const decision = classifyInterruptedRestoreRuntime({ engine: 'codex', sessionId: tab.codexSessionId, runtime });
    if (decision.state !== 'ready') return false;
    store.clearInterruptedState(tabId);
    return true;
  }
  return false;
}

function formatMoscowTime(value) {
  const timestamp = Number.isFinite(Number(value)) ? Number(value) : Date.now();
  return new Date(timestamp + (3 * 60 * 60 * 1000))
    .toISOString()
    .replace('T', ' ')
    .replace('Z', ' MSK');
}

/** Full copy payload for the shared ToastCard used by automatic recovery. */
export function buildInterruptedRestoreIncidentReport(input = {}) {
  const occurredAt = Number.isFinite(Number(input.occurredAt))
    ? Number(input.occurredAt)
    : Date.now();
  const tabId = cleanText(input.tabId) || '-';
  const sessionId = cleanText(input.sessionId) || '-';
  const engine = input.engine === 'claude' || input.engine === 'codex'
    ? input.engine
    : '-';
  const error = cleanText(input.detail || input.error) || 'unknown restore error';
  return [
    'Noted Terminal automatic restore incident',
    'Error: ' + error,
    'Tab ID: ' + tabId,
    'Session ID: ' + sessionId,
    'Tool: ' + engine,
    'Time (Moscow): ' + formatMoscowTime(occurredAt),
    'Time (UTC): ' + new Date(occurredAt).toISOString(),
    'Error code: ' + (cleanText(input.error) || '-'),
    'Runtime reason: ' + (cleanText(input.runtimeReason) || '-'),
    'Log lookup: [AutoResume] tab=' + tabId.slice(-12) + ' session=' + sessionId.slice(0, 8),
  ].join('\n');
}

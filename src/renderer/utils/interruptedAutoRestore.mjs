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

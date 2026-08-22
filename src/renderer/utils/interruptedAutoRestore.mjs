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

// Durable archive identity is namespace + storage id, even before opaque tab IDs.
export function omitExpiredArchiveHistory(snapshot, ids) {
  if (!snapshot || !ids?.size || !Array.isArray(snapshot.history) || !snapshot.history.some(row => ids.has(row.id))) return snapshot;
  return {...snapshot, history:snapshot.history.filter(row => !ids.has(row.id))};
}

export function archiveRecordKey(kind, row) {
  if (!['history', 'favorite'].includes(kind) || typeof row?.namespace !== 'string' || !row.namespace
    || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Invalid archive address');
  return JSON.stringify([kind, row.namespace, row.id]);
}

export function validateArchiveSnapshot(value) {
  if (value?.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.favorites))
    throw new Error('Unsupported archive response');
  const seen = new Set();
  for (const [kind, rows] of [['history', value.history], ['favorite', value.favorites]]) {
    for (const row of rows) {
      const key = archiveRecordKey(kind, row);
      if (seen.has(key)) throw new Error('Duplicate archive address');
      seen.add(key);
    }
  }
  return value; // Keep all raw columns, session/assets and future fields intact.
}

export function filterArchiveRecords(rows, { query = '', workflowId = '', cwd = '' } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => (!workflowId || row.workflowId === workflowId)
    && (!cwd || row.cwd === cwd)
    && terms.every(term => [row.name, row.cwd, row.workflowName, row.notes, row.command_type,
      row.claude_session_id, row.codex_session_id, row.gemini_session_id]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(term))));
}

export function archiveRestoreTarget(row, workflows, explicit) {
  if (explicit) {
    if (!workflows.some(workflow => workflow.id === explicit)) throw new Error('Workflow no longer exists');
    return explicit;
  }
  if (workflows.some(workflow => workflow.id === row.workflowId)) return row.workflowId;
  return workflows.find(workflow => workflow.kind === 'inbox')?.id;
}

export function archiveActionRequest(kind, row, snapshot, requestId, targetWorkflowId) {
  archiveRecordKey(kind, row);
  return {
    version: 1, namespace: row.namespace, requestId,
    ...(kind === 'history' ? { historyId: row.id,
      ...(typeof row.tab_id === 'string' && row.tab_id ? { expectedTabId: row.tab_id } : {}) }
      : { favoriteId: row.id }),
    ...(snapshot.revision !== undefined ? { expectedRevision: snapshot.revision } : {}),
    ...(targetWorkflowId ? { targetWorkflowId } : {}),
    record: structuredClone(row),
  };
}

export function archiveActionAcknowledged(result, action) {
  if (result === true) return true;
  if (!result || typeof result !== 'object' || result.success === false || result.ok === false) return false;
  if (result.success === true || result.ok === true) return true;
  return action === 'restore' && typeof result.tabId === 'string' && !!result.tabId;
}

export function archiveReceiptMatches(result, request) {
  if (!result || typeof result !== 'object') return true; // Boolean callback already resolves the exact request in Root.
  const expectedId = request.historyId ?? request.favoriteId;
  for (const [field, expected] of [['namespace', request.namespace], ['requestId', request.requestId],
    ['id', expectedId], ['historyId', request.historyId], ['favoriteId', request.favoriteId]]) {
    if (Object.hasOwn(result, field) && result[field] !== expected) return false;
  }
  return true;
}

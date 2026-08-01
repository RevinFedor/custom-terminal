'use strict';

const path = require('node:path');

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toolTypeForHistoryEntry(entry) {
  const commandType = cleanText(entry?.command_type || entry?.commandType);
  if (commandType === 'claude' || commandType === 'codex') return commandType;
  return null;
}

function resolveRestorableAgentTab({ tabId, historyEntries, project }) {
  const requestedTabId = cleanText(tabId);
  const entries = Array.isArray(historyEntries)
    ? historyEntries.filter((entry) => cleanText(entry?.tab_id || entry?.tabId) === requestedTabId)
    : [];

  if (!requestedTabId || entries.length === 0) {
    return {
      ok: false,
      code: 'target_tab_not_restorable',
      statusCode: 404,
      error: 'target tab is neither open nor present in restorable history',
    };
  }
  if (entries.length !== 1) {
    return {
      ok: false,
      code: 'target_tab_restore_ambiguous',
      statusCode: 409,
      error: 'multiple history entries claim the same target tab identity',
    };
  }

  const entry = entries[0];
  const projectId = cleanText(entry.project_id || entry.projectId);
  if (!project || cleanText(project.id || project.projectId) !== projectId) {
    return {
      ok: false,
      code: 'target_tab_restore_project_missing',
      statusCode: 409,
      error: 'target tab history no longer belongs to an available project',
    };
  }

  const toolType = toolTypeForHistoryEntry(entry);
  if (!toolType) {
    return {
      ok: false,
      code: 'target_tab_not_agent',
      statusCode: 409,
      error: 'target history entry is not a Claude/Codex agent tab',
    };
  }

  const sessionId = toolType === 'codex'
    ? cleanText(entry.codex_session_id || entry.codexSessionId) || null
    : cleanText(entry.claude_session_id || entry.claudeSessionId) || null;
  const projectPath = cleanText(project.path || project.projectPath) || null;
  const cwd = cleanText(entry.cwd) || projectPath;

  return {
    ok: true,
    historyId: entry.id,
    tabId: requestedTabId,
    tabName: cleanText(entry.name) || requestedTabId.slice(-12),
    projectId,
    projectName: cleanText(project.name || project.projectName)
      || (projectPath ? path.basename(projectPath) : projectId),
    projectPath,
    cwd,
    toolType,
    commandType: toolType,
    sessionId,
    claudeSessionId: toolType === 'claude' ? sessionId : null,
    codexSessionId: toolType === 'codex' ? sessionId : null,
    requiresRestore: true,
  };
}

function runSingleFlight(inflight, key, operation) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(operation);
  inflight.set(key, promise);
  void promise.finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  }).catch(() => {});
  return promise;
}

module.exports = {
  resolveRestorableAgentTab,
  runSingleFlight,
  toolTypeForHistoryEntry,
};

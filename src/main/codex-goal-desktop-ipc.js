'use strict';

const { codexGoalActionRequest } = require('./codex-goal-action-api');

// Thin desktop transport for the same guarded controller used by HTTP/MCP.
// No frame observation, readiness query, process start/Stop or raw PTY input.
function registerCodexGoalDesktopIpc({ ipcMain, actions, describeTab }) {
  for (const [channel, method] of [['codex:read-goal-action', 'GET'], ['codex:apply-goal-action', 'POST']]) {
    ipcMain.handle(channel, (_event, request = {}) => {
      const tabId = request?.tabId;
      if (typeof tabId !== 'string' || !tabId.trim() || tabId.length > 4096 || /[\x00-\x1f\x7f]/.test(tabId)) {
        return { ok: false, status: 'rejected', code: 'invalid-goal-action', reason: 'invalid-goal-action',
          availableActions: [] };
      }
      return codexGoalActionRequest({ method, tabId, body: request, requestId: request?.requestId,
        actions, descriptor: describeTab(tabId) }).data;
    });
  }
}

module.exports = { registerCodexGoalDesktopIpc };

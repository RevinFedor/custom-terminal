'use strict';

function createClaudeToolScreenHoldTracker() {
  const byTab = new Map();

  const start = ({ tabId, toolUseId, toolName = null } = {}) => {
    if (!tabId || !toolUseId) return false;
    let tools = byTab.get(tabId);
    if (!tools) {
      tools = new Map();
      byTab.set(tabId, tools);
    }
    tools.set(String(toolUseId), {
      toolUseId: String(toolUseId),
      toolName: toolName ? String(toolName) : null,
      completed: false,
    });
    return true;
  };

  const complete = ({ tabId, toolUseId } = {}) => {
    const tool = byTab.get(tabId)?.get(String(toolUseId || ''));
    if (!tool) return false;
    tool.completed = true;
    return true;
  };

  const release = ({ tabId, toolUseIds = [] } = {}) => {
    const tools = byTab.get(tabId);
    if (!tools) return 0;
    let removed = 0;
    for (const toolUseId of toolUseIds) {
      if (tools.delete(String(toolUseId))) removed += 1;
    }
    if (tools.size === 0) byTab.delete(tabId);
    return removed;
  };

  const releaseCompleted = (tabId) => {
    const tools = byTab.get(tabId);
    if (!tools) return 0;
    let removed = 0;
    for (const [toolUseId, tool] of tools) {
      if (!tool.completed) continue;
      tools.delete(toolUseId);
      removed += 1;
    }
    if (tools.size === 0) byTab.delete(tabId);
    return removed;
  };

  const clear = (tabId) => byTab.delete(tabId);
  const isHeld = (tabId) => (byTab.get(tabId)?.size || 0) > 0;
  const snapshot = (tabId) => Array.from(byTab.get(tabId)?.values() || [], (tool) => ({ ...tool }));

  return { start, complete, release, releaseCompleted, clear, isHeld, snapshot, _byTab: byTab };
}

module.exports = { createClaudeToolScreenHoldTracker };

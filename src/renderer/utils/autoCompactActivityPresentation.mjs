export function summarizeRunningAutoCompacts(activities = {}, tabs = []) {
  const runningTabIds = new Set(
    Object.entries(activities)
      .filter(([, activity]) => activity?.phase === 'compacting')
      .map(([tabId]) => tabId),
  );
  const workflowCounts = new Map();

  for (const tab of tabs) {
    if (!runningTabIds.has(tab.id)) continue;
    workflowCounts.set(tab.workflowId, (workflowCounts.get(tab.workflowId) || 0) + 1);
  }

  return {
    total: runningTabIds.size,
    workflowCounts,
  };
}

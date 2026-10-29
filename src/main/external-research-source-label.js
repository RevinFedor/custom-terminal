// Presentation metadata only. Never reconcile, resume, read provider results,
// inspect a session, or change the recorded source/target of an orchestration.
function externalResearchSourceLabel(run) {
  if (!run || run.runKind !== 'external-research'
      || typeof run.runId !== 'string' || !run.runId
      || typeof run.externalResearchJobId !== 'string' || !run.externalResearchJobId
      || typeof run.sourceTabId !== 'string' || !run.sourceTabId) return null;
  return {
    runId: run.runId,
    jobId: run.externalResearchJobId,
    tabId: run.sourceTabId,
    tabName: typeof run.sourceTabName === 'string' && run.sourceTabName.trim()
      ? run.sourceTabName.trim() : null,
  };
}

module.exports = { externalResearchSourceLabel };

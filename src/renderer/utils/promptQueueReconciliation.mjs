export function isWorkflowOutcomeAtOrAfterArm(workflowArmedAt, outcomeTs) {
  return Number.isFinite(workflowArmedAt)
    && Number.isFinite(outcomeTs)
    && Number(outcomeTs) >= Number(workflowArmedAt);
}

/**
 * Initial restore must apply every known failure before it considers success.
 * For success, only the newest classified outcome for a trigger is relevant;
 * replaying older successes could consume multiple queue items at startup.
 */
export function planWorkflowReconciliation(evidence) {
  const abnormal = [];
  const latestNaturalByTrigger = new Map();
  for (const item of evidence) {
    if (!item || !item.tabId) continue;
    if (item.kind === 'abnormal') {
      abnormal.push(item);
      continue;
    }
    if (item.kind !== 'natural' || !Number.isFinite(item.timestamp)) continue;
    const current = latestNaturalByTrigger.get(item.tabId);
    if (!current || Number(item.timestamp) >= Number(current.timestamp)) {
      latestNaturalByTrigger.set(item.tabId, item);
    }
  }
  return { abnormal, natural: Array.from(latestNaturalByTrigger.values()) };
}

// One onTab condition can await several independent successful workflows.
// Completion is durable per selected tab; subsequent turns do not reinsert it.
export function normalizePromptTabTrigger(trigger) {
  if (trigger?.kind !== 'onTab' || typeof trigger.tabId !== 'string' || !trigger.tabId) return null;
  if (!Array.isArray(trigger.dependencies)) return { kind: 'onTab', tabId: trigger.tabId };
  const seen = new Set();
  const dependencies = trigger.dependencies.flatMap(dep => {
    if (typeof dep?.tabId !== 'string' || !dep.tabId || seen.has(dep.tabId)) return [];
    seen.add(dep.tabId);
    const armedAt = Number.isFinite(dep.armedAt) && dep.armedAt >= 0 ? dep.armedAt : Number.MAX_SAFE_INTEGER;
    return [{ tabId: dep.tabId, armedAt,
      ...(Number.isFinite(dep.completedAt) && dep.completedAt >= armedAt ? { completedAt: dep.completedAt } : {}) }];
  });
  return dependencies.length ? { kind: 'onTab', tabId: trigger.tabId, dependencies } : { kind: 'onTab', tabId: trigger.tabId };
}

export function pendingPromptTabIds(trigger) {
  if (trigger?.kind !== 'onTab') return [];
  return Array.isArray(trigger.dependencies)
    ? trigger.dependencies.filter(dep => !Number.isFinite(dep.completedAt)).map(dep => dep.tabId)
    : [trigger.tabId];
}

export function promptTabTriggerReady(trigger) {
  return trigger?.kind !== 'onTab' || !Array.isArray(trigger.dependencies)
    || trigger.dependencies.length > 0 && pendingPromptTabIds(trigger).length === 0;
}

export function promptTabTriggerMatches(trigger, tabId) {
  return pendingPromptTabIds(trigger).includes(tabId);
}

export function appendPromptTabDependency(trigger, tabId, armedAt, legacyArmedAt = armedAt) {
  const prior = normalizePromptTabTrigger(trigger);
  const dependencies = prior?.dependencies || (prior ? [{ tabId: prior.tabId, armedAt: legacyArmedAt }] : []);
  if (dependencies.some(dep => dep.tabId === tabId && !Number.isFinite(dep.completedAt))) return prior;
  const next = dependencies.filter(dep => dep.tabId !== tabId).concat({ tabId, armedAt });
  return { kind: 'onTab', tabId: next.find(dep => !Number.isFinite(dep.completedAt)).tabId, dependencies: next };
}

export function completePromptTabDependency(trigger, tabId, outcomeTs) {
  if (!Array.isArray(trigger?.dependencies) || !Number.isFinite(outcomeTs)) return trigger;
  const dep = trigger.dependencies.find(dep => dep.tabId === tabId && !Number.isFinite(dep.completedAt));
  if (!dep || outcomeTs < dep.armedAt) return trigger;
  const dependencies = trigger.dependencies.map(dep => dep.tabId === tabId ? { ...dep, completedAt: outcomeTs } : dep);
  return { ...trigger, tabId: dependencies.find(dep => !Number.isFinite(dep.completedAt))?.tabId || tabId, dependencies };
}

export function removePromptTabDependency(trigger, tabId) {
  if (trigger?.kind !== 'onTab') return trigger;
  if (!Array.isArray(trigger.dependencies)) return trigger.tabId === tabId ? null : trigger;
  const dependencies = trigger.dependencies.filter(dep => dep.tabId !== tabId);
  const pending = dependencies.find(dep => !Number.isFinite(dep.completedAt));
  return pending ? { ...trigger, tabId: pending.tabId, dependencies } : null;
}

export function createsPromptQueueCycle(queues, ownerTabId, targetTabId) {
  const visited = new Set(), visiting = new Set();
  const visit = id => {
    if (id === ownerTabId || visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const q = queues.get(id), head = q?.items.find(item => item.enabled !== false);
    const targets = head?.trigger?.kind === 'onTab' ? pendingPromptTabIds(head.trigger)
      : q?.runAfterTabId ? [q.runAfterTabId] : [];
    if (targets.some(visit)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return visit(targetTabId);
}

const sourceForRequirement = requirement => String(requirement || '').split(':', 1)[0];

export function panePrewarmRequirements(config = {}) {
  const requirements = new Set();
  if (config.historyRequired) {
    requirements.add('history:load');
    requirements.add('history:subscribe');
  }
  if (config.timelineRequired) {
    if (config.timelineLoadRequired) requirements.add('timeline:load');
    if (config.timelineSubscribeRequired) requirements.add('timeline:subscribe');
  }
  return requirements;
}

export function panePrewarmSourceKeys(config = {}) {
  return {
    history: String(config.historyOwnerKey || ''),
    timeline: String(config.timelineOwnerKey || ''),
  };
}

const sameSet = (left, right) => (
  left.size === right.size && Array.from(left).every(value => right.has(value))
);

/**
 * Rebase an active hidden-prewarm lease onto the sources now owned by its
 * pane. Facts from an unchanged source remain useful; facts from a changed
 * source are revoked even when its session id happens to be equal.
 */
export function reconcilePanePrewarmTracker(tracker, config = {}) {
  const requirements = panePrewarmRequirements(config);
  const sourceKeys = panePrewarmSourceKeys(config);
  const changedSources = new Set();
  for (const source of ['history', 'timeline']) {
    if (String(tracker.sourceKeys?.[source] || '') !== sourceKeys[source]) changedSources.add(source);
  }
  const requirementsChanged = !sameSet(tracker.requirements, requirements);
  for (const requirement of Array.from(tracker.settled)) {
    if (!requirements.has(requirement) || changedSources.has(sourceForRequirement(requirement))) {
      tracker.settled.delete(requirement);
    }
  }
  tracker.sessionId = String(config.sessionId || '');
  tracker.requirements = requirements;
  tracker.sourceKeys = sourceKeys;
  const pending = Array.from(requirements).filter(requirement => !tracker.settled.has(requirement));
  return {
    changed: requirementsChanged || changedSources.size > 0,
    changedSources,
    pending,
    historyPending: pending.some(requirement => requirement.startsWith('history:')),
    timelinePending: pending.some(requirement => requirement.startsWith('timeline:')),
  };
}

export function panePrewarmSignalMatches(config, requirement, ownerKey) {
  const source = sourceForRequirement(requirement);
  const expected = source === 'history'
    ? String(config?.historyOwnerKey || '')
    : source === 'timeline'
      ? String(config?.timelineOwnerKey || '')
      : '';
  return !!expected && String(ownerKey || '') === expected;
}

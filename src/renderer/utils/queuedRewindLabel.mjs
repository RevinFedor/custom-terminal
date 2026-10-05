export function rewindIteration(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function queuedRewindLabel(action, resolvedIteration) {
  const iteration = rewindIteration(action?.targetIteration) || rewindIteration(resolvedIteration);
  return iteration ? `Rewind: ${iteration}` : 'Rewind';
}

export function findRewindIteration(entries, uuid) {
  let iteration = 0;
  for (const entry of entries || []) {
    if (entry.type !== 'user' || entry.isCompactSummary) continue;
    iteration++;
    if (entry.uuid === uuid) return iteration;
  }
  return null;
}

// Legacy actions have UUID/text but no display ordinal. Read once per session
// for concurrent local/global panels; never mutate an executing queue payload.
export function createRewindLabelReader(read) {
  const pending = new Map(), resolved = new Map();
  return async (action, context) => {
    const known = rewindIteration(action.targetIteration);
    if (known) return known;
    const owner = JSON.stringify([context.tabId, context.cwd, action.toolType, action.sourceSessionId]);
    const key = JSON.stringify([owner, action.targetUuid]);
    if (resolved.has(key)) return resolved.get(key);
    let request = pending.get(owner);
    if (!request) {
      request = Promise.resolve().then(() => read({ ...context, toolType: action.toolType, sessionId: action.sourceSessionId }));
      pending.set(owner, request);
      request.finally(() => { if (pending.get(owner) === request) pending.delete(owner); }).catch(() => {});
    }
    const result = await request;
    const iteration = result?.success ? findRewindIteration(result.entries, action.targetUuid) : null;
    if (iteration) {
      resolved.set(key, iteration);
      while (resolved.size > 512) resolved.delete(resolved.keys().next().value);
    }
    return iteration;
  };
}

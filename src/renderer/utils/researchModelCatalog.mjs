export function savedResearchModel(run) {
  const bounded = value => typeof value === 'string' && value.length <= 200 ? value : null;
  return { model: bounded(run.externalResearchModel), mode: bounded(run.externalResearchMode),
    effort: bounded(run.externalResearchEffort), label: bounded(run.label) };
}

/** One identical metadata read per retained tab/session owner, shared by
 * History and Timeline. No response bodies, SC calls, polling, or runtime proof.
 * Event values win a late catalog read. Failed reads are retryable on a later
 * explicit activation; unknown fields remain null. */
export function createResearchModelCatalog(maxOwners = 32) {
  const owners = new Map();
  const get = (owner, tabId) => {
    let record = owners.get(owner);
    if (!record) {
      record = { tabId, values: {}, events: {}, checked: new Set(), inFlightIds: new Set(), promise: null, loaded: false };
      owners.set(owner, record);
      if (owners.size > maxOwners) owners.delete(owners.keys().next().value);
    }
    return record;
  };
  const read = (owner, tabId, load, requiredRunIds = []) => {
      const record = get(owner, tabId);
      const required = [...new Set(requiredRunIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))];
      const known = id => Object.hasOwn(record.values, id) || record.checked.has(id);
      if (record.loaded && required.every(known)) return Promise.resolve(record.values);
      if (record.promise) {
        if (required.every(id => known(id) || record.inFlightIds.has(id))) return record.promise;
        // A new completion may arrive after this read took its snapshot. Join
        // it, then refresh once only if the new exact IDs are still uncovered.
        return record.promise.then(() => read(owner, tabId, load, required));
      }
      record.inFlightIds = new Set(required);
      record.promise = Promise.resolve().then(() => load(tabId)).then(runs => {
        if (!Array.isArray(runs)) throw new Error('Invalid saved research catalog response');
        const values = {};
        for (const run of runs) if (run?.runKind === 'external-research' && typeof run.runId === 'string' && run.runId.trim())
          values[run.runId] = savedResearchModel(run);
        record.values = { ...record.values, ...values, ...record.events };
        for (const id of required) record.checked.add(id);
        record.loaded = true;
        return record.values;
      }).finally(() => { record.promise = null; record.inFlightIds.clear(); });
      return record.promise;
  };
  return {
    read,
    publish(owner, tabId, run) {
      if (run?.runKind !== 'external-research' || run.sourceTabId !== tabId || typeof run.runId !== 'string' || !run.runId.trim()) return null;
      const record = get(owner, tabId);
      const next = savedResearchModel(run), previous = record.values[run.runId];
      if (previous?.model === next.model && previous?.mode === next.mode && previous?.effort === next.effort && previous?.label === next.label)
        return record.values;
      record.events = { ...record.events, [run.runId]: next };
      record.values = { ...record.values, [run.runId]: next };
      return record.values;
    },
    peek(owner) { return owners.get(owner)?.values || null; },
  };
}

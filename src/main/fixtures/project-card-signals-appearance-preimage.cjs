'use strict';

// A versioned read projection of existing owners. This never owns plans,
// settings, pending updates, provider work, or a second event scheduler.
const { TASK_PLAN_MAX_ROOTS } = require('./tab-task-plan');
const CAPABILITY = Object.freeze({ version: 1, endpoint: '/api/projects/:id/tabs',
  responseField: 'cardSignals', wakeTransport: 'project-activity', wakeField: 'cardSignals',
  maxPlanItems: TASK_PLAN_MAX_ROOTS });
const unknownFast = reason => ({ known: false, enabled: null, serviceTier: null, owner: null, proof: null, reason });

function projectFastSignal(identity, retained) {
  if (identity?.success !== true) return unknownFast(identity?.reason || 'owner-unproven');
  const owner = {
    ownerId: identity.ownerId,
    generationMode: identity.generationMode,
    generationId: identity.generationId,
    launchId: identity.launchId || null,
    terminalLifecycleGeneration: identity.terminalLifecycleGeneration,
    terminalRunSeq: identity.terminalRunSeq,
  };
  const proof = retained?.preserved === true ? retained.proof : null;
  if (!proof || !['priority', 'default'].includes(proof.serviceTier)) {
    return { ...unknownFast(retained?.reason || 'service-tier-unproven'), owner };
  }
  return { known: true, enabled: proof.serviceTier === 'priority', serviceTier: proof.serviceTier,
    owner, proof: { source: proof.source, proofAt: proof.proofAt }, reason: null };
}

function createProjectCardSignals({ epoch, readTabs, readPending, readCatalog, readFast, onDirty = () => {} }) {
  if (!epoch) throw new Error('card_signals_epoch_required');
  let revision = 0, allProjects = false;
  const dirty = new Set(), fingerprints = new Map(), directoryFingerprints = new Map();
  const invalidate = projectId => {
    revision += 1;
    if (projectId) dirty.add(projectId); else allProjects = true;
    onDirty();
  };
  const wake = () => ({ version: 1, epoch, revision, allProjects, projectIds: [...dirty].sort() });
  return {
    capability: CAPABILITY, invalidate, wake,
    flushed: () => { dirty.clear(); allProjects = false; },
    snapshot(projectId, requestedTabIds, { scope = null } = {}) {
      if (typeof projectId !== 'string' || !projectId) throw new Error('card_signals_project_required');
      const ids = [...new Set(requestedTabIds.filter(id => typeof id === 'string' && id))];
      const rows = new Map(readTabs(projectId, ids).map(row => [row.tabId, row]));
      const pending = readPending(ids);
      const catalog = readCatalog();
      const tabs = ids.map(tabId => {
        const row = rows.get(tabId);
        return { tabId,
          fast: row ? readFast(tabId, row) : unknownFast('tab-not-persisted-in-project'),
          plan: row?.plan || { known: false, revision: null, items: [], reason: 'tab-not-persisted-in-project' },
          pendingContext: row && pending[tabId] || { known: false, revision: null, count: null },
        };
      });
      const data = { projectId, taskStatuses: catalog.taskStatuses, taskStatusMarker: catalog.taskStatusMarker, tabs };
      const fingerprint = JSON.stringify(scope === 'directory-v2'
        ? { ...data, tabs: [...tabs].sort((a, b) => a.tabId.localeCompare(b.tabId)) } : data);
      const cache = scope === 'directory-v2' ? directoryFingerprints : fingerprints;
      const key = scope === 'directory-v2' ? JSON.stringify([projectId, [...ids].sort()]) : projectId;
      const previous = cache.get(key);
      // Queries can discover a missed/offline metadata change. Never stamp two
      // different card snapshots with one clock value; wake is still coalesced
      // by the existing project activity scheduler, not by this reader.
      if (previous !== undefined && previous !== fingerprint) invalidate(projectId);
      cache.set(key, fingerprint);
      if (cache === directoryFingerprints && cache.size > 128) cache.delete(cache.keys().next().value);
      return { version: 1, epoch, revision, ...data };
    },
  };
}

module.exports = { CARD_SIGNALS_CAPABILITY: CAPABILITY, createProjectCardSignals, projectFastSignal, unknownFast };

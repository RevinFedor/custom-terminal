'use strict';

const { randomUUID } = require('node:crypto');
const TAB_ACTIVITY_CAPABILITY = Object.freeze({ version: 1, responseField: 'tabActivity',
  projectEndpoint: '/api/projects/:id/tabs', snapshotEndpoint: '/api/project-activity',
  tabEndpoint: '/api/terminal-tabs/:id/status', event: 'project-activity', tabEvent: 'tab-activity',
  processBarSource: 'desktop-processBar' });

function processBarValue(value) {
  if (!value || !['left', 'right'].includes(value.position)) return null;
  const out = { position: value.position };
  for (const key of ['colorA', 'shimmerColor', 'inheritedColor']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 128) return null;
    out[key] = value[key];
  }
  for (const key of ['shimmerSpacingPct', 'shimmerOpacityPct']) {
    if (!Number.isFinite(value[key])) return null;
    out[key] = value[key];
  }
  return out;
}

// Read projection only: no timers, runtime mutations, run scheduling or I/O.
// Synchronous captures sample the registry and own activity together. This
// clock is independent of runtimeRevision and never authorizes an input action.
function createPublicTabActivity({ epoch = randomUUID(), readState, readInherited, onChanged = () => {} }) {
  let revision = 0, fingerprint = null, styleRevision = 0;
  let style = { known: false, stale: false, source: 'desktop-processBar', value: null, reason: 'not-observed' };
  const invalidate = (reason = 'changed', notify = true) => { revision++; if (notify) onChanged(reason); };
  const observeStyle = (value, expectedRevision = styleRevision) => {
    if (expectedRevision !== styleRevision) return false;
    const normalized = processBarValue(value);
    const next = normalized
      ? { known: true, stale: false, source: 'desktop-processBar', value: normalized, reason: null }
      : { ...style, known: false, stale: !!style.value, reason: 'renderer-unavailable' };
    if (JSON.stringify(next) === JSON.stringify(style)) return true;
    style = next; styleRevision++; invalidate('process-bar-style'); return true;
  };
  const sample = () => {
    let all = [], known = true, reason = null;
    try {
      const state = readState(), inherited = readInherited();
      if (state?.known !== true || inherited?.known !== true) {
        known = false; reason = state?.reason || inherited?.reason || 'owner-unavailable';
      } else {
        const sources = new Set(inherited.sourceTabIds);
        all = state.tabs.map(tab => {
          const ownBusy = tab.ownBusy === true, inheritedBusy = sources.has(tab.tabId);
          return { projectId: tab.projectId, tabId: tab.tabId, owner: tab.owner,
            ownBusy, inheritedBusy, loader: ownBusy || inheritedBusy,
            kind: ownBusy ? 'own' : inheritedBusy ? 'inherited' : 'idle' };
        }).sort((a, b) => a.tabId.localeCompare(b.tabId));
      }
    } catch (error) {
      known = false; reason = 'metadata-read-failed';
      console.warn('[TabActivity] metadata read failed:', String(error?.message || error).slice(0, 240));
    }
    const nextFingerprint = JSON.stringify([known, reason, all, style]);
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint; invalidate('activity-projection');
    }
    const capturedRevision = revision;
    const capturedStyle = { ...style, value: style.value && { ...style.value } };
    return ({ projectId = null, tabId = null } = {}) => {
      const scoped = all.filter(tab => (!projectId || tab.projectId === projectId) && (!tabId || tab.tabId === tabId));
      const found = !tabId || scoped.length > 0;
      return { version: 1, epoch, revision: capturedRevision,
        scope: { kind: tabId ? 'tab' : projectId ? 'project' : 'all', projectId, tabId },
        known: known && found, reason: known && !found ? 'tab-not-found' : reason,
        loaderCount: known && found ? scoped.filter(tab => tab.loader).length : null,
        processBar: capturedStyle,
        // Global is a complete ACTIVE set. Scoped reads also include idle tabs.
        activeSet: !projectId && !tabId,
        tabs: !projectId && !tabId ? scoped.filter(tab => tab.loader) : scoped };
    };
  };
  return { capability: { ...TAB_ACTIVITY_CAPABILITY, epoch }, sample, capture: scope => sample()(scope), invalidate, observeStyle,
    styleRevision: () => styleRevision, clock: () => ({ epoch, revision }) };
}
module.exports = { createPublicTabActivity, TAB_ACTIVITY_CAPABILITY, processBarValue };

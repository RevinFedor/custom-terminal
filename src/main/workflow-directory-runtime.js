'use strict';

const { sameDirectoryScope, executionRefForInput } = require('../shared/workflow-directory-catalog.cjs');

// Only the producer's retained owner can bind a positive runtime observation
// to execution. Fresh SQL/target tabId never supplies a missing owner proof.
function projectDirectoryRuntime(entry, state, epoch) {
  const ref = executionRefForInput(entry), stored = state.stored, scope = stored?.scope;
  const oldAddress = scope?.executionScope || (scope ? { version: 1, tabId: entry.tabId,
    projectId: scope.projectId, cwd: scope.cwd } : null);
  const pinned = state.terminalPresent === true && state.sdkPresent === false
    && stored?.observationKnown === true && !stored.transition && typeof stored.token === 'string' && !!stored.token
    && typeof stored.epoch === 'string' && Number.isSafeInteger(stored.revision) && scope?.instanceId === epoch
    && sameDirectoryScope(oldAddress, ref.subject) && scope.provider === state.provider
    && (entry.nativeRow || entry.legacyRow).command_type === state.provider
    && state.terminalId && scope.terminalId === state.terminalId && scope.runSeq === state.runSeq
    && scope.launchId === state.launchId && scope.projectId === ref.namespace && scope.cwd === ref.cwd
    && state.projectId === ref.namespace && state.cwd === ref.cwd;
  const absent = state.terminalPresent === false && state.sdkPresent === false
    && state.lookupUnknown !== true && state.liveOwnerCount === 0;
  const stopped = state.terminalPresent === true && state.sdkPresent === false
    && state.commandRunning === false && state.lookupUnknown !== true
    && state.projectId === ref.namespace && state.cwd === ref.cwd;
  const liveKnown = absent || stopped || !!(pinned && state.commandRunning === true && state.liveOwnerCount === 1);
  const live = liveKnown ? !(absent || stopped) : null;
  const ownKnown = (pinned && typeof state.ownBusy === 'boolean')
    || ((absent || stopped) && !state.pending && state.ownBusy !== true);
  const ownBusy = ownKnown ? state.pending === true || state.ownBusy === true : null;
  const inheritedKnown = state.inheritedKnown === true && (pinned || !state.inheritedBusy);
  const inheritedBusy = inheritedKnown ? state.inheritedBusy === true : null;
  const busyKnown = ownBusy === true || inheritedBusy === true || ownKnown && inheritedKnown;
  // Old notifications have only tabId/projectId/time. They remain visible via
  // v1, but time/projectId is not an exact subject/owner proof for v2.
  const notificationKnown = !state.notification || !!(pinned
    && sameDirectoryScope(state.notification.executionScope, ref.subject)
    && state.notification.ownerToken === stored.token);
  return { tabId: entry.tabId, executionScope: ref.subject, provider: state.provider ?? null,
    ownerToken: pinned ? stored.token : null,
    ownerOrder: pinned ? { epoch: stored.epoch, revision: stored.revision } : null,
    lifecycleGeneration: state.lifecycleGeneration ?? null, terminalRunSeq: state.runSeq ?? 0, launchId: state.launchId ?? null,
    liveKnown, live, busyKnown: !!busyKnown, ownBusy, inheritedBusy,
    notificationKnown, notification: notificationKnown ? !!state.notification : null,
    reason: liveKnown && busyKnown && notificationKnown ? null : 'runtime-owner-unproven',
    reasons: { live: liveKnown ? null : state.lookupUnknown ? 'process-lookup-unknown'
      : state.sdkPresent ? 'sdk-execution-owner-unproven' : 'retained-owner-unproven',
      busy: busyKnown ? null : state.inheritedKnown !== true ? 'inherited-source-unavailable' : 'busy-owner-unproven',
      notification: notificationKnown ? null : 'notification-binding-unproven' },
    proof: absent ? 'main-registry-absent' : stopped ? 'main-command-stopped'
      : pinned ? 'retained-exact-main-owner' : 'unproven' };
}

function createDirectoryRuntimeReader({ epoch, ownerInstanceId = epoch, capture, beginSample = () => {} }) {
  return entries => {
    const read = () => { beginSample(); return entries.map(entry => capture(entry)); };
    const states = read(), fingerprint = JSON.stringify(states);
    return { epoch, tabs: entries.map((entry, index) => projectDirectoryRuntime(entry, states[index], ownerInstanceId)),
      isCurrent: () => JSON.stringify(read()) === fingerprint };
  };
}
module.exports = { projectDirectoryRuntime, createDirectoryRuntimeReader };

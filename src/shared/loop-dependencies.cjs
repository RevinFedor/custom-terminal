'use strict';

const ACTIVE = new Set(['creating', 'starting', 'sending', 'sent', 'queued', 'running', 'waiting_descendants']);
const { isOrchestrationCompletionBlocking } = require('./orchestration-activity.cjs');

// Missing/legacy settings always keep the ordinary whole-work Loop.
function loopPromptMode(queue) {
  return queue?.loopPromptMode === 'own-turn' ? 'own-turn' : 'all-work';
}

function loopRunAdmission(runs, tabId, mode, known = true) {
  if (!known || !Array.isArray(runs)) return false;
  return mode === 'own-turn' ? loopExternalWaitAdmission(runs, tabId)
    : !runs.some(run => run.sourceTabId === tabId && isOrchestrationCompletionBlocking(run));
}

// This is Loop-review admission only. Whole-work completion keeps its policy.
function loopExternalWaitAdmission(runs, tabId, known = true) {
  if (!known || !Array.isArray(runs)) return false;
  return runs.filter(run => run.sourceTabId === tabId && isOrchestrationCompletionBlocking(run))
    .every(run => !!run.runId && ACTIVE.has(run.status)
      && !run.externalResearchDeliveryUnknown && !run.deliveryTransportUnknownAt
      && !run.sourceFollowupPending && !run.sourceFollowupStartedAt);
}

function normalizeLoopDependencies(input) {
  if (!Array.isArray(input) || !input.length || input.length > 32) throw Error('loop_dependencies_required');
  const seen = new Set();
  return input.map(ref => {
    if (!ref || !['run', 'message'].includes(ref.kind) || typeof ref.id !== 'string'
      || !ref.id.trim() || ref.id.length > 256) throw Error('loop_dependency_invalid');
    const key = ref.kind + ':' + ref.id;
    if (seen.has(key)) throw Error('loop_dependency_duplicate');
    seen.add(key); return { kind: ref.kind, id: ref.id };
  }).sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
}

function loopEpoch(queue) {
  return queue?.loopPromptEpoch || (queue?.loopPromptEnabled && Number.isFinite(queue.loopPromptArmedAt)
    ? 'legacy:' + queue.loopPromptArmedAt : null);
}

function sameLoopTurn(a, b) {
  return !!a && !!b && !!a.turnId && a.turnId === b.turnId
    && a.sessionId === b.sessionId && a.provider === b.provider;
}

module.exports = { loopPromptMode, loopRunAdmission, loopExternalWaitAdmission, normalizeLoopDependencies, loopEpoch, sameLoopTurn };

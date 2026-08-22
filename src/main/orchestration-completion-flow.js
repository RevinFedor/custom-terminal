'use strict';

const FLOW_PHASES = Object.freeze([
  'created',
  'probing-result',
  'arming-proof',
  'recording-result',
  'returned',
]);

function createTrace() {
  let phase = FLOW_PHASES[0];
  const trace = [{ phase, reason: 'created' }];
  return {
    advance(next, reason) {
      const currentIndex = FLOW_PHASES.indexOf(phase);
      const nextIndex = FLOW_PHASES.indexOf(next);
      if (nextIndex <= currentIndex) {
        throw new Error('Orchestration completion flow cannot move from ' + phase + ' to ' + next);
      }
      phase = next;
      trace.push({ phase, reason });
    },
    finish(outcome, result = {}) {
      this.advance('returned', outcome);
      return { outcome, ...result, flowTrace: trace.map((item) => ({ ...item })) };
    },
  };
}

// One pass is intentionally short. Long waits belong to the persisted run and
// proof coordinator; transcript changes or restart invoke another pass.
async function runOrchestrationCompletionFlow({
  run,
  probeResult,
  classifyProbe,
  armProof,
  markTerminalFailure,
  recordResult,
}) {
  const flow = createTrace();
  if (run?.status !== 'completed') return flow.finish('ready', { run });

  flow.advance('probing-result', 'fresh-result-read');
  let probe = await probeResult();
  let classification = classifyProbe(probe);
  let watcher = null;

  if (classification.kind === 'pending') {
    flow.advance('arming-proof', 'result-incomplete');
    watcher = await armProof(probe);
    if (watcher?.success === true) {
      probe = await probeResult();
      classification = classifyProbe(probe);
    }
  }

  if (classification.kind === 'terminal-failure') {
    const failed = await markTerminalFailure(classification, probe);
    return flow.finish('terminal-failure', { run: failed, probe, classification, watcher });
  }

  flow.advance('recording-result', classification.kind);
  const recorded = await recordResult(probe, classification, watcher);
  if (recorded?.status === 'completed' && recorded.resultComplete !== true) {
    return flow.finish('pending', { run: recorded, probe, classification, watcher });
  }
  return flow.finish('ready', { run: recorded, probe, classification, watcher });
}

module.exports = {
  ORCHESTRATION_COMPLETION_FLOW_PHASES: FLOW_PHASES,
  runOrchestrationCompletionFlow,
};

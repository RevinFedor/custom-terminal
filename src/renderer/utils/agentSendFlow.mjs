const FLOW_PHASES = Object.freeze([
  'created',
  'preparing-context',
  'ensuring-ready',
  'proving-composer',
  'provider-operation',
  'returned',
]);

const FLOW_PHASE_INDEX = new Map(FLOW_PHASES.map((phase, index) => [phase, index]));

function createFlowTrace(onPhase) {
  let phase = 'created';
  const trace = [{ phase, at: Date.now(), reason: 'created' }];
  const advance = (nextPhase, reason, detail = null) => {
    const currentIndex = FLOW_PHASE_INDEX.get(phase);
    const nextIndex = FLOW_PHASE_INDEX.get(nextPhase);
    if (nextIndex == null) throw new Error('Unknown agent send flow phase: ' + nextPhase);
    if (currentIndex == null || nextIndex <= currentIndex) {
      throw new Error('Agent send flow cannot move from ' + phase + ' to ' + nextPhase);
    }
    phase = nextPhase;
    const event = { phase, at: Date.now(), reason, ...(detail ? { detail } : {}) };
    trace.push(event);
    onPhase?.(event);
    return event;
  };
  return {
    advance,
    snapshot: () => ({ phase, trace: trace.map((event) => ({ ...event })) }),
  };
}

const finishResult = (flow, result, reason) => {
  // `returned` means the renderer driver finished this invocation. It is not
  // delivery truth; durable SENT/UNKNOWN/CANCELLED authority remains in the
  // main-process receipt store and may settle later after renderer reload.
  flow.advance('returned', reason);
  const snapshot = flow.snapshot();
  return {
    ...(result || {}),
    sendFlowPhase: snapshot.phase,
    sendFlowTrace: snapshot.trace,
  };
};

/**
 * Provider-neutral product transaction.
 *
 * Every callback is an adapter boundary. This file deliberately knows
 * nothing about Claude screens, Codex rollout carriers, IPC channels, model
 * pickers or xterm. Reading this function is enough to see the complete send
 * order; provider mechanics live behind the callbacks.
 */
export async function runAgentSendFlow({
  prepareContext,
  ensureReady,
  finishAfterReady,
  proveComposer,
  runProviderOperation,
  recoverReadyFailure,
  onPhase,
}) {
  const flow = createFlowTrace(onPhase);
  try {
    flow.advance('preparing-context', 'prepare-context');
    const context = await prepareContext();
    if (context?.complete === true) {
      return finishResult(flow, context.result, 'context-complete');
    }

    flow.advance('ensuring-ready', 'ensure-ready');
    let ready;
    try {
      ready = await ensureReady(context);
    } catch (error) {
      if (!recoverReadyFailure) throw error;
      const recovered = await recoverReadyFailure(error, context);
      if (recovered?.complete !== true) throw error;
      return finishResult(flow, recovered.result, 'ready-failure-recovered');
    }

    if (finishAfterReady) {
      const finished = await finishAfterReady(context, ready);
      if (finished?.complete === true) {
        return finishResult(flow, finished.result, 'ready-complete');
      }
    }

    flow.advance('proving-composer', 'prove-composer');
    const composer = await proveComposer(context, ready);
    if (composer?.complete === true) {
      return finishResult(flow, composer.result, 'composer-refused');
    }

    // The adapter owns settings, any post-settings composer re-proof, the
    // physical Enter boundary and provider audit. The driver intentionally
    // does not pretend those provider-specific sub-phases are complete here.
    flow.advance('provider-operation', 'prepare-submit-and-audit');
    const result = await runProviderOperation(context, ready, composer);
    return finishResult(flow, result, 'transport-returned');
  } catch (error) {
    const snapshot = flow.snapshot();
    if (error && typeof error === 'object') {
      error.sendFlowPhase = snapshot.phase;
      error.sendFlowTrace = snapshot.trace;
      // An initialized session and permission to paste are separate facts.
      // A readiness/composer failure happens before this invocation can call
      // the provider adapter. Keep that negative receipt across the bridge;
      // absence of a renderer reply is a different, genuinely unknown case.
      if (snapshot.phase === 'ensuring-ready' || snapshot.phase === 'proving-composer') {
        error.sendReceipt = {
          success: false,
          accepted: false,
          submitted: false,
          pasteWritten: false,
          enterWritten: false,
          status: 'not-submitted',
          code: error.code || 'agent_send_preflight_failed',
          ...(error.cancelled === true ? { cancelled: true } : {}),
          error: String(error.message || error),
          ...(error.manualActionRequired === true ? {
            manualActionRequired: true, manualActionType: error.manualActionType,
          } : {}),
          sendFlowPhase: snapshot.phase,
          sendFlowTrace: snapshot.trace,
          ...(error.draftTransfer ? { draftTransfer: error.draftTransfer } : {}),
        };
      }
    }
    throw error;
  }
}

export const AGENT_SEND_FLOW_PHASES = FLOW_PHASES;

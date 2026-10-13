import { retryInterruptedRestoreAdmission } from './interruptedAutoRestore.mjs';
import { readAgentLaunchFence, rememberAgentLaunchFence, observeAgentLaunchFences } from './agentLaunchFence.mjs';

let rendererNonce;
let nextIntent = 0;
const nextId = () => `launch:${rendererNonce ||= globalThis.crypto.randomUUID()}:${++nextIntent}`;
const copy = value => structuredClone(value);
const sameFence = (a, b) => !!a && !!b
  && a.terminalInstanceId === b.terminalInstanceId && a.stopRevision === b.stopRevision;

// One local scope owns acquisition, cancellation and the entire retry budget.
// The Main preparation registry owns authority; this is neither a Send nor a queue.
/** @param {any} options */
export function createAgentLaunchAdmission({
  invoke, events, tabId, toolType, sessionId = null, cwd, launchFence,
  sendOperationKey, sendAttemptId, expectedTarget,
  assertCurrent = () => {}, signal, onRetry = () => {},
  createId = nextId, wait, inspectTimeoutMs = 2000, responseTimeoutMs = 60000,
}) {
  observeAgentLaunchFences(events);
  // Freeze synchronously before the first invoke/await. New publications may
  // update the next explicit intent, never this one or its retry budget.
  launchFence = launchFence !== undefined ? copy(launchFence) : readAgentLaunchFence(tabId);
  const intentId = createId();
  const identity = { tabId, toolType, intentId };
  let witness, cancelled, finished = false, attempt = 0;
  let validatedBeginRefusal;
  let runPromise, runKey, materializePromise, materializeKey;
  let sourceChanged = false, sourceSession, sourceJoinPromise, sourceJoinResult;
  let resolveSourceJoin;
  const sourceJoin = new Promise(resolve => { resolveSourceJoin = resolve; });
  const abortReason = () => typeof signal?.reason === 'string' ? signal.reason : 'preparation-aborted';
  let resolveCancellation;
  const cancellation = new Promise(resolve => { resolveCancellation = resolve; });
  const trace = (stage, fields = {}) => ({
    success: false, accepted: attempt ? null : false,
    launchWritten: attempt ? null : false,
    stage, launchStage: stage, launchAttempt: attempt,
    launchIntent: witness || null, launchFence: witness?.launchFence || launchFence || null, intentId,
    // This scope owns launch admission, not the historical input outcome of
    // the caller's durable attempt. A transport/refusal projection must not
    // let the outer Send flow invent no-paste/no-Enter for that attempt.
    ...(sendOperationKey || sendAttemptId ? { sendReceipt: {
      success: null, accepted: null, submitted: null, status: 'delivery-unknown', deliveryUnknown: true,
      operationKey: sendOperationKey || null, attemptId: sendAttemptId || null,
    } } : {}),
    ...fields,
  });
  const failure = (error, stage) => {
    // A validated negative begin ACK is a known no-launch result. Preserve its
    // proof through run/materialize; transport loss and missing echo stay unknown.
    if (validatedBeginRefusal && error === validatedBeginRefusal.error) {
      return trace(stage, { ...validatedBeginRefusal.result, launchOutcomeUnknown: false });
    }
    return trace(stage, {
      code: error?.code || 'agent_launch_admission_unknown',
      error: error?.message || String(error),
      reason: error?.reason || error?.code || 'launch-admission-transport-unknown',
      accepted: null, launchWritten: error?.launchWritten === true ? true : null,
      launchOutcomeUnknown: true,
      ...(error?.sendReceipt ? { sendReceipt: error.sendReceipt }
        : sendOperationKey || sendAttemptId ? { sendReceipt: {
          success: null, accepted: null, submitted: null, status: 'delivery-unknown', deliveryUnknown: true,
          operationKey: sendOperationKey || null, attemptId: sendAttemptId || null,
          code: error?.code || 'agent_launch_admission_unknown',
        } } : {}),
    });
  };
  const finishResult = () => trace('launch-finished', { code: 'agent_launch_intent_finished',
    error: 'agent_launch_intent_finished', reason: 'preparation-settled' });
  // A silent IPC is an uncertain outcome, never another admission attempt.
  // This bounds transport waiting only; it cannot roll back Main's write/CAS.
  const awaitResponse = async (promises, stage) => {
    let timer, timeoutResult;
    try {
      const result = await Promise.race([...promises, new Promise(resolve => {
        timer = setTimeout(() => {
          timeoutResult = trace(stage, { code: 'agent_launch_ack_timeout',
            error: 'agent_launch_ack_timeout', reason: 'launch-ack-timeout', launchOutcomeUnknown: true });
          resolve(timeoutResult);
        }, responseTimeoutMs);
      })]);
      return { result, timedOut: timeoutResult !== undefined && result === timeoutResult };
    } finally { clearTimeout(timer); }
  };
  const notify = (channel, reason) => {
    try {
      return Promise.resolve(invoke(channel, {
        ...identity, ...(witness ? { token: witness.token } : {}), reason,
      })).catch(() => null);
    } catch { return Promise.resolve(null); }
  };
  const revoke = reason => {
    if (cancelled || finished) return;
    cancelled = trace('launch-cancelled', {
      code: 'agent_launch_cancelled', error: 'agent_launch_cancelled', reason,
    });
    // intentId exists before begin's ACK. Main also tombstones unseen IDs.
    void notify('agent:cancel-launch-intent', reason);
    resolveCancellation(cancelled);
  };
  const check = () => {
    if (signal?.aborted) revoke(abortReason());
    if (!cancelled && !finished) {
      try { assertCurrent(); }
      catch (error) { revoke(error?.reason || error?.code || error?.message || 'preparation-source-changed'); }
    }
    if (cancelled || finished) throw Object.assign(
      new Error(cancelled?.error || 'agent_launch_intent_finished'),
      cancelled || finishResult(),
    );
  };
  const aborted = () => revoke(abortReason());
  signal?.addEventListener('abort', aborted, { once: true });
  const fenceRevoked = (_event, data) => {
    if (data?.tabId !== tabId) return;
    // create ACK and publications may cross in transport. A publication the
    // intent already observed (or an older one) cannot revoke its new owner.
    if (Number.isSafeInteger(data.launchFence?.order) && Number.isSafeInteger(launchFence?.order)
      && data.launchFence.order <= launchFence.order) return;
    revoke(data.reason || 'launch-fence-revoked');
  };
  // Main publishes even a queued/no-op Stop and terminal replacement. Observe
  // it before begin: an old request must not capture a newer Stop revision
  // merely because its first acquire was delayed behind that operation.
  events?.on('agent:launch-fence-revoked', fenceRevoked);
  // Start synchronously, before the caller's first readiness/repair await.
  let acquisition;
  try {
    if (signal?.aborted) revoke(abortReason());
    acquisition = cancelled ? cancelled : !launchFence ? trace('launch-intent-acquire', {
      code: 'agent_launch_original_fence_required', error: 'agent_launch_original_fence_required',
      reason: 'main-terminal-authority-not-observed',
    }) : invoke('agent:begin-launch-intent', copy({
      ...identity, sessionId, cwd, sendOperationKey, sendAttemptId, expectedTarget,
      ...(launchFence !== undefined ? { launchFence } : {}),
    }));
  } catch (error) { acquisition = failure(error, 'launch-intent-acquire'); }
  const acquired = Promise.resolve(acquisition).then(result => {
    // This observation repairs only the cache for a later explicit intent.
    // The original local fence and this intent's one budget never change.
    if (result?.protocolVersion === 1) rememberAgentLaunchFence(tabId, result.observedLaunchFence);
    const value = result?.launchIntent;
    const knownRefusal = result?.success === false && result.protocolVersion === 1
      && result.launchStage === 'intent-begin' && result.launchOutcomeUnknown !== true
      && result.accepted === false && result.launchWritten === false
      && value?.intentId === intentId && value.tabId === tabId && value.toolType === toolType
      && value.token != null && sameFence(value.launchFence, launchFence)
      && sameFence(result.launchFence, launchFence);
    if (result?.success !== true || result.protocolVersion !== 1 || !value
      || value.intentId !== intentId || value.tabId !== tabId || value.toolType !== toolType
      || value.token == null || typeof value.launchFence?.terminalInstanceId !== 'string'
      || !Number.isInteger(value.launchFence?.stopRevision)
      || (launchFence !== undefined && !sameFence(value.launchFence, launchFence))) {
      const refusal = trace('launch-intent-acquire', {
        ...result, success: false, accepted: knownRefusal ? false : null,
        launchWritten: knownRefusal ? false : result?.launchWritten === true ? true : null,
        launchOutcomeUnknown: !knownRefusal,
        code: result?.code || 'agent_launch_intent_unsupported',
        error: result?.error || 'agent_launch_intent_unsupported',
        reason: result?.reason || 'original-launch-authority-unavailable',
      });
      if (knownRefusal) validatedBeginRefusal = { result: refusal,
        error: Object.assign(new Error(refusal.error), refusal) };
      return refusal;
    }
    witness = copy(value);
    if (cancelled || finished) void notify(cancelled
      ? 'agent:cancel-launch-intent' : 'agent:finish-launch-intent', 'late-acquire-after-settlement');
    return result;
  }, error => failure(error, 'launch-intent-acquire'));
  const ready = async () => {
    check();
    const { result } = await awaitResponse([acquired, cancellation], 'launch-intent-acquire');
    check();
    if (result?.success !== true) throw validatedBeginRefusal && result === validatedBeginRefusal.result
      ? validatedBeginRefusal.error : Object.assign(new Error(result?.error || 'agent_launch_intent_unsupported'), result);
    return copy(witness);
  };
  const matches = result => result?.protocolVersion === 1
    && result.launchIntent?.intentId === witness.intentId
    && result.launchIntent?.token === witness.token
    && result.launchIntent?.tabId === tabId && result.launchIntent?.toolType === toolType
    && sameFence(result.launchIntent?.launchFence, witness.launchFence);
  // A renderer session change must revoke the old write BEFORE asking whether
  // this is the first writer of our own launch. A successful answer only joins
  // that existing lifecycle; it never restores the revoked launch authority.
  const reconcileSession = session => {
    if (sourceChanged) {
      if (session !== sourceSession) { revoke('preparation-session-changed'); return Promise.resolve(false); }
      return sourceJoinPromise || Promise.resolve(false);
    }
    sourceChanged = true;
    sourceSession = session;
    if (cancelled || finished || !session) {
      revoke('preparation-session-changed');
      return sourceJoinPromise = Promise.resolve(false);
    }
    const inspect = () => {
      check();
      return invoke('agent:inspect-launch-intent', {
        launchIntent: copy(witness), launchFence: copy(witness.launchFence),
        revoke: true, sessionId: session,
      });
    };
    let inspection;
    try {
      // The original begin may already be accepted while its ACK waits. No
      // run is allowed after sourceChanged; await only that same acquisition
      // under the existing join deadline, then revoke and prove its writer.
      inspection = witness ? inspect() : ready().then(inspect);
    } catch (error) { inspection = Promise.reject(error); }
    sourceJoinPromise = (async () => {
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve(inspection).catch(() => null), cancellation,
          new Promise(resolve => { timer = setTimeout(() => resolve(null), inspectTimeoutMs); }),
        ]);
        if (cancelled || finished || !matches(result) || result?.success !== true
          || result.joined !== true || result.currentSessionId !== session
          || result.joinResult?.joined !== true || !result.joinResult?.launchId) {
          revoke('preparation-session-changed');
          return false;
        }
        check();
        sourceJoinResult = { ...result.joinResult, protocolVersion: 1,
          launchIntent: copy(witness), launchFence: copy(witness.launchFence),
          launchAttempt: attempt, stage: 'source-join', launchStage: 'source-join' };
        resolveSourceJoin(sourceJoinResult);
        return true;
      } finally { clearTimeout(timer); }
    })().catch(() => { revoke('preparation-session-changed'); return false; });
    return sourceJoinPromise;
  };
  const joinChangedSource = async () => {
    if (await sourceJoinPromise) return sourceJoinResult;
    check();
    return cancelled;
  };
  const call = async (channel, payload, number) => {
    check();
    if (sourceChanged) return joinChangedSource();
    const response = Promise.resolve().then(() => {
      check();
      if (sourceChanged) return joinChangedSource();
      return invoke(channel, { ...copy(payload), launchIntent: copy(witness),
        launchFence: copy(witness.launchFence), launchAttempt: number });
    }).then(result => {
      if (result?.protocolVersion === 1) rememberAgentLaunchFence(tabId, result.observedLaunchFence);
      return result;
    }).catch(error => failure(error, 'launch-admission-transport'));
    const { result, timedOut } = await awaitResponse([response, cancellation, sourceJoin],
      channel === 'codex:materialize-empty-session' ? 'launch-materialization' : 'launch-admission-transport');
    // The late transport is observed, but never grants another launch.
    if (cancelled || finished) return cancelled || finishResult();
    if (sourceChanged) return joinChangedSource();
    if (timedOut) return result;
    if (!matches(result) || result.launchAttempt !== number) return trace('launch-admission-transport', {
      code: 'agent_launch_admission_unknown', error: 'agent_launch_admission_unknown',
      reason: 'launch-authority-echo-missing', launchOutcomeUnknown: true,
      accepted: null, launchWritten: null,
    });
    return result;
  };
  const pause = async delay => {
    check();
    let timer;
    const timeout = wait ? wait(delay) : new Promise(resolve => { timer = setTimeout(resolve, delay); });
    try { await Promise.race([timeout, cancellation]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    check();
  };
  const run = (channel, payload) => {
    const frozen = copy(payload), key = JSON.stringify([channel, frozen]);
    if (runPromise) return key === runKey ? runPromise : Promise.resolve(trace('launch-admission', {
      code: 'agent_launch_intent_conflict', error: 'agent_launch_intent_conflict', reason: 'immutable-launch-payload-changed',
    }));
    runKey = key;
    runPromise = (async () => {
      await ready();
      return retryInterruptedRestoreAdmission(async number => {
        check();
        if (sourceChanged) return joinChangedSource();
        attempt = number;
        return call(channel, frozen, number);
      }, { wait: pause, onRetry: event => onRetry({ ...event, intentId, launchFence: copy(witness.launchFence) }) });
    })().catch(error => cancelled || failure(error, error?.stage || 'launch-admission'));
    return runPromise;
  };
  const materialize = payload => {
    const frozen = copy(payload), key = JSON.stringify(frozen);
    if (materializePromise && key !== materializeKey) return Promise.resolve(trace('launch-materialization', {
      code: 'agent_launch_intent_conflict', error: 'agent_launch_intent_conflict', reason: 'immutable-materialization-payload-changed',
    }));
    materializeKey = key;
    return materializePromise ||= (async () => {
      await ready();
      return call('codex:materialize-empty-session', frozen, 0);
    })().catch(error => cancelled || failure(error, error?.stage || 'launch-materialization'));
  };
  const finish = () => {
    if (finished) return Promise.resolve();
    finished = true;
    resolveCancellation(finishResult());
    signal?.removeEventListener('abort', aborted);
    events?.removeListener('agent:launch-fence-revoked', fenceRevoked);
    return notify('agent:finish-launch-intent', 'preparation-settled');
  };
  return { ready, run, materialize, reconcileSession, assertCurrent: check, cancel: revoke, finish,
    snapshot: () => trace('renderer-preparation') };
}

/** @param {any} options @param {(scope: any) => any} operation */
export async function withAgentLaunchAdmission({ launchAdmission, ...options }, operation) {
  const scope = launchAdmission || createAgentLaunchAdmission(options);
  try { return await operation(scope); }
  finally { if (!launchAdmission) void scope.finish(); }
}

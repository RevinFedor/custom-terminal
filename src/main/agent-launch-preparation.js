'use strict';

// A launch has a real lifecycle before the shell command is written: checking
// the saved transcript, proving the shell is idle, and preparing Resume.  That
// phase must be re-queryable (not a one-shot renderer event), and an older
// async completion must never clear a newer launch for the same tab.
function createAgentLaunchPreparationRegistry({
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  const byTab = new Map();
  let nextToken = 0;

  const publicState = (state) => state ? { ...state } : null;

  function begin({
    tabId,
    toolType,
    sessionId = null,
    command = null,
    phase = 'checking',
    reason = 'launch-requested',
  } = {}) {
    if (!tabId) throw new Error('tabId required');
    if (toolType !== 'claude' && toolType !== 'codex') {
      throw new Error('toolType must be claude or codex');
    }
    const state = {
      tabId,
      toolType,
      sessionId: sessionId || null,
      command: command || null,
      phase,
      reason,
      token: ++nextToken,
      since: now(),
      preparing: true,
    };
    byTab.set(tabId, state);
    onChange(publicState(state));
    return publicState(state);
  }

  function update(tabId, token, patch = {}) {
    const current = byTab.get(tabId);
    if (!current || current.token !== token || current.preparing !== true) return null;
    const next = {
      ...current,
      ...patch,
      tabId: current.tabId,
      toolType: current.toolType,
      token: current.token,
      preparing: true,
    };
    byTab.set(tabId, next);
    onChange(publicState(next));
    return publicState(next);
  }

  function finish(tabId, token, {
    accepted = false,
    reason = accepted ? 'launch-accepted' : 'launch-rejected',
    error = null,
  } = {}) {
    const current = byTab.get(tabId);
    if (!current || current.token !== token || current.preparing !== true) return false;
    const finalState = {
      ...publicState(current),
      preparing: false,
      accepted: accepted === true,
      reason,
      error: error ? String(error) : null,
      finishedAt: now(),
    };
    // Once the shell command is accepted, ordinary command/TUI lifecycle owns
    // the loader. Keeping that outcome here would resurrect a preparation
    // overlay after readiness. A rejection is different: it may happen while
    // the tab is in the background, so its exact error must remain queryable.
    if (accepted === true) byTab.delete(tabId);
    else byTab.set(tabId, finalState);
    onChange(publicState(finalState));
    return true;
  }

  function clear(tabId, token, {
    reason = 'launch-preparation-cleared',
  } = {}) {
    const current = byTab.get(tabId);
    if (!current || current.token !== token || current.preparing === true) return false;
    if (current.cleared === true) return true;
    const cleared = {
      ...current,
      preparing: false,
      accepted: false,
      cleared: true,
      reason,
      clearedAt: now(),
    };
    // Keep a harmless tombstone until the next begin. A delayed renderer read
    // can now prove that this exact failure was cleared instead of treating a
    // missing entry as an ambiguous transport race.
    byTab.set(tabId, cleared);
    onChange(publicState(cleared));
    return true;
  }

  function clearRejected(tabId, {
    toolType = null,
    reason = 'agent-tui-ready',
  } = {}) {
    const current = byTab.get(tabId);
    if (
      !current
      || current.preparing === true
      || current.accepted === true
      || current.cleared === true
      || (toolType && current.toolType !== toolType)
    ) return false;
    return clear(tabId, current.token, { reason });
  }

  function get(tabId) {
    return publicState(byTab.get(tabId) || null);
  }

  function list() {
    return Array.from(byTab.values())
      .filter((state) => state.preparing === true)
      .map(publicState);
  }

  // Intent ownership spans queued preparation and renderer-owned backoff. It
  // shares this registry, but never replaces the per-tab presentation token.
  const intents = new Map();
  const intentStreams = new Map();
  const intentCopy = state => state ? { ...state,
    launchFence: state.launchFence ? { ...state.launchFence } : null,
    source: state.source ? { ...state.source } : null,
  } : null;
  const intentIdentity = state => state ? { token: state.token, intentId: state.intentId,
    tabId: state.tabId, toolType: state.toolType,
    launchFence: state.launchFence ? { ...state.launchFence } : null } : null;
  const intentStream = (input) => {
    const match = /^launch:([A-Za-z0-9_-]{1,128}):([1-9][0-9]*)$/.exec(String(input.intentId || ''));
    const sequence = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(sequence)) throw new Error('agent_launch_intent_id_invalid');
    const key = JSON.stringify([input.senderId, match[1]]);
    let stream = intentStreams.get(key);
    if (!stream) {
      stream = { senderId: input.senderId, retiredThrough: 0, entries: new Map() };
      intentStreams.set(key, stream);
    }
    return { stream, sequence };
  };
  const sameIntent = (state, input) => state.tabId === input.tabId && state.toolType === input.toolType
    && state.senderId === input.senderId && (input.token == null || state.token === input.token);
  const retiredIntent = input => ({ ...input, token: null, revoked: true, finished: true,
    phase: 'finished', reason: 'agent_launch_intent_retired', attempt: 0, writeState: 'unknown' });
  const retireIntent = (state) => {
    if (!state.finished || state.inFlight) return;
    intents.delete(state.token);
    state.result = null;
    state.source = null;
    state.payloadKey = null;
    state.phase = 'finished';
    const { stream } = intentStream(state);
    // Out-of-order completion retains only actual entries. Never allocate
    // holes or reject a lower sequence merely because a later begin arrived.
    while (stream.entries.get(stream.retiredThrough + 1)?.finished === true
      && !stream.entries.get(stream.retiredThrough + 1)?.inFlight) {
      stream.entries.delete(++stream.retiredThrough);
    }
  };

  function beginIntent(input) {
    const { stream, sequence } = intentStream(input);
    if (sequence <= stream.retiredThrough) return { created: false, state: retiredIntent(input) };
    const previous = stream.entries.get(sequence);
    if (previous) {
      if (!sameIntent(previous, input)) throw new Error('agent_launch_intent_identity_changed');
      return { created: false, state: intentCopy(previous) };
    }
    const state = { ...input, token: ++nextToken, since: now(), attempt: 0,
      phase: 'reserved', writeState: 'none', result: null, payloadKey: null, revoked: false, inFlight: false };
    state.launchFence = input.launchFence ? Object.freeze({ ...input.launchFence }) : null;
    state.source = input.source ? { ...input.source } : null;
    intents.set(state.token, state);
    stream.entries.set(sequence, state);
    return { created: true, state: intentCopy(state) };
  }

  function getIntent(token) { return intentCopy(intents.get(token)); }
  function getIntentByIdentity(input) {
    const { stream, sequence } = intentStream(input);
    if (sequence <= stream.retiredThrough) return retiredIntent(input);
    const state = stream.entries.get(sequence);
    return state && sameIntent(state, input) ? intentCopy(state) : null;
  }

  function cancelIntent(input, reason = 'agent_launch_intent_cancelled') {
    const { stream, sequence } = intentStream(input);
    if (sequence <= stream.retiredThrough) return retiredIntent(input);
    let state = stream.entries.get(sequence);
    if (state && !sameIntent(state, input)) return null;
    if (!state) {
      // Cancel may win before begin's IPC callback. This tombstone forbids a
      // delayed begin from capturing a newer Stop revision as fresh authority.
      if (input.token != null) return null;
      state = { ...input, token: null, phase: 'cancelled', writeState: 'none', attempt: 0 };
      stream.entries.set(sequence, state);
    }
    state.revoked = true;
    state.finished = true;
    state.reason = reason;
    state.cancelledAt = now();
    const result = intentCopy(state);
    retireIntent(state);
    return result;
  }

  function finishIntent(input) {
    return !!cancelIntent(input, 'agent_launch_intent_finished');
  }

  function beginIntentAttempt(token, attempt, payloadKey, senderId) {
    const state = intents.get(token);
    if (!state || state.senderId !== senderId) return { allowed: false, reason: 'agent_launch_intent_missing' };
    if (state.revoked) return { allowed: false, reason: state.reason || 'agent_launch_intent_cancelled', state: intentCopy(state) };
    if (state.payloadKey && state.payloadKey !== payloadKey) {
      return { allowed: false, reason: 'agent_launch_intent_payload_changed', state: intentCopy(state) };
    }
    if (attempt === state.attempt && state.result) return { allowed: false, replay: true,
      result: { ...state.result }, state: intentCopy(state) };
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 4 || attempt !== state.attempt + 1
      || state.attempt > 0 && (state.phase !== 'refused' || state.writeState !== 'none'
        || state.result?.success !== false || state.result?.launchWritten !== false || state.result?.accepted !== false
        || state.result?.acceptancePending === true || state.result?.joined === true
        || state.result?.cancelled === true || state.result?.suppressed === true
        || state.result?.launchOutcomeUnknown === true || state.result?.deliveryUnknown === true
        || state.result?.sendReceipt?.deliveryUnknown === true || state.result?.status === 'delivery-unknown'
        || !(state.result?.error === 'process_lookup_failed' || state.result?.reason === 'process_lookup_unknown'
          || state.result?.lookupStatus === 'unknown'))) {
      return { allowed: false, reason: 'agent_launch_attempt_unresolved', state: intentCopy(state) };
    }
    state.payloadKey = payloadKey;
    state.attempt = attempt;
    state.phase = 'running';
    state.inFlight = true;
    state.result = null;
    return { allowed: true, state: intentCopy(state) };
  }

  function markIntentWrite(token, attempt, written = false, launchId = null) {
    const state = intents.get(token);
    if (!state || state.attempt !== attempt
      || (!written && (state.revoked || state.phase !== 'running' || state.writeState !== 'none'))
      || (written && state.writeState !== 'started')) return false;
    state.writeState = written ? 'written' : 'started';
    state.phase = written ? 'written' : 'writing';
    if (launchId) state.writeLaunchId = launchId;
    return true;
  }

  function settleIntentAttempt(token, attempt, result) {
    const state = intents.get(token);
    if (!state || state.attempt !== attempt) return false;
    state.result = { ...result };
    state.inFlight = false;
    state.phase = result?.launchWritten === false && result?.accepted === false
      ? 'refused' : 'settled';
    retireIntent(state);
    return true;
  }

  function adoptIntentSource(token, source, materializedSessionId = null) {
    const state = intents.get(token);
    if (!state || state.revoked || state.writeState !== 'none') return false;
    state.source = { ...source };
    if (materializedSessionId) state.materializedSessionId = materializedSessionId;
    return true;
  }

  function clearIntentSender(senderId) {
    for (const [key, stream] of intentStreams) {
      if (stream.senderId !== senderId) continue;
      for (const state of stream.entries.values()) intents.delete(state.token);
      intentStreams.delete(key);
    }
  }

  return { begin, update, finish, clear, clearRejected, get, list,
    beginIntent, getIntent, getIntentByIdentity, intentIdentity, cancelIntent, finishIntent,
    beginIntentAttempt, markIntentWrite, settleIntentAttempt, adoptIntentSource, clearIntentSender };
}

module.exports = { createAgentLaunchPreparationRegistry };

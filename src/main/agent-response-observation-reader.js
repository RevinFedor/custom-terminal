'use strict';

const { admitClaudeMainHook } = require('./claude-hook-routing');
const { claudeProviderFailureFromHook } = require('../shared/claude-provider-failure.cjs');
const { classifyOrchestrationResultProbe, RESULT_PROOF_KINDS, RESULT_PROOF_CODES } = require('./orchestration-result-proof');

const MAX_CHARS = 250_000;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const text = value => typeof value === 'string' && value.trim() ? value : null;
const limitChars = value => Math.max(500, Math.min(MAX_CHARS, Math.floor(Number(value)) || 100_000));
const failure = (code, error = code, subject = null) => ({ subject, error, code });
const pending = (code, subject = null) => ({ pending: true, ...failure(code, code, subject) });

function normalizeSubject(value) {
  const subject = {
    kind: value?.kind,
    toolType: value?.toolType,
    sessionId: text(value?.sessionId),
    targetExecutionContext: value?.targetExecutionContext ? {
      provider: value.targetExecutionContext.provider,
      sessionId: value.targetExecutionContext.sessionId,
      turnId: text(value.targetExecutionContext.turnId),
      generation: value.targetExecutionContext.generation ?? null,
      processId: value.targetExecutionContext.processId == null ? null : String(value.targetExecutionContext.processId),
      startedAt: value.targetExecutionContext.startedAt ?? null,
    } : null,
    ...(text(value?.promptUserUuid) ? { promptUserUuid: value.promptUserUuid } : {}),
    ...(text(value?.promptSourceIdentity) ? { promptSourceIdentity: value.promptSourceIdentity } : {}),
    ...(text(value?.providerPromptId) ? { providerPromptId: value.providerPromptId } : {}),
  };
  const context = subject.targetExecutionContext;
  if (!['claude', 'codex'].includes(subject.toolType) || !subject.sessionId
    || (context && (context.provider !== subject.toolType || !text(context.sessionId) || !context.turnId
      || (subject.kind !== 'codex-historical-execution' && context.sessionId !== subject.sessionId)))) return null;
  if (subject.kind === 'transcript') {
    return subject.promptUserUuid || (subject.toolType === 'codex' && subject.promptSourceIdentity) ? subject : null;
  }
  if (subject.kind === 'codex-historical-execution') {
    if (subject.toolType !== 'codex' || !context || value.targetExecutionContext.generation !== null) return null;
    // The subject owns the read view; the exact context may name its frozen
    // ancestor's physical session. The private source reader proves membership.
    // Neither historical identity supplies a live runtime generation/PID.
    for (const key of ['processId', 'startedAt']) {
      if (!Object.hasOwn(value.targetExecutionContext, key)) delete context[key];
    }
    return subject;
  }
  if (!context || !Number.isSafeInteger(context.generation) || context.generation <= 0) return null;
  if (subject.kind === 'codex-execution' && subject.toolType === 'codex') return subject;
  if (subject.kind === 'claude-hook' && subject.toolType === 'claude' && subject.providerPromptId
    && Number.isSafeInteger(Number(context.processId)) && Number(context.processId) > 0) return subject;
  return null;
}

function currentResponseExecutionContext(state) {
  const turn = state.turn;
  const context = state.executionContext;
  if (state.busy !== true || state.transitioning || !turn?.active || !context || turn.provider !== state.toolType
    || turn.sessionId !== state.sessionId || context.sessionId !== state.sessionId || context.provider !== state.toolType
    || context.generation !== turn.generation || !Number.isSafeInteger(context.generation) || context.generation <= 0
    || !text(context.turnId)) return null;
  // getActiveAgentExecutionContext has a synthetic fallback. Codex needs the
  // actual provider turn ID. Claude's generation/PID remains useful for exact
  // abnormal lifecycle matching even when a legacy hook has no prompt_id.
  if (state.toolType === 'codex' && (!turn.turnId || turn.turnId !== context.turnId)) return null;
  if (state.toolType === 'claude' && (!Number.isSafeInteger(Number(context.processId)) || Number(context.processId) <= 0
    || String(context.processId) !== String(turn.processId))) return null;
  if (!['claude', 'codex'].includes(state.toolType)) return null;
  return { provider: state.toolType, sessionId: state.sessionId, turnId: context.turnId,
    generation: context.generation, processId: context.processId == null ? null : String(context.processId),
    startedAt: Number.isFinite(context.startedAt) ? context.startedAt : null };
}

function currentResponseSubject(state) {
  const context = currentResponseExecutionContext(state);
  if (!context) return null;
  return normalizeSubject({
    kind: state.toolType === 'codex' ? 'codex-execution' : 'claude-hook',
    toolType: state.toolType,
    sessionId: state.sessionId,
    targetExecutionContext: context,
    providerPromptId: state.turn.providerPromptId,
  });
}

function boundedResult(result, maxChars) {
  const body = typeof result?.assistantText === 'string' ? result.assistantText : '';
  const limit = limitChars(maxChars);
  const truncated = body.length > limit;
  const head = Math.floor(limit * 0.4);
  return {
    ...result,
    found: result?.found === true,
    complete: result?.complete === true,
    sourceVerified: result?.sourceVerified === true,
    assistantText: truncated ? body.slice(0, head) + '\n...\n' + body.slice(-(limit - head - 5)) : body,
    assistantChars: Math.max(body.length, Number(result?.assistantChars) || 0),
    truncated: result?.truncated === true || truncated,
  };
}

function hookKey(tabId, subject) {
  const c = subject.targetExecutionContext;
  return JSON.stringify([tabId, subject.sessionId, subject.providerPromptId, c.turnId, c.generation, c.processId]);
}

function createAgentResponseObservationReader({
  captureState, readLifecycle, loadSessionTurns, readTurnResult, readCodexExecution,
  readLatestCodexExecution, readHistoricalCodexExecution,
  maxHookEntries = 64, maxHookChars = 1_000_000, maxStateEntries = 1024,
} = {}) {
  const revisions = new Map();
  const hookResults = new Map();
  const listeners = new Set();
  let serial = 0, retainedChars = 0;

  function revision(tabId, advance = false) {
    const next = advance || !revisions.has(tabId) ? ++serial : revisions.get(tabId);
    revisions.delete(tabId);
    revisions.set(tabId, next);
    while (revisions.size > Math.max(1, maxStateEntries)) revisions.delete(revisions.keys().next().value);
    return next;
  }

  function capture(tabId) {
    const raw = captureState(tabId);
    return { ...raw, revision: JSON.stringify([raw.revision, raw.known, raw.exists, raw.toolType,
      raw.sessionId, raw.cwd, raw.busy, raw.transitioning, raw.backgroundWorkCount, raw.goalWork,
      raw.turn?.completionEligible === true, raw.turn?.intentId || null, revision(tabId)]) };
  }

  async function getAgentResponseState(tabId) {
    let before;
    try {
      before = capture(tabId);
      const base = { known: before.known === true, tabId, toolType: before.toolType || null,
        sessionId: before.sessionId || null, cwd: before.cwd || null, busy: null, revision: before.revision,
        transitioning: before.transitioning,
        backgroundWorkCount: before.backgroundWorkCount ?? 0, executionContext: null, processStatus: 'unknown' };
      if (before.goalWork) base.goalWork = before.goalWork;
      if (before.exists === false && base.known) return { ...base, exists: false,
        code: 'tab_not_found', error: before.error || 'Target tab no longer exists' };
      if (before.exists === true) base.exists = true;
      if (!base.known) return { ...base, error: before.error || 'response_owner_unknown' };
      let lifecycle, lookupError;
      try { lifecycle = await readLifecycle(tabId, base.toolType); } catch (error) { lookupError = error; }
      const after = capture(tabId);
      if (after.known === true && after.exists === false) return { ...base, known: true, exists: false,
        toolType: null, sessionId: null, cwd: null, backgroundWorkCount: 0, revision: after.revision,
        code: 'tab_not_found', error: after.error || 'Target tab no longer exists' };
      if (before.revision !== after.revision) return { ...base, known: false, error: 'response_state_changed' };
      if (lookupError) return { ...base, code: 'response_process_lookup_failed',
        error: lookupError?.code || lookupError?.message || 'Process lookup failed' };
      if (lifecycle?.processStatus === 'found' && lifecycle.processName
        && lifecycle.processName !== base.toolType) return { ...base, known: false, error: 'response_owner_changed' };
      const busy = before.busy === true ? true
        : !['found', 'absent'].includes(lifecycle?.processStatus) ? null
          : lifecycle.processStatus === 'absent' && !before.transitioning ? false
            : before.busy === false ? false : null;
      const state = { ...base, busy,
        processStatus: ['found', 'absent'].includes(lifecycle?.processStatus) ? lifecycle.processStatus : 'unknown' };
      const executionContext = lifecycle?.processStatus === 'found'
        && (!before.executionContext?.processId || String(lifecycle.processPid) === String(before.executionContext.processId))
        ? currentResponseExecutionContext({ ...before, busy }) : null;
      state.executionContext = executionContext;
      const subject = executionContext ? currentResponseSubject({ ...before, busy, executionContext }) : null;
      if (subject) state.currentSubject = subject;
      if (subject) state.loopTaskProtocol = { eligible: before.turn?.completionEligible === true,
        intentId: before.turn?.intentId || null };
      if (busy === null) state.error = before.error || 'response_busy_unknown';
      return state;
    } catch (error) {
      return { known: false, tabId, toolType: before?.toolType || null, sessionId: before?.sessionId || null,
        cwd: before?.cwd || null, busy: null, revision: before?.revision || null, backgroundWorkCount: null, executionContext: null,
        processStatus: 'unknown',
        error: error?.code || error?.message || 'response_state_unavailable' };
    }
  }

  function observeClaudeHook({ tabId, message, turn, admitted, matched, backgroundWorkCount }) {
    if (admitted !== true || !['UserPromptSubmit', 'Stop', 'StopFailure'].includes(message?.event)) return false;
    if (!admitClaudeMainHook({ message, currentTurn: message.event === 'UserPromptSubmit' ? null : turn,
      currentProcessId: turn?.processId }).accepted) return false;
    revision(tabId, true);
    if (message.event === 'UserPromptSubmit' || matched !== true) return false;
    const subject = normalizeSubject({ kind: 'claude-hook', toolType: 'claude', sessionId: turn?.sessionId,
      providerPromptId: turn?.providerPromptId, targetExecutionContext: {
        provider: 'claude', sessionId: turn?.sessionId, turnId: turn?.generation ? 'claude:' + turn.generation : null,
        generation: turn?.generation, processId: turn?.processId, startedAt: turn?.startedAt,
      } });
    if (!subject || message.prompt_id !== subject.providerPromptId || message.session_id !== subject.sessionId
      || String(message.ppid) !== subject.targetExecutionContext.processId) return false;
    const key = hookKey(tabId, subject);
    if (hookResults.has(key)) return false;
    const body = typeof message.last_assistant_message === 'string' ? message.last_assistant_message : '';
    const providerFailure = claudeProviderFailureFromHook(message);
    const complete = message.event === 'Stop' && !providerFailure && !!body.trim();
    const result = boundedResult({ found: true, complete, sourceVerified: true,
      assistantText: body, assistantChars: body.length, executionContext: subject.targetExecutionContext,
      terminalEvent: providerFailure || message.event === 'StopFailure' ? 'provider_error' : 'Stop',
      hasFinalResult: complete, proofDefinitive: true,
      ...(!complete ? { errorCode: providerFailure?.code || (message.event === 'StopFailure' ? 'provider_error' : 'no_final_result'),
        error: (providerFailure?.message || (message.event === 'StopFailure' ? 'Claude StopFailure' : 'Claude Stop has no final text')).slice(0, 2000) } : {}),
    }, MAX_CHARS);
    const evidence = { tabId, subject, result,
      ...(Number.isFinite(backgroundWorkCount) ? { backgroundWorkCount } : {}) };
    hookResults.set(key, evidence);
    retainedChars += result.assistantText.length;
    while (hookResults.size > Math.max(1, maxHookEntries) || retainedChars > Math.max(0, maxHookChars)) {
      const oldest = hookResults.keys().next().value;
      retainedChars -= hookResults.get(oldest).result.assistantText.length;
      hookResults.delete(oldest);
    }
    // Direct private delivery, before the normal lifecycle wake. No answer is
    // put on generic SSE or in logs; persistence belongs to the caller.
    const reportFailure = () => console.warn('[AgentResponseObservation] completion listener failed'
      + ' tab=' + String(tabId).slice(-12) + ' generation=' + subject.targetExecutionContext.generation);
    for (const listener of listeners) {
      try { Promise.resolve(listener(clone(evidence))).catch(reportFailure); } catch { reportFailure(); }
    }
    return true;
  }

  function ownerError(state, expectedSessionId, subject) {
    if (state.known && (state.exists === false || state.code === 'tab_not_found')) {
      return failure('tab_not_found', state.error || 'Target tab no longer exists', subject);
    }
    if (!state.known) return pending(state.error || 'response_owner_unknown', subject);
    if (!state.sessionId) return pending('response_session_unknown', subject);
    if (state.sessionId !== expectedSessionId || (subject && (subject.sessionId !== state.sessionId
      || subject.toolType !== state.toolType))) return failure('response_owner_changed', 'Response owner no longer matches', subject);
    return null;
  }

  // Private continuation history check. It selects the latest EXECUTION, not
  // the latest successful answer, and publishes identity only. An interrupted
  // or abruptly-ended saved request need not have a completed response. Input
  // authority belongs to the continuation adapter and canonical sender.
  async function readContinuationLatestIdentity({ tabId, expectedSessionId, maxChars } = {}) {
    if (!tabId || !expectedSessionId) return failure('response_identity_required');
    const before = await getAgentResponseState(tabId);
    const invalid = ownerError(before, expectedSessionId, null);
    if (invalid) return invalid;
    if (before.toolType !== 'codex') return failure('continuation_history_provider_unsupported');
    if (before.busy === true || before.transitioning !== false
      || !['found', 'absent'].includes(before.processStatus)) return pending('continuation_history_runtime_unstable');
    if (typeof readLatestCodexExecution !== 'function') return failure('codex_latest_observed_execution_reader_unavailable');
    let loaded;
    try {
      loaded = await readLatestCodexExecution({ sessionId: expectedSessionId, cwd: before.cwd,
        resultReadMode: 'authoritative', maxChars: limitChars(maxChars) });
    } catch (error) {
      return failure(error?.code || 'continuation_history_read_failed');
    }
    const after = await getAgentResponseState(tabId);
    const changedOwner = ownerError(after, expectedSessionId, null);
    if (changedOwner) return changedOwner;
    if (before.revision !== after.revision || before.toolType !== after.toolType || before.cwd !== after.cwd
      || before.processStatus !== after.processStatus || after.busy === true || after.transitioning !== false) {
      return pending('response_state_changed');
    }
    if (loaded?.success !== true || loaded.sourceVerified !== true) {
      return pending(loaded?.errorCode || 'response_source_unverified');
    }
    const subject = normalizeSubject({ kind: 'codex-historical-execution', toolType: 'codex',
      sessionId: expectedSessionId, targetExecutionContext: loaded.executionContext });
    if (!subject) return failure('response_subject_unresolved');
    return { subject, result: { found: true, sourceVerified: true,
      executionContext: subject.targetExecutionContext,
      userUuid: loaded.userUuid || null, sourceIdentity: loaded.sourceIdentity || null,
      ...(Number.isSafeInteger(loaded.turnIndex) ? { turnIndex: loaded.turnIndex } : {}) } };
  }

  async function readClaudeInputInterval({ tabId, expectedSessionId, from, through }) {
    const unavailable = reason => ({ known: false, reason });
    const before = await getAgentResponseState(tabId);
    if (ownerError(before, expectedSessionId, null) || before.toolType !== 'claude' || before.busy !== false
      || before.transitioning !== false || !from?.userUuid || !through?.subject?.promptUserUuid) return unavailable('restart_interval_owner_unstable');
    const data = await loadSessionTurns(expectedSessionId, before.cwd, { provider: 'claude', forceFresh: true });
    const source = data?.sourceSnapshot, map = data?.recordMap, branch = [...(data?.branchUuids || [])];
    if (!source?.fileIdentity || !map || !branch.length) return unavailable('restart_interval_source_unknown');
    // Claude's explicit parent links prove the active interval. A skipped or
    // missing record in this chain is a gap, never evidence of no manual input.
    const covered = new Set(); let cursor = branch.at(-1), found = false;
    for (let i = 0; cursor && i < 10000; i++) {
      const record = map.get(cursor);
      if (!record || !data.branchUuids.has(cursor) || covered.has(cursor)) return unavailable('restart_interval_gap');
      covered.add(cursor); if (cursor === from.userUuid) { found = true; break; }
      cursor = record.parentUuid;
    }
    if (!found) return unavailable('restart_interval_anchor_unproven');
    const users = (data.turns || []).filter(turn => ['user', 'queued_command'].includes(turn.kind) && covered.has(turn.userUuid));
    if (!users.length || users.length > 64 || users[0].userUuid !== from.userUuid
      || users.at(-1).userUuid !== through.subject.promptUserUuid) return unavailable('restart_interval_edge_changed');
    const indexed = new Set(users.flatMap(turn => [turn.userUuid, ...(turn.userUuids || [])]));
    for (const uuid of covered) {
      const record = map.get(uuid), content = record.message?.content;
      if (record.type === 'user' && !indexed.has(uuid) && !(Array.isArray(content)
        && content.length && content.every(item => item.type === 'tool_result'))) return unavailable('restart_interval_unindexed_user');
    }
    const stat = await require('node:fs').promises.stat(source.filePath).catch(() => null);
    const after = await getAgentResponseState(tabId);
    if (!stat || source.fileIdentity !== stat.dev + ':' + stat.ino || source.size !== stat.size
      || source.mtimeMs !== stat.mtimeMs || source.ctimeMs !== stat.ctimeMs || after.revision !== before.revision
      || ownerError(after, expectedSessionId, null) || after.busy !== false) return unavailable('restart_interval_source_changed');
    return { known: true, complete: true, sourceRevision: JSON.stringify(source), executions: [],
      users: users.map(turn => ({ userUuid: turn.userUuid, aliases: [{ userUuid: turn.userUuid,
        sessionId: expectedSessionId }] })), ranges: [source] };
  }

  async function readAgentObservedResponse({ tabId, expectedSessionId, subject: inputSubject, maxChars, purpose, from, through } = {}) {
    // Reuse the existing private Main callback, without adding an unprovided
    // web option or an idle override to the ordinary completion reader.
    if (purpose === 'continuation-history') {
      if (inputSubject != null) return failure('continuation_history_requires_latest');
      return readContinuationLatestIdentity({ tabId, expectedSessionId, maxChars });
    }
    if (purpose === 'continuation-input-interval') return readClaudeInputInterval({ tabId, expectedSessionId, from, through });
    if (!tabId || !expectedSessionId) return failure('response_identity_required');
    const explicit = inputSubject != null;
    let subject = explicit ? normalizeSubject(inputSubject) : null;
    if (explicit && !subject) return failure('response_subject_unresolved');
    const before = await getAgentResponseState(tabId);
    const invalidOwner = ownerError(before, expectedSessionId, subject);
    if (invalidOwner) return invalidOwner;
    if (!explicit && before.busy !== false) return pending(before.busy === true ? 'response_busy' : 'response_busy_unknown');
    if (!explicit && before.backgroundWorkCount > 0) return pending('response_background_work');
    const limit = limitChars(maxChars);
    let result, readError;
    try {
      if (!explicit && before.toolType === 'codex') {
        if (typeof readLatestCodexExecution !== 'function') {
          readError = failure('codex_latest_observed_execution_reader_unavailable');
        } else {
          const loaded = await readLatestCodexExecution({ sessionId: expectedSessionId, cwd: before.cwd,
            resultReadMode: 'authoritative', maxChars: limit });
          result = { ...loaded, found: loaded?.success === true };
          if (loaded?.executionContext) subject = normalizeSubject({ kind: 'codex-historical-execution',
            toolType: 'codex', sessionId: expectedSessionId, targetExecutionContext: loaded.executionContext });
          if (loaded?.success === true && !subject) readError = failure('response_subject_unresolved');
        }
      } else if (!explicit) {
        const data = await loadSessionTurns(expectedSessionId, before.cwd, { provider: before.toolType, forceFresh: true });
        // Select latest USER, not latest successful answer, and never infer a
        // current prompt by text/hash/timestamp. Queued input is a real user.
        const turns = data?.turns || [];
        let turn = null;
        for (let index = turns.length - 1; index >= 0; index--) {
          const row = turns[index];
          if (row.kind === 'user' || row.kind === 'queued_command') { turn = row; break; }
        }
        if (!turn?.userUuid) readError = failure('response_latest_user_unavailable');
        else subject = normalizeSubject({ kind: 'transcript', toolType: before.toolType,
          sessionId: expectedSessionId, promptUserUuid: turn.userUuid });
      }
      if (subject?.kind === 'claude-hook') {
        const saved = hookResults.get(hookKey(tabId, subject));
        if (saved) result = clone(saved.result);
        else readError = pending('response_hook_evidence_unavailable', subject);
      } else if (subject?.kind === 'codex-execution') {
        const loaded = await readCodexExecution({ sessionId: expectedSessionId, cwd: before.cwd,
          targetExecutionContext: subject.targetExecutionContext, resultReadMode: 'authoritative', maxChars: limit });
        result = { ...loaded, found: loaded?.success === true };
      } else if (explicit && subject?.kind === 'codex-historical-execution') {
        if (typeof readHistoricalCodexExecution !== 'function') {
          readError = failure('codex_historical_observed_execution_reader_unavailable', undefined, subject);
        } else {
          const loaded = await readHistoricalCodexExecution({ sessionId: expectedSessionId, cwd: before.cwd,
            targetExecutionContext: subject.targetExecutionContext, resultReadMode: 'authoritative', maxChars: limit });
          result = { ...loaded, found: loaded?.success === true };
        }
      } else if (subject?.kind === 'transcript') {
        result = await readTurnResult({ sessionId: expectedSessionId, cwd: before.cwd, toolType: before.toolType,
          promptUserUuid: subject.promptUserUuid, promptSourceIdentity: subject.promptSourceIdentity,
          targetExecutionContext: subject.targetExecutionContext, forceFresh: true, resultReadMode: 'authoritative', maxChars: limit });
      }
    } catch (error) {
      readError = failure(error?.code || 'response_read_failed', error?.message || String(error), subject);
    }
    const after = await getAgentResponseState(tabId);
    const changedOwner = ownerError(after, expectedSessionId, explicit ? subject : null);
    if (changedOwner) return changedOwner;
    if (before.toolType !== after.toolType || before.cwd !== after.cwd) return failure('response_owner_changed', undefined, explicit ? subject : null);
    if (!explicit && (before.revision !== after.revision || after.busy !== false)) return pending('response_state_changed');
    if (readError) {
      if (readError.pending && after.processStatus === 'absent') {
        return failure(readError.code, 'Provider is absent; completion evidence is unavailable', subject);
      }
      return readError;
    }
    result = boundedResult(result, limit);
    if (result.complete && !result.assistantText.trim()) {
      result = { ...result, complete: false, hasFinalResult: false, proofDefinitive: result.sourceVerified === true,
        terminalEvent: result.terminalEvent || 'no_final_result', errorCode: 'no_final_result', error: 'No final response text' };
    }
    const proof = classifyOrchestrationResultProbe(result);
    if (after.processStatus === 'absent' && proof.kind === RESULT_PROOF_KINDS.PENDING && !result.complete
      && (!result.sourceVerified || !result.proofDefinitive)) {
      // An absent producer cannot finish a future flush. This ends the read,
      // not the provider turn: no synthetic terminal outcome or partial success.
      return failure(RESULT_PROOF_CODES.RESULT_UNAVAILABLE,
        'Provider is absent and the saved response has no completion proof'
          + (result.error ? ': ' + result.error : ''), subject);
    }
    if (proof.kind === RESULT_PROOF_KINDS.TERMINAL_FAILURE) {
      result = { ...result, complete: false, proofDefinitive: true,
        errorCode: result.errorCode || proof.code, error: result.error || proof.message };
    }
    if (!result.sourceVerified) return { ...pending(result.errorCode || 'response_source_unverified', subject), result };
    if (!result.complete && !result.proofDefinitive) return { ...pending(result.errorCode || 'response_incomplete', subject), result };
    return { subject, result, ...(result.error ? { error: result.error, code: result.errorCode || 'response_failed' } : {}) };
  }

  return {
    getAgentResponseState, readAgentObservedResponse, observeClaudeHook,
    readCachedClaudeResponse(tabId, sessionId) {
      const saved = [...hookResults.values()].reverse().find(value => value.tabId === tabId
        && value.subject.sessionId === sessionId && value.result.complete === true);
      if (!saved) return { known: false, reason: 'response_hook_not_cached' };
      return { known: true, complete: true, ref: clone(saved.subject),
        assistantText: saved.result.assistantText.slice(0, 2000),
        assistantChars: saved.result.assistantChars,
        truncated: saved.result.truncated === true || saved.result.assistantText.length > 2000 };
    },
    onAgentResponseCompletion(listener) {
      if (typeof listener !== 'function') throw new TypeError('completion listener required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => ({ hookEntries: hookResults.size, retainedChars, stateEntries: revisions.size }),
  };
}

module.exports = { createAgentResponseObservationReader, currentResponseSubject };

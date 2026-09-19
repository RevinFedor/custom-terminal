'use strict';

const { planClaudePtySettings } = require('../shared/claude-pty-setting-plan.cjs');

// A main-owned scenario, not a renderer lease: every setting, its semantic
// confirmation, and the associated prompt share the existing PTY write owner.
function createClaudeSettingsSendRuntime({
  getTerminal,
  withWriteLock,
  captureRuntime,
  isRuntimeCurrent,
  validateTarget = () => null,
  readConfirmedSettings,
  sendCommand,
  readProof,
  waitForProof = null,
  confirmDialog,
  retryExactInput,
  settleClaim,
  toggleThinking,
  paste,
  beginSettingsActivity = () => null,
  endSettingsActivity = () => {},
  notifySettingsApplied = () => {},
  notifySettingsOutcome = null,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
}) {
  const assertCurrent = (tabId, runtime) => {
    const targetFailure = validateTarget(tabId, runtime);
    if (targetFailure) throw Object.assign(new Error(targetFailure.error), targetFailure);
    if (!isRuntimeCurrent(tabId, runtime)) throw new Error('claude_send_runtime_changed');
  };

  const outcomePublisher = (tabId, runtime, steps, results) => async (status, error, late = false) => {
    const detail = { tabId, results: [...results], runtime,
      steps: steps.map(step => ({ ...step })), status,
      allowUnattemptedContinuation: status === 'applied' && !late,
      failedCommand: error?.failedCommand || null,
      errorCode: error?.code || null, error: error?.message || null,
    };
    try {
      if (notifySettingsOutcome) await notifySettingsOutcome(detail);
      else if (status === 'applied') await notifySettingsApplied(detail);
    } catch (failure) { log('[ClaudePtySetting] outcome reconciliation failed: ' + String(failure?.message || failure)); }
    return detail;
  };
  const observeLateResult = (error, steps, results, notifyOutcome) => {
    const step = steps.find(item => item.command === error.failedCommand);
    if (!step || typeof error.lateSettingResult !== 'function') return;
    // Started after lock release. This observer never retries a command or
    // sends an unattempted suffix, even if it eventually finds success.
    void error.lateSettingResult().then(async late => {
      if (!late) return;
      Object.assign(step, { status: late.status, actualValue: late.result?.value,
        observed: late.result?.observed || null,
        claimId: late.result?.claimId || step.claimId || null,
        claimOrder: late.result?.claimOrder || step.claimOrder || null,
        requestSatisfied: late.result ? late.result.requestSatisfied ?? null : null,
        error: late.error || null, errorCode: late.errorCode || null });
      if (late.result) results.push(late.result);
      const complete = steps.every(item => item.status === 'applied');
      await notifyOutcome(complete ? 'applied' : late.status === 'applied' ? 'unknown' : 'failed',
        late.error ? { message: late.error, code: late.errorCode, failedCommand: late.failedCommand } : null, true);
    }).catch(failure => log('[ClaudePtySetting] late proof failed: ' + String(failure?.message || failure)));
  };
  const recordFailure = (error, steps, results) => {
    const step = steps.find(item => item.command === error.failedCommand)
      || steps.find(item => item.status === 'unknown');
    if (step) {
      error.failedCommand ||= step.command;
      Object.assign(step, { status: error.settingStatus || 'unknown',
        error: error.message, errorCode: error.code || null,
        commandId: error.settingCommandId || null,
        claimId: error.settingClaimId || null,
        claimOrder: error.settingClaimOrder || null,
        ...(error.settingResult ? { actualValue: error.settingResult.value,
          observed: error.settingResult.observed,
          requestSatisfied: error.settingResult.requestSatisfied ?? null } : {}) });
    }
    if (error.settingResult) results.push(error.settingResult);
    error.appliedSettings = Object.fromEntries(results.map(result => [result.kind, result.value]));
  };

  async function applyAtOwner({ tabId, kind, value, source }, owner, runtime) {
    const normalizedValue = String(value || '').trim();
    if (!['model', 'effort'].includes(kind) || !normalizedValue) {
      throw new Error('invalid_claude_setting');
    }
    assertCurrent(tabId, runtime);
    const command = '/' + kind + ' ' + normalizedValue;
    const afterMs = now();
    const sent = await sendCommand(tabId, command, {
      source,
      stashFirst: true,
      armPromptBoundaryOnSubmit: true,
      expectSettingClaimResult: true,
      proofOwner: 'main',
      ptyWriteOwner: owner,
      settingsOperationId: runtime.settingsOperationId || null,
      settingsOperationOrder: runtime.settingsOperationOrder || null,
      startupAttemptId: runtime.startupAttemptId || null,
      ...(runtime.expectedTarget ? { expectedTarget: runtime.expectedTarget } : {}),
    });
    if (sent?.success !== true) throw new Error(sent?.error || 'Claude setting command was not sent');
    const claimId = Number(sent.startupSettingClaimId || 0);
    const claimOrder = Number(sent.startupSettingClaimOrder || claimId || 0);
    const proofRequest = { tabId, command, afterMs, label: source,
      commandId: sent.settingCommandId || null, generation: runtime.launchGeneration };
    const settle = (success, reason, detail) => claimId > 0
      ? settleClaim(tabId, claimId, success, reason, detail)
      : undefined;
    const appliedResult = proof => ({
      success: proof.requestSatisfied !== false, applied: true, tabId, kind,
      value: proof.actualValue ?? normalizedValue, requestedValue: normalizedValue, command,
      requestSatisfied: proof.requestSatisfied ?? null, observed: proof.observed || null,
      claimId: claimId || null,
      claimOrder: claimOrder || null,
      commandId: proofRequest.commandId,
      proof: proof.reason || 'jsonl-stdout', sessionId: proof.sessionId || null,
      timestamp: proof.timestamp || null,
    });
    const rejection = proof => Object.assign(new Error(
      proof.outputText || proof.outputPreview || proof.error || 'Claude rejected ' + command,
    ), { code: proof.failureCode || 'claude_setting_rejected', failedCommand: command,
      settingClaimId: claimId || null,
      settingClaimOrder: claimOrder || null,
      settingStatus: proof.requestSatisfied === false ? 'applied-different' : 'rejected',
      ...(proof.observed ? { settingResult: appliedResult(proof) } : {}) });
    const observe = async (timeoutMs, label) => {
      const deadline = now() + timeoutMs;
      let last = null;
      while (now() <= deadline) {
        assertCurrent(tabId, runtime);
        last = await readProof({ ...proofRequest, label });
        assertCurrent(tabId, runtime);
        if (last?.success === true && last.requestSatisfied !== false) return { proof: last, last };
        if (last?.terminal === true) {
          throw rejection(last);
        }
        await confirmDialog(tabId, kind, label, owner);
        await wait(180);
      }
      return { proof: null, last };
    };
    try {
      let observed = await observe(6500, source);
      if (!observed.proof && sent.submitted === false && sent.enterWritten !== true && sent.pasteWritten === true) {
        assertCurrent(tabId, runtime);
        const retry = await retryExactInput(tabId, command, {
          submit: true, source: source + ':proof-timeout', ptyWriteOwner: owner,
          settingCommandId: proofRequest.commandId,
        });
        if (retry?.submitted === true) {
          proofRequest.commandId = retry.settingCommandId || proofRequest.commandId;
          observed = await observe(3500, source + ':exact-retry');
        }
      }
      if (!observed.proof) {
        const last = observed.last || {};
        throw Object.assign(new Error(command + ' was not confirmed by Claude'
          + '; reason=' + (last.reason || 'timeout')
          + '; wrapper=' + !!last.wrapperSeen + '; stdout=' + !!last.stdoutSeen
          + (last.error ? '; error=' + last.error : '')), {
          code: 'claude_setting_outcome_unknown', settingStatus: 'unknown', failedCommand: command,
          settingClaimId: claimId || null,
          settingClaimOrder: claimOrder || null,
        });
      }
      const result = appliedResult(observed.proof);
      await settle(true, 'jsonl-proof-found', { actualValue: result.value,
        requestedValue: normalizedValue, observedSetting: result.observed, status: 'applied' });
      log('[ClaudePtySetting] confirmed tab=' + tabId + ' command=' + JSON.stringify(command));
      return result;
    } catch (error) {
      // A read deadline/error is not a negative result. Keep the claim and a
      // read-only continuation; never retain the expired PTY owner in it.
      error.failedCommand ||= command;
      error.settingCommandId = proofRequest.commandId;
      error.settingClaimId ||= claimId || null;
      error.settingClaimOrder ||= claimOrder || null;
      error.settingStatus ||= 'unknown';
      if (error.settingStatus === 'unknown') {
        await settle(false, 'jsonl-proof-unknown', { status: 'unknown' });
        if (typeof waitForProof === 'function' && proofRequest.commandId) {
          error.lateSettingResult = async () => {
            const proof = await waitForProof(proofRequest);
            if (proof?.success === true && proof.requestSatisfied !== false) {
              const result = appliedResult(proof);
              await settle(true, 'late-jsonl-proof-found', { actualValue: result.value,
                requestedValue: normalizedValue, observedSetting: result.observed, status: 'applied' });
              return { status: 'applied', result };
            }
            if (proof?.terminal === true) {
              const rejected = rejection(proof);
              await settle(!!rejected.settingResult, 'late-jsonl-proof-terminal', {
                actualValue: rejected.settingResult?.value, observedSetting: rejected.settingResult?.observed,
                status: rejected.settingStatus,
              });
              return { status: rejected.settingStatus, result: rejected.settingResult || null,
                error: rejected.message, errorCode: rejected.code, failedCommand: command };
            }
            return null;
          };
        }
      } else await settle(!!error.settingResult, 'jsonl-proof-terminal', {
        actualValue: error.settingResult?.value, observedSetting: error.settingResult?.observed,
        status: error.settingStatus,
      });
      throw error;
    }
  }

  async function applySetting(request) {
    if (!['model', 'effort'].includes(request.kind)) throw new Error('invalid_claude_setting');
    const applied = await applySettings({ ...request, model: undefined, effort: undefined, [request.kind]: request.value });
    return applied.results[0];
  }

  async function applySettings(request) {
    const term = getTerminal(request.tabId);
    if (!term) throw new Error('no_terminal');
    const changes = ['model', 'effort', 'thinking'].filter(kind => typeof request[kind] === 'string' && request[kind].trim());
    if (!changes.length) throw new Error('invalid_claude_setting');
    if (changes.includes('thinking') && !['adaptive', 'enabled', 'disabled'].includes(request.thinking)) throw new Error('invalid_claude_thinking');
    const runtime = captureRuntime(request.tabId, term, request);
    const activity = beginSettingsActivity(request.tabId, changes.length === 1 ? changes[0] : 'model');
    const results = [];
    const steps = changes.map(kind => ({ kind, command: '/' + kind + ' ' + request[kind].trim(),
      requestedValue: request[kind].trim(), status: 'unattempted' }));
    const notifyOutcome = outcomePublisher(request.tabId, runtime, steps, results);
    try {
      const applied = await withWriteLock(term, async owner => {
        for (const step of steps) {
          step.status = 'unknown';
          let result;
          if (step.kind === 'thinking') {
            assertCurrent(request.tabId, runtime);
            const want = request.thinking !== 'disabled';
            const thinking = await toggleThinking(request.tabId, want, owner);
            assertCurrent(request.tabId, runtime);
            if (thinking?.success !== true || thinking.thinking !== want) throw Object.assign(
              new Error(thinking?.error || 'Claude thinking was not confirmed'), {
                code: 'claude_thinking_state_unknown', settingStatus: 'unknown', failedCommand: step.command,
              });
            result = { success: true, kind: 'thinking', value: want ? 'adaptive' : 'disabled',
              observed: { thinking: want }, proof: thinking.thinkingProof || null };
          } else result = await applyAtOwner({
            ...request, kind: step.kind, value: request[step.kind],
            source: changes.length === 1 ? request.source : request.source + ':' + step.kind,
          }, owner, runtime);
          results.push(result);
          Object.assign(step, { status: 'applied', actualValue: result.value, observed: result.observed,
            commandId: result.commandId || null, claimId: result.claimId || null,
            claimOrder: result.claimOrder || null,
            requestSatisfied: result.requestSatisfied ?? null });
        }
        return { success: true, results,
          appliedSettings: Object.fromEntries(results.map(result => [result.kind, result.value])) };
      }, {
        kind: 'claude-setting', source: request.source, tabId: request.tabId,
        submitted: false, manualInputYields: false, queuedAt: now(),
      });
      // A confirmed replacement can resume a failed startup transaction. It
      // must happen after the entire model/effort pair releases its PTY owner.
      await notifyOutcome('applied');
      return applied;
    } catch (error) {
      recordFailure(error, steps, results);
      error.settingsOutcome = await notifyOutcome(error.settingStatus === 'unknown' ? 'unknown' : 'failed', error);
      observeLateResult(error, steps, results, notifyOutcome);
      throw error;
    } finally { endSettingsActivity(activity); }
  }

  async function sendPrompt(request) {
    const { tabId, content, model, effort, thinking } = request;
    const term = getTerminal(tabId);
    if (!term) return { success: false, submitted: false, error: 'no_terminal' };
    const runtime = captureRuntime(tabId, term, request);
    const source = request.source || 'claude-settings-send';
    const operation = {
      kind: 'claude-settings-send', source, tabId,
      submitted: false, promptSubmitted: false, promptSubmitAttempted: false,
      manualInputYields: false, queuedAt: now(),
    };
    let promptPasteInvoked = false;
    let result;
    const steps = ['model', 'effort'].filter(kind => typeof request[kind] === 'string' && request[kind].trim())
      .map(kind => ({ kind, command: '/' + kind + ' ' + request[kind].trim(),
        requestedValue: request[kind].trim(), status: 'unattempted' }));
    const results = [];
    const notifyOutcome = outcomePublisher(tabId, runtime, steps, results);
    try {
      result = await withWriteLock(term, async owner => {
      assertCurrent(tabId, runtime);
      // Read after admission: a preceding accepted settings intent may have
      // changed the exact current-session proof while this send was queued.
      const confirmed = await readConfirmedSettings({ tabId });
      assertCurrent(tabId, runtime);
      const settingPlan = planClaudePtySettings({
        requestedModel: model, requestedEffort: effort, confirmed,
        currentSessionId: confirmed?.sessionId || null,
      });
      let composerMutated = false;
      const activity = settingPlan.applyModel || settingPlan.applyEffort
        ? beginSettingsActivity(tabId, settingPlan.applyModel ? 'model' : 'effort') : null;
      try {
      for (const kind of ['model', 'effort']) {
        const step = steps.find(item => item.kind === kind);
        if (!settingPlan[kind === 'model' ? 'applyModel' : 'applyEffort']) {
          if (step) Object.assign(step, { status: 'applied', actualValue: confirmed[kind] });
          continue;
        }
        if (step) step.status = 'unknown';
        const applied = await applyAtOwner({ tabId, kind, value: settingPlan[kind], source: source + ':' + kind }, owner, runtime);
        results.push(applied);
        if (step) Object.assign(step, { status: 'applied', actualValue: applied.value, observed: applied.observed,
          commandId: applied.commandId || null, claimId: applied.claimId || null,
          claimOrder: applied.claimOrder || null,
          requestSatisfied: applied.requestSatisfied ?? null });
        composerMutated = true;
      }
      } finally { if (activity) endSettingsActivity(activity); }
      if (thinking === 'enabled' || thinking === 'disabled') {
        assertCurrent(tabId, runtime);
        const toggle = await toggleThinking(tabId, thinking === 'enabled', owner);
        if (toggle?.success !== true || toggle.thinking !== (thinking === 'enabled')) {
          return { success: false, submitted: false, code: 'claude_thinking_state_unknown',
            error: toggle?.error || 'Claude thinking picker did not prove its final state' };
        }
        composerMutated = true;
      }
      assertCurrent(tabId, runtime);
      promptPasteInvoked = true;
      const physicalResult = await paste(term, content, {
        ...request,
        ptyWriteOwner: owner,
        requireFreshClaudeExactEmptyBeforePaste: composerMutated,
        deferPostWriteResolution: true,
      });
      // Slash-setting Enter is not a user-prompt submit. Only the final paste
      // can suppress a physical Enter queued behind this transaction.
      operation.promptSubmitted = physicalResult?.enterWritten === true || physicalResult?.submitted === true;
      operation.promptSubmitAttempted = physicalResult?.enterAttempted === true;
      return physicalResult;
      }, operation);
    } catch (error) {
      if (steps.length) {
        recordFailure(error, steps, results);
        await notifyOutcome(error.settingStatus === 'unknown' ? 'unknown' : 'failed', error);
        observeLateResult(error, steps, results, notifyOutcome);
      }
      // Settings can write their own slash commands. This receipt describes
      // only the requested user prompt, which cannot have been sent before
      // entering paste(). Do not infer the same after that boundary.
      if (promptPasteInvoked) throw error;
      return {
        success: false, accepted: false, submitted: false,
        pasteWritten: false, enterWritten: false, status: 'not-submitted',
        code: error?.code || 'claude_settings_before_send_failed',
        ...(error?.httpStatus ? { httpStatus: error.httpStatus } : {}),
        error: String(error?.message || error),
        ...(error?.draftTransfer ? { draftTransfer: error.draftTransfer } : {}),
      };
    }
    if (steps.length) await notifyOutcome(steps.every(step => step.status === 'applied') ? 'applied' : 'unknown');
    // A delayed post-Enter audit can wait for a whole streaming turn. It is
    // not an input owner: release the PTY before that read-only continuation.
    return typeof result?.finishAfterPtyWrite === 'function'
      ? result.finishAfterPtyWrite()
      : result;
  }

  return { applySetting, applySettings, sendPrompt };
}

module.exports = { createClaudeSettingsSendRuntime };

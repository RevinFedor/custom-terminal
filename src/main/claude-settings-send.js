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
  confirmDialog,
  retryExactInput,
  settleClaim,
  toggleThinking,
  paste,
  beginSettingsActivity = () => null,
  endSettingsActivity = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
}) {
  const assertCurrent = (tabId, runtime) => {
    const targetFailure = validateTarget(tabId, runtime);
    if (targetFailure) throw Object.assign(new Error(targetFailure.error), targetFailure);
    if (!isRuntimeCurrent(tabId, runtime)) throw new Error('claude_send_runtime_changed');
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
      ...(runtime.expectedTarget ? { expectedTarget: runtime.expectedTarget } : {}),
    });
    if (sent?.success !== true) throw new Error(sent?.error || 'Claude setting command was not sent');
    const claimId = Number(sent.startupSettingClaimId || 0);
    const settle = (success, reason) => claimId > 0
      ? settleClaim(tabId, claimId, success, reason)
      : undefined;
    const observe = async (timeoutMs, label) => {
      const deadline = now() + timeoutMs;
      let last = null;
      while (now() <= deadline) {
        assertCurrent(tabId, runtime);
        last = await readProof({ tabId, command, afterMs, label });
        assertCurrent(tabId, runtime);
        if (last?.success === true) return { proof: last, last };
        await confirmDialog(tabId, kind, label, owner);
        await wait(180);
      }
      return { proof: null, last };
    };
    try {
      let observed = await observe(6500, source);
      if (!observed.proof) {
        assertCurrent(tabId, runtime);
        const retry = await retryExactInput(tabId, command, {
          submit: true, source: source + ':proof-timeout', ptyWriteOwner: owner,
        });
        if (retry?.submitted === true) observed = await observe(3500, source + ':exact-retry');
      }
      if (!observed.proof) {
        const last = observed.last || {};
        throw new Error(command + ' was not confirmed by Claude'
          + '; reason=' + (last.reason || 'timeout')
          + '; wrapper=' + !!last.wrapperSeen + '; stdout=' + !!last.stdoutSeen
          + (last.error ? '; error=' + last.error : ''));
      }
      await settle(true, 'jsonl-proof-found');
      log('[ClaudePtySetting] confirmed tab=' + tabId + ' command=' + JSON.stringify(command));
      return {
        success: true, tabId, kind, value: normalizedValue, command,
        proof: observed.proof.reason || 'jsonl-stdout',
        sessionId: observed.proof.sessionId || null,
        timestamp: observed.proof.timestamp || null,
      };
    } catch (error) {
      await settle(false, 'jsonl-proof-failed');
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
    const changes = ['model', 'effort'].filter(kind => typeof request[kind] === 'string' && request[kind].trim());
    if (!changes.length) throw new Error('invalid_claude_setting');
    const runtime = captureRuntime(request.tabId, term, request);
    const activity = beginSettingsActivity(request.tabId, changes.length === 1 ? changes[0] : 'model');
    const results = [];
    try {
      return await withWriteLock(term, async owner => {
        for (const kind of changes) results.push(await applyAtOwner({
          ...request, kind, value: request[kind],
          source: changes.length === 1 ? request.source : request.source + ':' + kind,
        }, owner, runtime));
        return { success: true, results,
          appliedSettings: Object.fromEntries(results.map(result => [result.kind, result.value])) };
      }, {
        kind: 'claude-setting', source: request.source, tabId: request.tabId,
        submitted: false, manualInputYields: false, queuedAt: now(),
      });
    } catch (error) {
      error.appliedSettings = Object.fromEntries(results.map(result => [result.kind, result.value]));
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
      submitted: false, promptSubmitted: false, manualInputYields: false, queuedAt: now(),
    };
    let promptPasteInvoked = false;
    let result;
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
        if (!settingPlan[kind === 'model' ? 'applyModel' : 'applyEffort']) continue;
        await applyAtOwner({ tabId, kind, value: settingPlan[kind], source: source + ':' + kind }, owner, runtime);
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
      return physicalResult;
      }, operation);
    } catch (error) {
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
    // A delayed post-Enter audit can wait for a whole streaming turn. It is
    // not an input owner: release the PTY before that read-only continuation.
    return typeof result?.finishAfterPtyWrite === 'function'
      ? result.finishAfterPtyWrite()
      : result;
  }

  return { applySetting, applySettings, sendPrompt };
}

module.exports = { createClaudeSettingsSendRuntime };

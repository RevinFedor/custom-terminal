'use strict';

const { classifyCodexSettingsWriterTransition } = require('./codex-settings-writer-transition');
const clean = value => typeof value === 'string' && value.trim() !== 'none' ? value.trim() : '';

function codexSettingsSendNotSubmitted(result = {}) {
  return { ...result, success: false, accepted: false, submitted: false,
    promptSent: false, pasteWritten: false, enterWritten: false, status: 'not-submitted' };
}

function codexSettingsSendScopeCurrent(expected, current, { input = false } = {}) {
  if (!expected?.terminal || expected.terminal !== current?.terminal
    || !expected.lifecycleGeneration || expected.lifecycleGeneration !== current.lifecycleGeneration
    || !(expected.runSeq > 0) || expected.runSeq !== current.runSeq
    || current.live !== true || (input && expected.inputRevision !== current.inputRevision)) return false;
  return classifyCodexSettingsWriterTransition({
    expectedOwnerId: expected.ownerId, currentOwnerId: current.ownerId,
    currentWriterLaunchId: current.writerLaunchId,
    sameTerminal: true, sameRunSeq: true, sameLifecycleGeneration: true,
    processRunning: true, hasLiveCodexEvidence: true,
  }).allowed === true;
}

function codexSettingsObservationCurrent(expected, current, model, effort) {
  if (expected?.settingsObservationKey === current?.settingsObservationKey) return true;
  let observed;
  try { observed = JSON.parse(current?.settingsObservationKey); } catch { return false; }
  return Array.isArray(observed) && observed[1] === model && observed[2] === effort;
}

// No serializer lives here: settings and the associated prompt use the existing
// global settings queue and the existing exact PTY write owner. The owner and
// continuation never cross IPC; audit resolution runs after both queues release.
function createCodexSettingsSendRuntime({
  readScope, readSettings, withSettingsQueue, withWriteLock,
  selectSettings, paste, sendLocalCommand, publishSettings = () => {},
}) {
  const appliedByTerminal = new WeakMap();
  function publishApplied(tabId, result) {
    if (result?.settingsPublished === true) return;
    publishSettings(tabId, result);
    result.settingsPublished = true;
  }
  function rememberApplied(tabId, result, expectedScope) {
    const scope = readScope(tabId);
    const model = clean(result?.model);
    const effort = clean(result?.effort);
    const ownerId = clean(result?.codexSettingsProofSessionId
      || result?.codexProvisionalSettingsOwnerId || scope?.ownerId);
    if (!codexSettingsSendScopeCurrent(expectedScope, scope, { input: true })
      || !scope?.terminal || !scope.live || !ownerId || ownerId !== scope.ownerId
      || !model || !effort || (result?.success !== true && result?.applied !== true)
      || !(result.applicationProofSource || result.configProofSource)) return false;
    if (!codexSettingsObservationCurrent(expectedScope, scope, model, effort)) return false;
    appliedByTerminal.set(scope.terminal, {
      ...scope, ownerId, model, effort,
      proofAt: Number(result.proofAt) || Date.now(),
      source: result.applicationProofSource || result.configProofSource,
    });
    return true;
  }

  async function sendPrompt(request) {
    const { tabId, content, sender } = request;
    const initialScope = readScope(tabId);
    const modelRequested = clean(request.model);
    const effortRequested = clean(request.effort);
    if (!initialScope?.terminal || initialScope.live !== true) {
      return codexSettingsSendNotSubmitted({ error: 'codex_send_runtime_unavailable' });
    }
    let promptPasteInvoked = false;
    let settingsResult = null;
    const operation = { kind: 'codex-settings-send', source: request.source,
      tabId, submitted: false, promptSubmitted: false, manualInputYields: false, queuedAt: Date.now() };
    const assertCurrent = (scope, input = false) => {
      if (!codexSettingsSendScopeCurrent(scope, readScope(tabId), { input })) {
        throw new Error(input ? 'codex_input_ownership_changed' : 'codex_send_runtime_changed');
      }
    };
    try {
      const physical = await withSettingsQueue(() => withWriteLock(initialScope.terminal, async owner => {
        assertCurrent(initialScope);
        let scope = readScope(tabId);
        const expectedOwnerId = clean(request.expectedWriterSessionId);
        if (expectedOwnerId && !codexSettingsSendScopeCurrent(
          { ...scope, ownerId: expectedOwnerId }, scope,
        )) throw new Error('codex_settings_writer_changed');
        const remembered = appliedByTerminal.get(scope.terminal);
        const cached = remembered && (typeof scope.settingsObservationKey === 'string' || scope.settingsObservationKey === null)
          && remembered.settingsObservationKey === scope.settingsObservationKey
          && codexSettingsSendScopeCurrent(remembered, scope, { input: true })
          ? remembered : null;
        // An old DB pair for this writer may lag the previous picker. Only a
        // current semantic frame or the exact unchanged committed picker wins.
        // Provider fallback does not increment inputRevision. The separate
        // observed-settings key must still match; old callers without this
        // evidence read the current frame instead of trusting a remembered pair.
        let current = cached;
        if (!current) for (let attempt = 0; attempt < 2; attempt++) {
          const beforeRead = readScope(tabId);
          current = await readSettings(tabId, beforeRead);
          assertCurrent(beforeRead, true);
          const afterRead = readScope(tabId);
          if (beforeRead.settingsObservationKey === afterRead.settingsObservationKey) {
            scope = afterRead;
            break;
          }
          if (attempt === 1) return codexSettingsSendNotSubmitted({
            error: 'codex_settings_observation_changed', code: 'codex_settings_observation_changed',
          });
        }
        assertCurrent(scope, true);
        const proven = current?.ownerId === scope.ownerId && !!scope.ownerId
          && !!clean(current?.model) && !!clean(current?.effort);
        if ((!modelRequested || !effortRequested) && !proven) {
          return codexSettingsSendNotSubmitted({ error: 'codex_current_settings_unproven',
            code: 'codex_current_settings_unproven' });
        }
        const model = modelRequested || current.model;
        const effort = effortRequested || current.effort;
        // The write lock serializes app input, not provider output. A native
        // fallback can change this pair during config confirmation or paste
        // preparation without changing inputRevision or the process owner.
        const settingsWriteGuard = () => {
          const latest = readScope(tabId);
          if (!codexSettingsSendScopeCurrent(scope, latest)) return {
            allowed: false, reason: 'codex_send_runtime_changed',
          };
          return codexSettingsObservationCurrent(scope, latest, model, effort)
            ? { allowed: true }
            : { allowed: false, reason: 'codex_settings_observation_changed' };
        };
        const samePair = proven && model === current.model && effort === current.effort;
        if (!samePair && (scope.busy || request.queue === true || request.statusAtSend === 'busy')) {
          return codexSettingsSendNotSubmitted({ error: 'codex_settings_change_requires_idle',
            code: 'codex_settings_change_requires_idle' });
        }
        if (!samePair) {
          settingsResult = await selectSettings(sender, {
            tabId, model, effort,
            expectedTarget: request.expectedTarget,
            sendOperationKey: request.pasteOptions?.sendOperationKey,
            sendAttemptId: request.pasteOptions?.sendAttemptId,
            expectedWriterSessionId: scope.ownerId || null,
            allowTurnBusy: false,
          }, owner);
          assertCurrent(scope);
          const currentSettings = settingsWriteGuard();
          if (!currentSettings.allowed) return codexSettingsSendNotSubmitted({
            error: currentSettings.reason, code: currentSettings.reason, settingsResult,
          });
          const applied = (settingsResult?.success === true || settingsResult?.applied === true)
            && !!(settingsResult.applicationProofSource || settingsResult.configProofSource)
            && settingsResult.model === model && settingsResult.effort === effort;
          if (applied) publishApplied(tabId, settingsResult);
          if (!applied || settingsResult.success !== true) {
            return codexSettingsSendNotSubmitted({ ...settingsResult,
              error: settingsResult?.error || 'codex_settings_before_send_unproven', settingsResult });
          }
        }
        assertCurrent(scope);
        const beforePaste = settingsWriteGuard();
        if (!beforePaste.allowed) return codexSettingsSendNotSubmitted({
          error: beforePaste.reason, code: beforePaste.reason, settingsResult,
        });
        promptPasteInvoked = true;
        const written = request.localCommand
          ? await sendLocalCommand({ ...request.localCommand, sender, tabId, command: content, settingsWriteGuard }, owner)
          : await paste(scope.terminal, content, {
              ...request.pasteOptions, ptyWriteOwner: owner,
              settingsWriteGuard,
              queueProofWriteOperation: operation, deferPostWriteResolution: true,
            });
        operation.promptSubmitted = written?.enterWritten === true || written?.submitted === true;
        return written;
      }, operation));
      const result = typeof physical?.finishAfterPtyWrite === 'function'
        ? await physical.finishAfterPtyWrite() : physical;
      return settingsResult ? { ...result, settingsResult } : result;
    } catch (error) {
      const detail = { error: String(error?.message || error), ...(settingsResult ? { settingsResult } : {}) };
      if (!promptPasteInvoked) return codexSettingsSendNotSubmitted(detail);
      return { ...detail, success: null, accepted: true,
        submitted: operation.promptSubmitted ? true : null,
        ...(operation.promptSubmitted ? { pasteWritten: true, enterWritten: true } : {}),
        status: 'delivery-unknown', receiptState: 'delivery-unknown', deliveryUnknown: true };
    }
  }
  return { sendPrompt, rememberApplied, publishApplied };
}

module.exports = { createCodexSettingsSendRuntime, codexSettingsSendScopeCurrent,
  codexSettingsSendNotSubmitted, codexSettingsObservationCurrent };

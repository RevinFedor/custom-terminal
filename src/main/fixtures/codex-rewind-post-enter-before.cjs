// Historical before-fix source fragments only; never call these outside the test VM.
// Extracted verbatim from /private/tmp/noted-settings-final-vZa4ZH/source/src/main/main.js
// Full source SHA-256: 7bc36c12ebdb5171e94d748c46ff66eb58f1953a76b7a4bba20037d8fab7c271
// This is not a second production implementation. Keep the original failures reproducible.
"use strict";

async function captureAgentInputAtWriteBoundary(
  tabId,
  mode,
  agent = 'claude',
  options = {},
  ownedTerm = null,
) {
  const term = ownedTerm || terminals.get(tabId);
  if (!term) return { success: false, error: 'no_terminal' };
  if (terminals.get(tabId) !== term) {
    return { success: false, error: 'terminal_generation_changed' };
  }
  // Codex's startup draft can accept paste while ignoring Ctrl+G. It is not
  // the initialized composer. Do not create an ambiguous editor intent there;
  // a previously initialized composer remains eligible during a busy turn.
  if (agent === 'codex' && !isCodexTuiEffectivelyReady(tabId)) {
    return { success: false, error: 'codex_input_not_ready', draftPreserved: true };
  }

  const logPrefix = agent === 'claude'
    ? '[capture-input:' + mode + ']'
    : '[capture-input:' + agent + ':' + mode + ']';

  let cliPid = null;
  let lockPids = [];
  const processResolution = await resolveAgentInputProcess(tabId, agent, logPrefix);
  if (!processResolution.success) return processResolution;
  cliPid = processResolution.cliPid;
  lockPids = processResolution.lockPids;

  // This identity belongs to the screen proof that authorized the capture.
  // Ctrl+G itself is an input mutation, so the identity returned to callers is
  // captured separately after we reserve the new input revision below.
  let draftProofCaptureIdentity = captureAgentInputIdentity(tabId, term);
  let draftProof = options?.draftProof && typeof options.draftProof === 'object'
    ? options.draftProof
    : null;
  let draftProofMatchesAtCapture = draftProof
    ? agentDraftProofMatchesCaptureIdentity(draftProof, draftProofCaptureIdentity)
    : null;
  if (draftProof && !draftProofMatchesAtCapture) {
    console.warn(logPrefix + ' Tab ' + tabId.slice(-12)
      + ': screen proof identity changed before Ctrl+G; grab may preserve a real draft but cannot authorize empty');
  }

  if (cliPid) {
    // Verify the cached PID still maps to a live process. If user restarted Claude in shell
    // (Ctrl+C → claude --resume) without going through our Bridge:Fresh path, bridgePidCache
    // holds a dead PID — the lock-file would be written under the dead PID's name and the
    // live CLI would never find it. Result: silent timeout → "Helper not reachable".
    let alive = true;
    try { process.kill(cliPid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (!alive) {
      console.warn(logPrefix + ' Tab ' + tabId.slice(-12) + ': stale ' + agent + 'Pid=' + cliPid + ' (process gone)');
      return { success: false, error: 'stale_pid', pid: cliPid };
    }
    const editor = await readProcessEditor(cliPid);
    if (!editor || !editor.includes(CAPTURE_HELPER_BASENAME)) {
      console.warn(logPrefix + ' Tab ' + tabId.slice(-12) + ': wrong EDITOR=' + editor + ' — restart ' + agent + ' in this tab');
      return { success: false, error: 'wrong_editor', editor };
    }
  }

  if (grabInputPending.has(tabId)) {
    const previous = grabInputPending.get(tabId);
    const terminalRetired = previous.captureIdentity?.terminalToken !== term;
    const helperReturned = agentInputCaptureProtocol.reconcileReturned(previous.captureOperation);
    if (terminalRetired || helperReturned) {
      if (terminalRetired) releaseAgentInputCapturePending(tabId, previous, { processRetired: true });
      else if (grabInputPending.get(tabId) === previous) grabInputPending.delete(tabId);
      clearTimeout(previous.timer);
      previous.resolve({ success: false, error: 'capture_operation_cancelled', draftPreserved: true });
    } else {
      return {
        success: false,
        error: previous.timedOut ? 'external_editor_pending_drain' : 'already_in_progress',
        operationId: previous.captureOperation.operationId,
      };
    }
  }
  if (agent === 'codex') {
    const slashCompletion = await dismissCodexSlashCompletionBeforeExternalEditor(
      tabId,
      term,
      draftProof,
      logPrefix,
    );
    if (slashCompletion.success !== true) return slashCompletion;
    if (slashCompletion.dismissed === true) {
      draftProof = slashCompletion.draftProof;
      draftProofCaptureIdentity = captureAgentInputIdentity(tabId, term);
      draftProofMatchesAtCapture = draftProof
        ? agentDraftProofMatchesCaptureIdentity(draftProof, draftProofCaptureIdentity)
        : null;
    }
  }
  const isClaudeMissingPromptCapture = agent === 'claude'
    && draftProof?.proofOutcome === 'unknown'
    && draftProof?.proofReason === 'active-prompt-not-found';
  if (isClaudeMissingPromptCapture) {
    const currentSnapshot = getHeadlessVisibleBufferSnapshot(
      tabId,
      'before-missing-prompt-exact-capture',
      { preferCommitted: false },
    );
    const currentProof = currentSnapshot?.success === true
      ? parseClaudeDraftFromVisibleSnapshot(currentSnapshot)
      : {
          proofOutcome: 'unknown',
          proofReason: 'headless-current-frame-unavailable',
        };
    const admission = classifyClaudeMissingPromptCaptureForTab(
      tabId,
      currentSnapshot,
      currentProof,
      options?.ownedWriteOperation || null,
    );
    const exactFrameStillCurrent = draftProofMatchesAtCapture === true
      && validateAgentInputFrameIdentity(tabId, draftProofCaptureIdentity);
    if (admission.recommended !== true || !exactFrameStillCurrent) {
      const blockedReason = !exactFrameStillCurrent
        ? 'claude-current-frame-changed-before-exact-capture'
        : admission.reason;
      console.warn(logPrefix + ' Tab ' + tabId.slice(-12)
        + ': missing-prompt exact capture refused reason=' + blockedReason);
      return {
        success: false,
        error: 'claude_draft_state_unknown_before_paste',
        proofReason: blockedReason,
      };
    }
  }
  const draftProofMatchesAtWrite = draftProof
    ? draftProofMatchesAtCapture === true
      && validateAgentInputIdentity(tabId, draftProofCaptureIdentity)
      && (!isClaudeMissingPromptCapture
        || validateAgentInputFrameIdentity(tabId, draftProofCaptureIdentity))
    : null;
  if (draftProof && !draftProofMatchesAtWrite) {
    console.warn(logPrefix + ' Tab ' + tabId.slice(-12)
      + ': terminal identity changed before Ctrl+G write; exact-empty override disabled');
  }
  // Intentionally do NOT pre-block on claudeSpinnerBusy: Claude's Ctrl+G
  // binding works mid-stream as long as there is a draft in the input box —
  // that's the whole point of the queue (grab + queue while Claude is still
  // typing). Only block when the Stop-hook actually reports turn-in-flight,
  // because in that very narrow window Ctrl+G IS a no-op. If timeout fires,
  // the warn-log below classifies the cause (turn/spinner/silent helper) so
  // the toast can be honest.

  // Arm an immutable request before Ctrl+G. Timeout cancels this request but
  // does NOT remove it: an editor process starting a few milliseconds later
  // must still know that the app, not the user, requested this invocation.
  if (lockPids.length === 0) {
    console.warn(logPrefix + ' Tab ' + tabId.slice(-12) + ': no ' + agent + ' PID — cannot write lock');
    return { success: false, error: 'no_' + agent + '_pid' };
  }
  if (terminals.get(tabId) !== term) return { success: false, error: 'terminal_generation_changed' };
  if (agent === 'codex' && !isCodexTuiEffectivelyReady(tabId)) {
    return { success: false, error: 'codex_input_not_ready', draftPreserved: true };
  }
  let captureOperation;
  try {
    captureOperation = agentInputCaptureProtocol.arm({
      tabId,
      terminalId: term._notedGrabTerminalId,
      agent,
      mode,
      pids: lockPids,
      sock: CLAUDE_HOOK_SOCK,
      generation: publicAgentInputIdentity(captureAgentInputIdentity(tabId, term), true),
      text: options.text,
    });
  } catch (error) {
    console.warn(logPrefix + ' capture arm failed:', error.message);
    return {
      success: false,
      error: error.message === 'external_editor_pending_drain' ? error.message : 'lock_write_failed',
      ...(error.operationId ? { operationId: error.operationId } : {}),
    };
  }

  // Ctrl+G is a real composer mutation. Reserve its revision only after the
  // helper contract is armed and immediately before the serialized PTY write:
  // a capture queued behind a paste must not invalidate that paste before it
  // submits, while a later paste must never reuse proof captured before this
  // external-editor roundtrip.
  const ownedInputRevision = bumpTerminalInputRevision(tabId);
  const captureIdentity = captureAgentInputIdentity(tabId, term);
  if (captureIdentity.inputRevision !== ownedInputRevision) {
    agentInputCaptureProtocol.cancel(captureOperation, 'terminal_input_ownership_changed');
    agentInputCaptureProtocol.release(captureOperation, { processRetired: true });
    return { success: false, error: 'terminal_input_ownership_changed' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const pending = {
      resolve: settle,
      timer: null,
      captureOperation,
      captureRequestId: typeof options.captureRequestId === 'string' ? options.captureRequestId : null,
      mode,
      agent,
      pid: cliPid,
      pids: lockPids,
      captureIdentity,
      draftProofCaptureIdentity,
      draftProof,
      draftProofIdentityAtWrite: draftProofMatchesAtWrite,
      draftProofDiagnostic: draftProof
        ? buildHeadlessDraftProofDiagnostic(tabId, draftProof, 'before-exact-empty-grab')
        : null,
    };
    const timer = setTimeout(() => {
      if (grabInputPending.get(tabId) !== pending) return;
      const decision = agentInputCaptureProtocol.cancel(captureOperation, 'external_editor_timeout');
      if (decision.decision === 'commit') return; // authorized callback owns the return barrier
      pending.timedOut = true;
      const helperReturned = agentInputCaptureProtocol.reconcileReturned(captureOperation);
      if (helperReturned && grabInputPending.get(tabId) === pending) grabInputPending.delete(tabId);
      // A timeout is not proof Ctrl+G was ignored. No global log-size heuristic,
      // retry, Escape or newer intent is permitted to guess away this ambiguity.
      console.warn(logPrefix + ' Tab ' + tabId.slice(-12)
        + ': timeout (3000ms), cancellation retained operation=' + captureOperation.operationId
        + ' helperReturned=' + helperReturned + ' pid=' + cliPid);
      settle({ success: false, error: 'external_editor_timeout', draftPreserved: true, operationId: captureOperation.operationId });
    }, 3000);
    pending.timer = timer;
    grabInputPending.set(tabId, pending);
    console.log(logPrefix + ' Tab ' + tabId.slice(-12) + ': sending Ctrl+G pid=' + cliPid
      + ' operation=' + captureOperation.operationId + ' lockPids=' + lockPids.join(','));
    recordComposerForensicPtyInput(tabId, '\x07', {
      kind: 'ctrl-g',
      phase: 'pty-write-attempt',
      origin: 'agent-input-capture',
      source: agent + ':' + mode + '-input',
      operationKind: 'agent-input-capture',
      checkpoint: true,
    });
    try {
      term.write('\x07'); // Ctrl+G → chat:externalEditor
    } catch (error) {
      clearTimeout(timer);
      pending.timedOut = true;
      agentInputCaptureProtocol.cancel(captureOperation, 'capture_pty_write_failed');
      settle({ success: false, error: 'capture_pty_write_failed', draftPreserved: true });
    }
  });
}

async function grabRestoredCodexRewindInput(expectedText, targetPayload) {
    const expected = normalizeCandidate(expectedText);
    const delays = [0, 180, 420, 900, 1600, 2600];
    let lastResult = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      // Native Rewind already owns the shared PTY write boundary. Calling the
      // public wrapper here would enqueue behind ourselves and deadlock.
      const result = await captureAgentInputAtWriteBoundary(
        tabId,
        'grab',
        'codex',
        {},
        term,
      );
      lastResult = result;
      const text = typeof result?.text === 'string' ? result.text : '';
      const normalized = normalizeCandidate(text);
      const comparison = expected
        ? compareCodexRestoredPrompt(expectedText, text, targetPayload)
        : { matched: normalized.length === 0, mode: normalized.length === 0 ? 'empty-expected' : 'mismatch', containsExpected: false, extraChars: normalized.length };
      const matched = comparison.matched === true;
      console.log('[Codex:Rewind] Grab restored input attempt=' + (attempt + 1)
        + ' success=' + (result?.success === true)
        + ' chars=' + text.length
        + ' matchedTarget=' + matched
        + ' mode=' + (comparison.mode || '-')
        + ' containsTarget=' + !!comparison.containsExpected
        + ' extraChars=' + (comparison.extraChars || 0)
        + ' images=' + (comparison.imageCount || 0)
        + ' resolvedImages=' + (comparison.resolvedImages || 0)
        + ' missingImages=' + (comparison.missingImages || 0)
        + ' error=' + (result?.error || '-'));

      if (result?.success && normalized.length > 0) {
        return {
          success: true,
          text,
          attempt: attempt + 1,
          matchedTarget: matched,
          matchMode: comparison.mode,
          historyDraftText: comparison.historyDraftText,
          historyDraftWarning: comparison.historyDraftWarning,
        };
      }
      if (result?.success && attempt === delays.length - 1) {
        return {
          success: true,
          text,
          attempt: attempt + 1,
          matchedTarget: matched,
          matchMode: comparison.mode,
          historyDraftText: comparison.historyDraftText,
          historyDraftWarning: comparison.historyDraftWarning,
          empty: true,
        };
      }
      if (!result?.success && !['already_in_progress', 'codex_ctrl_g_noop', 'editor_not_wired'].includes(result?.error)) {
        break;
      }
    }
    return {
      success: false,
      error: lastResult?.error || 'codex_rewind_input_grab_failed',
      text: typeof lastResult?.text === 'string' ? lastResult.text : '',
      matchedTarget: false,
    };
  }

function releaseAgentInputCapturePending(tabId, pending, proof = {}) {
  if (!agentInputCaptureProtocol.release(pending.captureOperation, proof)) return false;
  clearTimeout(pending.timer);
  if (grabInputPending.get(tabId) === pending) grabInputPending.delete(tabId);
  return true;
}

function closeCodexWatcher(tabId, reason = 'close') {
  const state = codexWatchers.get(tabId);
  if ((reason === 'ttl' || reason === 'ttl-no-watch')
    && state?.provisionalSubmitReservation?.submitted === true) {
    // Delivery was attempted but the post-Enter rollout audit has not yet
    // resolved. Dropping this observer would also drop the one-submit latch and
    // permit a blind duplicate after rearm. Keep the launch-scoped uncertainty
    // alive until audit/adoption/explicit lifecycle cleanup resolves it.
    state.timeout = setTimeout(() => {
      if (codexWatchers.get(tabId) === state) closeCodexWatcher(tabId, reason);
    }, CODEX_WATCHER_TTL_MS);
    console.warn('[Codex Watcher] ttl deferred for submitted provisional action tab=' + String(tabId).slice(-12)
      + ' launch=' + (state.provisionalSubmitReservation.launchId || '-'));
    return;
  }
  if (state) {
    if (state.sourceMode === 'writer-handoff' && state.handoffWaiters?.size) {
      for (const resolve of state.handoffWaiters) {
        try {
          resolve({ status: 'observer-closed', reason });
        } catch {}
      }
      state.handoffWaiters.clear();
    }
    try { state.watcher?.close?.(); } catch {}
    if (state.interval) clearInterval(state.interval);
    if (state.timeout) clearTimeout(state.timeout);
    codexWatchers.delete(tabId);
    console.log('[Codex Watcher] closed for tab:', tabId, 'reason:', reason);
  }
  const keepDiscoveryIntent = reason === 'ttl'
    || reason === 'ttl-no-watch'
    || reason === 'restart';
  if (!keepDiscoveryIntent && codexSessionDiscoveryIntents.delete(tabId)) {
    console.log('[Codex Watcher] discovery intent cleared tab=' + String(tabId).slice(-12)
      + ' reason=' + reason);
  }
}

function originalRewindAuthorityFinally() {
if (rewindActionAuthority
        && rewindActionAuthority.phase !== 'committed'
        && rewindActionAuthority.phase !== 'revoked') {
        if (codexRewindOperationResult?.success === true
          && codexRewindOperationResult?.bindingCommitted === true
          && rewindActionAuthority.phase === 'consumed'
          && codexRewindOperationResult?.handoffStatus !== 'branch-draft-restored') {
          transitionMainCodexActionAuthority(
            rewindActionAuthority,
            'committed',
            'rewind-result-committed',
          );
        } else if (codexRewindOperationResult?.success === true
          && codexRewindOperationResult?.handoffStatus === 'branch-draft-restored') {
          // The same consumed authority remains attached to the exact next
          // submit. The branch is not durable until that submit materializes
          // a child (or a provider-owned same-source user_message).
        } else {
          transitionMainCodexActionAuthority(
            rewindActionAuthority,
            'revoked',
            codexRewindOperationResult?.error || 'rewind-not-committed',
          );
        }
      }
}

module.exports = Object.freeze({
  "sourcePath": "/private/tmp/noted-settings-final-vZa4ZH/source/src/main/main.js",
  "sourceSha256": "7bc36c12ebdb5171e94d748c46ff66eb58f1953a76b7a4bba20037d8fab7c271",
  "fragmentSha256": {
    "captureAgentInputAtWriteBoundary": "c154f841c6ca881b6c78887ab8124736eb8d789ec4b8fe7b45486774d764ee0d",
    "grabRestoredCodexRewindInput": "4906298433b3cbd03b44f616ec39790e53ebfee41126311bf36d28289aaef3cc",
    "releaseAgentInputCapturePending": "3351911231cc37e76c29813ffdba4d0570188f5817b6b35bef1edb84522d183e",
    "closeCodexWatcher": "29e72ede3ff24dcf46035069b205b48aac9efa403afcae01dde13a1c7d9d7ab8",
    "authorityFinally": "8fd436670fc950622c59a3f94ec4e594f676f5c77603e11eab2bd7efb1e076ff"
  }
});


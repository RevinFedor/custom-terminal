'use strict';

const {
  createClaudeStartupCoordinator,
  PHASE,
  PROOF,
} = require('./claude-startup-transaction');

function parseSettingCommand(command) {
  const match = String(command || '').trim().match(/^\/(model|effort)\s+(.+)$/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase(),
    value: match[2].trim(),
  };
}

function selectClaudeStartupSettingsSession({
  launchMode = 'unknown',
  launchSessionId = null,
  readinessSessionId = null,
  persistedSessionId = null,
} = {}) {
  // A fresh `claude` launch can reuse a stopped tab whose SQLite row still
  // names the previous writer. That row is not launch intent. Applying its
  // session-history settings to the new conversation would make Start behave
  // like Continue. Resume/Fork, in contrast, must prefer their explicit source
  // identity so the CLI-restored state is never overwritten by app defaults.
  if (launchMode === 'fresh') return null;
  const launch = String(launchSessionId || '').trim();
  if (launchMode === 'resume' && launch) return launch;
  return String(readinessSessionId || launch || persistedSessionId || '').trim() || null;
}

function classifyClaudeStartupDeliveryProof({
  scan = null,
  composer = null,
  sendResult = null,
} = {}) {
  const base = scan && typeof scan === 'object' ? scan : {
    success: false,
    reason: 'no-proof-result',
  };
  if (base.success === true || base.outcome === PROOF.FOUND) {
    return { ...base, outcome: PROOF.FOUND };
  }
  if (
    sendResult?.submitted === false
    && composer?.success === true
    && composer.exact === true
  ) {
    return {
      ...base,
      success: false,
      outcome: PROOF.ABSENT,
      reason: 'exact-input-awaiting-submit',
      scanReason: base.reason || null,
      recovery: { kind: 'submit-existing-input' },
      composerProof: 'exact',
      submitProof: 'not-written',
    };
  }
  return {
    ...base,
    success: false,
    outcome: PROOF.UNRESOLVED,
    composerProof: composer?.success === true
      ? (composer.exact === true ? 'exact' : (composer.empty === true ? 'empty' : 'different'))
      : 'unknown',
    submitProof: sendResult?.submitted === false
      ? 'not-written'
      : (sendResult?.submitted === true ? 'written' : 'unknown'),
    composerError: composer?.error || null,
  };
}

// Main-process ownership adapter for the pure startup coordinator.
//
// Readiness producers call `ensure()` directly in main. Renderer is neither an
// initiator nor an executor: it only receives the resulting gate snapshot.
// The adapter also remembers settings that were explicitly selected by the
// user during this live launch, so a still-preparing default transaction never
// overwrites a newer manual choice.
function createClaudeStartupMainRuntime({
  now = () => Date.now(),
  log = () => {},
  currentLaunchGeneration,
  resolveSettings,
  sendCommand,
  proveCommand,
  publishGate,
  coordinator = createClaudeStartupCoordinator({ now, log }),
} = {}) {
  if (typeof currentLaunchGeneration !== 'function') {
    throw new TypeError('currentLaunchGeneration is required');
  }
  if (typeof resolveSettings !== 'function') throw new TypeError('resolveSettings is required');
  if (typeof sendCommand !== 'function') throw new TypeError('sendCommand is required');
  if (typeof proveCommand !== 'function') throw new TypeError('proveCommand is required');
  if (typeof publishGate !== 'function') throw new TypeError('publishGate is required');

  const claimsByTab = new Map();
  const manualClaimsById = new Map();
  let claimSeq = 0;

  function releaseManualClaimToken(token, success, reason) {
    if (!token || token.status !== 'pending') return false;
    token.status = success === true ? 'confirmed' : 'failed';
    token.settledReason = reason || null;
    if (typeof token.resolveSettlement === 'function') {
      token.resolveSettlement({
        success: success === true,
        reason: reason || null,
      });
      token.resolveSettlement = null;
    }
    return true;
  }

  function discardGenerationClaims(tabId, generation, reason) {
    for (const [claimId, token] of manualClaimsById) {
      if (token.tabId !== tabId || token.generation === generation) continue;
      releaseManualClaimToken(token, false, reason);
      manualClaimsById.delete(claimId);
    }
  }

  function claimsFor(tabId, generation, create = false) {
    const existing = claimsByTab.get(tabId);
    if (existing?.generation === generation) return existing;
    if (!create) return null;
    discardGenerationClaims(tabId, generation, 'generation-superseded');
    const claims = { generation, model: null, effort: null };
    claimsByTab.set(tabId, claims);
    return claims;
  }

  function getCurrentGeneration(tabId) {
    return currentLaunchGeneration(tabId) || null;
  }

  function isCurrent(tabId, generation) {
    return !!generation && getCurrentGeneration(tabId) === generation;
  }

  function buildSteps(tabId, generation, trigger, settings) {
    const claims = claimsFor(tabId, generation, true);
    const steps = [];
    const model = String(settings?.model || '').trim();
    const effort = String(settings?.effort || '').trim();

    if (model && model !== 'none' && !claims.model) {
      steps.push({
        phase: PHASE.MODEL,
        command: '/model ' + model,
        source: 'startup-defaults:' + trigger + '-model',
        label: 'startup-model',
      });
    } else if (claims.model) {
      log('[StartupTx] skip-model tab=' + String(tabId).slice(-12)
        + ' gen=' + generation + ' alreadyApplied=' + claims.model.via);
    }

    if (effort && effort !== 'none' && !claims.effort) {
      steps.push({
        phase: PHASE.EFFORT,
        command: '/effort ' + effort,
        source: 'startup-defaults:' + trigger + '-effort',
        label: 'startup-effort',
      });
    } else if (claims.effort) {
      log('[StartupTx] skip-effort tab=' + String(tabId).slice(-12)
        + ' gen=' + generation + ' alreadyApplied=' + claims.effort.via);
    }
    return steps;
  }

  function recordConfirmedClaim(tabId, generation, command, via) {
    const parsed = parseSettingCommand(command);
    if (!parsed || !isCurrent(tabId, generation)) return null;
    const claims = claimsFor(tabId, generation, true);
    const existing = claims[parsed.kind];
    const claim = {
      id: ++claimSeq,
      value: parsed.value,
      via,
      at: now(),
    };
    if (existing?.via && existing.via !== 'startup-defaults') {
      // A user action admitted after this startup send but before its proof is
      // causally newer. The old startup proof must not overwrite that claim,
      // but it remains the confirmed fallback if the newer manual proof fails.
      // Attach it below the whole manual chain so nested clicks roll back to
      // the last valid choice rather than losing an already-proven startup
      // setting.
      let cursor = existing;
      while (cursor) {
        const token = manualClaimsById.get(cursor.id);
        if (!token || token.tabId !== tabId || token.generation !== generation) break;
        if (!token.previous) {
          token.previous = claim;
          log('[StartupTx] startup-proof-preserved-below-manual tab='
            + String(tabId).slice(-12)
            + ' gen=' + generation
            + ' kind=' + parsed.kind
            + ' manualSource=' + existing.via);
          break;
        }
        if (token.previous.via === 'startup-defaults') break;
        cursor = token.previous;
      }
      return existing;
    }
    claims[parsed.kind] = claim;
    return claim;
  }

  function claimManualSetting(
    tabId,
    command,
    source = 'manual',
    { expectsSettlement = false } = {},
  ) {
    const generation = getCurrentGeneration(tabId);
    const parsed = parseSettingCommand(command);
    if (!generation || !parsed || String(source).startsWith('startup-defaults:')) return null;
    const claims = claimsFor(tabId, generation, true);
    const previous = claims[parsed.kind] || null;
    const claim = {
      id: ++claimSeq,
      value: parsed.value,
      via: source || 'manual',
      at: now(),
    };
    claims[parsed.kind] = claim;
    let resolveSettlement = null;
    const settlement = expectsSettlement
      ? new Promise((resolve) => { resolveSettlement = resolve; })
      : null;
    log('[StartupTx] manual-claim tab=' + String(tabId).slice(-12)
      + ' gen=' + generation
      + ' command="' + String(command) + '"'
      + ' source=' + (source || 'manual')
      + ' expectsSettlement=' + (expectsSettlement ? 'true' : 'false'));
    const token = {
      tabId,
      generation,
      kind: parsed.kind,
      previous,
      claim,
      status: 'pending',
      expectsSettlement,
      settlement,
      resolveSettlement,
      settledReason: null,
    };
    manualClaimsById.set(claim.id, token);
    return token;
  }

  function rollbackManualClaim(token, reason = 'send-failed') {
    if (!token || token.status !== 'pending') return false;
    releaseManualClaimToken(token, false, reason);
    const claims = claimsFor(token.tabId, token.generation, false);
    if (!claims || claims[token.kind] !== token.claim) return false;
    let previous = token.previous || null;
    while (previous) {
      const previousToken = manualClaimsById.get(previous.id);
      if (previousToken?.status !== 'failed') break;
      previous = previousToken.previous || null;
    }
    claims[token.kind] = previous;
    log('[StartupTx] manual-claim-rollback tab=' + String(token.tabId).slice(-12)
      + ' gen=' + token.generation
      + ' kind=' + token.kind
      + ' reason=' + reason);
    return true;
  }

  function settleManualClaim(tabId, claimId, success, reason = 'proof-result') {
    const token = manualClaimsById.get(Number(claimId));
    if (!token || token.tabId !== tabId) return false;
    if (success === true) {
      if (!releaseManualClaimToken(token, true, reason)) {
        return token.status === 'confirmed';
      }
      log('[StartupTx] manual-claim-confirmed tab=' + String(tabId).slice(-12)
        + ' gen=' + token.generation
        + ' kind=' + token.kind
        + ' source=' + token.claim.via);
      return true;
    }
    return rollbackManualClaim(token, reason);
  }

  function abandonPendingManualClaims(reason = 'proof-owner-gone') {
    let abandoned = 0;
    // Renderer reload/crash destroys the async proof owners. Resolve every
    // waiter from main so a startup transaction cannot remain pending forever.
    // Rollback follows the normal claim chain and lets the configured startup
    // default continue when no confirmed manual choice remains.
    for (const token of manualClaimsById.values()) {
      if (token.status !== 'pending' || token.expectsSettlement !== true) continue;
      rollbackManualClaim(token, reason);
      abandoned += 1;
    }
    return abandoned;
  }

  function confirmManualClaimAfterSend(token, reason = 'send-complete') {
    if (!token || token.expectsSettlement) return false;
    return settleManualClaim(token.tabId, token.claim.id, true, reason);
  }

  async function awaitWinningManualClaim(tabId, generation, kind) {
    while (isCurrent(tabId, generation)) {
      const claims = claimsFor(tabId, generation, false);
      const claim = claims ? claims[kind] : null;
      if (!claim || claim.via === 'startup-defaults') return null;
      const token = manualClaimsById.get(claim.id);
      if (!token || token.status === 'confirmed' || token.expectsSettlement !== true) {
        return claim;
      }
      if (token.status === 'failed') continue;
      log('[StartupTx] wait-manual-proof tab=' + String(tabId).slice(-12)
        + ' gen=' + generation
        + ' kind=' + kind
        + ' source=' + claim.via);
      await token.settlement;
      // A second manual choice may have superseded the one we just waited for.
      // Re-read the launch-scoped claim instead of trusting the old token.
    }
    return null;
  }

  function ensure({ tabId, generation, trigger, sessionIdHint = null } = {}) {
    if (!tabId || !generation) {
      return { started: false, reason: 'missing-identity', promise: Promise.resolve(null) };
    }
    if (!isCurrent(tabId, generation)) {
      log('[StartupTx] readiness-stale tab=' + String(tabId).slice(-12)
        + ' gen=' + generation + ' trigger=' + trigger);
      return { started: false, reason: 'stale-generation', promise: Promise.resolve(null) };
    }

    const existing = coordinator.snapshot(tabId);
    const isJoin = existing?.generation === generation;
    if (!isJoin) {
      publishGate({
        tabId,
        status: 'pending',
        reason: trigger,
        generation,
        at: now(),
      });
    }

    const ensured = coordinator.ensureTransaction({
      tabId,
      generation,
      trigger,
      resolveSteps: async () => {
        const settings = await resolveSettings({
          tabId,
          generation,
          trigger,
          sessionIdHint,
        });
        if (!isCurrent(tabId, generation)) return [];
        return buildSteps(tabId, generation, trigger, settings);
      },
      sendCommand: async (payload) => {
        if (!isCurrent(tabId, generation)) {
          return { success: false, error: 'stale-generation' };
        }
        const parsed = parseSettingCommand(payload.command);
        const claim = parsed
          ? await awaitWinningManualClaim(tabId, generation, parsed.kind)
          : null;
        if (!isCurrent(tabId, generation)) {
          return { success: false, error: 'stale-generation' };
        }
        if (claim) {
          return {
            success: true,
            skipped: true,
            reason: 'manual-setting-won:' + claim.via,
          };
        }
        return sendCommand(payload);
      },
      proveCommand: async (payload) => {
        const proof = await proveCommand(payload);
        if (proof?.outcome === PROOF.FOUND) {
          recordConfirmedClaim(tabId, generation, payload.command, 'startup-defaults');
        }
        return proof;
      },
    });

    if (ensured.started) {
      ensured.promise.then((result) => {
        if (!result || !isCurrent(tabId, generation)) return;
        if (result.status === 'ready') {
          publishGate({
            tabId,
            status: 'ready',
            reason: trigger,
            generation,
            at: now(),
          });
          return;
        }
        if (result.status === 'failed') {
          publishGate({
            tabId,
            status: 'failed',
            reason: trigger,
            error: result.error || 'Claude startup defaults failed',
            failedCommand: result.failedCommand || null,
            proofOutcome: result.proofOutcome || null,
            userRetryable: result.userRetryable === true,
            generation,
            at: now(),
          });
        }
      }).catch((error) => {
        if (!isCurrent(tabId, generation)) return;
        publishGate({
          tabId,
          status: 'failed',
          reason: trigger,
          error: error?.message || String(error),
          failedCommand: null,
          proofOutcome: PROOF.UNRESOLVED,
          userRetryable: true,
          generation,
          at: now(),
        });
      });
    }
    return ensured;
  }

  function retry(tabId) {
    const generation = getCurrentGeneration(tabId);
    if (!generation) {
      return { started: false, reason: 'no-live-generation', promise: Promise.resolve(null) };
    }
    coordinator.clear(tabId, 'user-retry');
    log('[StartupRetry] decision=user action=manual-retry tab='
      + String(tabId).slice(-12) + ' gen=' + generation);
    return ensure({
      tabId,
      generation,
      trigger: 'manual-retry',
    });
  }

  function clear(tabId, reason = 'clear') {
    coordinator.clear(tabId, reason);
    claimsByTab.delete(tabId);
    for (const [claimId, token] of manualClaimsById) {
      if (token.tabId !== tabId) continue;
      releaseManualClaimToken(token, false, reason);
      manualClaimsById.delete(claimId);
    }
    publishGate({
      tabId,
      status: 'cleared',
      reason,
      at: now(),
    });
  }

  function snapshot(tabId) {
    const tx = coordinator.snapshot(tabId);
    const generation = getCurrentGeneration(tabId);
    const claims = claimsFor(tabId, generation, false);
    return {
      transaction: tx,
      claims: claims ? {
        generation: claims.generation,
        model: claims.model ? { ...claims.model } : null,
        effort: claims.effort ? { ...claims.effort } : null,
      } : null,
    };
  }

  return {
    ensure,
    retry,
    clear,
    snapshot,
    claimManualSetting,
    rollbackManualClaim,
    settleManualClaim,
    confirmManualClaimAfterSend,
    abandonPendingManualClaims,
    PROOF,
  };
}

module.exports = {
  classifyClaudeStartupDeliveryProof,
  createClaudeStartupMainRuntime,
  parseSettingCommand,
  selectClaudeStartupSettingsSession,
};

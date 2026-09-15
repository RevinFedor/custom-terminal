'use strict';

const {
  createClaudeStartupCoordinator,
  PHASE,
  PROOF,
} = require('./claude-startup-transaction');
const {
  resolveConfiguredAgentModel,
} = require('./agent-provider-model-contract');
const { parseClaudeObservedModelValue } = require('./claude-setting-observation');

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

function normalizeClaudeStartupIntent(providerState) {
  if (!providerState || providerState.type !== 'anthropic') return null;
  const model = String(providerState.startupModel || '').trim();
  const effort = String(providerState.startupEffort || '').trim();
  const intent = {
    ...(model && model !== 'none' ? { model } : {}),
    ...(effort && effort !== 'none' ? { effort } : {}),
  };
  return intent.model || intent.effort ? intent : null;
}

function applyClaudeStartupIntent(settings, intent) {
  const normalized = normalizeClaudeStartupIntent({
    type: 'anthropic',
    startupModel: intent?.model,
    startupEffort: intent?.effort,
  });
  if (!normalized) return settings;
  return {
    ...(settings || {}),
    ...normalized,
    source: 'tab-startup-intent',
  };
}

function claudeBuiltInModelAliasFromDisplay(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const match = normalized.match(/^(?:claude\s+)?(default|opus|sonnet|haiku|fable)(?:\s|\(|$)/);
  return match?.[1] || null;
}

function resolveClaudeStartupModelValue(model, configuredModels = [], observedModel = null) {
  const requested = String(model || '').trim();
  if (!requested || requested === 'none') return requested;
  const observedId = typeof observedModel?.modelId === 'string'
    ? observedModel.modelId.trim()
    : '';
  const observedContextTokens = Number(observedModel?.contextTokens);
  if (observedId && observedId === requested
    && /^claude-[a-z0-9][a-z0-9.-]*$/i.test(observedId)
    && [200000, 1000000].includes(observedContextTokens)) {
    return observedId + (observedContextTokens === 1000000 ? '[1m]' : '');
  }
  // A historical display version must not become today's unversioned alias.
  // This constructs a new restore request, not evidence of the current model;
  // context is carried only when the saved observation actually named it.
  const observedVersion = parseClaudeObservedModelValue(requested);
  if (observedVersion && !observedVersion.modelId && !observedVersion.release
    && !observedVersion.contextConflicting
    && [null, 200000, 1000000].includes(observedVersion.contextTokens)) {
    return 'claude-' + observedVersion.family + '-'
      + observedVersion.version.replace(/\./g, '-')
      + (observedVersion.contextTokens === 1000000 ? '[1m]' : '');
  }
  const resolved = resolveConfiguredAgentModel({
    provider: 'claude',
    model: requested,
    configuredModels,
  });
  if (resolved.resolution !== 'runtime-id') return resolved.model;
  return claudeBuiltInModelAliasFromDisplay(requested) || resolved.model;
}

/**
 * Recover the last confirmed model/effort pair across durable fork ancestry.
 *
 * A compact fork deliberately removes the pre-compact JSONL prefix. The
 * startup slash-command proof can live in that removed prefix (and trailing
 * startup commands are also trimmed before Resume), so the child alone may
 * truthfully report no setting. Fork markers are durable and identify the
 * exact parent whose history the child came from. Walk that lineage only
 * after each child lookup succeeded: a failed child read is unknown and must
 * never be overwritten with an older parent's value.
 */
async function resolveClaudeSettingsAcrossForkChain({
  sessionId,
  readSettings,
  getParentSession,
  maxDepth = 16,
} = {}) {
  if (typeof readSettings !== 'function') throw new TypeError('readSettings is required');
  if (typeof getParentSession !== 'function') throw new TypeError('getParentSession is required');

  const rootSessionId = String(sessionId || '').trim();
  if (!rootSessionId) {
    return { success: false, reason: 'missing-session-id', sessionId: rootSessionId };
  }

  const visited = new Set();
  const lineage = [];
  let currentSessionId = rootSessionId;
  let model = null;
  let effort = null;
  let modelSessionId = null;
  let observedModel = null;
  let modelRequestedValue = null;
  let modelRequestSatisfied = null;
  let modelProofAt = 0;
  let modelProofSessionId = null;
  let effortSessionId = null;
  let latestSessionId = rootSessionId;

  for (let depth = 0; depth < maxDepth && currentSessionId; depth += 1) {
    if (visited.has(currentSessionId)) {
      return {
        success: true,
        sessionId: rootSessionId,
        latestSessionId,
        model,
        observedModel,
        modelRequestedValue,
        modelRequestSatisfied,
        modelProofAt,
        modelProofSessionId,
        effort,
        modelSessionId,
        effortSessionId,
        lineage,
        inherited: !!(
          (modelSessionId && modelSessionId !== rootSessionId)
          || (effortSessionId && effortSessionId !== rootSessionId)
        ),
        reason: 'fork-cycle-stopped',
      };
    }
    visited.add(currentSessionId);
    lineage.push(currentSessionId);

    const result = await readSettings(currentSessionId);
    if (result?.success !== true) {
      if (currentSessionId === rootSessionId) return result || {
        success: false,
        reason: 'settings-read-failed',
        sessionId: rootSessionId,
      };
      break;
    }
    if (depth === 0 && result.latestSessionId) latestSessionId = result.latestSessionId;
    if (!model && result.model) {
      model = result.model;
      modelSessionId = currentSessionId;
      observedModel = result.observedModel && typeof result.observedModel === 'object'
        ? { ...result.observedModel }
        : null;
      modelRequestedValue = result.modelRequestedValue || null;
      modelRequestSatisfied = result.modelRequestSatisfied ?? null;
      modelProofAt = Number(result.modelProofAt || 0);
      modelProofSessionId = result.modelProofSessionId || null;
    }
    // Effort is process-local. A parent/older JSONL record is historical proof,
    // not the setting of the process that is starting now. The data layer only
    // marks it current when its stdout was written inside this exact live launch.
    if (!effort && result.effort && result.effortCurrentRuntime === true) {
      effort = result.effort;
      effortSessionId = currentSessionId;
    }
    if (model && effort) break;

    const parent = getParentSession(currentSessionId);
    currentSessionId = String(parent?.source_session_id || '').trim() || null;
  }

  return {
    success: true,
    sessionId: rootSessionId,
    latestSessionId,
    model,
    observedModel,
    modelRequestedValue,
    modelRequestSatisfied,
    modelProofAt,
    modelProofSessionId,
    effort,
    modelSessionId,
    effortSessionId,
    lineage,
    inherited: !!(
      (modelSessionId && modelSessionId !== rootSessionId)
      || (effortSessionId && effortSessionId !== rootSessionId)
    ),
    reason: model || effort ? 'confirmed' : 'no-confirmed-settings',
  };
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
  const startupPromptProof = sendResult?.startupPromptProof || null;
  const stableRepasteIdentity = sendResult?.submitted === false
    && sendResult?.pasteWritten === true
    && sendResult?.reason === 'claude-startup-command-not-proven-at-enter'
    && composer?.success === true
    && composer?.empty === true
    && composer?.terminalIdentityStable === true
    && composer?.startupGenerationStable === true
    && startupPromptProof
    && Number.isFinite(Number(startupPromptProof.terminalRunSeq))
    && Number(composer.terminalRunSeq) === Number(startupPromptProof.terminalRunSeq)
    && startupPromptProof.terminalLifecycleGeneration
    && composer.terminalLifecycleGeneration
      === startupPromptProof.terminalLifecycleGeneration
    && startupPromptProof.mirrorGeneration
    && composer.mirrorGeneration === startupPromptProof.mirrorGeneration
    && Number.isFinite(Number(startupPromptProof.inputRevision))
    && Number(composer.inputRevision) === Number(startupPromptProof.inputRevision) + 1;
  if (stableRepasteIdentity) {
    return {
      ...base,
      success: false,
      outcome: PROOF.ABSENT,
      reason: 'exact-empty-after-paste-before-enter',
      scanReason: base.reason || null,
      recovery: { kind: 'repaste-after-empty' },
      composerProof: 'empty',
      submitProof: 'not-written',
    };
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

function classifyClaudeStartupRetryComposer({
  recovery = null,
  command = '',
  composer = null,
} = {}) {
  const expected = String(command || '').trim();
  const actual = String(composer?.text || '').trim();
  const exactTransactionCommand = recovery?.kind === 'repaste-after-empty'
    && composer?.proofOutcome === 'found'
    && composer?.hasDraft === true
    && (
      String(composer?.source || '').startsWith('headless-main:')
      || composer?.exactCapture === true
    )
    && parseSettingCommand(expected) !== null
    && actual === expected;

  return exactTransactionCommand
    ? {
      ownership: 'transaction-command',
      action: 'submit-existing-input',
      reason: 'exact-retry-command-restored-before-repaste',
    }
    : {
      ownership: composer?.hasDraft === true ? 'user-or-unknown' : 'empty',
      action: composer?.hasDraft === true ? 'preserve-native-draft' : 'repaste',
      reason: composer?.hasDraft === true
        ? 'not-exact-transaction-command'
        : 'composer-empty',
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
  const retryPlansByTab = new Map();
  const coordinatorChangeWaiters = new Map();
  let claimSeq = 0;
  let attemptSeq = 0;

  function coordinatorIdentity(tabId) {
    const snapshot = coordinator.snapshot(tabId);
    return snapshot ? { attemptId: snapshot.attemptId,
      executionRevision: snapshot.executionRevision } : null;
  }

  function sameCoordinatorIdentity(left, right) {
    return !!left && !!right && left.attemptId === right.attemptId
      && Number(left.executionRevision) === Number(right.executionRevision);
  }

  function signalCoordinatorChange(tabId) {
    const waiters = coordinatorChangeWaiters.get(tabId);
    if (!waiters) return;
    for (const notify of [...waiters]) notify();
  }

  function waitForCoordinatorChange(tabId, expected) {
    if (!sameCoordinatorIdentity(coordinatorIdentity(tabId), expected)) {
      return { promise: Promise.resolve(), cancel() {} };
    }
    let active = true;
    let resolveWait;
    const promise = new Promise(resolve => { resolveWait = resolve; });
    const notify = () => {
      if (!active || sameCoordinatorIdentity(coordinatorIdentity(tabId), expected)) return;
      active = false;
      coordinatorChangeWaiters.get(tabId)?.delete(notify);
      resolveWait();
    };
    if (!coordinatorChangeWaiters.has(tabId)) coordinatorChangeWaiters.set(tabId, new Set());
    coordinatorChangeWaiters.get(tabId).add(notify);
    return { promise, cancel() {
      if (!active) return;
      active = false;
      coordinatorChangeWaiters.get(tabId)?.delete(notify);
    } };
  }

  function releaseManualClaimToken(token, success, reason) {
    if (!token || !['pending', 'unknown'].includes(token.status)) return false;
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
    for (const operation of new Set(Object.values(existing?.manualOperations || {}))) {
      operation?.resolveSettlement?.();
    }
    discardGenerationClaims(tabId, generation, 'generation-superseded');
    retryPlansByTab.delete(tabId);
    const claims = { generation, model: null, effort: null, manualOperation: null,
      manualOperations: { model: null, effort: null }, manualOperationsById: new Map() };
    claimsByTab.set(tabId, claims);
    return claims;
  }

  function getCurrentGeneration(tabId) {
    return currentLaunchGeneration(tabId) || null;
  }

  function isCurrent(tabId, generation) {
    return !!generation && getCurrentGeneration(tabId) === generation;
  }

  function claimIsConfirmed(claim) {
    if (!claim) return false;
    const token = manualClaimsById.get(claim.id);
    return !token || token.status === 'confirmed' || token.expectsSettlement !== true;
  }

  function buildSteps(tabId, generation, trigger, settings) {
    const claims = claimsFor(tabId, generation, true);
    const steps = [];
    const retryPlan = retryPlansByTab.get(tabId);
    const model = String(retryPlan?.generation === generation && retryPlan.kind === 'model'
      ? retryPlan.value : settings?.model || '').trim();
    const effort = String(retryPlan?.generation === generation && retryPlan.kind === 'effort'
      ? retryPlan.value : settings?.effort || '').trim();

    // Session history chooses the model we want to restore, but it is not proof
    // of the model loaded by this new process generation. Claude can resume the
    // same JSONL on its default model (production tab-3954: history=Fable,
    // fresh bridge=Opus). Only a claim produced inside this generation may
    // suppress the physical /model step.
    if (settings?.effortAlreadyConfirmed === true && effort && effort !== 'none' && !claims.effort) {
      recordConfirmedClaim(tabId, generation, '/effort ' + effort, 'session-history');
    }

    if (model && model !== 'none' && (retryPlan?.kind === 'model' || !claimIsConfirmed(claims.model))) {
      steps.push({
        phase: PHASE.MODEL,
        command: '/model ' + model,
        source: 'startup-defaults:' + trigger + '-model',
        label: 'startup-model',
        explicitRetry: retryPlan?.kind === 'model',
        retryClaimFence: retryPlan?.kind === 'model' ? retryPlan.claimFence : null,
        retryFailedClaimId: retryPlan?.kind === 'model' ? retryPlan.failedClaimId : null,
        retryFailedClaimOrder: retryPlan?.kind === 'model' ? retryPlan.failedClaimOrder : null,
      });
    } else if (claims.model) {
      log('[StartupTx] skip-model tab=' + String(tabId).slice(-12)
        + ' gen=' + generation + ' alreadyApplied=' + claims.model.via);
    }

    if (effort && effort !== 'none' && (retryPlan?.kind === 'effort' || !claimIsConfirmed(claims.effort))) {
      steps.push({
        phase: PHASE.EFFORT,
        command: '/effort ' + effort,
        source: 'startup-defaults:' + trigger + '-effort',
        label: 'startup-effort',
        explicitRetry: retryPlan?.kind === 'effort',
        retryClaimFence: retryPlan?.kind === 'effort' ? retryPlan.claimFence : null,
        retryFailedClaimId: retryPlan?.kind === 'effort' ? retryPlan.failedClaimId : null,
        retryFailedClaimOrder: retryPlan?.kind === 'effort' ? retryPlan.failedClaimOrder : null,
      });
    } else if (claims.effort) {
      log('[StartupTx] skip-effort tab=' + String(tabId).slice(-12)
        + ' gen=' + generation + ' alreadyApplied=' + claims.effort.via);
    }
    if (retryPlan?.generation === generation) retryPlansByTab.delete(tabId);
    return steps;
  }

  function recordConfirmedClaim(tabId, generation, command, via, detail = {}) {
    const parsed = parseSettingCommand(command);
    if (!parsed || !isCurrent(tabId, generation)) return null;
    const claims = claimsFor(tabId, generation, true);
    const existing = claims[parsed.kind];
    const claimId = ++claimSeq;
    const retryClaimFence = Number(detail.retryClaimFence);
    const hasRetryFence = detail.explicitRetry === true
      && Number.isSafeInteger(retryClaimFence)
      && retryClaimFence >= 0;
    const claim = {
      id: claimId,
      admissionOrder: hasRetryFence ? retryClaimFence : claimId,
      value: detail.actualValue ?? detail.value ?? parsed.value,
      requestedValue: detail.requestedValue ?? parsed.value,
      actualValue: detail.actualValue ?? detail.value ?? null,
      observedSetting: detail.observedSetting || null,
      proofStatus: detail.proofStatus
        || (detail.requestSatisfied === false ? 'applied-different' : 'applied'),
      via,
      at: now(),
    };
    const explicitRetryMayReplace = hasRetryFence
      && (!existing || Number(existing.admissionOrder ?? existing.id) <= retryClaimFence);
    if (existing?.via && existing.via !== 'startup-defaults' && !explicitRetryMayReplace) {
      if (!hasRetryFence && via === 'startup-defaults') {
        // This command was admitted before the manual head but proved later.
        // Proof completion time must not make that preserved fallback newer.
        claim.admissionOrder = 0;
      }
      // A user action admitted after this startup send but before its proof is
      // causally newer. The old startup proof must not overwrite that claim,
      // but it remains the confirmed fallback if the newer manual proof fails.
      // Attach it below the whole manual chain so nested clicks roll back to
      // the last valid choice rather than losing an already-proven startup
      // setting.
      let cursor = existing;
      let insertedRetryFallback = false;
      while (cursor) {
        const token = manualClaimsById.get(cursor.id);
        if (!token || token.tabId !== tabId || token.generation !== generation) break;
        const previousOrder = Number(token.previous?.admissionOrder ?? token.previous?.id ?? -1);
        const insertAtCausalFence = hasRetryFence
          && Number(cursor.admissionOrder ?? cursor.id) > retryClaimFence
          && (!token.previous || previousOrder <= retryClaimFence);
        if (insertAtCausalFence || !token.previous) {
          token.previous = claim;
          insertedRetryFallback = insertAtCausalFence;
          log('[StartupTx] startup-proof-preserved-below-manual tab='
            + String(tabId).slice(-12)
            + ' gen=' + generation
            + ' kind=' + parsed.kind
            + ' manualSource=' + existing.via
            + (insertedRetryFallback ? ' causalFence=' + retryClaimFence : ''));
          break;
        }
        if (!hasRetryFence && token.previous.via === 'startup-defaults') break;
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
    { expectsSettlement = false, proofOwner = 'renderer', settingsOperationId = null,
      settingsOperationOrder = null, startupAttemptId = undefined } = {},
  ) {
    const generation = getCurrentGeneration(tabId);
    const parsed = parseSettingCommand(command);
    if (!generation || !parsed || String(source).startsWith('startup-defaults:')) return null;
    const claims = claimsFor(tabId, generation, true);
    const previous = claims[parsed.kind] || null;
    const claimId = ++claimSeq;
    const claim = {
      id: claimId,
      admissionOrder: claimId,
      value: parsed.value,
      requestedValue: parsed.value,
      actualValue: null,
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
      proofOwner: proofOwner === 'main' ? 'main' : 'renderer',
      settlement,
      resolveSettlement,
      settledReason: null,
      settingsOperationId,
      settingsOperationOrder,
      startupAttemptId,
    };
    manualClaimsById.set(claim.id, token);
    return token;
  }

  function rollbackManualClaim(token, reason = 'send-failed') {
    if (!token || !['pending', 'unknown'].includes(token.status)) return false;
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

  function settleManualClaim(tabId, claimId, success, reason = 'proof-result', detail = {}) {
    const token = manualClaimsById.get(Number(claimId));
    if (!token || token.tabId !== tabId) return false;
    if (!isCurrent(tabId, token.generation)) return false;
    if (token.startupAttemptId !== undefined
      && token.startupAttemptId !== (coordinator.snapshot(tabId)?.attemptId || null)) return false;
    if (detail.status === 'unknown' || detail.outcome === 'unknown' || detail.outcome === PROOF.UNRESOLVED) {
      if (!['pending', 'unknown'].includes(token.status)) return false;
      token.status = 'unknown';
      token.settledReason = reason;
      token.claim.proofStatus = 'unknown';
      token.resolveSettlement?.({ success: false, outcome: 'unknown', reason });
      token.resolveSettlement = null;
      return true;
    }
    if (success === true) {
      if (!['pending', 'unknown', 'confirmed'].includes(token.status)) return false;
      const actualValue = detail.actualValue ?? detail.value;
      if (actualValue !== undefined && actualValue !== null) {
        token.claim.value = actualValue;
        token.claim.actualValue = actualValue;
      }
      if (detail.requestedValue !== undefined) token.claim.requestedValue = detail.requestedValue;
      if (detail.observedSetting) token.claim.observedSetting = detail.observedSetting;
      token.claim.proofStatus = detail.status || 'applied';
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
    // Renderer reload/crash destroys only renderer-owned proof jobs. A main
    // settings/send transaction survives navigation and settles its own claim.
    // Rollback follows the normal claim chain and lets the configured startup
    // default continue when no confirmed manual choice remains.
    for (const token of manualClaimsById.values()) {
      if (token.status !== 'pending' || token.expectsSettlement !== true) continue;
      if (token.proofOwner === 'main') continue;
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
      if (token.status === 'unknown') return { ...claim, proofStatus: 'unknown' };
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

  function admitManualSettingsOperation({ tabId, runtime } = {}) {
    const generation = runtime?.launchGeneration;
    const currentAttemptId = coordinator.snapshot(tabId)?.attemptId || null;
    const order = Number(runtime?.settingsOperationOrder);
    const id = runtime?.settingsOperationId;
    if (!isCurrent(tabId, generation) || runtime?.startupAttemptId !== currentAttemptId
      || !id || !Number.isSafeInteger(order) || order < 1) {
      return { admitted: false, reason: 'stale-settings-operation' };
    }
    const claims = claimsFor(tabId, generation, true);
    const kinds = [...new Set((Array.isArray(runtime.settingsKinds) && runtime.settingsKinds.length
      ? runtime.settingsKinds : ['model', 'effort']).filter(kind => ['model', 'effort'].includes(kind)))];
    if (!kinds.length) return { admitted: false, reason: 'settings-operation-kind-missing' };
    const existingById = claims.manualOperationsById.get(id);
    if (existingById) {
      const same = existingById.runtime.settingsOperationOrder === order;
      return { admitted: same, reason: same ? 'already-admitted' : 'stale-settings-operation' };
    }
    for (const kind of kinds) {
      const previous = claims.manualOperations[kind];
      if (previous && previous.runtime.settingsOperationOrder >= order) {
        return { admitted: false, reason: 'stale-settings-operation' };
      }
    }
    let resolveSettlement;
    const settlement = new Promise(resolve => { resolveSettlement = resolve; });
    const operation = {
      runtime: { ...runtime, settingsKinds: kinds, settingsOperationOrder: order },
      kinds,
      settlement,
      resolveSettlement,
      status: 'pending',
      outcomeSignature: null,
    };
    const replaced = new Set(kinds.map(kind => claims.manualOperations[kind]).filter(Boolean));
    for (const kind of kinds) claims.manualOperations[kind] = operation;
    claims.manualOperationsById.set(id, operation);
    claims.manualOperation = operation;
    for (const previous of replaced) {
      if (!Object.values(claims.manualOperations).includes(previous)) previous.resolveSettlement?.();
    }
    log('[StartupTx] manual-operation-admitted tab=' + String(tabId).slice(-12)
      + ' gen=' + generation + ' operation=' + id + ' order=' + order);
    return { admitted: true };
  }

  function currentManualOperation(tabId, runtime) {
    if (!runtime || !isCurrent(tabId, runtime.launchGeneration)) return null;
    if (runtime.startupAttemptId !== (coordinator.snapshot(tabId)?.attemptId || null)) return null;
    const claims = claimsFor(tabId, runtime.launchGeneration, false);
    const operation = claims?.manualOperationsById.get(runtime.settingsOperationId);
    if (operation?.runtime.settingsOperationOrder !== Number(runtime.settingsOperationOrder)) return null;
    return operation.kinds.some(kind => claims.manualOperations[kind] === operation) ? operation : null;
  }

  async function awaitManualOperation(tabId, generation, payload) {
    while (isCurrent(tabId, generation)) {
      const kind = parseSettingCommand(payload.command)?.kind;
      const claims = claimsFor(tabId, generation, false);
      const operation = kind ? claims?.manualOperations[kind] : claims?.manualOperation;
      if (!operation || operation.status !== 'pending') return;
      payload.onWaitingForManual?.();
      await operation.settlement;
    }
  }

  function publishResult(tabId, generation, attemptId, reason, result) {
    if (!result || !['failed', 'ready'].includes(result.status)) return;
    publishGate({
      tabId, generation, attemptId, reason, at: now(),
      status: result.status,
      resultRevision: result.resultRevision || null,
      ...(result.status === 'failed' ? {
        error: result.error || 'Claude startup defaults failed',
        errorCode: result.errorCode || null,
        failedCommand: result.failedCommand || null,
        proofOutcome: result.proofOutcome || null,
        userRetryable: result.userRetryable === true,
        failureRevision: result.resultRevision || null,
        failureId: attemptId + ':failure:' + result.resultRevision,
      } : {}),
    });
  }

  async function reconcileManualSettingsOutcome(outcome = {}) {
    const { tabId, runtime } = outcome;
    const operation = currentManualOperation(tabId, runtime);
    if (!operation) return { reconciled: false, reason: 'stale-settings-operation' };
    const allSteps = Array.isArray(outcome.steps) ? outcome.steps : [];
    const claims = claimsFor(tabId, runtime.launchGeneration, false);
    const applicableKinds = new Set(operation.kinds.filter(kind => claims?.manualOperations[kind] === operation));
    const steps = allSteps.filter(step => applicableKinds.has(step.kind
      || String(step.command || '').match(/^\/(model|effort)\s/)?.[1]));
    if (!steps.length) return { reconciled: false, reason: 'settings-operation-kinds-superseded' };
    // Duplicate callbacks do not create another failure identity. Late proof is
    // a different reduction of the same operation, not a new admission/order.
    const signature = JSON.stringify({
      status: outcome.status, failedCommand: outcome.failedCommand,
      error: outcome.error, errorCode: outcome.errorCode,
      steps: steps.map(step => ({ kind: step.kind, command: step.command, status: step.status,
        value: step.actualValue ?? step.value, error: step.error, errorCode: step.errorCode })),
    });
    if (operation.outcomeSignature === signature) return { reconciled: false, reason: 'already-reconciled' };
    operation.outcomeSignature = signature;
    const outcomeRevision = (operation.outcomeRevision || 0) + 1;
    operation.outcomeRevision = outcomeRevision;
    const isApplicable = () => currentManualOperation(tabId, runtime) === operation
      && [...applicableKinds].every(kind => claimsFor(tabId, runtime.launchGeneration, false)
        ?.manualOperations[kind] === operation)
      && operation.outcomeRevision === outcomeRevision;
    try {
      const reconciled = await coordinator.reconcileSettingsOutcome({
        ...outcome,
        generation: runtime.launchGeneration,
        attemptId: runtime.startupAttemptId,
        settingsOperationId: runtime.settingsOperationId,
        settingsOperationOrder: runtime.settingsOperationOrder,
        steps,
        isApplicable,
      });
      operation.completionPromise = reconciled?.promise || Promise.resolve(reconciled?.result || null);
      operation.completionCoordinatorIdentity = {
        attemptId: runtime.startupAttemptId,
        executionRevision: reconciled?.executionRevision,
      };
      signalCoordinatorChange(tabId);
      if (!isApplicable()) return { reconciled: false, reason: 'stale-settings-operation' };
      const ownsRevision = () => isApplicable()
        && coordinator.snapshot(tabId)?.executionRevision === reconciled.executionRevision;
      if (reconciled.started) {
        publishGate({ tabId, status: 'pending', reason: 'manual-settings-replacement',
          generation: runtime.launchGeneration, attemptId: runtime.startupAttemptId, at: now() });
        reconciled.promise.then(result => {
          if (ownsRevision()) publishResult(tabId, runtime.launchGeneration, runtime.startupAttemptId,
            'manual-settings-replacement', result);
        }).catch(error => {
          if (ownsRevision()) publishResult(tabId, runtime.launchGeneration, runtime.startupAttemptId,
            'manual-settings-replacement', { status: 'failed', error: error?.message || String(error),
              proofOutcome: PROOF.UNRESOLVED, userRetryable: true });
        });
      } else if (reconciled.reconciled && ownsRevision()) {
        publishResult(tabId, runtime.launchGeneration, runtime.startupAttemptId, 'manual-settings-outcome', reconciled.result);
      }
      return reconciled;
    } finally {
      if (operation.outcomeRevision === outcomeRevision) {
        operation.status = outcome.status || 'unknown';
        operation.resolveSettlement?.();
        operation.resolveSettlement = null;
      }
    }
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
    const attemptId = isJoin ? existing.attemptId : generation + ':settings:' + (++attemptSeq);
    const ownsAttempt = () => isCurrent(tabId, generation)
      && coordinator.snapshot(tabId)?.attemptId === attemptId;
    const ownsExecution = payload => ownsAttempt()
      && coordinator.snapshot(tabId)?.executionRevision === payload.executionRevision;

    const ensured = coordinator.ensureTransaction({
      tabId,
      generation,
      attemptId,
      trigger,
      currentSettingsOperation: () => claimsFor(tabId, generation, false)?.manualOperation || null,
      resolveSteps: async () => {
        const settings = await resolveSettings({
          tabId,
          generation,
          trigger,
          sessionIdHint,
        });
        if (!ownsAttempt()) return [];
        return buildSteps(tabId, generation, trigger, settings);
      },
      sendCommand: async (payload) => {
        if (!ownsExecution(payload)) {
          return { success: false, error: 'stale-generation' };
        }
        if (claimsFor(tabId, generation, false)?.manualOperation?.status === 'pending') {
          await awaitManualOperation(tabId, generation, payload);
        }
        if (!ownsExecution(payload)) return { success: false, error: 'superseded-settings-outcome' };
        const parsed = parseSettingCommand(payload.command);
        const claim = parsed && payload.explicitRetry !== true
          ? await awaitWinningManualClaim(tabId, generation, parsed.kind)
          : null;
        if (!ownsExecution(payload)) {
          return { success: false, error: 'stale-generation' };
        }
        if (claim?.proofStatus === 'unknown') {
          return { success: false, error: 'manual-setting-outcome-unknown', submitted: null };
        }
        if (claim) {
          return {
            success: true,
            skipped: true,
            reason: 'manual-setting-won:' + claim.via,
          };
        }
        payload.onSendAdmitted?.();
        return sendCommand({ ...payload, isExecutionCurrent: () => ownsExecution(payload) });
      },
      proveCommand: async (payload) => {
        const observationOnly = payload.observationOnly === true
          && payload.explicitRetry === true
          && ownsAttempt();
        if (!ownsExecution(payload) && !observationOnly) {
          return { outcome: PROOF.UNRESOLVED, reason: 'superseded-settings-attempt' };
        }
        const proof = await proveCommand(payload);
        const observedApplication = proof?.outcome === PROOF.FOUND
          || (proof?.requestSatisfied === false && proof?.observed && proof?.actualValue);
        const mayPreserveSupersededRetry = payload.explicitRetry === true
          && ownsAttempt()
          && observedApplication;
        let claim = null;
        if (observedApplication && (ownsExecution(payload) || mayPreserveSupersededRetry)) {
          claim = recordConfirmedClaim(tabId, generation, payload.command,
            payload.explicitRetry ? 'explicit-retry' : 'startup-defaults', {
              ...proof,
              explicitRetry: payload.explicitRetry === true,
              retryClaimFence: payload.retryClaimFence,
              proofStatus: proof.requestSatisfied === false ? 'applied-different' : 'applied',
            });
          if (claim?.id) {
            proof.claimId = claim.id;
            proof.claimOrder = claim.admissionOrder ?? claim.id;
          }
        }
        if (!ownsExecution(payload)) return { outcome: PROOF.UNRESOLVED,
          reason: mayPreserveSupersededRetry ? 'superseded-retry-proof-preserved' : 'superseded-settings-attempt',
          historicalClaimId: claim?.id || null };
        return proof;
      },
    });

    if (ensured.started) {
      signalCoordinatorChange(tabId);
      const executionRevision = ensured.transaction.executionRevision;
      const ownsOriginalExecution = () => ownsAttempt()
        && coordinator.snapshot(tabId)?.executionRevision === executionRevision;
      publishGate({ tabId, status: 'pending', reason: trigger, generation, attemptId, at: now() });
      ensured.promise.then((result) => {
        if (!result || !ownsOriginalExecution()) return;
        publishResult(tabId, generation, attemptId, trigger, result);
      }).catch((error) => {
        if (!ownsOriginalExecution()) return;
        publishGate({
          tabId,
          status: 'failed',
          reason: trigger,
          error: error?.message || String(error),
          errorCode: null,
          failedCommand: null,
          proofOutcome: PROOF.UNRESOLVED,
          userRetryable: true,
          generation,
          attemptId,
          at: now(),
        });
      });
    }
    return ensured;
  }

  function retry(tabId, expected = {}) {
    const generation = getCurrentGeneration(tabId);
    if (!generation) {
      return { started: false, reason: 'no-live-generation', promise: Promise.resolve(null) };
    }
    const current = coordinator.snapshot(tabId);
    if ((expected.generation && expected.generation !== generation)
      || (expected.attemptId && expected.attemptId !== current?.attemptId)) {
      return { started: false, reason: 'stale-settings-attempt', promise: Promise.resolve(null) };
    }
    if (current?.generation === generation && (!current.settled || current.result?.status === 'ready')) {
      return ensure({ tabId, generation, trigger: 'manual-retry-join' });
    }
    const failedStep = current?.result?.status === 'failed'
      ? current.steps?.find(step => step.command === current.result.failedCommand) || null
      : null;
    const retryTarget = parseSettingCommand(failedStep?.command);
    const currentClaim = retryTarget ? claimsFor(tabId, generation, false)?.[retryTarget.kind] : null;
    const failedClaimId = Number(failedStep?.claimId || failedStep?.proof?.claimId || 0);
    const failedClaimOrder = Number(failedStep?.claimOrder || failedStep?.proof?.claimOrder
      || failedStep?.retryFailedClaimOrder || failedStep?.retryClaimFence || failedClaimId);
    const newerCausalOverride = Number(currentClaim?.admissionOrder ?? currentClaim?.id ?? 0)
      > failedClaimOrder;
    if (retryTarget && newerCausalOverride) {
      const claims = claimsFor(tabId, generation, false);
      const operation = claims?.manualOperations?.[retryTarget.kind] || null;
      if (operation?.status === 'pending') {
        if (!operation.retryJoinPromise) {
          operation.retryJoinPromise = operation.settlement.then(async () => {
            if (operation.completionPromise) {
              const change = waitForCoordinatorChange(
                tabId,
                operation.completionCoordinatorIdentity || coordinatorIdentity(tabId),
              );
              try {
                await Promise.race([
                  Promise.resolve(operation.completionPromise).catch(() => {}),
                  change.promise,
                ]);
              } finally { change.cancel(); }
            }
            return coordinator.snapshot(tabId)?.result || {
              status: 'pending', generation, attemptId: current?.attemptId || null,
            };
          });
        }
        return { started: false, joined: true, reason: 'newer-manual-operation-pending',
          promise: operation.retryJoinPromise };
      }
      // A fully confirmed legacy/manual pair has no pending operation to join.
      // Re-evaluate the same launch below without a retry plan: buildSteps will
      // keep those confirmed claims and close the old failure without a write.
    }
    if (retryTarget && !newerCausalOverride) retryPlansByTab.set(tabId, { generation, ...retryTarget,
      failedCommand: failedStep.command, failedClaimId, failedClaimOrder, claimFence: claimSeq,
      sourceAttemptId: current.attemptId });
    coordinator.clear(tabId, 'user-retry');
    signalCoordinatorChange(tabId);
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
    signalCoordinatorChange(tabId);
    for (const operation of new Set(Object.values(claimsByTab.get(tabId)?.manualOperations || {}))) {
      operation?.resolveSettlement?.();
    }
    claimsByTab.delete(tabId);
    retryPlansByTab.delete(tabId);
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
    admitManualSettingsOperation,
    reconcileManualSettingsOutcome,
    claimManualSetting,
    rollbackManualClaim,
    settleManualClaim,
    confirmManualClaimAfterSend,
    abandonPendingManualClaims,
    PROOF,
  };
}

module.exports = {
  applyClaudeStartupIntent,
  classifyClaudeStartupDeliveryProof,
  classifyClaudeStartupRetryComposer,
  createClaudeStartupMainRuntime,
  normalizeClaudeStartupIntent,
  parseSettingCommand,
  resolveClaudeStartupModelValue,
  resolveClaudeSettingsAcrossForkChain,
  selectClaudeStartupSettingsSession,
};

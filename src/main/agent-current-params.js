'use strict';

const { normalizeAuthoritativeContextPct } = require('./agent-context-usage-state');
const { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT } = require('../shared/codex-model-catalog.cjs');

const clean = value => typeof value === 'string' ? value.trim() : '';
const choice = value => clean(value) === 'none' ? '' : clean(value);
const number = value => Number.isFinite(Number(value)) && value != null ? Number(value) : null;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tabType = capture => capture?.tab_type ?? capture?.tabType ?? null;
const UNSTABLE_CODES = new Set(['params_snapshot_unstable', 'runtime_snapshot_unstable',
  'codex_runtime_snapshot_unstable', 'settings-read-unstable', 'stale-session']);

function readError(code, cause = null) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), {
    code, statusCode: 503, success: false, coherent: false, runtimeStateUnknown: true,
  });
}

// Compare semantic facts, never the entire headless/runtime object. In particular
// a repeated committed footer may advance frameSeq without changing its proof.
// The caller's optional semanticKey covers main-owned setting/policy revisions;
// its isCurrent callback additionally checks the opaque terminal/process scope.
function currentParamsCaptureKey(capture = {}) {
  capture = capture || {};
  return JSON.stringify([capture.provider, tabType(capture), capture.sessionId,
    capture.cwd, capture.projectId, capture.lifecycleGeneration,
    capture.terminalRunSeq ?? capture.runSeq, capture.inputRevision, capture.launchId,
    capture.ownerToken, capture.ownerOrder?.epoch, capture.ownerOrder?.revision,
    capture.settingsOwnerId, capture.semanticKey]);
}

function publicOwner(capture) {
  return {
    provider: capture.provider, sessionId: clean(capture.sessionId) || null,
    lifecycleGeneration: capture.lifecycleGeneration || null,
    terminalRunSeq: number(capture.terminalRunSeq ?? capture.runSeq),
    inputRevision: number(capture.inputRevision), launchId: capture.launchId || null,
    ownerToken: capture.ownerToken || null, ownerOrder: copy(capture.ownerOrder) || null,
  };
}

function observation(value) {
  if (typeof value === 'string') return clean(value) || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['value', 'model', 'modelId', 'label', 'source', 'provenance', 'contextTokens']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number'
      || typeof value[key] === 'boolean') result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

function observedModel(confirmed) {
  return observation(confirmed.observedModel ?? confirmed.observedSettings?.model
    ?? confirmed.observed?.model ?? confirmed.observed);
}

function observationModelValue(observed) {
  return typeof observed === 'string' ? observed
    : clean(observed?.modelId) || clean(observed?.value) || clean(observed?.model) || clean(observed?.label);
}

function fallbackSetting(stored, kind, lastDefault) {
  const saved = choice(stored[kind]);
  return { value: saved || choice(stored['default' + kind[0].toUpperCase() + kind.slice(1)]) || lastDefault,
    known: false, currentRuntime: false, scope: 'intent', source: saved ? 'saved-intent' : 'default-intent' };
}

function contextProjection(context, stored, capture) {
  const exactPct = normalizeAuthoritativeContextPct(context?.contextPct);
  const exact = exactPct != null && !!clean(capture.sessionId)
    && context?.provider === capture.provider && context?.sessionId === capture.sessionId;
  const savedPct = normalizeAuthoritativeContextPct(stored.contextPct);
  return {
    value: exact ? exactPct : savedPct,
    known: exact,
    source: exact ? 'provider-session-observation' : savedPct != null ? 'saved-tab-context' : 'unavailable',
    sessionId: exact ? context.sessionId : null,
    observedAt: exact ? number(context.observedAt) : null,
  };
}

function claudeProjection({ confirmed, thinking, stored, runtime }) {
  const successful = confirmed?.success === true;
  const inactive = runtime.processStatus === 'absent' || runtime.liveLifecycle === false;
  const observed = successful ? observedModel(confirmed) : null;
  const confirmedModel = successful ? observationModelValue(observed) || clean(confirmed.model) : '';
  const model = confirmedModel ? {
    value: confirmedModel, known: true, currentRuntime: !inactive && confirmed.modelCurrentRuntime === true,
    scope: !inactive && confirmed.modelCurrentRuntime === true ? 'runtime' : 'historical',
    source: clean(confirmed.modelSource) || clean(confirmed.proof) || 'active-jsonl-branch',
    proofAt: number(confirmed.modelProofAt), sessionId: confirmed.modelProofSessionId || confirmed.sessionId || null,
    ...(observed ? { observed } : {}),
  } : fallbackSetting(stored, 'model', 'default');
  const historicalEffort = successful ? clean(confirmed.effortHistorical) || clean(confirmed.effort) || null : null;
  const currentEffort = !inactive && successful && confirmed.effortCurrentRuntime === true ? clean(confirmed.effort) : '';
  const effort = currentEffort ? {
    value: currentEffort, known: true, currentRuntime: true, scope: 'runtime',
    source: clean(confirmed.effortSource) || 'current-runtime-local-command',
    proofAt: number(confirmed.effortProofAt), sessionId: confirmed.effortProofSessionId || confirmed.sessionId || null,
    runtimeGeneration: confirmed.runtimeGeneration || null,
  } : { value: '?', known: false, currentRuntime: false, scope: 'unknown', source: 'unproven-current-runtime' };
  const thinkingKnown = !inactive && thinking?.success === true && thinking.known === true
    && typeof thinking.thinking === 'boolean';
  const lastThinking = !inactive && thinking?.success === true && typeof thinking.lastConfirmedThinking === 'boolean';
  const thinkOn = thinkingKnown ? thinking.thinking : lastThinking ? thinking.lastConfirmedThinking : true;
  return {
    model, effort,
    fields: {
      effortHistorical: historicalEffort,
      thinking: thinkOn ? 'adaptive' : 'disabled', thinkingKnown,
      thinkingSource: thinkingKnown ? 'native-picker-proof' : lastThinking ? 'last-confirmed-intent' : 'default-intent',
      thinkingProof: thinkingKnown ? copy(thinking.thinkingProof) || null : null,
      thinkingReadReason: inactive ? 'process-inactive' : thinking?.reason || (thinkingKnown ? null : 'thinking-state-unavailable'),
      thinkingLastConfirmedAt: inactive ? null : number(thinking?.lastConfirmedAt),
    },
    readReason: successful ? null : confirmed?.reason || 'confirmed-settings-unavailable',
  };
}

function codexProjection({ settings, providerState, stored, runtime, capture }) {
  const ownerId = clean(settings.ownerId) || clean(capture.settingsOwnerId)
    || clean(runtime.provenWriterSessionId) || clean(runtime.codexCurrentSettingsOwnerId)
    || clean(runtime.codexProvisionalSettingsOwnerId) || clean(capture.sessionId);
  const inactive = runtime.processStatus === 'absent' || runtime.liveLifecycle === false;
  const candidate = inactive ? null : [settings.liveSettings, settings.currentSettings, settings.provisionalSettings]
    .find(value => value && ownerId && value.ownerId === ownerId && clean(value.model) && clean(value.effort));
  const project = (kind, defaultValue) => candidate ? {
    value: clean(candidate[kind]), known: true, currentRuntime: true, scope: 'runtime',
    source: clean(candidate.source) || 'owner-validated-settings',
    proofAt: number(candidate.proofAt), ownerId,
  } : fallbackSetting(stored, kind, defaultValue);
  const revision = number(providerState.codexSettingsIntentRevision) || 0;
  const appliedRevision = number(providerState.codexSettingsIntentAppliedRevision) || 0;
  const appliedOwner = clean(providerState.codexSettingsIntentAppliedOwnerId);
  const requestedModel = choice(providerState.codexSettingsIntentModel);
  const requestedEffort = choice(providerState.codexSettingsIntentEffort);
  const intentKnown = Number.isInteger(revision) && revision > 0 && !!requestedModel && !!requestedEffort;
  const desiredFast = providerState.codexFastIntent;
  const fastIntentKnown = typeof desiredFast === 'boolean';
  const tierProof = settings.serviceTierProof;
  const tier = tierProof?.serviceTier;
  const fastKnown = !inactive && !!ownerId && tierProof?.ownerId === ownerId
    && (tier === 'priority' || tier === 'default');
  const fastCurrent = fastKnown ? tier === 'priority' : null;
  return {
    model: project('model', DEFAULT_CODEX_MODEL), effort: project('effort', DEFAULT_CODEX_EFFORT),
    fields: {
      liveSettings: candidate === settings.liveSettings ? copy(candidate) : null,
      thinking: 'disabled',
      requestedModel: intentKnown ? requestedModel : null,
      requestedEffort: intentKnown ? requestedEffort : null,
      settingsRevision: intentKnown ? revision : 0,
      settingsAppliedRevision: appliedRevision,
      settingsPending: intentKnown && (inactive || revision !== appliedRevision || !ownerId || appliedOwner !== ownerId),
      fast: fastIntentKnown ? desiredFast : fastCurrent,
      fastKnown, fastCurrent,
      fastPending: fastIntentKnown && (!fastKnown || desiredFast !== fastCurrent),
    },
    fast: { known: fastKnown, current: fastCurrent, desired: fastIntentKnown ? desiredFast : null,
      source: fastKnown ? clean(tierProof.source) || 'owner-validated-service-tier' : 'unavailable',
      ownerId: fastKnown ? ownerId : null, proofAt: fastKnown ? number(tierProof.proofAt) : null },
    readReason: null,
  };
}

/**
 * A read adapter only: no PTY writes, renderer calls, process discovery, timers
 * or proof reconstruction. Dependencies own their existing authority checks.
 *
 * capture(tabId) is synchronous: {provider, tab_type|tabType, sessionId, cwd,
 * projectId, lifecycleGeneration, terminalRunSeq, inputRevision, launchId,
 * ownerToken, ownerOrder, settingsOwnerId?, semanticKey?, ...opaqueScope}.
 * isCurrent(tabId, captured) synchronously checks the opaque physical owner.
 * semanticKey must describe setting/policy changes, NOT animated frame sequence.
 *
 * readRuntime(tabId,capture) returns the existing main coherent runtime.
 * readClaudeSettings({tabId,sessionId,cwd}) and readClaudeThinking(tabId,capture)
 * return their existing main API/store results.
 * readCodexSettings(tabId,capture,runtime) returns {ownerId?, liveSettings?,
 * currentSettings?, provisionalSettings?, serviceTierProof?}. Each supplied
 * candidate is already main-owner-validated and carries ownerId/model/effort/
 * source/proofAt; serviceTierProof carries ownerId/serviceTier/source/proofAt.
 * readProviderState(tabId,capture) returns the OWN TAB's stored provider options.
 * readContext(tabId,{provider,sessionId},capture) returns exact context usage.
 * readStoredChoices(tabId,capture) returns {model?,effort?,defaultModel?,
 * defaultEffort?,contextPct?}; these are intent/fallback, never live proof.
 * All read dependencies may be async. Successful results are copied before the
 * next await so mutation of a backing map cannot rewrite an earlier observation.
 * SDK returns null only for the explicit persisted claude-sdk tab type.
 */
function createAgentCurrentParamsReader(deps) {
  for (const name of ['capture', 'isCurrent', 'readRuntime', 'readClaudeSettings', 'readClaudeThinking',
    'readCodexSettings', 'readProviderState', 'readContext', 'readStoredChoices']) {
    if (typeof deps?.[name] !== 'function') throw new TypeError(name + ' is required');
  }
  async function read(tabId) {
    if (!clean(tabId)) throw readError('params_tab_required');
    for (let pass = 0; pass < 2; pass++) {
      try {
        const rawCapture = deps.capture(tabId);
        if (!rawCapture) throw readError('params_target_unavailable');
        const captured = { ...rawCapture, ownerOrder: copy(rawCapture.ownerOrder) };
        // Keep the opaque captured scope for main's object-identity check, but
        // copy every projection field and semantic key before the FIRST await.
        const key = currentParamsCaptureKey(captured);
        const capture = { ...publicOwner(captured), tabType: tabType(captured),
          cwd: captured.cwd || null, projectId: captured.projectId || null,
          settingsOwnerId: captured.settingsOwnerId || null };
        if (capture.tabType === 'claude-sdk') return null;
        if (!['claude', 'codex'].includes(capture.provider)) throw readError('params_target_unavailable');
        const runtime = copy(await deps.readRuntime(tabId, captured));
        if (!runtime) throw readError('params_runtime_unavailable');
        const runtimeProvider = runtime.toolType || runtime.commandType;
        if (runtimeProvider && runtimeProvider !== capture.provider) throw readError('params_snapshot_unstable');
        let confirmed = null, thinking = null, settings = null;
        if (capture.provider === 'claude') {
          confirmed = copy(await deps.readClaudeSettings({ tabId, sessionId: capture.sessionId, cwd: capture.cwd }));
          if (UNSTABLE_CODES.has(confirmed?.reason)
            || (confirmed?.success === true && confirmed.sessionId !== capture.sessionId)) {
            throw readError('params_snapshot_unstable');
          }
          thinking = copy(await deps.readClaudeThinking(tabId, captured));
        } else settings = copy(await deps.readCodexSettings(tabId, captured, runtime)) || {};
        const providerState = copy(await deps.readProviderState(tabId, captured)) || {};
        const context = copy(await deps.readContext(tabId,
          { provider: capture.provider, sessionId: capture.sessionId }, captured));
        const stored = copy(await deps.readStoredChoices(tabId, captured)) || {};
        if (deps.isCurrent(tabId, captured) !== true
          || currentParamsCaptureKey(deps.capture(tabId)) !== key) throw readError('params_snapshot_unstable');
        const projected = capture.provider === 'claude'
          ? claudeProjection({ confirmed, thinking, stored, runtime })
          : codexProjection({ settings, providerState, stored, runtime, capture });
        const contextValue = contextProjection(context, stored, capture);
        return {
          tabId, provider: capture.provider, sessionId: capture.sessionId, coherent: true,
          owner: publicOwner(capture),
          model: projected.model.value, modelKnown: projected.model.known,
          modelCurrentRuntime: projected.model.currentRuntime, modelSource: projected.model.source,
          effort: projected.effort.value, effortKnown: projected.effort.known,
          effortCurrentRuntime: projected.effort.currentRuntime, effortSource: projected.effort.source,
          ...projected.fields,
          contextPct: contextValue.value, contextKnown: contextValue.known, contextSource: contextValue.source,
          savedSettings: { model: choice(stored.model) || null, effort: choice(stored.effort) || null },
          provenance: { model: projected.model, effort: projected.effort, context: contextValue,
            ...(projected.fast ? { fast: projected.fast } : {}), readReason: projected.readReason },
        };
      } catch (error) {
        if (UNSTABLE_CODES.has(error?.code)) {
          if (pass === 0) continue;
          throw readError('params_snapshot_unstable', error);
        }
        if (error?.statusCode === 503 && clean(error.code).startsWith('params_')) throw error;
        throw readError('params_read_failed', error);
      }
    }
    throw readError('params_snapshot_unstable');
  }
  return { read };
}

module.exports = { createAgentCurrentParamsReader, currentParamsCaptureKey };

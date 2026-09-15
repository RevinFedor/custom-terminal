'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentCurrentParamsReader, currentParamsCaptureKey } = require('./agent-current-params');
const { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT } = require('../shared/codex-model-catalog.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(provider = 'claude') {
  const calls = [];
  const state = { version: 1, provider, tab_type: 'terminal', terminal: {}, frameSeq: 1,
    inputRevision: 1, semanticRevision: 1, processStatus: 'found',
    stored: { model: 'saved-model', effort: 'high', contextPct: 83 },
    options: {}, confirmed: null, thinking: null, codex: null, context: null };
  const capture = () => ({ provider: state.provider, tab_type: state.tab_type,
    projectId: 'P', cwd: '/fixture', sessionId: 'S' + state.version, terminal: state.terminal,
    lifecycleGeneration: 'G' + state.version, terminalRunSeq: state.version,
    inputRevision: state.inputRevision, launchId: 'L' + state.version,
    ownerToken: 'O' + state.version, ownerOrder: { epoch: 'E', revision: state.version },
    semanticKey: state.semanticRevision, frameSeq: state.frameSeq });
  const record = (name, read) => (...args) => { calls.push({ name, args }); return read(...args); };
  const deps = {
    capture,
    isCurrent: (_tab, before) => before.terminal === state.terminal
      && before.lifecycleGeneration === 'G' + state.version,
    readRuntime: record('runtime', () => ({ toolType: state.provider,
      processStatus: state.processStatus, sessionId: 'S' + state.version,
      provenWriterSessionId: state.provider === 'codex' ? 'S' + state.version : null })),
    readClaudeSettings: record('claude', () => state.confirmed || ({ success: true,
      sessionId: 'S' + state.version, model: 'claude-observed-' + state.version,
      modelProofSessionId: 'S' + state.version, modelProofAt: state.version * 1000,
      proof: 'active-jsonl-branch', effort: 'max', effortHistorical: 'max', effortCurrentRuntime: true,
      effortProofSessionId: 'S' + state.version, effortProofAt: state.version * 1000,
      runtimeGeneration: 'L' + state.version })),
    readClaudeThinking: record('thinking', () => state.thinking || ({ success: true, known: true,
      thinking: state.version % 2 === 1, lastConfirmedThinking: state.version % 2 === 1,
      lastConfirmedAt: state.version * 1000, thinkingProof: { sessionId: 'S' + state.version,
        lifecycleGeneration: 'G' + state.version, inputRevision: state.inputRevision } })),
    readCodexSettings: record('codex', () => state.codex || ({ ownerId: 'S' + state.version,
      liveSettings: { ownerId: 'S' + state.version, sessionId: 'S' + state.version,
        model: 'codex-observed-' + state.version, effort: 'ultra', proofAt: state.version * 1000,
        source: 'committed-composer-footer', frameSeq: state.frameSeq } })),
    readProviderState: record('provider', () => state.options),
    readContext: record('context', () => state.context || ({ provider: state.provider,
      sessionId: 'S' + state.version, contextPct: state.version * 10, observedAt: state.version * 1000 })),
    readStoredChoices: record('stored', () => state.stored),
  };
  const reader = createAgentCurrentParamsReader(deps);
  return { reader, deps, state, calls,
    count: name => calls.filter(call => call.name === name).length,
    nextOwner() { state.version++; state.terminal = {}; state.inputRevision++; },
  };
}

function pauseFirst(h, name) {
  const entered = deferred(), finish = deferred();
  const original = h.deps[name];
  let first = true;
  h.deps[name] = async (...args) => {
    const value = original(...args);
    if (first) { first = false; entered.resolve(); await finish.promise; }
    return value;
  };
  return { entered: entered.promise, finish: finish.resolve };
}

for (const dependency of ['readRuntime', 'readClaudeSettings', 'readClaudeThinking',
  'readProviderState', 'readContext', 'readStoredChoices']) {
  test('actual adapter rereads the whole owner after a change during ' + dependency, async () => {
    const h = fixture();
    const pause = pauseFirst(h, dependency);
    const pending = h.reader.read('T');
    await pause.entered;
    h.nextOwner();
    pause.finish();
    const result = await pending;
    assert.equal(result.sessionId, 'S2');
    assert.equal(result.owner.lifecycleGeneration, 'G2');
    assert.equal(result.owner.ownerToken, 'O2');
    assert.equal(result.model, 'claude-observed-2');
    assert.equal(result.thinking, 'disabled');
    assert.equal(result.thinkingProof.sessionId, 'S2');
    assert.equal(result.contextPct, 20);
    assert.equal(h.count('runtime'), 2);
  });
}

test('actual Codex dependency is reread after its suspended observation loses the owner', async () => {
  const h = fixture('codex');
  const pause = pauseFirst(h, 'readCodexSettings');
  const pending = h.reader.read('T');
  await pause.entered; h.nextOwner(); pause.finish();
  const result = await pending;
  assert.equal(result.model, 'codex-observed-2');
  assert.equal(result.liveSettings.ownerId, 'S2');
  assert.equal(result.contextPct, 20);
  assert.equal(h.count('codex'), 2);
});

test('repeated owner churn is bounded to two reads and fails as typed unknown, never SDK', async () => {
  const h = fixture();
  const original = h.deps.readRuntime;
  h.deps.readRuntime = async (...args) => { const value = original(...args); h.nextOwner(); return value; };
  await assert.rejects(h.reader.read('T'), error => error.code === 'params_snapshot_unstable'
    && error.statusCode === 503 && error.coherent === false && error.runtimeStateUnknown === true);
  assert.equal(h.count('runtime'), 2);
});

test('opaque terminal replacement and user input each invalidate an otherwise equal capture', async () => {
  for (const mutate of [h => { h.state.terminal = {}; }, h => { h.state.inputRevision++; }]) {
    const h = fixture();
    const pause = pauseFirst(h, 'readStoredChoices');
    const pending = h.reader.read('T');
    await pause.entered; mutate(h); pause.finish();
    const result = await pending;
    assert.equal(result.coherent, true);
    assert.equal(result.owner.inputRevision, h.state.inputRevision);
    assert.equal(h.count('runtime'), 2);
  }
});

test('same-owner model observation and intent revision changes invalidate the semantic key', async () => {
  const h = fixture('codex');
  const pause = pauseFirst(h, 'readStoredChoices');
  const pending = h.reader.read('T');
  await pause.entered;
  h.state.codex = { ownerId: 'S1', liveSettings: { ownerId: 'S1', model: 'gpt-reserve', effort: 'high',
    proofAt: 2000, source: 'committed-composer-footer' } };
  h.state.options = { codexSettingsIntentModel: 'gpt-6-astra', codexSettingsIntentEffort: 'max',
    codexSettingsIntentRevision: 2, codexSettingsIntentAppliedRevision: 1, codexSettingsIntentAppliedOwnerId: 'S1' };
  h.state.semanticRevision++;
  pause.finish();
  const result = await pending;
  assert.equal(result.model, 'gpt-reserve');
  assert.equal(result.requestedModel, 'gpt-6-astra');
  assert.equal(result.settingsPending, true);
  assert.equal(h.count('runtime'), 2);
});

test('ordinary animated frame changes do not force repeated observation', async () => {
  const h = fixture('codex');
  const pause = pauseFirst(h, 'readStoredChoices');
  const pending = h.reader.read('T');
  await pause.entered; h.state.frameSeq += 100; pause.finish();
  const result = await pending;
  assert.equal(h.count('runtime'), 1);
  assert.equal(result.model, 'codex-observed-1');
  assert.equal(result.liveSettings.frameSeq, 1);
  assert.equal(currentParamsCaptureKey({ provider: 'codex', frameSeq: 1 }),
    currentParamsCaptureKey({ provider: 'codex', frameSeq: 999 }));
});

test('provider replacement restarts with the correct provider reader', async () => {
  const h = fixture();
  const pause = pauseFirst(h, 'readContext');
  const pending = h.reader.read('T');
  await pause.entered; h.nextOwner(); h.state.provider = 'codex'; pause.finish();
  const result = await pending;
  assert.equal(result.provider, 'codex');
  assert.equal(result.model, 'codex-observed-2');
  assert.equal(result.thinking, 'disabled');
  assert.equal(result.thinkingProof, undefined);
  assert.equal(h.count('claude'), 1);
  assert.equal(h.count('codex'), 1);
});

test('only explicit persisted SDK type bypasses all PTY dependencies, including stopped SDK', async () => {
  const h = fixture();
  h.state.tab_type = 'claude-sdk';
  assert.equal(await h.reader.read('T'), null);
  assert.deepEqual(h.calls, []);
  h.state.tab_type = 'terminal';
  h.deps.readRuntime = () => null;
  await assert.rejects(h.reader.read('T'), { code: 'params_runtime_unavailable', statusCode: 503 });
  h.state.provider = null;
  await assert.rejects(h.reader.read('T'), { code: 'params_target_unavailable', statusCode: 503 });
});

test('a PTY dependency exception remains typed failure and never selects SDK fallback', async () => {
  const h = fixture();
  h.deps.readClaudeSettings = async () => { throw Error('fixture source unavailable'); };
  await assert.rejects(h.reader.read('T'), error => error.code === 'params_read_failed'
    && error.statusCode === 503 && error.cause?.message === 'fixture source unavailable');
  assert.equal(h.count('runtime'), 1);
});

test('Claude historical effort is kept separately and cannot become current via saved choices', async () => {
  const h = fixture();
  h.state.confirmed = { success: true, sessionId: 'S1', model: 'claude-sonnet-5', modelProofAt: 1000,
    proof: 'active-jsonl-branch', effort: 'max', effortHistorical: 'max', effortCurrentRuntime: false };
  const result = await h.reader.read('T');
  assert.equal(result.modelKnown, true);
  assert.equal(result.modelCurrentRuntime, false);
  assert.equal(result.provenance.model.scope, 'historical');
  assert.equal(result.effort, '?');
  assert.equal(result.effortKnown, false);
  assert.equal(result.effortHistorical, 'max');
  assert.equal(result.savedSettings.effort, 'high');
});

test('Claude accepts optional actual observed model without deriving canonical proof from a label', async () => {
  for (const observed of [
    { observedModel: { modelId: 'claude-sonnet-5', label: 'Sonnet 5' } },
    { observedSettings: { model: { value: 'claude-sonnet-5' } } },
    { observed: { model: 'claude-sonnet-5' } },
  ]) {
    const h = fixture();
    h.state.confirmed = { success: true, sessionId: 'S1', model: 'requested-fable[1m]',
      proof: 'active-jsonl-branch', ...observed };
    const result = await h.reader.read('T');
    assert.equal(result.model, 'claude-sonnet-5');
    assert.equal(result.modelCurrentRuntime, false);
    assert.ok(result.provenance.model.observed);
    assert.equal(result.savedSettings.model, 'saved-model');
  }
});

test('unavailable Claude evidence labels saved and default intent without claiming it is known', async () => {
  const h = fixture();
  h.state.confirmed = { success: false, reason: 'session-missing' };
  let result = await h.reader.read('T');
  assert.equal(result.model, 'saved-model');
  assert.equal(result.modelKnown, false);
  assert.equal(result.modelSource, 'saved-intent');
  assert.equal(result.provenance.readReason, 'session-missing');
  h.state.stored = { model: 'none', defaultModel: 'claude-opus-5' };
  result = await h.reader.read('T');
  assert.equal(result.model, 'claude-opus-5');
  assert.equal(result.modelKnown, false);
  assert.equal(result.modelSource, 'default-intent');
  assert.equal(result.savedSettings.model, null);
});

test('unstable Claude evidence cannot silently become a saved fallback after bounded retries', async () => {
  const h = fixture();
  h.state.confirmed = { success: false, reason: 'settings-read-unstable' };
  await assert.rejects(h.reader.read('T'), { code: 'params_snapshot_unstable', statusCode: 503 });
  assert.equal(h.count('claude'), 2);
});

test('thinking preserves the last confirmed intent while a current proof is unavailable', async () => {
  const h = fixture();
  h.state.thinking = { success: true, known: false, thinking: null, lastConfirmedThinking: false,
    lastConfirmedAt: 1234, thinkingProof: null, reason: 'input-changed-since-proof' };
  const result = await h.reader.read('T');
  assert.equal(result.thinking, 'disabled');
  assert.equal(result.thinkingKnown, false);
  assert.equal(result.thinkingSource, 'last-confirmed-intent');
  assert.equal(result.thinkingProof, null);
  assert.equal(result.thinkingReadReason, 'input-changed-since-proof');
  assert.equal(result.thinkingLastConfirmedAt, 1234);
});

test('authoritative context zero is valid; wrong provider/session can only use labelled saved fallback', async () => {
  const h = fixture();
  h.state.context = { provider: 'claude', sessionId: 'S1', contextPct: 0, observedAt: 1234 };
  let result = await h.reader.read('T');
  assert.equal(result.contextPct, 0); assert.equal(result.contextKnown, true);
  assert.equal(result.provenance.context.observedAt, 1234);
  for (const wrong of [{ provider: 'codex', sessionId: 'S1' }, { provider: 'claude', sessionId: 'old' }]) {
    h.state.context = { ...wrong, contextPct: 25 };
    result = await h.reader.read('T');
    assert.equal(result.contextPct, 83); assert.equal(result.contextKnown, false);
    assert.equal(result.contextSource, 'saved-tab-context');
    assert.equal(result.provenance.context.sessionId, null);
  }
  h.state.stored.contextPct = null;
  result = await h.reader.read('T');
  assert.equal(result.contextPct, null); assert.equal(result.contextSource, 'unavailable');
});

test('Codex observed fallback, requested intent, and stored choice are independent', async () => {
  const h = fixture('codex');
  h.state.codex = { ownerId: 'S1', liveSettings: { ownerId: 'S1', model: 'gpt-reserve', effort: 'high',
    proofAt: 1234, source: 'committed-composer-footer' } };
  h.state.options = { codexSettingsIntentModel: 'gpt-6-astra', codexSettingsIntentEffort: 'max',
    codexSettingsIntentRevision: 2, codexSettingsIntentAppliedRevision: 2, codexSettingsIntentAppliedOwnerId: 'S1' };
  const result = await h.reader.read('T');
  assert.equal(result.model, 'gpt-reserve'); assert.equal(result.modelKnown, true);
  assert.equal(result.modelCurrentRuntime, true);
  assert.equal(result.requestedModel, 'gpt-6-astra'); assert.equal(result.requestedEffort, 'max');
  assert.equal(result.savedSettings.model, 'saved-model');
  assert.equal(result.settingsPending, false, 'provider fallback does not create a new user settings command');
  assert.equal(h.state.options.codexSettingsIntentRevision, 2);
});

test('Codex current/provisional proof is owner checked and never replaced by an intent as proof', async () => {
  const h = fixture('codex');
  h.state.codex = { ownerId: 'launch:L1', liveSettings: { ownerId: 'old', model: 'stale', effort: 'max' },
    provisionalSettings: { ownerId: 'launch:L1', model: 'launch-model', effort: 'ultra',
      proofAt: 1000, source: 'verified-launch-composer' } };
  h.state.options = { codexSettingsIntentModel: 'launch-model', codexSettingsIntentEffort: 'ultra',
    codexSettingsIntentRevision: 1, codexSettingsIntentAppliedRevision: 1, codexSettingsIntentAppliedOwnerId: 'S1' };
  let result = await h.reader.read('T');
  assert.equal(result.model, 'launch-model'); assert.equal(result.effort, 'ultra');
  assert.equal(result.modelKnown, true); assert.equal(result.settingsPending, true);
  assert.equal(result.liveSettings, null);
  h.state.codex = { ownerId: 'S1', liveSettings: { ownerId: 'old', model: 'stale', effort: 'max' } };
  result = await h.reader.read('T');
  assert.equal(result.model, 'saved-model'); assert.equal(result.modelKnown, false);
  assert.equal(result.effort, 'high'); assert.equal(result.effortKnown, false);
  assert.equal(result.modelSource, 'saved-intent');
  h.state.stored = {};
  result = await h.reader.read('T');
  assert.equal(result.model, DEFAULT_CODEX_MODEL); assert.equal(result.effort, DEFAULT_CODEX_EFFORT);
  assert.equal(result.modelSource, 'default-intent');
});

test('Fast intent is compatible display state, separately proven and pending when different/unknown', async () => {
  for (const item of [
    { desired: false, tier: 'priority', expected: false, current: true, pending: true, known: true },
    { desired: true, tier: 'priority', expected: true, current: true, pending: false, known: true },
    { desired: true, tier: null, expected: true, current: null, pending: true, known: false },
    { desired: undefined, tier: 'default', expected: false, current: false, pending: false, known: true },
    { desired: undefined, tier: null, expected: null, current: null, pending: false, known: false },
    { desired: true, tier: 'priority', owner: 'old', expected: true, current: null, pending: true, known: false },
  ]) {
    const h = fixture('codex');
    h.state.options = { codexFastIntent: item.desired };
    h.state.codex = { ownerId: 'S1', serviceTierProof: item.tier
      ? { ownerId: item.owner || 'S1', serviceTier: item.tier, proofAt: 1234, source: 'tui' } : null };
    const result = await h.reader.read('T');
    assert.equal(result.fast, item.expected); assert.equal(result.fastCurrent, item.current);
    assert.equal(result.fastPending, item.pending); assert.equal(result.fastKnown, item.known);
    assert.equal(result.provenance.fast.desired, item.desired ?? null);
  }
});

test('stopped Codex cannot expose old current model/Fast as live proof', async () => {
  const h = fixture('codex');
  h.state.processStatus = 'absent';
  h.state.options = { codexFastIntent: true };
  h.state.codex = { ownerId: 'S1', liveSettings: { ownerId: 'S1', model: 'old-runtime', effort: 'ultra' },
    serviceTierProof: { ownerId: 'S1', serviceTier: 'priority', proofAt: 1000 } };
  const result = await h.reader.read('T');
  assert.equal(result.modelKnown, false); assert.equal(result.model, 'saved-model');
  assert.equal(result.fastKnown, false); assert.equal(result.fastCurrent, null); assert.equal(result.fastPending, true);
});

test('proved process absence revokes Claude process-local values but retains historical model evidence', async () => {
  const h = fixture();
  h.state.processStatus = 'absent';
  const result = await h.reader.read('T');
  assert.equal(result.model, 'claude-observed-1');
  assert.equal(result.modelKnown, true); assert.equal(result.modelCurrentRuntime, false);
  assert.equal(result.effort, '?'); assert.equal(result.effortKnown, false);
  assert.equal(result.effortHistorical, 'max');
  assert.equal(result.thinkingKnown, false); assert.equal(result.thinkingProof, null);
  assert.equal(result.thinkingReadReason, 'process-inactive');
});

test('returned source values are detached before the following dependency await', async () => {
  const h = fixture();
  h.state.confirmed = { success: true, sessionId: 'S1', model: 'first-observation', proof: 'active-jsonl-branch' };
  const pause = pauseFirst(h, 'readClaudeThinking');
  const pending = h.reader.read('T');
  await pause.entered;
  h.state.confirmed.model = 'mutated-backing-object';
  pause.finish();
  const result = await pending;
  assert.equal(result.model, 'first-observation');
  assert.equal(result.provenance.model.value, 'first-observation');
});

test('runtime provider mismatch is explicit unstable and cannot publish another provider as this tab', async () => {
  const h = fixture();
  let reads = 0;
  h.deps.readRuntime = () => { reads++; return { toolType: 'codex', processStatus: 'found' }; };
  await assert.rejects(h.reader.read('T'), { code: 'params_snapshot_unstable', statusCode: 503 });
  assert.equal(reads, 2);
  assert.equal(h.count('claude'), 0);
});

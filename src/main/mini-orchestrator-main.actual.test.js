'use strict';
// Executes the actual narrow Main functions and runtime. Electron, the DB and
// Gemini transport are controlled fixtures; no app, reader or model is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMiniOrchestratorRuntime } = require('./mini-orchestrator-runtime');
const { rememberCodexLivePromptOwner, resolveCodexLivePromptOwner } = require('./codex-live-prompt-owner');
const outcomes = require('./codex-turn-outcome');
const promptGrammar = require('./codex-prompt-audit');
const { createCodexLiveUserCarrierPairer } = require('./codex-live-user-carrier-pairing');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function part(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start); return main.slice(a, b);
}
const ownReader = part('function readMiniOrchestratorOwner(', 'function getMiniOrchestratorRuntime(');
const observe = part('function observeMiniOrchestratorCodex(', 'for (const [channel, action]');
const release = part('async function publishCodexSuppressedCatchUpRelease(', 'function releaseCodexSourceObservationAfterWriterProof(');
const identity = (s, r, prefix) => `${prefix}-source-${s.sessionId}-${r.__byteOffset}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
test('actual Main enables automatic return only for the explicit private DEV flag, not ordinary app or generic E2E', () => {
  const body = part('function getMiniOrchestratorRuntime(', 'function miniOrchestratorSendFailure(');
  for (const [env, expected] of [[{}, false], [{ NOTED_MINI_AUTOMATIC_CORRECTIONS: '1' }, false],
    [{ NOTED_E2E_TEST: 'true' }, false], [{ NOTED_E2E_TEST: 'true', NOTED_MINI_AUTOMATIC_CORRECTIONS: '1' }, false],
    [{ NOTED_E2E_TEST: 'true', NOTED_MINI_REPLAY_PROFILE: '/own/private/PROFILE.json', NOTED_MINI_AUTOMATIC_CORRECTIONS: '1' }, true]]) {
    let captured;
    const context = { process: { env }, path, srcMainDir: __dirname, projectManager: { db: {} }, systemPromptService: {},
      miniOrchestratorRuntime: null, miniOrchestratorHookRelease: null, readMiniOrchestratorOwner() { return null; },
      getAgentResponseObservationReader: () => ({ onAgentResponseCompletion: () => () => {} }),
      require: () => ({ createMiniOrchestratorRuntime: options => { captured = options; return {}; } }) };
    vm.runInNewContext(body + '\ngetMiniOrchestratorRuntime();', context);
    assert.equal(captured.automaticCorrections, expected);
  }
});
function fixture({ legacyGate = false, correction = false, legacyCarrierDedup = false } = {}) {
  const terminal = {}, tabId = 'own-mini-tab', generation = 'own-physical:1';
  const state = { tabId, sessionId: 'own-sid', processGeneration: generation, sourceObservationTerminal: terminal,
    sourceObservationLaunchId: 'own-launch', processGenerationBoundaryOffset: 100,
    capacityRetryLiveAfterOffset: 100, offset: 500, sourceWriterReplayOffset: 100,
    busy: false, liveTurnEvents: 0, currentTurnId: null };
  const store = new Map(), reviews = [], sends = [], logs = [], known = new Map([[tabId, state.sessionId]]);
  const context = { terminals: new Map([[tabId, terminal]]), codexTurnWatchers: new Map([[tabId, state]]), aiStoppingTabs: new Set(),
    getTerminalLifecycleGeneration: () => generation, getCodexRuntimeSessionId: id => known.get(id),
    getCombinedTabBackgroundWorkCount: () => 0,
    codexEventType: r => r.type === 'event_msg' ? r.payload.type : null,
    codexLiveSourceIdentity: identity, codexStableLiveUserUuid: (s, r) => `user:${s.sessionId}:${r.__byteOffset}`,
    codexUserMessagePresentationText: r => r.payload.message || r.payload.content?.[0]?.text || '',
    resolveCodexLivePromptOwner,
    isCodexEnvironmentContextUserText: promptGrammar.isCodexEnvironmentContextUserText,
    isCodexProjectInstructionsUserText: promptGrammar.isCodexProjectInstructionsUserText,
    isCodexGoalContinuationUserText: promptGrammar.isCodexGoalContinuationUserText,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    clearCodexPromptInFlight() {}, finishCodexStartupLifecycle() {}, markCodexTuiReadyFromTurnEnd() {},
    isCodexInputReadyTurnEndEvent: outcomes.isCodexInputReadyTurnEndEvent,
    emitCodexBusy(_tab, busy) { state.busy = busy; }, broadcastCodexPublicRuntimeSnapshot() {},
    codexCanonicalPresentation: null, emitCodexTurnStateResolved() {},
  };
  const old = observe.replace('if (!miniOrchestratorRuntime?.isEnabled(state.tabId)) return;',
    'if (!miniOrchestratorRuntime?.isEnabled(state.tabId) || suppressed) return;');
  const selectedObserve = (legacyGate ? old : observe);
  const observed = legacyCarrierDedup ? selectedObserve.replace('inputAliases: record.__auditEntryUuidAliases || [],', 'inputAliases: [],') : selectedObserve;
  vm.runInNewContext(ownReader + observed + release, context);
  const runtime = createMiniOrchestratorRuntime({ db: { getAppState: k => store.get(k), setAppState: (k, v) => store.set(k, v) },
    systemPromptService: { get: id => ({ id, name: 'Own instruction', revision: 'r1', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', content: 'Review this object', filePaths: [] }) },
    readOwner: id => context.readMiniOrchestratorOwner(id), publish() {},
    review: async input => { reviews.push(input); if (correction) await input.onSendPrompt('Add the missing detail.'); return { text: 'Own review complete' }; },
    sendCorrection: async request => { sends.push(request); return { status: 'queued', handoffId: request.handoffId }; },
  });
  context.miniOrchestratorRuntime = runtime;
  runtime.setEnabled(tabId, true);
  const feed = (type, offset, payload = {}, { audit = null, response = false, recordData = {} } = {}) => {
    const record = { type: response ? 'response_item' : 'event_msg', timestamp: '2026-10-30T10:08:18.360Z',
      __byteOffset: offset, payload: { type, turn_id: 'own-turn', ...payload }, ...recordData };
    const outcome = outcomes.classifyCodexTurnRecord(state, record);
    if (type === 'task_started') state.busy = true;
    const suppressed = !!state.publicTurnStateSuppressed || !!state.catchUpPublicationsSuppressed || !!state.manualBindingConflict;
    context.observeMiniOrchestratorCodex(state, record, suppressed, outcome, audit);
    if (outcome) {
      state.busy = outcome.busy; state.outcomeKnown = true; state.lastOutcomeReason = outcome.reason;
      state.lastOutcomeHasFinalResult = outcome.hasFinalResult; state.lastOutcomeTurnId = outcome.turnId;
      state.lastEventType = outcome.event; state.lastEventTs = record.timestamp;
    }
    return record;
  };
  const begin = () => {
    runtime.onInputAccepted({ tabId, handoffId: 'own-handoff', operationKey: 'own-op' });
    rememberCodexLivePromptOwner(state, { matched: true, handoffId: 'own-handoff', sessionId: state.sessionId,
      sourceIdentity: identity(state, { __byteOffset: 150 }, 'codex-user') });
    assert.equal(outcomes.prepareCodexSourceProofReplay(state).prepared, true);
    feed('task_started', 110); feed('user_message', 150, { message: 'Own original question' });
  };
  const complete = () => feed('task_complete', 490, { last_agent_message: 'Own final answer' });
  const commit = async () => {
    state.offset = 500;
    const result = outcomes.completeCodexSuppressedCatchUpRelease(state, { scanSucceeded: true });
    assert.equal(result.released, true);
    await context.publishCodexSuppressedCatchUpRelease(tabId, state, result, 'own-test'); await tick();
  };
  return { state, context, runtime, reviews, sends, logs, begin, feed, complete, commit, known, tabId };
}

test('old suppressed gate loses the exact first input; repaired Main carries it once and waits for release', async () => {
  const old = fixture({ legacyGate: true }); old.begin(); old.complete(); await old.commit();
  assert.equal(old.reviews.length, 0); old.runtime.dispose();
  const f = fixture(); f.begin();
  assert.equal(f.runtime.get(f.tabId).phase, 'collecting');
  f.complete(); await tick(); assert.equal(f.reviews.length, 0, 'no Gemini while the existing publication fence is held');
  await f.commit();
  assert.equal(f.reviews.length, 1); assert.equal(f.reviews[0].inputs[0].text, 'Own original question');
  assert.equal(f.reviews[0].answer, 'Own final answer'); assert.equal(f.runtime.get(f.tabId).phase, 'complete');
  f.runtime.capture.flush(f.tabId); await tick(); assert.equal(f.reviews.length, 1); f.runtime.dispose();
});

test('release between the first input and final preserves the live continuation and one correction', async () => {
  const f = fixture({ correction: true }); f.begin(); await f.commit(); assert.equal(f.reviews.length, 0);
  f.complete(); f.runtime.capture.flush(f.tabId); await tick();
  assert.equal(f.reviews.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].tabId, f.tabId); assert.equal(f.runtime.guard(f.sends[0]), null); f.runtime.dispose();
});

test('manual conflict, provisional writer, wrong byte floor and unrelated catchup never gain reviewer authority', async () => {
  for (const change of [s => s.manualBindingConflict = {}, s => s.sourceObservationLaunchId = 'still-pending',
    s => s.processGenerationBoundaryOffset = 200, s => s.releasePublicSuppressionKind = 'historical-catchup']) {
    const f = fixture(); outcomes.prepareCodexSourceProofReplay(f.state); change(f.state);
    f.feed('task_started', 110); f.feed('user_message', 150, { message: 'not authorized' }); f.complete();
    await tick(); assert.equal(f.reviews.length, 0); assert.equal(f.runtime.get(f.tabId).phase, 'idle'); f.runtime.dispose();
  }
});

test('Off or a newer queued input during held completion cannot trigger an old review', async () => {
  for (const off of [true, false]) {
    const f = fixture(); f.begin(); f.complete();
    if (off) f.runtime.setEnabled(f.tabId, false);
    else f.runtime.onInputAccepted({ tabId: f.tabId, handoffId: 'next-handoff', operationKey: 'next-op' });
    await f.commit(); assert.equal(f.reviews.length, 0); f.runtime.dispose();
  }
});

test('preferred response-only user carrier works without inventing a second input', async () => {
  const f = fixture(); outcomes.prepareCodexSourceProofReplay(f.state);
  f.feed('task_started', 110); f.state.preferredUserAuditOffsets = new Set([150]);
  f.feed('message', 150, { role: 'user', content: [{ type: 'input_text', text: 'Own response-only question' }] }, { response: true });
  f.complete(); await f.commit(); assert.equal(f.reviews.length, 1);
  assert.equal(f.reviews[0].inputs.length, 1); assert.equal(f.reviews[0].inputs[0].text, 'Own response-only question'); f.runtime.dispose();
});
test('actual shared pairer aliases repair response/event duplication: OLD two inputs, CURRENT one', async () => {
  for (const legacyCarrierDedup of [true, false]) {
    const f = fixture({ legacyCarrierDedup }); outcomes.prepareCodexSourceProofReplay(f.state);
    f.feed('task_started', 110); f.state.preferredUserAuditOffsets = new Set([150]);
    const pairer = createCodexLiveUserCarrierPairer();
    for (const [kind, offset, uuid] of [['response_item', 150, 'real-response'], ['event_msg', 160, 'real-event']]) {
      const p = pairer.accept({ kind, text: 'one actual question', byteOffset: offset,
        projection: { sessionId: f.state.sessionId, message: { sessionId: f.state.sessionId, uuid,
          sourceIdentity: identity(f.state, { __byteOffset: offset }, 'codex-user') } } }).projections[0].message;
      const recordData = { __auditCanonicalCarrier: { entryUuid: p.uuid }, __auditEntryUuidAliases: p.entryUuidAliases || [] };
      if (kind === 'response_item') f.feed('message', offset, { role: 'user', content: [{ type: 'input_text', text: 'one actual question' }] }, { response: true, recordData });
      else f.feed('user_message', offset, { message: 'one actual question' }, { recordData });
    }
    f.complete(); await f.commit();
    assert.equal(f.reviews.length, 1);
    assert.equal(f.reviews[0].inputs.length, legacyCarrierDedup ? 2 : 1);
    if (!legacyCarrierDedup) assert.equal(f.reviews[0].inputs[0].inputId, 'real-event');
    f.runtime.dispose();
  }
});

test('reserved environment metadata is not a request; a proved human quotation remains a request', async () => {
  for (const proved of [false, true]) {
    const f = fixture(); outcomes.prepareCodexSourceProofReplay(f.state);
    f.feed('task_started', 110); f.state.preferredUserAuditOffsets = new Set([140, 150]);
    const text = '<environment_context><cwd>/own</cwd></environment_context>';
    const audit = proved ? { matched: true, handoffId: 'own-quote', sessionId: f.state.sessionId, entryUuid: 'quoted-env' } : null;
    f.feed('message', 140, { role: 'user', content: [{ type: 'input_text', text }] }, { response: true, audit });
    f.feed('user_message', 150, { message: 'Actual own question' });
    f.complete(); await f.commit();
    assert.equal(f.reviews.length, 1);
    assert.equal(f.reviews[0].inputs.length, proved ? 2 : 1);
    assert.equal(f.reviews[0].inputs.at(-1).text, 'Actual own question'); f.runtime.dispose();
  }
});

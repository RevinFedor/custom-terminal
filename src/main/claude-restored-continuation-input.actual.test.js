'use strict';

// A restored Claude tab must be able to receive its build:i-c Continue.
//
// Scar (01Nov, operation 8abf840c): five live, input-ready Claude tabs sat in
// `runtime-input-pending` forever. Claude's idle proof was the observed-turn
// journal alone, so a tab that had not run a turn under the current main
// process reported busy=null and could never satisfy the input gate — while
// that same tab was waiting for the Continue the gate refused to send.
//
// These cases execute the REAL reader and the REAL gate; only the response/
// runtime ports are controlled.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContinuationInputReader,
  canSubmitContinuationInput,
  continuationInputTransitionPending,
} = require('./orchestration-continuation-input');

const SID = 'session-a';

function responseState(patch = {}) {
  return {
    known: true, exists: true, tabId: 'T', toolType: 'claude', sessionId: SID,
    cwd: '/repo', busy: null, transitioning: false, processStatus: 'found',
    backgroundWorkCount: 0, revision: 'rev-1', ...patch,
  };
}

function runtimeSnapshot(patch = {}) {
  return {
    coherent: true, toolType: 'claude', processStatus: 'found', status: 'active',
    inputReady: true, busy: false, starting: false, stopping: false,
    startupDefaultsPending: false, lifecycleGeneration: 'gen-1', terminalRunSeq: 1,
    processPid: 123, inputRevision: 4,
    sendTarget: { toolType: 'claude', sessionId: SID },
    ...patch,
  };
}

const reader = (response, runtime) => createContinuationInputReader({
  readResponseState: async () => response,
  readRuntimeSnapshot: async () => runtime,
  readSendDestination: () => null,
});

// The exact production decision: the gate plus the transition guard the
// build-continue validator applies next to it.
const admits = (state) => canSubmitContinuationInput(state) && !continuationInputTransitionPending(state);

test('restored Claude tab with a live idle composer admits its Continue', async () => {
  const state = await reader(responseState(), runtimeSnapshot())('T');
  assert.equal(state.busy, null, 'no observed turn yet — response busy stays null');
  assert.equal(state.continuationRuntime.known, true);
  assert.equal(admits(state), true, 'an input-ready restored tab must not wait forever');
});

test('an observed running turn still blocks', async () => {
  const state = await reader(responseState({ busy: true }), runtimeSnapshot({ busy: true, status: 'busy' }))('T');
  assert.equal(admits(state), false);
});

test('a tab that is still starting or mid-transition blocks', async () => {
  for (const [response, runtime] of [
    [{}, { status: 'starting', inputReady: false, starting: true }],
    [{}, { startupDefaultsPending: true }],
    [{}, { inputReady: false }],
    [{}, { stopping: true }],
    [{ transitioning: true }, {}],
  ]) {
    const state = await reader(responseState(response), runtimeSnapshot(runtime))('T');
    assert.equal(admits(state), false, JSON.stringify({ ...response, ...runtime }));
  }
});

test('a runtime belonging to another session or provider is not this tab proof', async () => {
  for (const runtime of [
    { sendTarget: { toolType: 'claude', sessionId: 'other-session' } },
    { sendTarget: null },
    { coherent: false },
    { lifecycleGeneration: null },
    { toolType: 'codex' },
  ]) {
    const state = await reader(responseState(), runtimeSnapshot(runtime))('T');
    assert.equal(state.continuationRuntime.known, false);
    assert.equal(admits(state), false, JSON.stringify(runtime));
  }
});

test('an absent process is never admitted on runtime alone', async () => {
  const state = await reader(
    responseState({ processStatus: 'unknown' }),
    runtimeSnapshot({ processStatus: 'unknown' }),
  )('T');
  assert.equal(admits(state), false);
});

test('a runtime read that races the response state is reported, not admitted', async () => {
  let call = 0;
  const racing = createContinuationInputReader({
    readResponseState: async () => (call++ === 0 ? responseState() : responseState({ revision: 'rev-2' })),
    readRuntimeSnapshot: async () => runtimeSnapshot(),
    readSendDestination: () => null,
  });
  const state = await racing('T');
  assert.equal(state.known, false);
  assert.equal(state.continuationInput.reason, 'continuation_runtime_changed');
  assert.equal(admits(state), false);
});

test('a stopped Claude tab keeps the existing authoritative-idle path', async () => {
  const state = await reader(
    responseState({ busy: false, processStatus: 'absent' }),
    runtimeSnapshot({ processStatus: 'absent', status: 'inactive', inputReady: false }),
  )('T');
  assert.equal(admits(state), true, 'proven idle is unchanged by this repair');
});

test('Codex keeps its own admission path untouched', async () => {
  const codex = createContinuationInputReader({
    readResponseState: async () => responseState({ toolType: 'codex', busy: false }),
    readRuntimeSnapshot: async () => runtimeSnapshot({ toolType: 'codex' }),
    readSendDestination: () => null,
  });
  const state = await codex('T');
  assert.equal(state.continuationRuntime, undefined, 'the Claude branch must not capture Codex');
  assert.equal(admits(state), true);
});

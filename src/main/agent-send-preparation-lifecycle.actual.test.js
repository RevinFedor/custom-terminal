'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { fixture, drainMicrotasks: tick } = require('./fixtures/send-preparation-write.cjs');
const { actualFunction } = require('./fixtures/codex-draft-request-observation.cjs');
const { createAgentInputObservation } = require('./agent-input-observation');

function lifecycle(h) {
  let reads = 0, pokes = 0, state = { inputReady: true };
  Object.assign(h.ctx, { historyMutationInput: { assert() {} },
    agentSendCancellations: require('./agent-send-cancellation').createAgentSendCancellationRegistry(),
    createAgentInputObservation: options => createAgentInputObservation({ ...options,
      now: h.clock.now, setTimer: h.clock.setTimer, clearTimer: h.clock.clearTimer }),
    getCodexTuiReadyState: async () => { reads++; return state; },
    codexStartupAutoEnter: new Map([['T', {}]]), hasCodexEstablishedComposerLifecycle: () => true,
    probeCodexStartupFromRawBuffer: () => { pokes++; return { ready: false }; },
    CODEX_EXTERNAL_PROMPT_READY_TIMEOUT_MS: 90000,
    agentSendRequestTargetFailure: () => null,
  });
  vm.runInContext(actualFunction('assertAgentSendLaunchCurrent') + '\n'
    + actualFunction('ensureCodexInputReadyForExternalPrompt'), h.ctx);
  return { get reads() { return reads; }, get pokes() { return pokes; }, setState: value => { state = value; },
    ready: () => h.ctx.ensureCodexInputReadyForExternalPrompt('T', {
      handoffId: 'H', attemptId: h.attempt.attemptId, sendOperationKey: h.identity.operationKey,
      startupFrameWait: h.opts.codexStartupFrameWait,
    }),
    launch: () => h.ctx.assertAgentSendLaunchCurrent('T', 'codex', h.opts),
  };
}

test('actual launch write authority refuses expired HEAD before a late Resume can write', t => {
  const h = fixture(t, { open: false }), l = lifecycle(h);
  assert.doesNotThrow(l.launch);
  h.clock.advance(60000);
  assert.throws(l.launch, error => error.sendLaunchRefusal?.code === 'agent_send_preparation_expired'
    && error.sendLaunchRefusal.launchWritten === false);
  assert.equal(h.writes.length, 0);
});

test('actual readiness refuses an expired HEAD even if a fresh readiness read would say true', async t => {
  const h = fixture(t, { open: false }), l = lifecycle(h); h.clock.advance(60000);
  const r = await l.ready(); assert.equal(r.success, false); assert.equal(l.pokes, 0);
});

test('actual pending readiness is bounded by active HEAD and cannot accept its late async true', async t => {
  const h = fixture(t, { open: false }), l = lifecycle(h);
  let release, done = false;
  h.ctx.getCodexTuiReadyState = () => new Promise(resolve => { release = resolve; });
  const p = l.ready().then(r => { done = true; return r; }); await tick(80);
  try {
    h.clock.advance(60000); await tick(120);
    assert.equal(done, true, 'the 90s legacy readiness budget cannot extend the accepted HEAD');
    const r = await p; assert.equal(r.success, false); assert.equal(l.pokes, 0);
    release({ inputReady: true }); await tick(80); assert.equal(l.pokes, 0); assert.equal(h.writes.length, 0);
  } finally {
    // Close the controlled late read before the fixture closes SQLite, on RED too.
    release?.({ inputReady: true }); await tick(80); await p;
  }
});

test('actual current readiness proceeds immediately inside its original HEAD lifetime', async t => {
  const h = fixture(t, { open: false }), l = lifecycle(h), at = h.clock.now();
  const r = await l.ready(); assert.equal(r.success, true); assert.equal(h.clock.now(), at); assert.equal(l.pokes, 0);
});

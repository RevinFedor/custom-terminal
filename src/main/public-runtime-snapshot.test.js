'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  __testPublicRuntimeSnapshots: runtime,
} = require('./web-server');

test.beforeEach(() => runtime.reset());

test('model/policy changes advance public status order; repaint alone does not, explicit null clears a handled dialog', () => {
  const base = { type: 'snapshot', sessionStatus: 'active', inputReady: false, lifecycleGeneration: 'G',
    liveSettings: { model: 'gpt-reserve', effort: 'max', ownerId: 'S', proofAt: 1, frameSeq: 8 },
    model: 'gpt-reserve', effort: 'max', runtimePolicy: { type: 'usage-exhaustion', phase: 'confirming', operationId: 'O' } };
  const initial = runtime.stamp('T', base);
  const repaint = runtime.stamp('T', { ...base, liveSettings: { ...base.liveSettings, frameSeq: 9 } });
  assert.equal(initial.runtimeRevision, repaint.runtimeRevision);
  const manual = runtime.stamp('T', { ...base, manualActionRequired: true, manualActionType: 'usage-exhaustion',
    runtimePolicy: { ...base.runtimePolicy, phase: 'manual' } });
  assert.ok(manual.runtimeRevision > repaint.runtimeRevision);
  const restored = runtime.stamp('T', { ...base, inputReady: true, model: 'gpt-6-astra',
    liveSettings: { ...base.liveSettings, model: 'gpt-6-astra', proofAt: 2 },
    runtimePolicy: null, manualActionRequired: false, manualActionType: null });
  assert.ok(restored.runtimeRevision > manual.runtimeRevision);
  assert.equal(restored.model, 'gpt-6-astra'); assert.equal(restored.runtimePolicy, null);
  const stop = runtime.stamp('T', { type: 'snapshot', sessionStatus: 'inactive', model: null, effort: null, liveSettings: null });
  assert.equal(stop.model, null); assert.equal(stop.liveSettings, null);
});

test('public runtime snapshots keep one monotonic revision across equivalent sources', () => {
  const first = runtime.stamp('tab-a', {
    type: 'snapshot',
    sessionStatus: 'starting',
    inputReady: true,
    turnBusy: false,
    sessionId: 'session-a',
    lifecycleGeneration: 'terminal-a:1',
  });
  const equivalent = runtime.stamp('tab-a', {
    type: 'snapshot',
    status: 'starting',
    inputReady: true,
    busy: false,
    sessionId: 'session-a',
    lifecycleGeneration: 'terminal-a:1',
  });
  const busy = runtime.stamp('tab-a', {
    type: 'busy',
    busy: true,
    lifecycleGeneration: 'terminal-a:1',
  });

  assert.equal(first.runtimeRevision, 1);
  assert.equal(first.sessionStatus, 'starting');
  assert.equal(first.inputReady, true);
  assert.equal(equivalent.runtimeRevision, 1);
  assert.equal(busy.runtimeRevision, 2);
  assert.equal(busy.sessionStatus, 'busy');
  assert.equal(busy.turnBusy, true);
  assert.equal(busy.sessionId, 'session-a');
});

test('done ignores non-lifecycle status labels and retains the exact generation', () => {
  runtime.stamp('tab-a', {
    type: 'busy',
    busy: true,
    sessionStatus: 'busy',
    inputReady: true,
    sessionId: 'session-a',
    lifecycleGeneration: 'terminal-a:7',
  });
  const done = runtime.stamp('tab-a', {
    type: 'done',
    status: 'completed',
    busy: false,
  });

  assert.equal(runtime.normalizeStatus('completed'), null);
  assert.equal(done.sessionStatus, 'active');
  assert.equal(done.turnBusy, false);
  assert.equal(done.inputReady, true);
  assert.equal(done.lifecycleGeneration, 'terminal-a:7');
  assert.equal(done.runtimeRevision, 2);
});

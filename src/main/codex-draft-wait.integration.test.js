'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const authority = require('./codex-draft-authority');
const { createCodexDraftRequestHarness, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const actual = name => {
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name);
  assert.ok(declaration, `actual ${name} exists`);
  return declaration.getText(ast);
};

function actualProbe(frame) {
  const state = {
    complete: true,
    generation: 'G',
    ...frame,
  };
  const context = vm.createContext({
    ...authority,
    getHeadlessTerminalMirror: () => state,
    console: { log() {}, warn() {} },
  });
  vm.runInContext(actual('getHeadlessCodexDraftState')
    + '\nglobalThis.probe = getHeadlessCodexDraftState;', context);
  return context.probe('T', 'probe-fixture');
}

const blockedFrames = [
  ['synchronized-output-open', {
    writeSeq: 12, flushedSeq: 12, redrawTrace: { synchronizedOutputOpen: true },
    pendingResizeWriteSeq: null,
  }],
  ['frame-not-flushed', {
    writeSeq: 13, flushedSeq: 12, redrawTrace: { synchronizedOutputOpen: false },
    pendingResizeWriteSeq: null,
  }],
  ['post-resize-frame-not-observed', {
    writeSeq: 14, flushedSeq: 14, redrawTrace: { synchronizedOutputOpen: false },
    pendingResizeWriteSeq: 14,
  }],
];

for (const [reason, frame] of blockedFrames) {
  test(`actual main probe rejects ${reason}`, () => {
    const result = actualProbe(frame);
    assert.equal(result.hasDraft, null);
    assert.equal(result.frameBlocker, reason);
    assert.deepEqual(JSON.parse(JSON.stringify(result.frameState)), {
      generation: 'G',
      writeSeq: frame.writeSeq,
      flushedSeq: frame.flushedSeq,
      synchronizedOutputOpen: frame.redrawTrace.synchronizedOutputOpen,
      pendingResizeWriteSeq: frame.pendingResizeWriteSeq,
    });
  });
}

function proofHarness(initial = { state: 'blocked', seq: 31 }) {
  let value = { ...initial };
  const mirror = { generation: 'G1', generationOrdinal: 1, complete: true,
    synchronizedFrameWaiters: new Set() };
  const harness = createCodexDraftRequestHarness({
    mirror,
    getDraft: () => value.state === 'blocked'
      ? { success: true, hasDraft: null, source: 'headless-main:frame-not-authoritative',
        frameBlocker: value.blocker || 'synchronized-output-open',
        frameState: { generation: mirror.generation, writeSeq: value.seq, flushedSeq: value.seq,
          synchronizedOutputOpen: true, pendingResizeWriteSeq: null } }
      : { success: true, hasDraft: value.state === 'draft',
        source: `headless-main:cursor:10:${value.state}`,
        preview: value.state === 'draft' ? 'current manual draft' : '',
        frameIdentity: { generation: mirror.generation, writeSeq: value.seq } },
  });
  return {
    ...harness,
    mirror,
    setValue(next) { value = { ...next }; },
    notify() { harness.notifyFrame(mirror); },
    wait() { return harness.waitForHeadlessDraftState(false, 1000, 'fixture-wrapper', { waitOnUnknownOnly: true }); },
    waitWithTargetedSemantics(options = {}) {
      return harness.waitForHeadlessDraftState(false, 1000, 'fixture-wrapper', options);
    },
  };
}

test('thin actual wait wrapper observes the same current mirror until a committed frame settles it', async () => {
  const h = proofHarness();
  const pending = h.wait();
  await drainMicrotasks();
  assert.equal(h.clock.setCalls.length, 1, 'one shared observation deadline is active');
  h.setValue({ state: 'empty', seq: 32 });
  h.notify();
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.frameIdentity.writeSeq, 32);
  assert.equal(result.observation.status, 'settled');
  assert.equal(h.clock.setCalls.length, 1, 'the thin wrapper adds no second timer loop');
});

test('actual wait wrapper keeps the newest blocker on deadline rather than treating expiry as empty', async () => {
  const h = proofHarness({ state: 'blocked', seq: 31 });
  const pending = h.wait();
  await drainMicrotasks();
  h.setValue({ state: 'blocked', seq: 67, blocker: 'synchronized-output-open' });
  h.clock.advanceToNext();
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, null);
  assert.equal(result.frameBlocker, 'synchronized-output-open');
  assert.equal(result.frameState.writeSeq, 67);
  assert.equal(result.proofOutcome, 'unknown');
  assert.equal(result.observation.status, 'expired');
});

test('unknownOnly preserves an already-proven draft as an immediate refusal', async () => {
  const h = proofHarness({ state: 'draft', seq: 40 });
  const result = await h.wait();
  assert.equal(result.hasDraft, true);
  assert.equal(result.preview, 'current manual draft');
  assert.equal(result.observation.status, 'settled');
  assert.equal(h.clock.timers.size, 0);
});

test('waitOnUnknownOnly=false keeps waiting for the requested false state after a true draft', async () => {
  const h = proofHarness({ state: 'draft', seq: 40 });
  const pending = h.waitWithTargetedSemantics({ waitOnUnknownOnly: false });
  await drainMicrotasks();
  assert.equal(h.clock.timers.size, 1);
  h.setValue({ state: 'empty', seq: 41 });
  h.notify();
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.frameIdentity.writeSeq, 41);
  assert.equal(result.observation.status, 'settled');
});

test('actual wait wrapper revokes a late frame when its captured mirror owner changes', async () => {
  const h = proofHarness();
  const pending = h.wait();
  await drainMicrotasks();
  h.setCurrentMirror({ generation: 'G2', generationOrdinal: 2, complete: true,
    synchronizedFrameWaiters: new Set() });
  h.notify();
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, null);
  assert.equal(result.observation.status, 'superseded');
  assert.equal(result.error, 'owner-changed');
});

test('one synchronous final read at the deadline can settle a newly committed current frame', async () => {
  const h = proofHarness();
  const pending = h.wait();
  await drainMicrotasks();
  h.setValue({ state: 'empty', seq: 32 });
  // Deliberately do not emit the frame notification; the one final read must
  // observe current data without polling or renewing the deadline.
  h.clock.advanceToNext();
  await drainMicrotasks();

  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.frameIdentity.writeSeq, 32);
  assert.equal(result.timedOut, false);
  assert.equal(result.observation.status, 'settled');
});

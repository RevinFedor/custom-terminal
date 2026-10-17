'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { CompactOperationRegistry } = require('./compact-operation-state');
const helpers = require('./codex-compact-slash-submit');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start); return source.slice(a, b);
};
const observer = between('function observeCodexCompactPostEnter(', 'async function submitCodexCompactSlashCommandWithProof(');
const cancel = between('function cancelCodexManualCompactPending(', 'function reconcileCodexManualCompactPendingOwner(');
const settlement = between('        if (compactPendingOperation\n          && result?.success !== true', '        if (compactPendingOperation && result &&');

// Actual Main observer/cancellation/result branch and registry. Clock, screen,
// runtime ownership and PTY are controlled ports; no Electron/provider input.
function fixture() {
  const publications = [], listeners = new Set(), term = {};
  const mirror = { synchronizedFrameWaiters: new Set() };
  const registry = new CompactOperationRegistry({ publish: value => {
    publications.push(value); for (const listener of [...listeners]) listener(value);
  } });
  const identity = { tabId: 'T', provider: 'codex', sessionId: 'S', generation: 'G',
    promptGeneration: 1, terminal: term, command: '/compact', operationId: 'codex:api:H',
    handoffId: 'H', sourceByteOffset: 100, causalBoundaryEventSequence: 7 };
  const pending = registry.armPending(identity);
  let timer, seq = 1, writes = 0;
  const context = vm.createContext({ ...helpers, compactOperations: registry,
    codexCompactTuiFeedbackBuffers: new Map(), console: { log() {}, warn() {} },
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
    getHeadlessTerminalMirror: () => mirror,
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, authoritativeFrameCommitted: true,
      synchronizedOutputOpen: false, writeSeq: seq, flushedSeq: seq }),
    getHeadlessCodexDraftState: () => ({ success: true, hasDraft: false, source: 'headless-main:empty' }),
    readCodexCompactSubmitOwnership: () => ({ identityCheck: { valid: true },
      active: registry.getActive('T', 'codex'),
      startConfirmed: registry.getActive('T', 'codex')?.causalStartConfirmed === true,
      pendingCurrent: registry.getPending('T', 'codex')?.operationId === identity.operationId }),
    subscribeCompactOperationChanges: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  vm.runInContext(observer + '\n' + cancel, context);
  const wait = context.observeCodexCompactPostEnter({ ...identity, term, identity: {}, afterWriteSeq: 1,
    allowOwnedDraft: true, timeoutMs: 5000, trigger() { writes++; seq = 2; } });
  return { registry, publications, identity, listeners, mirror, writes: () => writes,
    start: (patch = {}) => registry.confirmStart({ ...identity, sourceByteOffset: 100,
      eventSequence: 8, proof: 'task_started', ...patch }),
    cancel: reason => context.cancelCodexManualCompactPending('T', reason, identity.operationId),
    async timeoutResult() {
      timer(); const observation = await wait;
      const result = helpers.buildCodexCompactUnconfirmedResult({
        reason: observation.lastFrameProof.reason, enterCount: 1, frameProof: observation.lastFrameProof });
      this.settle(result); return result;
    },
    settle(result) {
      Object.assign(context, { result, compactPendingOperation: pending, tabId: 'T' });
      vm.runInContext(settlement, context);
    },
    complete() {
      registry.observeCodexEvidence({ ...identity, kind: 'compacted', rolloutOffset: 200, eventSequence: 9 });
      registry.observeCodexEvidence({ ...identity, kind: 'task_complete', rolloutOffset: 300, eventSequence: 10 });
      return registry.finalizeCodexTaskComplete(identity);
    },
  };
}

test('timeout after Enter retains the original compact for late causal start and exact completion', async () => {
  const h = fixture(); const result = await h.timeoutResult();
  assert.equal(result.deliveryUnconfirmed, true);
  assert.equal(h.publications.length, 0, 'timeout is not success, failure or a visible compact start');
  assert.equal(h.registry.getPending('T', 'codex')?.operationId, 'codex:api:H');
  assert.ok(h.start()); assert.equal(h.complete()?.outcome, 'completed');
  assert.equal(h.registry.snapshot('T', 'codex').settled[0].handoffId, 'H', 'remount uses the same exact handoff');
  assert.equal(h.writes(), 1, 'late proof must not write a second Enter');
  assert.equal(h.listeners.size, 0); assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
});

test('completion delivered before the late negative IPC result remains in the exact settled ledger', async () => {
  const h = fixture(); assert.ok(h.start()); assert.equal(h.complete()?.outcome, 'completed');
  await h.timeoutResult();
  assert.equal(h.registry.snapshot('T', 'codex').settled.length, 1);
  assert.equal(h.registry.snapshot('T', 'codex').settled[0].outcome, 'completed');
  assert.equal(h.writes(), 1);
});

for (const reason of ['manual-stop', 'manual-content-changed', 'owner-generation-changed']) {
  test('late compact start cannot revive cancelled owner: ' + reason, async () => {
    const h = fixture(); await h.timeoutResult(); h.cancel(reason);
    assert.equal(h.start(), null); assert.equal(h.complete(), null); assert.equal(h.publications.length, 0);
    assert.equal(h.writes(), 1);
  });
}

for (const patch of [{ sessionId: 'OTHER' }, { generation: 'OTHER' }, { terminal: {} },
  { eventSequence: 7 }, { sourceByteOffset: 99 }]) {
  test('retained intent rejects foreign/stale proof ' + JSON.stringify(patch), async () => {
    const h = fixture(); await h.timeoutResult(); assert.equal(h.start(patch), null);
    assert.equal(h.publications.length, 0); assert.equal(h.writes(), 1);
  });
}

test('known pre-Enter refusal still cancels the pending command', () => {
  const h = fixture(); h.settle({ success: false, submitted: false, error: 'before-enter' });
  assert.equal(h.registry.getPending('T', 'codex'), null);
});

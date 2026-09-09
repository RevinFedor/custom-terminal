'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bindCodexActionAuthorityGeneration,
  createCodexActionAuthority,
  transitionCodexActionAuthority,
} = require('./codex-action-authority');
const {
  waitForCodexRewindInitializedComposer,
  classifyCodexRewindPostEnterRecovery,
} = require('./codex-rewind-post-enter');

function readySnapshot(patch = {}) {
  return {
    success: true,
    authoritativeFrameCommitted: true,
    currentSnapshot: true,
    inspected: { ready: true, blockers: [], ignoredBlockers: [] },
    ...patch,
  };
}

function waitFixture(snapshot = null) {
  const listeners = new Set();
  const order = [];
  let current = true;
  let cancel;
  let reads = 0;
  let inspections = 0;
  const cancelPromise = new Promise(resolve => { cancel = resolve; });
  return {
    listeners,
    order,
    cancel,
    get reads() { return reads; },
    get inspections() { return inspections; },
    emit(nextSnapshot = snapshot) {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
    changeScope() {
      current = false;
      for (const listener of listeners) listener();
    },
    wait(patch = {}) {
      return waitForCodexRewindInitializedComposer({
        readSnapshot: () => { reads += 1; order.push('read'); return snapshot; },
        inspectReady: value => { inspections += 1; return value.inspected; },
        isCurrent: () => current,
        subscribe: listener => {
          order.push('subscribe');
          listeners.add(listener);
          return () => { order.push('unsubscribe'); listeners.delete(listener); };
        },
        cancelPromise,
        timeoutMs: 200,
        ...patch,
      });
    },
  };
}

function assertPending(result, error) {
  assert.equal(result.success, false);
  assert.equal(result.pending, true);
  assert.equal(result.rollbackMayHaveApplied, true);
  assert.equal(result.error, error);
}

test('initialized composer already committed is read only after subscribing', async () => {
  const f = waitFixture(readySnapshot());
  assert.deepEqual(await f.wait(), {
    success: true, pending: false, rollbackMayHaveApplied: true,
  });
  assert.deepEqual(f.order, ['subscribe', 'read', 'unsubscribe']);
  assert.equal(f.reads, 1);
  assert.equal(f.listeners.size, 0);
});

test('ready-after-subscribe is event driven and never reads on an elapsed retry delay', async () => {
  const f = waitFixture();
  const result = f.wait();
  await Promise.resolve();
  assert.equal(f.reads, 1);
  f.emit(readySnapshot({ inspected: { ready: false, reason: 'initializing' } }));
  await Promise.resolve();
  assert.equal(f.reads, 2);
  f.emit(readySnapshot());
  assert.equal((await result).success, true);
  assert.equal(f.reads, 3);
  assert.equal(f.listeners.size, 0);
});

for (const field of ['blockers', 'ignoredBlockers']) {
  test('MCP startup in ' + field + ' still owns the post-Enter composer', async () => {
    const f = waitFixture(readySnapshot({
      inspected: { ready: true, [field]: ['mcp-startup'] },
    }));
    let completed = false;
    const result = f.wait().then(value => { completed = true; return value; });
    await Promise.resolve();
    assert.equal(completed, false, 'ordinary send-ready does not authorize extraction');
    f.emit(readySnapshot());
    assert.equal((await result).success, true);
    assert.equal(f.listeners.size, 0);
  });
}

test('irrelevant historical ignored blockers do not change the current composer contract', async () => {
  const f = waitFixture(readySnapshot({
    inspected: { ready: true, ignoredBlockers: ['old-scrollback-warning'] },
  }));
  assert.equal((await f.wait()).success, true);
});

test('uncommitted, absent and explicitly stale frames cannot authorize extraction', async () => {
  const f = waitFixture();
  let completed = false;
  const result = f.wait().then(value => { completed = true; return value; });
  for (const frame of [
    null,
    readySnapshot({ success: false }),
    readySnapshot({ authoritativeFrameCommitted: false }),
    readySnapshot({ authoritativeFrameCommitted: undefined }),
    readySnapshot({ currentSnapshot: false }),
    readySnapshot({ fresh: false }),
    readySnapshot({ committed: false }),
  ]) {
    f.emit(frame);
    await Promise.resolve();
    assert.equal(completed, false);
  }
  assert.equal(f.inspections, 0, 'parser verdict cannot upgrade an uncommitted frame');
  f.emit(readySnapshot());
  assert.equal((await result).success, true);
});

test('an event delivered synchronously during subscription cannot leak its listener', async () => {
  const f = waitFixture(readySnapshot());
  let unsubscribed = 0;
  let subscribed = false;
  const result = await f.wait({
    subscribe(listener) { subscribed = true; listener(); return () => { unsubscribed += 1; }; },
    readSnapshot() { assert.equal(subscribed, true); return readySnapshot(); },
  });
  assert.equal(result.success, true);
  assert.equal(unsubscribed, 1);
});

test('already-cancelled operation cannot race an already-ready frame into success', async () => {
  const f = waitFixture(readySnapshot());
  f.cancel();
  assertPending(await f.wait(), 'codex_rewind_post_enter_cancelled');
  assert.equal(f.reads, 0);
  assert.equal(f.listeners.size, 0);
});

test('a ready event and cancellation in the same turn cannot authorize extraction', async () => {
  const f = waitFixture();
  const result = f.wait();
  await Promise.resolve();
  f.emit(readySnapshot());
  f.cancel();
  assertPending(await result, 'codex_rewind_post_enter_cancelled');
  assert.equal(f.listeners.size, 0);
});

test('cancellation during observation wins over the ready candidate', async () => {
  const f = waitFixture(readySnapshot());
  const result = f.wait({ inspectReady() { f.cancel(); return { ready: true }; } });
  assertPending(await result, 'codex_rewind_post_enter_cancelled');
  assert.equal(f.listeners.size, 0);
});

test('a newer uncommitted frame invalidates a ready candidate before completion', async () => {
  const f = waitFixture(readySnapshot());
  let completed = false;
  const result = f.wait().then(value => { completed = true; return value; });
  await Promise.resolve();
  f.emit(readySnapshot({ authoritativeFrameCommitted: false }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(completed, false);
  f.emit(readySnapshot());
  assert.equal((await result).success, true);
});

test('cancellation and scope replacement retain the written operation without a continuation write', async () => {
  for (const kind of ['cancel', 'scope']) {
    const f = waitFixture();
    let writes = 0;
    const result = f.wait().then(value => { if (value.success) writes += 1; return value; });
    await Promise.resolve();
    if (kind === 'cancel') f.cancel();
    else f.changeScope();
    assertPending(await result, kind === 'cancel'
      ? 'codex_rewind_post_enter_cancelled' : 'codex_rewind_post_enter_scope_changed');
    f.emit(readySnapshot());
    assert.equal(writes, 0);
    assert.equal(f.listeners.size, 0);
  }
});

test('scope is frozen at admission and rechecked after inspection before success', async () => {
  const scope = { runSeq: 2, terminalToken: {} };
  const f = waitFixture(readySnapshot());
  let inspected = false;
  const result = f.wait({
    scope,
    isCurrent(expected) {
      assert.equal(expected.runSeq, 2);
      assert.equal(expected.terminalToken, scope.terminalToken);
      return !inspected;
    },
    inspectReady() { inspected = true; return { ready: true }; },
  });
  scope.runSeq = 3;
  assertPending(await result, 'codex_rewind_post_enter_scope_changed');
});

test('deadline is only a failure bound and preserves the post-Enter recovery obligation', async () => {
  const f = waitFixture(readySnapshot({
    inspected: { ready: true, ignoredBlockers: ['mcp-startup'] },
  }));
  const result = await f.wait({ timeoutMs: 5 });
  assertPending(result, 'codex_rewind_initialized_composer_timeout');
  assert.equal(result.reason, 'mcp-startup');
  assert.equal(f.reads, 1);
  assert.equal(f.listeners.size, 0);
});

test('observation failures never reject as a retry-safe unwritten operation', async () => {
  for (const dependency of ['subscribe', 'readSnapshot', 'inspectReady', 'isCurrent']) {
    const f = waitFixture(readySnapshot());
    const result = await f.wait({ [dependency]: () => { throw new Error(dependency + '-failed'); } });
    assertPending(result, 'codex_rewind_initialized_composer_observation_failed');
    assert.equal(result.reason, dependency + '-failed');
    assert.equal(f.listeners.size, 0);
  }
});

function recoveryFixture() {
  const terminalToken = { _notedGrabTerminalId: 'physical-terminal-a' };
  const identity = {
    terminalToken,
    projectId: 'project-a', tabId: 'tab-a',
    lifecycleGeneration: 'terminal-epoch:2', runSeq: 2,
    launchId: 'codex-original-launch',
    sourceSessionId: 'source-a', persistedSessionId: 'source-a',
    inputRevision: 0, operationId: 'operation-a', requestId: 'request-a',
  };
  const target = {
    targetUuid: 'codex-user-source-a-44', targetPhysicalSessionId: 'source-a',
    targetSourceLine: 44, targetTextHash: 'a'.repeat(64),
  };
  const created = createCodexActionAuthority({
    authorityId: 'native-rewind-authority-a', profile: 'native-rewind',
    identity, target, now: 1000,
  });
  assert.equal(created.success, true);
  const authority = created.authority;
  assert.equal(transitionCodexActionAuthority(authority, 'armed', { now: 1001 }).success, true);
  assert.equal(bindCodexActionAuthorityGeneration(authority, 'action-generation-a').success, true);
  assert.equal(transitionCodexActionAuthority(authority, 'consumed', { now: 1002 }).success, true);
  const journal = {
    version: 2, phase: 'confirm-enter-boundary',
    projectId: identity.projectId, originProjectId: identity.projectId, tabId: identity.tabId,
    operationId: identity.operationId, requestId: identity.requestId,
    actionGeneration: authority.actionGeneration, actionStartedAtMs: 1002,
    sourceSessionId: identity.sourceSessionId, expectedBindingSessionId: identity.persistedSessionId,
    sourceLifecycleGeneration: identity.lifecycleGeneration, sourceRunSeq: identity.runSeq,
    ...target, rollbackTurns: 2,
    targetUserOrdinal: 0, targetDerivation: null,
  };
  const current = {
    ...identity, actionGeneration: authority.actionGeneration,
    isRunning: true, stopping: false, busy: false,
    sourceFilePath: '/test/source-a.jsonl', mirrorGeneration: 'mirror-a',
  };
  const record = {
    operationId: identity.operationId, requestId: identity.requestId,
    actionGeneration: authority.actionGeneration, expectedInputRevision: identity.inputRevision,
    originalLaunchId: identity.launchId, terminalToken,
    mirrorGeneration: current.mirrorGeneration, sourceFilePath: current.sourceFilePath,
  };
  return { journal, authority, current, record };
}

test('consumed and committed exact old operations may continue without granting another Enter', () => {
  for (const committed of [false, true]) {
    const f = recoveryFixture();
    if (committed) transitionCodexActionAuthority(f.authority, 'committed', { now: 1003 });
    const before = JSON.stringify(f);
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, true);
    assert.equal(JSON.stringify(f), before, 'classifier never mutates authority/journal/current/record');
    assert.equal(classifyCodexRewindPostEnterRecovery({ ...f, record: null }).accepted, true);
  }
});

test('only the exact legacy codex_input_not_ready revocation is recoverable at its original input', () => {
  const f = recoveryFixture();
  transitionCodexActionAuthority(f.authority, 'revoked', { reason: 'codex_input_not_ready', now: 1003 });
  const before = JSON.stringify(f.authority);
  assert.deepEqual(classifyCodexRewindPostEnterRecovery({ ...f, record: null }), {
    accepted: true, reason: 'legacy-post-enter-recovery',
  });
  assert.equal(JSON.stringify(f.authority), before);
  assert.equal(transitionCodexActionAuthority(f.authority, 'armed').error, 'action-authority-terminal');
  f.current.inputRevision = 1;
  assert.equal(classifyCodexRewindPostEnterRecovery({ ...f, record: null }).reason, 'input-revision-changed');
  f.record.expectedInputRevision = 1;
  assert.equal(classifyCodexRewindPostEnterRecovery(f).reason, 'input-revision-changed');
});

test('Stop, manual input, cancellation and an unconsumed revocation cannot be revived', () => {
  for (const reason of ['manual-input', 'terminal-kill', 'stop-start', 'rewind_cancelled', 'codex_input_not_ready-extra']) {
    const f = recoveryFixture();
    transitionCodexActionAuthority(f.authority, 'revoked', { reason, now: 1003 });
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false, reason);
  }
  const f = recoveryFixture();
  transitionCodexActionAuthority(f.authority, 'revoked', { reason: 'codex_input_not_ready', now: 1003 });
  f.authority.consumedAt = null;
  assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false);
  for (const phase of ['requested', 'waiting', 'armed']) {
    f.authority.phase = phase;
    assert.equal(classifyCodexRewindPostEnterRecovery(f).reason, 'rewind-authority-not-consumed');
  }
});

test('all current physical and logical identity fields stay exact even with an identical prompt prefix', () => {
  for (const patch of [
    { terminalToken: {} }, { projectId: 'project-b' }, { tabId: 'tab-b' },
    { lifecycleGeneration: 'terminal-epoch:3' }, { runSeq: 3 },
    { launchId: 'codex-new-launch' }, { actionGeneration: 'action-generation-b' },
    { sourceSessionId: 'source-b' }, { persistedSessionId: 'source-b' },
    { operationId: 'operation-b' }, { requestId: 'request-b' }, { inputRevision: 1 },
    { isRunning: false }, { stopping: true }, { busy: true },
    { stopping: undefined }, { busy: undefined },
    { mirrorGeneration: 'mirror-b' }, { sourceFilePath: '/test/other.jsonl' },
  ]) {
    const f = recoveryFixture();
    f.current = { ...f.current, ...patch, visibleText: 'The same beginning of a long prompt…' };
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false, JSON.stringify(patch));
  }
});

test('journal and target cannot borrow another action with matching text/hash', () => {
  for (const patch of [
    { operationId: 'operation-b' }, { requestId: 'request-b' },
    { actionGeneration: 'action-b' }, { projectId: 'project-b' }, { originProjectId: 'project-b' },
    { tabId: 'tab-b' }, { sourceSessionId: 'source-b' }, { expectedBindingSessionId: 'source-b' },
    { sourceLifecycleGeneration: 'terminal-epoch:3' }, { sourceRunSeq: 3 },
    { targetUuid: 'another-same-text-user' }, { targetPhysicalSessionId: 'source-b' },
    { targetSourceLine: 45 }, { targetTextHash: 'b'.repeat(64) },
    { rollbackTurns: 0 }, { targetTextHash: 'prefix-only' },
    { invalid: true }, { phase: 'stable-source-submit-armed' }, { phase: 'stable-source-submit-written' },
  ]) {
    const f = recoveryFixture();
    Object.assign(f.journal, patch);
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false, JSON.stringify(patch));
  }
});

test('legacy four-field target does not inherit a manufactured optional ordinal from its journal', () => {
  const f = recoveryFixture();
  assert.equal(Object.hasOwn(f.authority.target, 'targetUserOrdinal'), false);
  assert.equal(f.journal.targetUserOrdinal, 0);
  assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, true);
  f.authority.target.targetUserOrdinal = null;
  assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, true);
  f.authority.target.targetUserOrdinal = 0;
  f.journal.targetUserOrdinal = 1;
  assert.equal(classifyCodexRewindPostEnterRecovery(f).reason, 'rewind-target-changed:targetUserOrdinal');
  f.journal.targetUserOrdinal = 0;
  f.authority.target.targetDerivation = 'navigation-only';
  f.journal.targetDerivation = 'navigation-only';
  assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, true);
  f.journal.targetDerivation = 'navigation-and-screen';
  assert.equal(classifyCodexRewindPostEnterRecovery(f).reason, 'rewind-target-changed:targetDerivation');
});

function legacyOwnedCaptureFixture() {
  const f = recoveryFixture();
  transitionCodexActionAuthority(f.authority, 'revoked', { reason: 'codex_input_not_ready', now: 1003 });
  // Main stamps this metadata only after accepting the original input scope.
  assert.equal(classifyCodexRewindPostEnterRecovery({ ...f, record: null }).accepted, true);
  f.record.authorizedLegacyRecoveryAt = 1004;
  f.record.authorizedLegacyRecoveryInputRevision = f.authority.identity.inputRevision;
  f.record.captureOperation = {
    protocol: 2, operationId: 'capture-operation-a',
    terminalId: f.current.terminalToken._notedGrabTerminalId,
    tabId: f.current.tabId, agent: 'codex', mode: 'grab',
    generation: {
      terminalIdentityStable: true,
      terminalRunSeq: f.current.runSeq,
      terminalLifecycleGeneration: f.current.lifecycleGeneration,
      inputRevision: f.current.inputRevision,
      mirrorGeneration: f.current.mirrorGeneration,
    },
  };
  f.record.expectedInputRevision += 1;
  f.current.inputRevision += 1;
  return f;
}

test('legacy recovery accounts for its own protocol-v2 Grab revision without reviving the old authority', () => {
  const f = legacyOwnedCaptureFixture();
  const before = JSON.stringify(f.authority);
  assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, true);
  assert.equal(f.authority.phase, 'revoked');
  assert.equal(JSON.stringify(f.authority), before);
  assert.equal(transitionCodexActionAuthority(f.authority, 'consumed').error, 'action-authority-terminal');
});

test('legacy capture-shaped objects cannot launder wrong mode, identity, generation or a second revision', () => {
  for (const patch of [
    { protocol: 1 }, { operationId: '' }, { terminalId: 'other-terminal' },
    { mode: 'copy' }, { agent: 'claude' }, { tabId: 'other-tab' },
  ]) {
    const f = legacyOwnedCaptureFixture();
    Object.assign(f.record.captureOperation, patch);
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false, JSON.stringify(patch));
  }
  for (const patch of [
    { terminalIdentityStable: false }, { terminalRunSeq: 3 },
    { terminalLifecycleGeneration: 'other:2' }, { inputRevision: 1 },
    { mirrorGeneration: 'other-mirror' },
  ]) {
    const f = legacyOwnedCaptureFixture();
    Object.assign(f.record.captureOperation.generation, patch);
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false, JSON.stringify(patch));
  }
  for (const patch of [
    { authorizedLegacyRecoveryAt: undefined }, { authorizedLegacyRecoveryAt: 0 },
    { authorizedLegacyRecoveryInputRevision: 1 }, { captureOperation: null },
  ]) {
    const f = legacyOwnedCaptureFixture();
    Object.assign(f.record, patch);
    assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, false, JSON.stringify(patch));
  }
  const f = legacyOwnedCaptureFixture();
  f.record.expectedInputRevision += 1;
  f.current.inputRevision += 1;
  assert.equal(classifyCodexRewindPostEnterRecovery(f).reason, 'input-revision-changed');
});

test('owned extraction revision requires the same main continuation record', () => {
  const f = recoveryFixture();
  f.current.inputRevision = 1;
  f.record.expectedInputRevision = 1;
  assert.equal(classifyCodexRewindPostEnterRecovery(f).accepted, true);
  assert.equal(classifyCodexRewindPostEnterRecovery({ ...f, record: null }).reason, 'input-revision-changed');
  for (const patch of [
    { operationId: 'other' }, { requestId: 'other' }, { actionGeneration: 'other' },
    { expectedInputRevision: undefined }, { expectedInputRevision: -1 },
    { originalLaunchId: 'other' }, { terminalToken: {} }, { mirrorGeneration: 'other' },
    { sourceFilePath: '/test/other.jsonl' },
  ]) {
    assert.equal(classifyCodexRewindPostEnterRecovery({ ...f, record: { ...f.record, ...patch } }).accepted,
      false, JSON.stringify(patch));
  }
});

test('record scope fields are additive while its operation and revision proof are mandatory', () => {
  const f = recoveryFixture();
  const { operationId, requestId, actionGeneration, expectedInputRevision } = f.record;
  assert.equal(classifyCodexRewindPostEnterRecovery({
    ...f, record: { operationId, requestId, actionGeneration, expectedInputRevision },
  }).accepted, true);
  assert.equal(classifyCodexRewindPostEnterRecovery({ ...f, record: {} }).accepted, false);
});

test('restored draft is a recoverable phase, not proof of a committed rollback or next submit', () => {
  for (const phase of ['confirm-enter-boundary', 'branch-draft-restored', 'rollback-applied', 'stable-source-settled']) {
    const f = recoveryFixture();
    f.journal.phase = phase;
    const result = classifyCodexRewindPostEnterRecovery(f);
    assert.equal(result.accepted, true, phase);
    assert.equal(result.bindingCommitted, undefined);
    assert.equal(result.writeEnter, undefined);
    assert.equal(result.historyDraftText, undefined);
  }
});

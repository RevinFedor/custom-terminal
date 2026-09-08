'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyCodexProviderPreviewRecord,
  codexProviderCausalTurnVerdict,
  codexProviderPreviewOwnerVerdict,
  codexProviderRequestAdmissionVerdict,
  codexProviderPreviewRolloutVerdict,
  codexProviderTerminalOutcomeVerdict,
} = require('./codex-provider-preview');

const terminalToken = {};
const owner = {
  sourceId: 'source-current',
  launchId: 'launch-current',
  terminalToken,
  runSeq: 7,
  lifecycleGeneration: 'lifecycle-current',
};
const current = {
  sourceId: owner.sourceId,
  launchId: owner.launchId,
  terminalToken,
  runSeq: 7,
  lifecycleGeneration: 'lifecycle-current',
};

test('only an exact canonical terminal outcome closes the current provider turn', () => {
  const liveOwner = { ...owner, turnId: 'turn-B', turnActive: true };
  const watcher = { processGeneration: owner.lifecycleGeneration, sourceObservationLaunchId: owner.launchId };
  const args = { owner: liveOwner, current, watcher, currentWatcher: watcher,
    outcome: { event: 'task_complete', busy: false }, turnId: 'turn-B' };
  assert.equal(codexProviderTerminalOutcomeVerdict(args).allowed, true);
  assert.equal(codexProviderTerminalOutcomeVerdict({ ...args, outcome: { event: 'turn_aborted', busy: false } }).allowed, true);
  for (const patch of [
    { turnId: 'turn-A' }, { turnId: null },
    { currentWatcher: {} },
    { owner: { ...liveOwner, turnActive: false } },
    { current: { ...current, terminalToken: {} } },
    { current: { ...current, runSeq: 8 } },
    { current: { ...current, lifecycleGeneration: 'old' } },
    { current: { ...current, launchId: 'next' } },
    { watcher: { ...watcher, processGeneration: 'old' } },
    { outcome: { event: 'turn_completed', busy: false } },
    { outcome: { event: 'task_started', busy: true } },
    { outcome: { reason: 'generic-idle', busy: false } },
  ]) assert.equal(codexProviderTerminalOutcomeVerdict({ ...args, ...patch }).allowed, false, JSON.stringify(patch));
});

test('provider owner rejects stale launch and stale run', () => {
  assert.equal(codexProviderPreviewOwnerVerdict(owner, current, owner.sourceId).allowed, true);
  assert.equal(codexProviderPreviewOwnerVerdict(owner, {
    ...current,
    launchId: 'launch-next',
  }, owner.sourceId).reason, 'provider-launch-replaced');
  assert.equal(codexProviderPreviewOwnerVerdict(owner, {
    ...current,
    runSeq: 8,
  }, owner.sourceId).reason, 'provider-run-replaced');
  assert.equal(codexProviderPreviewOwnerVerdict(owner, current, 'source-old').reason,
    'provider-source-replaced');
});

test('provider request needs a causal turn and cannot contradict the adopted writer', () => {
  assert.deepEqual(codexProviderRequestAdmissionVerdict({
    hasCausalTurn: false,
    writerSessionId: 'writer-session',
    requestSessionId: 'recap-session',
  }), {
    allowed: false,
    reason: 'provider-request-without-causal-turn',
  });
  assert.deepEqual(codexProviderRequestAdmissionVerdict({
    hasCausalTurn: true,
    writerSessionId: 'writer-session',
    requestSessionId: 'recap-session',
  }), {
    allowed: false,
    reason: 'provider-request-writer-session-mismatch',
  });
  assert.equal(codexProviderRequestAdmissionVerdict({
    hasCausalTurn: true,
    writerSessionId: 'writer-session',
    requestSessionId: 'writer-session',
  }).allowed, true);
  assert.equal(codexProviderRequestAdmissionVerdict({
    hasCausalTurn: true,
    requestSessionId: 'new-session-before-writer-adoption',
  }).allowed, true, 'cold/fork launch keeps streaming while writer identity is still pending');
});

test('unstarted pending compact is not a provider turn', () => {
  assert.deepEqual(codexProviderCausalTurnVerdict({
    pendingCompact: true,
  }), {
    active: false,
    reason: 'compact-pending-without-task-started',
  });
  assert.deepEqual(codexProviderCausalTurnVerdict({
    pendingCompact: true,
    rolloutTurnBusy: true,
  }), {
    active: true,
    reason: 'rollout-turn-active',
  });
  assert.equal(codexProviderCausalTurnVerdict({
    promptInFlightSubmitted: true,
  }).active, true);
  assert.equal(codexProviderCausalTurnVerdict({
    startupBeforeInputReady: true,
  }).active, true);
});

test('rollout owner is independent from provider transport session', () => {
  const verdict = codexProviderPreviewRolloutVerdict({
    owner,
    current,
    watcher: {
      tabId: 'tab-a',
      sessionId: 'rollout-b6de8a1a',
      filePath: '/tmp/rollout-b6de8a1a.jsonl',
      processGeneration: owner.lifecycleGeneration,
      processGenerationBoundaryOffset: 100,
      sourceObservationLaunchId: owner.launchId,
      publicTurnStateSuppressed: true,
    },
    detail: {
      tabId: 'tab-a',
      sessionId: 'rollout-b6de8a1a',
      filePath: '/tmp/rollout-b6de8a1a.jsonl',
      recordByteOffset: 120,
      providerSessionId: 'transport-f9edf20d',
    },
  });
  assert.deepEqual(verdict, { allowed: true, reason: 'exact-rollout-run' });
});

test('rollout boundary rejects an older lifecycle and pre-run record', () => {
  const base = {
    owner,
    current,
    watcher: {
      tabId: 'tab-a',
      sessionId: 'rollout-a',
      filePath: '/tmp/a.jsonl',
      processGeneration: owner.lifecycleGeneration,
      processGenerationBoundaryOffset: 100,
      sourceObservationLaunchId: owner.launchId,
    },
    detail: {
      tabId: 'tab-a',
      sessionId: 'rollout-a',
      filePath: '/tmp/a.jsonl',
      recordByteOffset: 120,
    },
  };
  assert.equal(codexProviderPreviewRolloutVerdict({
    ...base,
    watcher: { ...base.watcher, processGeneration: 'old' },
  }).reason, 'rollout-lifecycle-mismatch');
  assert.equal(codexProviderPreviewRolloutVerdict({
    ...base,
    detail: { ...base.detail, recordByteOffset: 99 },
  }).reason, 'rollout-before-run-boundary');
});

test('exact assistant item and following tool boundary keep physical rollout identity', () => {
  const assistant = classifyCodexProviderPreviewRecord({
    sessionId: 'rollout-owner',
    recordByteOffset: 420,
    recordEndByteOffset: 520,
    record: {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'item-exact',
        content: [{ type: 'output_text', text: 'saved answer' }],
      },
    },
  });
  assert.equal(assistant.kind, 'assistant');
  assert.equal(assistant.itemId, 'item-exact');
  assert.equal(assistant.identity, 'codex-assistant-source-rollout-owner-420');

  const tool = classifyCodexProviderPreviewRecord({
    sessionId: 'rollout-owner',
    recordByteOffset: 520,
    recordEndByteOffset: 600,
    record: {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        id: 'call-1',
        name: 'apply_patch',
        input: { patch: '*** Begin Patch' },
      },
    },
  });
  assert.equal(tool.kind, 'boundary');
  assert.equal(tool.boundaryKind, 'tool-use');
  assert.equal(tool.phase, 'tool');
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyCodexProviderPreviewRecord,
  codexProviderPreviewOwnerVerdict,
  codexProviderPreviewRolloutVerdict,
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

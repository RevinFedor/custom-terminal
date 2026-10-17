import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentSendFlow } from './agentSendFlow.mjs';

test('provider-neutral flow exposes the complete product order', async () => {
  const calls = [];
  const result = await runAgentSendFlow({
    prepareContext: async () => { calls.push('context'); return { intent: 1 }; },
    ensureReady: async () => { calls.push('ready'); return { status: 'active' }; },
    finishAfterReady: async () => ({ complete: false }),
    proveComposer: async () => { calls.push('composer'); return { complete: false, proof: 1 }; },
    runProviderOperation: async () => { calls.push('provider'); return { success: true, submitted: true }; },
  });
  assert.deepEqual(calls, ['context', 'ready', 'composer', 'provider']);
  assert.equal(result.sendFlowPhase, 'returned');
  assert.deepEqual(result.sendFlowTrace.map((event) => event.phase), [
    'created',
    'preparing-context',
    'ensuring-ready',
    'proving-composer',
    'provider-operation',
    'returned',
  ]);
});

test('a composer refusal never reaches provider transport', async () => {
  let submitted = false;
  const result = await runAgentSendFlow({
    prepareContext: async () => ({}),
    ensureReady: async () => ({ status: 'active' }),
    proveComposer: async () => ({
      complete: true,
      result: { success: false, submitted: false, code: 'terminal_draft_conflict' },
    }),
    runProviderOperation: async () => { submitted = true; return {}; },
  });
  assert.equal(submitted, false);
  assert.equal(result.code, 'terminal_draft_conflict');
  assert.equal(result.sendFlowTrace.some((event) => event.phase === 'provider-operation'), false);
});

test('history-only context may finish without composer or model turn', async () => {
  const result = await runAgentSendFlow({
    prepareContext: async () => ({
      complete: true,
      result: { success: true, historyOnly: true, modelTurnStarted: false },
    }),
    ensureReady: async () => assert.fail('ready must not run'),
    proveComposer: async () => assert.fail('composer must not run'),
    runProviderOperation: async () => assert.fail('provider operation must not run'),
  });
  assert.equal(result.historyOnly, true);
  assert.deepEqual(result.sendFlowTrace.map((event) => event.phase), [
    'created', 'preparing-context', 'returned',
  ]);
});

test('renderer flow completion is not promoted to delivery success', async () => {
  const result = await runAgentSendFlow({
    prepareContext: async () => ({}),
    ensureReady: async () => ({ status: 'active' }),
    proveComposer: async () => ({ complete: false }),
    runProviderOperation: async () => ({ success: null, submitted: true, status: 'audit-pending' }),
  });
  assert.equal(result.success, null);
  assert.equal(result.status, 'audit-pending');
  assert.equal(result.sendFlowPhase, 'returned');
});

test('a readiness rejection proves this invocation never reached paste or Enter', async () => {
  const error = Object.assign(new Error('Codex did not become ready for send'), {
    code: 'agent_input_readiness_timeout',
  });
  await assert.rejects(runAgentSendFlow({
    prepareContext: async () => ({}),
    ensureReady: async () => { throw error; },
    proveComposer: async () => assert.fail('composer must not run'),
    runProviderOperation: async () => assert.fail('provider must not run'),
  }), (received) => {
    assert.equal(received, error);
    assert.equal(received.sendReceipt.submitted, false);
    assert.equal(received.sendReceipt.pasteWritten, false);
    assert.equal(received.sendReceipt.enterWritten, false);
    assert.equal(received.sendReceipt.status, 'not-submitted');
    assert.equal(received.sendReceipt.code, 'agent_input_readiness_timeout');
    return true;
  });
});

test('a composer error retains a withdrawn draft in its explicit refusal', async () => {
  const draftTransfer = { id: 'exact-capture', text: 'raw draft\n', imagePaths: ['/image.png'] };
  await assert.rejects(runAgentSendFlow({
    prepareContext: async () => ({}),
    ensureReady: async () => ({ status: 'active' }),
    proveComposer: async () => { throw Object.assign(new Error('cancelled'), { draftTransfer }); },
    runProviderOperation: async () => assert.fail('provider must not run'),
  }), (received) => {
    assert.equal(received.sendReceipt.draftTransfer, draftTransfer);
    assert.equal(received.sendReceipt.submitted, false);
    return true;
  });
});

test('a provider error is not proof that Enter was never written', async () => {
  await assert.rejects(runAgentSendFlow({
    prepareContext: async () => ({}),
    ensureReady: async () => ({ status: 'active' }),
    proveComposer: async () => ({ complete: false }),
    runProviderOperation: async () => { throw new Error('reply lost after possible Enter'); },
  }), (received) => {
    assert.equal(received.sendFlowPhase, 'provider-operation');
    assert.equal(received.sendReceipt, undefined);
    return true;
  });
});

test('preflight attestation pins the original issued scope before the first await', async () => {
  const scope = { version: 1, id: 'original', operationKey: 'O', attemptId: 'A', tabId: 'T', provider: 'codex' };
  await assert.rejects(runAgentSendFlow({ preflightScope: scope,
    prepareContext: async () => ({}),
    ensureReady: async () => {
      scope.id = 'changed-after-admission';
      throw Object.assign(new Error('no launch'), { protocolVersion: 1, accepted: false,
        launchWritten: false, launchStage: 'no-launch', launchAttempt: 1,
        launchIntent: { tabId: 'T', toolType: 'codex', intentId: 'launch:test:1', token: 1 },
        sendReceipt: { operationKey: 'O', attemptId: 'A', submitted: null, deliveryUnknown: true } });
    },
    proveComposer: () => assert.fail('no composer'), runProviderOperation: () => assert.fail('no provider'),
  }), error => {
    assert.equal(error.sendReceipt.preflightRefusal.scope.id, 'original');
    return true;
  });
});

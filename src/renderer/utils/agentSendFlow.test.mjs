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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isStandaloneAgentLocalCommand,
  normalizeAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from './agentLocalCommand.mjs';

test('History can restore a never-entered retained control without lying about its physical paste', () => {
  const result = { localSlashCommand: true, submitted: false, slashInserted: true, pasteWritten: true, enterWritten: false,
    slashRollback: { serviceInputPending: true } };
  assert.equal(projectAgentLocalCommandSendResult({ candidate: true, result }).restoreDraftSafe, true);
  assert.equal(result.pasteWritten, true);
  for (const changed of [{ ...result, localSlashCommand: false }, { ...result, enterWritten: undefined },
    { ...result, submitted: true }, { ...result, slashRollback: {} }]) {
    assert.notEqual(projectAgentLocalCommandSendResult({ candidate: true, result: changed }).restoreDraftSafe, true);
  }
});

test('local command requires one unstructured line', () => {
  assert.equal(normalizeAgentLocalCommand('  /status  '), '/status');
  assert.equal(normalizeAgentLocalCommand('/compact now'), '/compact now');
  assert.equal(normalizeAgentLocalCommand('/status\nnext'), null);
  assert.equal(normalizeAgentLocalCommand('//not-command'), null);
  assert.equal(isStandaloneAgentLocalCommand({ prompt: '/status' }), true);
  assert.equal(isStandaloneAgentLocalCommand({ prompt: '/status', imageCount: 1 }), false);
  assert.equal(isStandaloneAgentLocalCommand({ prompt: '/status', chipCount: 1 }), false);
});

test('local command result settles without conversation audit identity', () => {
  assert.deepEqual(projectAgentLocalCommandSendResult({
    candidate: true,
    result: { success: true, submitted: true, localSlashCommand: true },
  }), {
    handled: true,
    transferred: true,
    requiresAuditIdentity: false,
    queueStatus: 'sent',
    deliveryUnconfirmed: false,
    reason: 'agent-local-command-submitted',
  });
  assert.equal(projectAgentLocalCommandSendResult({
    candidate: true,
    result: { success: true, submitted: true },
  }).handled, false);
});

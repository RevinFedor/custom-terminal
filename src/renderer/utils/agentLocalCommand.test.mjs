import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isStandaloneAgentLocalCommand,
  normalizeAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from './agentLocalCommand.mjs';

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

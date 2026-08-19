import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isStandaloneCodexLocalSlashCommand,
  normalizeCodexLocalSlashCommand,
  projectCodexLocalSlashSendResult,
} from './codexLocalSlashCommand.mjs';

test('only a standalone one-line Codex slash command uses the local action contract', () => {
  assert.equal(normalizeCodexLocalSlashCommand('  /compact  '), '/compact');
  assert.equal(normalizeCodexLocalSlashCommand('/status verbose'), '/status verbose');
  assert.equal(normalizeCodexLocalSlashCommand('/status\nexplain this'), null);
  assert.equal(normalizeCodexLocalSlashCommand('ordinary prompt'), null);
  assert.equal(isStandaloneCodexLocalSlashCommand({ prompt: '/status' }), true);
  assert.equal(isStandaloneCodexLocalSlashCommand({
    prompt: '/status',
    imageCount: 1,
  }), false);
  assert.equal(isStandaloneCodexLocalSlashCommand({
    prompt: '/status',
    chipCount: 1,
  }), false);
});

test('exact TUI input-frame plus Enter settles local slash as sent without user_message identity', () => {
  assert.deepEqual(projectCodexLocalSlashSendResult({
    candidate: true,
    result: {
      localSlashCommand: true,
      success: true,
      submitted: true,
      localCommandProof: 'codex-tui-input-frame-and-enter',
    },
  }), {
    handled: true,
    transferred: true,
    requiresAuditIdentity: false,
    queueStatus: 'sent',
    deliveryUnconfirmed: false,
    reason: 'codex-local-slash-submitted',
  });
});

test('a post-Enter slash failure remains unknown, while an unrouted command keeps normal audit flow', () => {
  assert.equal(projectCodexLocalSlashSendResult({
    candidate: true,
    result: { localSlashCommand: true, success: false, submitted: true },
  }).queueStatus, 'delivery-unknown');
  assert.deepEqual(projectCodexLocalSlashSendResult({
    candidate: true,
    result: { success: true, submitted: true },
  }), { handled: false });
  assert.deepEqual(projectCodexLocalSlashSendResult({
    candidate: true,
    result: { localSlashCommand: true, success: false, submitted: false },
  }), {
    handled: true,
    transferred: false,
    requiresAuditIdentity: false,
    queueStatus: null,
    deliveryUnconfirmed: false,
  });
});

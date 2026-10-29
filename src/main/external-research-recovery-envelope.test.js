'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { recoveryEnvelope, recoveryInstructions } = require('./external-research-recovery-envelope');
const { buildOrchestrationCompletionContent } = require('./orchestration-completion-content');
const run = { runId: 'own', runKind: 'external-research', status: 'failed', externalResearchJobId: 'noted_own',
  externalResearchBrowserInstanceId: 'profile', error: 'provider_conversation_load_error', externalResearchStage: 'configuring' };
function snapshot() { return { id: 'noted_own', browserInstanceId: 'profile', tabId: 42, execution: { version: 1,
  purpose: 'author', controlEpoch: 'epoch', controlRevision: 7,
  send: { state: 'not_attempted', attemptId: null, startedAt: null, acceptedAt: null },
  failure: { noSend: true, code: 'provider_conversation_load_error' },
  beforeSendAccount: { userId: 'user', accountId: 'account', binding: 'before_send' },
  reader: { readerId: 'reader', generation: 1, document: { tabId: 42, documentId: 'document', generation: 1 } },
  turn: { quality: 'unbound', conversationId: 'same' } } }; }
test('typed no-Send evidence and exact recovery locators survive the actual failure callback producer', () => {
  const envelope = recoveryEnvelope(run, snapshot());
  assert.equal(envelope.send.noSend, true); assert.equal(envelope.remoteOutcome, 'not_started');
  assert.equal(envelope.reader.document.documentId, 'document'); assert.equal(envelope.account.accountId, 'account');
  const content = buildOrchestrationCompletionContent({ ...run, externalResearchRecoveryEnvelope: envelope }, { success: false, error: run.error });
  assert.match(content.prompt, /external-research-recovery/);
  assert.match(content.prompt, /"noSend":true/); assert.match(content.prompt, /"controlEpoch":"epoch"/);
  assert.match(content.prompt, /не жди обязательного разрешения владельца SC/);
  assert.doesNotMatch(content.prompt, /send_message и жди|Не обходи сбой.*ручным Send/);
});
test('timeout, incomplete timestamps and observer-only purpose never invent no-Send proof', () => {
  assert.equal(recoveryEnvelope(run).send.noSend, null);
  const incomplete = snapshot(); delete incomplete.execution.send.startedAt;
  assert.equal(recoveryEnvelope(run, incomplete).send.noSend, null);
  const observer = snapshot(); observer.execution.purpose = 'observe';
  assert.equal(recoveryEnvelope(run, observer).send.noSend, null);
  const accepted = snapshot(); accepted.execution.send.state = 'accepted';
  const value = recoveryEnvelope(run, accepted);
  assert.equal(value.send.noSend, false); assert.equal(value.remoteOutcome, 'unknown');
});
test('refusal is returned without bypass advice; another job/profile cannot supply recovery evidence', () => {
  const s = snapshot(); s.execution.sourceHandoff = { reason: 'provider_content_blocked' };
  const envelope = recoveryEnvelope(run, s);
  assert.equal(envelope.refusal, true); assert.match(recoveryInstructions(envelope), /не обходи его/);
  assert.throws(() => recoveryEnvelope(run, { ...s, id: 'other' }), /job_mismatch/);
  assert.throws(() => recoveryEnvelope(run, { ...s, browserInstanceId: 'other' }), /browser_mismatch/);
});

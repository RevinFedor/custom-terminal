'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInboxRewindTarget } = require('./inbox-rewind-identity');

const first = { role: 'user', uuid: 'message-1', sourceIdentity: 'source-1', content: 'same prompt' };
const second = { role: 'user', uuid: 'message-2', sourceIdentity: 'source-2', content: 'same prompt' };

test('a source-only durable Codex receipt resolves its exact row despite identical text', () => {
  const result = resolveInboxRewindTarget([first, second], { sourceIdentity: 'source-2' }, { sourceIdentity: 'source-2' });
  assert.equal(result.ok, true);
  assert.equal(result.entry, second);
});

test('paired transcript carrier aliases keep the original send identity addressable', () => {
  const paired = { ...second, sourceIdentity: 'canonical-2', sourceIdentityAliases: ['source-2'] };
  assert.equal(resolveInboxRewindTarget([paired], { sourceIdentity: 'source-2' }).entry, paired);
});

test('client UUID and source must both belong to the audited row', () => {
  assert.equal(resolveInboxRewindTarget([first, second], { sourceIdentity: 'source-2' }, { entryUuid: 'message-1', sourceIdentity: 'source-2' }).ok, false);
  assert.equal(resolveInboxRewindTarget([first, second], { entryUuid: 'message-1' }, { sourceIdentity: 'source-2' }).ok, false);
});

test('removed branch, duplicate identity and service carriers never resolve by similar text', () => {
  for (const entries of [[second], [first, { ...first }], [{ ...first, serviceCarrier: 'project-instructions' }]]) {
    assert.equal(resolveInboxRewindTarget(entries, { sourceIdentity: 'source-1' }).ok, false);
  }
});

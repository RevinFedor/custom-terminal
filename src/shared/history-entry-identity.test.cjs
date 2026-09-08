'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historyEntryHasExactIdentity } = require('./history-entry-identity.cjs');

test('canonical identities and explicit source/UUID aliases match exactly', () => {
  const entry = { uuid: 'canonical', sourceIdentity: 'event-source', sourceIdentityAliases: ['response-source'], sourceUuidAliases: ['response-uuid'] };
  for (const identity of ['canonical', 'event-source', 'response-source', 'response-uuid']) assert.equal(historyEntryHasExactIdentity(entry, identity), true);
  for (const identity of ['response', 'other-uuid', '', null]) assert.equal(historyEntryHasExactIdentity(entry, identity), false);
});

test('alias properties must be arrays and text never substitutes for identity', () => {
  assert.equal(historyEntryHasExactIdentity({ sourceUuidAliases: 'raw-id', content: 'raw-id' }, 'raw-id'), false);
  assert.equal(historyEntryHasExactIdentity({ sourceUuidAliases: [{ id: 'raw-id' }] }, 'raw-id'), false);
  assert.equal(historyEntryHasExactIdentity({ sourceIdentityAliases: ['source'] }, 'source'), true);
});

test('browser wrapper shares the expanded identity resolver', async () => {
  const browser = await import('./history-entry-identity.mjs');
  assert.equal(browser.historyEntryHasExactIdentity, historyEntryHasExactIdentity);
});

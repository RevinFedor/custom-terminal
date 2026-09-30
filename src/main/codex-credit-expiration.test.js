'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCreditExpiration, fetchCodexCreditExpiration, createCodexCreditExpirationReader } = require('./codex-credit-expiration');

const payload = (balance = '62500', date = '2027-01-01T00:00:00Z') => ({
  balance, expiring_balance_details: [{ amount_remaining: balance, expiry_date: date, grant_type: 'promotional_credit' }],
});
const auth = { accountId: 'workspace-a', accountKey: 'a', accessToken: 'private-fixture-token', tokenFingerprint: 'token-a' };

test('server grant timestamps retain UTC and only remaining credit amounts are exposed', () => {
  const value = normalizeCreditExpiration(payload(), 1000);
  assert.equal(value.balance, 62500);
  assert.deepEqual(value.expirations, [{ amount: 62500, expiresAt: '2027-01-01T00:00:00.000Z' }]);
  assert.doesNotMatch(JSON.stringify(value), /grant_type|accountId|token/);
});

test('mixed packages aggregate matching dates without assigning the whole balance to the first expiry', () => {
  const value = normalizeCreditExpiration({ balance: '100', expiring_balance_details: [
    { amount_remaining: '30', expiry_date: '2027-01-01Z' },
    { amount_remaining: '20', expiry_date: '2027-01-01Z' },
    { amount_remaining: '40', expiry_date: '2027-06-01Z' },
    { amount_remaining: '10', expiry_date: null },
  ] });
  assert.equal(value.expirations[0].amount, 50);
  assert.equal(value.expirations.length, 2);
});

test('missing details, invalid values or grant totals above balance cannot become a date', () => {
  for (const value of [{ balance: '62500' }, { ...payload(), balance: true },
    { ...payload(), balance: ' ' }, payload('10', 'bad date'),
    { ...payload('10'), balance: '5' }]) assert.equal(normalizeCreditExpiration(value), null);
});

test('request is scoped to the account URL and matching OAuth and has a physical deadline', async () => {
  await fetchCodexCreditExpiration(auth, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/accounts/workspace-a/remaining_balance');
    assert.equal(options.headers.Authorization, 'Bearer private-fixture-token');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'workspace-a');
    assert.equal(options.credentials, 'omit');
    return { ok: true, json: async () => payload() };
  } });
  await assert.rejects(fetchCodexCreditExpiration(auth, { timeoutMs: 10, fetchImpl: (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) }), /aborted/);
});

test('concurrent readers share a request; account or token changes cannot reuse its date', async () => {
  let calls = 0;
  let now = 1000;
  const reader = createCodexCreditExpirationReader({ now: () => now, fetchImpl: async () => {
    calls++; return { ok: true, json: async () => payload() };
  } });
  await Promise.all([reader.read(auth), reader.read(auth)]);
  assert.equal(calls, 1);
  await reader.read(auth);
  assert.equal(calls, 1);
  await reader.read({ ...auth, accountKey: 'b', accountId: 'workspace-b' });
  await reader.read({ ...auth, tokenFingerprint: 'rotated' });
  assert.equal(calls, 3);
  now += 30_000;
  await reader.read(auth);
  assert.equal(calls, 4);
});

test('a failed optional source returns no date, respects Retry-After and leaves other accounts readable', async () => {
  let calls = 0;
  let now = 1000;
  const reader = createCodexCreditExpirationReader({ now: () => now, fetchImpl: async (_url, options) => {
    calls++;
    if (options.headers['ChatGPT-Account-Id'] === 'workspace-b') return { ok: true, json: async () => payload() };
    return { ok: false, status: 429, headers: { get: () => '300' } };
  } });
  assert.equal(await reader.read(auth), null);
  assert.equal(await reader.read(auth, { force: true }), null);
  now += 90_000;
  assert.equal(await reader.read(auth, { force: true }), null);
  assert.equal(calls, 1);
  assert.ok(await reader.read({ ...auth, accountKey: 'b', accountId: 'workspace-b' }));
});

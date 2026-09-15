'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexAuthProfileRoute, ROUTE_ENV } = require('./codex-auth-profile-route');
const key = 'aaaaaaaaaaaaaaaa';
function fixture() {
  let current = { terminal: {}, launchId: 'L1', cwd: '/fixture/project' };
  let auth = { accountKey: key, accountId: 'provider-account-fixture', accessToken: 'fixture-secret', accessExpiresAtMs: 2000, email: 'aa@example.test' };
  const route = createCodexAuthProfileRoute({ configuration: { homePath: '/authorized/profile', accountKey: key, fixtureCwd: '/fixture/project' },
    readAuth: home => { assert.equal(home, '/authorized/profile'); return auth; }, captureTab: () => current, now: () => 1000 });
  return { route, headers: () => ({ authorization: 'Bearer ' + route.childEnvironment()[ROUTE_ENV] }),
    change: patch => { current = { ...current, ...patch }; }, auth: patch => { auth = { ...auth, ...patch }; } };
}
test('ordinary launch has no alternate auth route', () => assert.equal(createCodexAuthProfileRoute({}), null));
test('exact registered fixture launch uses the existing profile only at the proxy; no secret in launch config or public proof', () => {
  const h = fixture(); const flags = h.route.launchOverrides('T', 'http://127.0.0.1:4999/codex/t/T');
  const headers = h.route.authorize('T', { ...h.headers(), 'ChatGPT-Account-Id': 'spoofed', 'X-API-Key': 'spoofed' }, 'L1');
  assert.equal(headers.authorization, 'Bearer fixture-secret'); assert.equal(headers['chatgpt-account-id'], 'provider-account-fixture');
  assert.equal(headers['X-API-Key'], undefined);
  const publicData = JSON.stringify([flags, h.route.inspect(), h.route.childEnvironment()]);
  assert.doesNotMatch(publicData, /fixture-secret|provider-account-fixture|authorized\/profile|aa@example/);
  assert.ok(flags.some(x => x.includes('env_key')));
});
for (const changed of [{ launchId: 'L2' }, { terminal: {} }, { cwd: '/user/project' }]) test('changed tab scope cannot use prior route proof ' + Object.keys(changed)[0], () => {
  const h = fixture(); h.route.bind('T'); h.change(changed);
  assert.throws(() => h.route.authorize('T', h.headers(), 'L1'), e => e.code === 'codex_auth_route_owner_changed');
});
test('unbound or wrongly authenticated request is rejected without exposing provider credentials', () => {
  const h = fixture(); assert.throws(() => h.route.authorize('T', h.headers(), 'L1'), /owner_changed/);
  h.route.bind('T'); assert.throws(() => h.route.authorize('T', { authorization: 'Bearer bad' }, 'L1'), /unauthorized/);
  h.route.unbind('T', 'L1'); assert.throws(() => h.route.authorize('T', h.headers(), 'L1'), /owner_changed/);
});
test('same-account token rotation is read in place; account switch/expiry never auto-logs in or falls back', () => {
  const h = fixture(); h.route.bind('T'); h.auth({ accessToken: 'next-fixture-token' });
  assert.equal(h.route.authorize('T', h.headers(), 'L1').authorization, 'Bearer next-fixture-token');
  h.auth({ accountKey: 'bbbbbbbbbbbbbbbb' }); assert.throws(() => h.route.authorize('T', h.headers(), 'L1'), /profile_changed/);
  h.auth({ accountKey: key, accessExpiresAtMs: 900 }); assert.throws(() => h.route.authorize('T', h.headers(), 'L1'), /profile_expired/);
});
test('an old connection URL cannot borrow a replacement launch or clear its binding', () => {
  const h = fixture(); h.route.bind('T'); h.change({ launchId: 'L2' }); h.route.bind('T');
  assert.equal(h.route.unbind('T', 'L1'), false);
  assert.throws(() => h.route.authorizeRequest('T', '/_noted_profile/L1/responses', h.headers()), /owner_changed/);
  const current = h.route.authorizeRequest('T', '/_noted_profile/L2/responses?fixture=1', h.headers());
  assert.equal(current.forwardUrl, '/responses?fixture=1'); assert.equal(current.launchId, 'L2');
});

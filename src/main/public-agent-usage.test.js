'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const url = require('node:url');
const vm = require('node:vm');
const ts = require('typescript');
const { createPublicAgentUsageReader, projectPublicAgentUsage } = require('./public-agent-usage');
const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
const timestamp = '2030-01-10T12:00:00.000Z';
const bucket = (utilization = 0) => ({ utilization, resets_at: '2030-01-11T12:00:00.000Z' });
const account = (accountKey, extra = {}) => ({ accountKey, label: 'fr***@example.com',
  isCurrent: accountKey === A, source: 'openai-usage-api', timestamp,
  stale: accountKey !== A, usage: { seven_day: bucket(27) }, ...extra });
const sample = extra => ({ success: true, accounts: [account(A), account(B)], selectedAccountKey: A,
  currentAccountKey: A, cacheAgeMs: 400, lastAttemptAt: Date.parse(timestamp), ...extra });

test('Codex absence, zero, unknown and reset-credit availability remain different', () => {
  const first = projectPublicAgentUsage('codex', sample());
  assert.deepEqual(first.windows.map(window => window.id), ['weekly']);
  assert.equal(first.windows[0].usedPct, 27);
  assert.equal(first.fullResets.status, 'unavailable');
  const data = sample({ accounts: [account(A, { reset_credits: { available_count: 0, timestamp, credits: [] },
    usage: { seven_day: bucket(100), five_hour: bucket(0), credits: { unlimited: true, balance: 0 },
      additional_rate_limits: [{ key: 'spark', label: 'Spark', five_hour: bucket(20) }] } })] });
  const next = projectPublicAgentUsage('codex', data);
  assert.deepEqual(next.windows.map(window => window.id), ['weekly', 'five-hour', 'spark:five-hour']);
  assert.equal(next.windows[1].usedPct, 0); assert.equal(next.fullResets.availableCount, 0);
  assert.equal(next.fullResets.status, 'known'); assert.equal(next.credits.unlimited, true);
  data.accounts[0].usage.five_hour.utilization = ' ';
  assert.equal(projectPublicAgentUsage('codex', data).windows[1].usedPct, null);
});

test('Claude Fable is a shared weekly sublimit and never gets a separate reset, including unknown', () => {
  const data = sample({ accounts: [account(A, { source: 'anthropic-oauth-api', usage: {
    seven_day: bucket(61), five_hour: bucket(32), model_scoped: [{ display_name: 'Fable', utilization: 99, resets_at: timestamp }],
  } })] });
  const known = projectPublicAgentUsage('claude', data);
  assert.deepEqual(known.windows.map(row => row.id), ['weekly', 'five-hour', 'fable']);
  assert.equal(known.windows[2].usedPct, 99);
  assert.equal(known.windows[2].resetAt, null); assert.equal(known.windows[2].sharedWith, 'weekly');
  data.accounts[0].usage.model_scoped = [];
  const unknown = projectPublicAgentUsage('claude', data).windows[2];
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.usedPct, null); assert.equal(unknown.resetAt, null);
});

test('allowlisted DTO never exposes auth, home, session, raw billing, reset IDs or provider failure text', () => {
  const secret = 'VERY_SECRET';
  const data = sample({ oauthToken: secret, home: '/Users/private',
    billing: { orgId: secret, customer: secret, invoice: secret },
    profiles: [{ profileId: secret, login: { userCode: secret, verificationUrl: secret } }],
    accounts: [account(A, { label: '/Users/private/auth.json', auth: secret, profileId: secret,
      sourceThreadId: secret, source: secret, lastError: '401 ' + secret,
      billing: { customer: secret }, reset_credits: { available_count: 1, timestamp,
        credits: [{ title: 'Full reset', expires_at: timestamp, id: secret, description: secret }] } })] });
  const result = projectPublicAgentUsage('codex', data);
  const body = JSON.stringify(result);
  assert.doesNotMatch(body, /VERY_SECRET|\/Users|auth\.json|sourceThreadId|verificationUrl|userCode|orgId/);
  assert.equal(result.error.code, 'auth_required'); assert.equal(result.accounts[0].source, 'unknown');
  assert.equal(result.fullResets.items.length, 1);
});

test('selected historical account is not current login; a missing key never silently displays another account', () => {
  const selected = projectPublicAgentUsage('codex', sample(), B);
  assert.equal(selected.selectedAccountKey, B); assert.equal(selected.currentAccountKey, A);
  assert.equal(selected.freshness.stale, true); assert.equal(selected.freshness.timestamp, timestamp);
  const missing = projectPublicAgentUsage('codex', sample(), 'missing');
  assert.equal(missing.error.code, 'account_not_found'); assert.equal(missing.selectedAccountKey, null);
  assert.deepEqual(missing.windows, []);
});

test('only account selection reaches the existing getter; refresh cannot bypass its cache/backoff', async () => {
  const calls = [];
  const get = provider => async options => { calls.push({ provider, options }); return sample(); };
  const reader = createPublicAgentUsageReader({ getClaudeUsage: get('claude'), getCodexUsage: get('codex') });
  await reader({ provider: 'codex', accountKey: B, refresh: true, force: true, home: '/Users/private', login: true });
  await reader({ provider: 'claude', accountKey: A, authReader: () => assert.fail('client-injected auth') });
  assert.deepEqual(calls, [{ provider: 'codex', options: { accountKey: B, force: false } },
    { provider: 'claude', options: { accountKey: A, force: false } }]);
  await assert.rejects(() => reader({ provider: 'other' }), error => error.statusCode === 400);
});

test('public getter actually reuses Claude OAuth cache and historical selection without another provider fetch', async t => {
  const api = require('./ipc/claude-usage')._api;
  api.resetClaudeUsageStateForTests(); t.after(() => api.resetClaudeUsageStateForTests());
  const auth = { accountKey: 'claude:' + A, tokenFingerprint: 'test-fingerprint', label: 'aa***@example.com',
    currentKind: 'max-oauth', credentialKind: 'oauth-bearer', usageEndpointEligible: true, oauthToken: 'fixture-only' };
  let count = 0;
  const reader = createPublicAgentUsageReader({ getClaudeUsage: options => api.getUsage({ ...options,
    authReader: async () => auth, now: () => Date.parse(timestamp),
    fetchImpl: async () => { count++; return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ five_hour: bucket(20), seven_day: bucket(30) }) }; },
  }) });
  const first = await reader({ provider: 'claude' });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(count, 1);
  const refreshed = await reader({ provider: 'claude', refresh: true, force: true });
  assert.equal(refreshed.ok, true); assert.equal(count, 1);
});

test('real HTTP exercises actual authenticated read route; rejected requests never reach getters', async t => {
  const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  const auth = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'checkAuth');
  let route;
  function visit(n) { if (ts.isIfStatement(n) && n.expression.getText(ast) === "parsed.pathname === '/api/agent-usage'") route = n; ts.forEachChild(n, visit); }
  visit(ast); assert.ok(route);
  assert.ok(source.indexOf("if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });", source.indexOf('async function handleApi')) < route.pos);
  let calls = 0;
  const context = vm.createContext({ url, token: 'fixture-bearer',
    readAgentUsage: createPublicAgentUsageReader({ getCodexUsage: async () => { calls++; return sample(); } }),
    sendJson: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } });
  vm.runInContext(auth.getText(ast) + '\nasync function handler(req,res,parsed) {'
    + "if (!checkAuth(req)) return sendJson(res,401,{error:'unauthorized'});" + route.getText(ast) + '}', context);
  const server = http.createServer((req, res) => context.handler(req, res, url.parse(req.url, true)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/agent-usage';
  const unauthorized = await fetch(endpoint + '?provider=codex');
  assert.equal(unauthorized.status, 401); assert.equal(calls, 0);
  const headers = { Authorization: 'Bearer fixture-bearer' };
  const wrongMethod = await fetch(endpoint + '?provider=codex', { method: 'POST', headers });
  assert.equal(wrongMethod.status, 405); assert.equal(calls, 0);
  const wrongProvider = await fetch(endpoint + '?provider=other', { headers });
  assert.equal(wrongProvider.status, 400); assert.equal(calls, 0);
  const success = await fetch(endpoint + '?provider=codex&accountKey=' + B + '&refresh=1&force=1', { headers });
  assert.equal(success.status, 200); const value = await success.json(); assert.equal(value.selectedAccountKey, B);
  assert.equal(calls, 1);
});

test('desktop Codex IPC and main public reader invoke the same getter body', () => {
  const codex = fs.readFileSync(require.resolve('./ipc/codex-data'), 'utf8');
  assert.match(codex, /module\.exports\._api\.getUsage = async \(opts = \{\}\) =>/);
  assert.match(codex, /ipcMain\.handle\('codex:get-usage', \(_event, opts = \{\}\) => module\.exports\._api\.getUsage\(opts\)\)/);
  const main = fs.readFileSync(require.resolve('./main'), 'utf8');
  assert.match(main, /getCodexUsage: options => codexDataModule\._api\.getUsage\(options\)/);
  assert.match(main, /getClaudeUsage: options => require\(path\.join\(srcMainDir, 'ipc', 'claude-usage'\)\)\._api\.getUsage\(options\)/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { captureClaudeUsageAuthNamespace: capture, readClaudeUsageCredentialFile: readFile } = require('../claude-usage-auth-namespace');
const { _api: usage } = require('./claude-usage');
const { createPublicAgentUsageReader } = require('../public-agent-usage');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const status = extra => ({ loggedIn: true, authMethod: 'claude.ai', email: 'fixture@example.test', orgId: 'org-fixture', ...extra });
const payload = (token, extra = {}) => JSON.stringify({ claudeAiOauth: { accessToken: token, ...extra } });
const scope = name => capture({ env: { USER: 'fixture', ...(name ? { CLAUDE_CONFIG_DIR: '/fixture/' + name } : {}) }, home: '/fixture/home' });
function reader(namespace = scope('A'), options = {}) {
  return () => usage.readClaudeAuthState({ namespaceReader: () => namespace,
    statusReader: async current => { assert.equal(current, namespace); return status(); },
    keychainReader: async (service, current) => {
      assert.equal(current, namespace); assert.equal(service, namespace.oauthService);
      return payload('fixture-token-' + namespace.key);
    },
    fileReader: async () => assert.fail('Keychain document must not be merged with a fallback'), ...options,
  });
}
test.afterEach(() => usage.resetClaudeUsageStateForTests());

test('default services/account key stay compatible; explicit roots follow the actual CLI NFC hash grammar', () => {
  const ordinary = scope(null);
  assert.equal(ordinary.apiService, 'Claude Code'); assert.equal(ordinary.oauthService, 'Claude Code-credentials');
  assert.equal(ordinary.account, 'fixture'); assert.equal(ordinary.key, 'default');
  assert.equal(usage.stableClaudeAccountKey(status()), usage.stableClaudeAccountKey(status(), null, ordinary.key));
  const raw = '/fixture/cafe\u0301/';
  const configured = capture({ env: { USER: 'fixture', CLAUDE_CONFIG_DIR: raw }, home: '/fixture/home' });
  const suffix = digest(raw.normalize('NFC')).slice(0, 8);
  assert.equal(configured.oauthService, 'Claude Code-credentials-' + suffix);
  assert.equal(configured.apiService, 'Claude Code-' + suffix);
  assert.notEqual(configured.oauthService, scope('café').oauthService, 'trailing slash is part of the CLI hash');
  const explicitDefault = capture({ env: { USER: 'fixture', CLAUDE_CONFIG_DIR: '/fixture/home/.claude' }, home: '/fixture/home' });
  assert.notEqual(explicitDefault.oauthService, ordinary.oauthService, 'explicit default path is still a separate Keychain entry');
  assert.equal(capture({ env: { USER: 'bad user' }, home: '/fixture' }).account, 'claude-code-user');
});

test('private storage override cannot point at global/another root; no implicit custom OAuth endpoint', () => {
  for (const secure of ['', '/fixture/other']) assert.throws(() => capture({ env: {
    USER: 'fixture', CLAUDE_CONFIG_DIR: '/fixture/A', CLAUDE_SECURESTORAGE_CONFIG_DIR: secure,
  } }), e => e.code === 'auth_namespace_mismatch');
  assert.equal(capture({ env: { USER: 'fixture', CLAUDE_CONFIG_DIR: '/fixture/A',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/A' } }).oauthService, scope('A').oauthService);
  assert.notEqual(capture({ env: { USER: 'fixture', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fixture/home/.claude' },
    home: '/fixture/home' }).oauthService, scope(null).oauthService);
  assert.throws(() => capture({ env: { CLAUDE_CONFIG_DIR: '' } }), e => e.code === 'auth_namespace_invalid');
  assert.throws(() => capture({ env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://fixture.invalid' } }), e => e.code === 'auth_source_unsupported');
});

test('two private profiles with the same identity/token remain different usage owners and never read global services', async () => {
  const calls = [];
  const make = namespace => reader(namespace, { keychainReader: async (service, captured) => {
    calls.push(service); assert.equal(captured.account, 'fixture');
    assert.notEqual(service, 'Claude Code-credentials'); return payload('same-fixture-token');
  } })();
  const [a, b] = await Promise.all([make(scope('A')), make(scope('B'))]);
  assert.notEqual(a.accountKey, b.accountKey); assert.notEqual(a.credentialScopeKey, b.credentialScopeKey);
  assert.equal(a.tokenFingerprint, b.tokenFingerprint); assert.equal(calls.length, 4);
  assert.equal(a.oauthSource, scope('A').oauthService); assert.equal(b.oauthSource, scope('B').oauthService);
});

test('private missing credential cannot fall back to a global key or pretend OAuth is a managed login', async () => {
  const a = scope('A'), services = [], files = [];
  await assert.rejects(reader(a, {
    keychainReader: async name => { services.push(name); return name === 'Claude Code-credentials' ? payload('GLOBAL') : null; },
    fileReader: async file => { files.push(file); return null; },
  }), e => e.code === 'auth_missing');
  assert.deepEqual(services, [a.oauthService, a.oauthService]);
  assert.deepEqual(files, [a.credentialsFile, a.credentialsFile]);
});

test('Keychain observer failure is not treated as missing and never opens the private file fallback', async () => {
  const a = scope('A'); let fileReads = 0;
  await assert.rejects(reader(a, {
    keychainReader: async () => { throw Object.assign(new Error('security denied'), { code: 'auth_source_unavailable' }); },
    fileReader: async () => { fileReads++; return payload('stale-fallback'); },
  }), error => error.code === 'auth_source_unavailable');
  assert.equal(fileReads, 0);
});

test('aborted/unknown credential observer failure remains typed unavailable, while item-not-found alone permits fallback', async () => {
  const a = scope('A');
  await assert.rejects(reader(a, {
    keychainReader: async () => { throw Object.assign(new Error('killed'), { code: 'auth_read_timeout' }); },
    fileReader: async () => payload('must-not-read'),
  }), error => error.code === 'auth_read_timeout');
  const found = await reader(a, {
    keychainReader: async () => null,
    fileReader: async () => payload('fixture-fallback'),
  })();
  assert.equal(found.oauthSource, 'credentials-file');
});

test('logged out/unknown status reads no credential store at all', async () => {
  for (const value of [null, status({ loggedIn: false })]) {
    assert.equal(await reader(scope('A'), { statusReader: async () => value,
      keychainReader: async () => assert.fail('no secret read before login proof') })(), null);
  }
});

test('the private fallback is one complete container, not a merge with an MCP-only Keychain document', async () => {
  const a = scope('A'); let fallbackReads = 0;
  const fallback = { fileReader: async file => { assert.equal(file, a.credentialsFile); fallbackReads++; return payload('fallback-fixture'); } };
  const found = await reader(a, { ...fallback, keychainReader: async () => null })();
  assert.equal(found.oauthSource, 'credentials-file'); assert.equal(found.oauthToken, 'fallback-fixture');
  assert.equal(fallbackReads, 2);
  await assert.rejects(reader(a, { ...fallback,
    keychainReader: async () => JSON.stringify({ mcpOAuth: { fixture: { accessToken: 'foreign' } } }),
  }), e => e.code === 'auth_missing');
  assert.equal(fallbackReads, 2, 'present MCP container does not authorize a fallback');
});

test('explicit credential identity conflict is rejected before quota; inactive API item is never consulted for OAuth', async () => {
  await assert.rejects(reader(scope('A'), { keychainReader: async () => payload('fixture', { email: 'other@example.test' }) }),
    e => e.code === 'account_mismatch');
  await assert.rejects(reader(scope('A'), { keychainReader: async () => payload('fixture', { orgId: 'other-org' }) }),
    e => e.code === 'account_mismatch');
  await assert.rejects(reader(scope('A'), { keychainReader: async () => payload('fixture', {
    tokenAccount: { emailAddress: 'different@example.test', organizationUuid: 'org-fixture' },
  }) }), e => e.code === 'account_mismatch');
  const good = await reader(scope('A'), { keychainReader: async service => {
    assert.ok(service.includes('-credentials-')); return payload('fixture', { email: 'fixture@example.test', orgId: 'org-fixture' });
  } })();
  assert.equal(good.currentKind, 'max-oauth'); assert.equal(good.apiKey, null);
});

test('CLI-reported configDirectory conflict refuses before reading any credential', async () => {
  await assert.rejects(reader(scope('A'), { statusReader: async () => status({ configDirectory: '/fixture/B' }),
    keychainReader: async () => assert.fail('foreign status may not choose a key') }), e => e.code === 'auth_namespace_mismatch');
});

for (const change of ['identity', 'token', 'source', 'namespace']) test('auth assembly detects concurrent ' + change + ' change', async () => {
  const a = scope('A'), b = scope('B'); let statuses = 0, keys = 0, scopes = 0;
  await assert.rejects(reader(a, {
    namespaceReader: () => ++scopes > 1 && change === 'namespace' ? b : a,
    statusReader: async () => status({ email: ++statuses > 1 && change === 'identity' ? 'B@example.test' : 'fixture@example.test' }),
    keychainReader: async () => { keys++; return keys > 1 && change === 'source' ? null : payload(keys > 1 && change === 'token' ? 'new' : 'old'); },
    fileReader: async () => payload('old'),
  }), e => e.code === 'auth_changed');
});

test('environment API-key source never consumes a stale OAuth/Keychain identity', async () => {
  const a = capture({ env: { USER: 'fixture', CLAUDE_CONFIG_DIR: '/fixture/A', ANTHROPIC_API_KEY: 'sk-ant-api03-fixture' } });
  const result = await reader(a, { statusReader: async () => status({ authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }),
    keychainReader: async () => assert.fail('env credential does not read Keychain') })();
  assert.equal(result.apiKeySource, 'ANTHROPIC_API_KEY'); assert.equal(result.oauthToken, null);
  assert.equal(result.currentKind, 'api-platform'); assert.equal(result.usageEndpointEligible, false);
});

test('actual default credential adapters pass the SAME captured env and exact account to OS calls, without real subprocesses', async () => {
  const modulePath = require.resolve('./claude-usage'), source = fs.readFileSync(modulePath, 'utf8');
  const a = scope('A'), calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, AbortController, setTimeout, clearTimeout,
    require: name => name === 'electron' ? { ipcMain: {} } : name === 'child_process' ? {
      execFile: (program, args, options, callback) => {
        calls.push({ program, args, options }); assert.equal(options.env, a.env);
        if (program === 'claude') callback(null, JSON.stringify(status()));
        else { assert.equal(program, 'security'); assert.deepEqual(Array.from(args), ['find-generic-password', '-a', 'fixture', '-s', a.oauthService, '-w']); callback(null, payload('fixture-token')); }
      },
    } : require(require.resolve(name, { paths: [path.dirname(modulePath)] })),
  });
  const auth = await module.exports._api.readClaudeAuthState({ namespaceReader: () => a,
    fileReader: async () => assert.fail('no fallback with a keychain token') });
  assert.equal(auth.namespaceKey, a.key); assert.equal(calls.length, 4);
});

test('real private fixture file fallback refuses a symlink outside its selected directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-usage-auth-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aDir = path.join(root, 'A'), bDir = path.join(root, 'B'); fs.mkdirSync(aDir); fs.mkdirSync(bDir);
  const a = capture({ env: { USER: 'fixture', CLAUDE_CONFIG_DIR: aDir } });
  assert.equal(await readFile(a.credentialsFile, a), null);
  fs.writeFileSync(a.credentialsFile, payload('fixture-only'), { mode: 0o600 });
  assert.equal(JSON.parse(await readFile(a.credentialsFile, a)).claudeAiOauth.accessToken, 'fixture-only');
  fs.renameSync(a.credentialsFile, path.join(bDir, '.credentials.json'));
  fs.symlinkSync(path.join(bDir, '.credentials.json'), a.credentialsFile);
  await assert.rejects(() => readFile(a.credentialsFile, a), e => e.code === 'auth_namespace_mismatch');
});

test('double observation keeps one bounded auth deadline; a late status cannot start credential reads', async () => {
  let release, reads = 0, passedSignal;
  const pending = reader(scope('A'), { authReadTimeoutMs: 15,
    statusReader: (_scope, { signal }) => { passedSignal = signal; return new Promise(resolve => { release = resolve; }); },
    keychainReader: async () => { reads++; return payload('not-read'); },
  })();
  const hold = setTimeout(() => {}, 1000);
  try { await assert.rejects(() => pending, e => e.code === 'auth_read_timeout'); }
  finally { clearTimeout(hold); }
  assert.equal(passedSignal.aborted, true); release(status());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 0);
});

test('actual Usage/HTTP DTO preserve two namespace caches and stale history on auth conflict; no secret/namespace leaks', async () => {
  const a = await reader(scope('A'))(), b = await reader(scope('B'))(); let active = a, calls = [];
  const at = Date.parse('2030-01-10T12:00:00Z');
  const dbWrites = [];
  usage.setClaudeUsageStateStoreForTests({ getAppState: () => null, setAppState: (_key, value) => dbWrites.push(value) });
  const authReader = async () => { if (active instanceof Error) throw active; return active; };
  const read = createPublicAgentUsageReader({ getClaudeUsage: options => usage.getUsage({ ...options, authReader, now: () => at,
    fetchImpl: async (_url, request) => { calls.push(request.headers.Authorization || request.headers.authorization);
      return { ok: true, headers: { get: () => null }, json: async () => ({ five_hour: { utilization: 12, resets_at: '2030-01-11T00:00:00Z' },
        seven_day: { utilization: 24, resets_at: '2030-01-17T00:00:00Z' } }) }; },
  }) });
  const first = await read({ provider: 'claude' }); assert.equal(first.currentAccountKey, a.accountKey);
  active = b; const second = await read({ provider: 'claude' }); assert.equal(second.currentAccountKey, b.accountKey);
  assert.equal(second.accounts.length, 2); assert.equal(calls.length, 2);
  await read({ provider: 'claude', accountKey: a.accountKey }); assert.equal(calls.length, 2, 'historical selection is read-only');
  await read({ provider: 'claude', refresh: true }); assert.equal(calls.length, 2, 'normal refresh keeps cache/throttle');
  active = Object.assign(new Error('Claude credential account mismatch'), { code: 'account_mismatch' });
  const conflict = await read({ provider: 'claude', accountKey: b.accountKey });
  assert.equal(conflict.error.code, 'account_mismatch'); assert.equal(conflict.currentAccountKey, null);
  assert.equal(conflict.freshness.stale, true); assert.equal(conflict.windows[0].usedPct, 24);
  assert.equal(calls.length, 2); assert.equal(conflict.windows[2].resetAt, null);
  const serialized = JSON.stringify([first, second, conflict, dbWrites]);
  for (const secret of [a.oauthToken, b.oauthToken, a.credentialScopeKey, '/fixture/', 'fixture@example.test']) {
    assert.ok(!serialized.includes(secret), 'DTO/persistence must not leak ' + secret.slice(0, 8));
  }
});

test('statusline session/PID binding is also separated by namespace, including persisted lookup', async () => {
  const scopes = [scope('A'), scope('B')];
  const auth = await Promise.all(scopes.map(s => reader(s)()));
  for (let n = 0; n < scopes.length; n++) {
    const result = await usage.recordStatuslineUsage({ session_id: 'SAME-SID', ppid: 17, updated_at: 1900000000,
      rate_limits: { five_hour: { used_percentage: n + 10 }, seven_day: { used_percentage: n + 20 } },
    }, { namespaceReader: () => scopes[n], authReader: async () => auth[n], now: () => 1900000000000 });
    assert.equal(result.accepted, true);
  }
  const accounts = usage.listClaudeUsageAccounts(null, 1900000000000);
  assert.equal(accounts.length, 2);
  assert.equal(accounts.find(a => a.accountKey === auth[0].accountKey).usage.five_hour.utilization, 10);
  assert.equal(accounts.find(a => a.accountKey === auth[1].accountKey).usage.five_hour.utilization, 11);
});

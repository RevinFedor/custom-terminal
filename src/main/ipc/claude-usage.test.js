const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { _api } = require('./claude-usage');
const {
  buildChildProcessEnv,
  isolateMainProcessEnv,
} = require('../child-process-env');

const BASE_NOW = Date.parse('2030-01-10T12:00:00Z');

function accountKey(char) {
  return `claude:${char.repeat(20)}`;
}

function authFor(char, overrides = {}) {
  const kind = overrides.currentKind || 'max-oauth';
  return {
    accountKey: accountKey(char),
    tokenFingerprint: overrides.tokenFingerprint || `fingerprint-${char}`,
    label: overrides.label || `${char}${char}***@example.com`,
    accountHint: kind === 'api-platform' ? 'Anthropic API Platform' : 'Claude subscription',
    currentKind: kind,
    credentialKind: kind === 'max-oauth' ? 'oauth-bearer' : (kind === 'api-platform' ? 'api-key' : 'managed-api-key'),
    usageEndpointEligible: kind === 'max-oauth',
    oauthToken: overrides.oauthToken || `oauth-secret-${char}`,
    apiKey: overrides.apiKey || `sk-ant-api03-secret-${char}`,
    email: overrides.email || `${char}@example.com`,
    orgId: overrides.orgId || `org-raw-${char}`,
    notice: kind === 'claude-managed-key'
      ? 'Quota updates after Claude replies through the official status line.'
      : null,
    ...overrides,
  };
}

function usagePayload({
  five = 36,
  weekly = 39,
  fiveReset = BASE_NOW + 2 * 60 * 60 * 1000,
  weeklyReset = BASE_NOW + 4 * 24 * 60 * 60 * 1000,
  limits = undefined,
} = {}) {
  const payload = {
    five_hour: five == null ? null : {
      utilization: five,
      resets_at: new Date(fiveReset).toISOString(),
    },
    seven_day: weekly == null ? null : {
      utilization: weekly,
      resets_at: new Date(weeklyReset).toISOString(),
    },
  };
  if (limits !== undefined) payload.limits = limits;
  return payload;
}

function fableLimit({
  percent = 21,
  reset = BASE_NOW + 4 * 24 * 60 * 60 * 1000,
  displayName = 'Fable',
} = {}) {
  return {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent,
    resets_at: new Date(reset).toISOString(),
    is_active: false,
    scope: {
      model: {
        id: null,
        display_name: displayName,
      },
      surface: null,
    },
  };
}

function statuslinePayload({
  sessionId = 'session-a',
  ppid = 100,
  five = 36,
  weekly = 39,
  at = BASE_NOW,
  fiveReset = BASE_NOW + 2 * 60 * 60 * 1000,
  weeklyReset = BASE_NOW + 4 * 24 * 60 * 60 * 1000,
} = {}) {
  return {
    session_id: sessionId,
    ppid,
    updated_at: Math.floor(at / 1000),
    rate_limits: {
      five_hour: five == null ? null : {
        used_percentage: five,
        resets_at: Math.floor(fiveReset / 1000),
      },
      seven_day: weekly == null ? null : {
        used_percentage: weekly,
        resets_at: new Date(weeklyReset).toISOString(),
      },
    },
  };
}

function fetchResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    json: async () => payload,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeDb(initialState = null) {
  let appState = initialState == null ? null : JSON.parse(JSON.stringify(initialState));
  const writes = [];
  const snapshots = [];
  return {
    writes,
    snapshots,
    getAppState() {
      return appState == null ? null : JSON.parse(JSON.stringify(appState));
    },
    setAppState(_key, value) {
      appState = JSON.parse(JSON.stringify(value));
      writes.push(JSON.parse(JSON.stringify(value)));
    },
    saveClaudeUsageSnapshot(snapshot) {
      snapshots.push(JSON.parse(JSON.stringify(snapshot)));
    },
    getClaudeUsageSnapshots(fromTs, toTs, key) {
      return snapshots
        .filter((row) => row.account_key === key && row.ts >= fromTs && row.ts <= toTs)
        .sort((left, right) => left.ts - right.ts);
    },
    snapshot() {
      return appState == null ? null : JSON.parse(JSON.stringify(appState));
    },
  };
}

test.afterEach(() => {
  _api.resetClaudeUsageStateForTests();
});

test('treats /login managed key as managed even when stale OAuth or MCP tokens coexist', async () => {
  const status = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiKeySource: '/login managed key',
    email: 'person@example.com',
    orgId: 'raw-org-id',
  };
  const keychainReader = async (service) => {
    if (service === 'Claude Code') return 'sk-ant-api03-current-managed-key';
    return JSON.stringify({
      claudeAiOauth: { accessToken: 'stale-claude-oauth' },
      mcpOAuth: { figma: { accessToken: 'figma-access-token' } },
    });
  };
  const auth = await _api.readClaudeAuthState({
    statusReader: async () => status,
    keychainReader,
  });

  assert.equal(auth.currentKind, 'claude-managed-key');
  assert.equal(auth.credentialKind, 'managed-api-key');
  assert.equal(auth.usageEndpointEligible, false);
  assert.equal(auth.oauthToken, 'stale-claude-oauth');
  assert.equal(auth.label, 'pe***@example.com');

  const mcpOnly = await _api.readClaudeAuthState({
    statusReader: async () => status,
    keychainReader: async (service) => (
      service === 'Claude Code'
        ? 'sk-ant-api03-current-managed-key'
        : JSON.stringify({ mcpOAuth: { figma: { accessToken: 'figma-access-token' } } })
    ),
  });
  assert.equal(mcpOnly.oauthToken, null);
  assert.equal(mcpOnly.currentKind, 'claude-managed-key');
});

test('keeps API Platform classification and billing mode separate from Claude managed login', async () => {
  const auth = await _api.readClaudeAuthState({
    statusReader: async () => ({
      loggedIn: true,
      authMethod: 'api_key',
      apiKeySource: 'ANTHROPIC_API_KEY',
      email: 'api@example.com',
      orgId: 'api-org',
    }),
    keychainReader: async (service) => service === 'Claude Code' ? 'sk-ant-api03-platform' : null,
  });
  assert.equal(auth.currentKind, 'api-platform');
  assert.equal(auth.credentialKind, 'api-key');
  assert.equal(auth.usageEndpointEligible, false);
});

test('does not infer a current account from stale Keychain data when auth status is unavailable', async () => {
  const auth = await _api.readClaudeAuthState({
    statusReader: async () => null,
    keychainReader: async (service) => (
      service === 'Claude Code'
        ? 'sk-ant-api03-stale-managed-key'
        : JSON.stringify({ claudeAiOauth: { accessToken: 'stale-oauth-token' } })
    ),
  });
  assert.equal(auth, null);
});

test('strictly validates percentages and never turns missing windows into zero', () => {
  assert.throws(
    () => _api.normalizeClaudeUsageData({ five_hour: null, seven_day: null }),
    (error) => error.code === 'invalid_response',
  );
  assert.throws(
    () => _api.normalizeClaudeUsageData(usagePayload({ five: 101 })),
    (error) => error.code === 'invalid_response',
  );
  assert.throws(
    () => _api.normalizeClaudeUsageData({
      five_hour: { utilization: false },
      seven_day: null,
    }),
    (error) => error.code === 'invalid_response',
  );
  assert.equal(
    _api.normalizeClaudeUsageData(usagePayload({ five: 0, weekly: 0 })).five_hour.utilization,
    0,
  );
});

test('normalizes Fable from the current model-scoped limits array without trusting is_active', () => {
  const normalized = _api.normalizeClaudeUsageData(usagePayload({
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 50,
        scope: { model: null },
      },
      fableLimit(),
      fableLimit({ percent: 150, displayName: 'Broken model quota' }),
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: null,
        scope: { model: { display_name: 'Malformed' } },
      },
    ],
  }));

  assert.deepEqual(normalized.model_scoped, [{
    display_name: 'Fable',
    utilization: 21,
    resets_at: new Date(BASE_NOW + 4 * 24 * 60 * 60 * 1000).toISOString(),
  }]);
  assert.equal(normalized.five_hour.utilization, 36);
  assert.equal(normalized.seven_day.utilization, 39);
});

test('physically aborts a hung OAuth request and classifies 429 retry delay', async () => {
  let aborted = false;
  const hungFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    _api.fetchUsage('oauth-token', { fetchImpl: hungFetch, timeoutMs: 5 }),
    (error) => error.code === 'timeout',
  );
  assert.equal(aborted, true);

  await assert.rejects(
    _api.fetchUsage('oauth-token', {
      fetchImpl: async () => fetchResponse({}, 429, { 'retry-after': '90' }),
      now: () => BASE_NOW,
    }),
    (error) => error.code === 'rate_limited' && error.retryAfterMs === 90_000,
  );
});

test('persists at most eight sanitized accounts and restores historical snapshots after restart', async () => {
  const db = createFakeDb();
  _api.setClaudeUsageProjectManagerForTests({ db });
  let currentAuth;
  for (let index = 0; index < 9; index += 1) {
    const char = String(index);
    currentAuth = authFor(char, {
      currentKind: 'claude-managed-key',
      oauthToken: null,
      label: `${char}${char}***@example.com`,
    });
    const accepted = await _api.recordStatuslineUsage(statuslinePayload({
      sessionId: `session-${char}`,
      ppid: 100 + index,
      five: 10 + index,
      weekly: 20 + index,
      at: BASE_NOW + index * 1000,
    }), {
      authReader: async () => currentAuth,
      now: () => BASE_NOW + index * 1000,
    });
    assert.equal(accepted.accepted, true);
  }

  for (let index = 0; index < 140; index += 1) {
    await _api.recordStatuslineUsage(statuslinePayload({
      sessionId: `capped-session-${index}`,
      ppid: 1000 + index,
      five: 18,
      weekly: 28,
      at: BASE_NOW + 10_000 + index,
    }), {
      authReader: async () => currentAuth,
      now: () => BASE_NOW + 10_000 + index,
    });
  }

  const persisted = db.snapshot();
  assert.equal(persisted.accounts.length, 8);
  assert.equal(persisted.sessionBindings.length, 128);
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(serialized, /oauth-secret|sk-ant-|org-raw|["]email["]/);
  assert.doesNotMatch(serialized, /"0@example\.com"|"1@example\.com"/);
  assert.doesNotMatch(serialized, /session-/);
  assert.match(serialized, /\*\*\*@/);

  const oldestRetained = persisted.accounts[persisted.accounts.length - 1].account.accountKey;
  _api.resetClaudeUsageStateForTests();
  _api.setClaudeUsageProjectManagerForTests({ db });
  const newAuth = authFor('8', {
    currentKind: 'claude-managed-key',
    oauthToken: null,
  });
  const restored = await _api.getUsage({
    accountKey: oldestRetained,
    force: true,
    authReader: async () => newAuth,
    now: () => BASE_NOW + 60_000,
    fetchImpl: async () => {
      throw new Error('historical selection must not fetch');
    },
  });
  const selected = restored.accounts.find((account) => account.accountKey === oldestRetained);
  assert.ok(selected);
  assert.equal(selected.isCurrent, false);
  assert.equal(selected.stale, true);
  assert.ok(selected.usage);
});

test('historical force refresh never uses the current account network credential', async () => {
  const db = createFakeDb();
  _api.setClaudeUsageProjectManagerForTests({ db });
  const authA = authFor('a', { currentKind: 'claude-managed-key', oauthToken: null });
  await _api.recordStatuslineUsage(statuslinePayload(), {
    authReader: async () => authA,
    now: () => BASE_NOW,
  });

  const authB = authFor('b');
  let requests = 0;
  const result = await _api.getUsage({
    accountKey: authA.accountKey,
    force: true,
    authReader: async () => authB,
    now: () => BASE_NOW + 10_000,
    fetchImpl: async () => {
      requests += 1;
      return fetchResponse(usagePayload());
    },
  });

  assert.equal(requests, 0);
  assert.equal(result.selectedAccountKey, authA.accountKey);
  assert.equal(result.currentAccountKey, authB.accountKey);
  assert.equal(result.data.seven_day.utilization, 39);
  assert.equal(result.stale, true);
});

test('a hydrated current OAuth account refetches even when its persisted snapshot is still young', async () => {
  const db = createFakeDb();
  const auth = authFor('a');
  _api.setClaudeUsageProjectManagerForTests({ db });
  await _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => BASE_NOW,
    fetchImpl: async () => fetchResponse(usagePayload({ five: 20, weekly: 30 })),
  });

  _api.resetClaudeUsageStateForTests();
  _api.setClaudeUsageProjectManagerForTests({ db });
  let requests = 0;
  const result = await _api.getUsage({
    force: false,
    authReader: async () => auth,
    now: () => BASE_NOW + 10_000,
    fetchImpl: async () => {
      requests += 1;
      return fetchResponse(usagePayload({ five: 21, weekly: 31 }));
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.data.five_hour.utilization, 21);
  assert.equal(result.stale, false);
});

test('binds statusline quota to session plus process identity across login switches', async () => {
  const db = createFakeDb();
  _api.setClaudeUsageProjectManagerForTests({ db });
  const authA = authFor('a', { currentKind: 'claude-managed-key', oauthToken: null });
  const authB = authFor('b', { currentKind: 'claude-managed-key', oauthToken: null });
  let currentAuth = authA;

  await _api.recordStatuslineUsage(statuslinePayload({
    sessionId: 'resumed-session',
    ppid: 100,
    five: 20,
    weekly: 30,
  }), { authReader: async () => currentAuth, now: () => BASE_NOW });

  // Simulate an app restart while the Claude process itself keeps running.
  _api.resetClaudeUsageStateForTests();
  _api.setClaudeUsageProjectManagerForTests({ db });
  currentAuth = authB;
  await _api.recordStatuslineUsage(statuslinePayload({
    sessionId: 'resumed-session',
    ppid: 100,
    five: 21,
    weekly: 31,
    at: BASE_NOW + 1000,
  }), { authReader: async () => currentAuth, now: () => BASE_NOW + 1000 });
  await _api.recordStatuslineUsage(statuslinePayload({
    sessionId: 'resumed-session',
    ppid: 200,
    five: 40,
    weekly: 50,
    at: BASE_NOW + 2000,
  }), { authReader: async () => currentAuth, now: () => BASE_NOW + 2000 });

  const accounts = _api.listClaudeUsageAccounts(authB.accountKey, BASE_NOW + 3000);
  assert.equal(accounts.find((account) => account.accountKey === authA.accountKey).usage.seven_day.utilization, 31);
  assert.equal(accounts.find((account) => account.accountKey === authB.accountKey).usage.seven_day.utilization, 50);
  assert.deepEqual(new Set(db.snapshots.map((snapshot) => snapshot.account_key)), new Set([
    authA.accountKey,
    authB.accountKey,
  ]));
});

test('fresh official statusline stays authoritative while OAuth supplements Fable', async () => {
  const auth = authFor('a');
  await _api.recordStatuslineUsage(statuslinePayload(), {
    authReader: async () => auth,
    now: () => BASE_NOW,
  });
  let requests = 0;
  const result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => BASE_NOW + 10_000,
    fetchImpl: async () => {
      requests += 1;
      return fetchResponse({
        five_hour: { utilization: 150, resets_at: 'not-a-date' },
        seven_day: null,
        limits: [fableLimit()],
      });
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.source, 'claude-statusline');
  assert.equal(result.data.five_hour.utilization, 36);
  assert.equal(result.data.seven_day.utilization, 39);
  assert.equal(result.data.model_scoped[0].display_name, 'Fable');
  assert.equal(result.data.model_scoped[0].utilization, 21);

  const cached = await _api.getUsage({
    force: false,
    authReader: async () => auth,
    now: () => BASE_NOW + 20_000,
    fetchImpl: async () => {
      requests += 1;
      return fetchResponse(usagePayload({ limits: [fableLimit({ percent: 22 })] }));
    },
  });
  assert.equal(requests, 1);
  assert.equal(cached.data.model_scoped[0].utilization, 21);

  await _api.recordStatuslineUsage(statuslinePayload({
    five: 37,
    weekly: 40,
    at: BASE_NOW + 30_000,
  }), {
    authReader: async () => auth,
    now: () => BASE_NOW + 30_000,
  });
  const afterStatusline = _api.listClaudeUsageAccounts(auth.accountKey, BASE_NOW + 30_000)[0];
  assert.equal(afterStatusline.usage.five_hour.utilization, 37);
  assert.equal(afterStatusline.usage.model_scoped[0].utilization, 21);
});

test('an old live statusline remains the common-limit source while OAuth updates only Fable', async () => {
  const auth = authFor('a');
  await _api.recordStatuslineUsage(statuslinePayload(), {
    authReader: async () => auth,
    now: () => BASE_NOW,
  });

  const result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => BASE_NOW + 400_000,
    fetchImpl: async () => fetchResponse(usagePayload({
      five: 90,
      weekly: 90,
      limits: [fableLimit({ percent: 25 })],
    })),
  });

  assert.equal(result.source, 'claude-statusline');
  assert.equal(result.data.five_hour.utilization, 36);
  assert.equal(result.data.seven_day.utilization, 39);
  assert.equal(result.data.model_scoped[0].utilization, 25);
  assert.equal(result.stale, true);
});

test('an optional Fable failure keeps common limits healthy and eventually hides stale Fable', async () => {
  const auth = authFor('a');
  await _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => BASE_NOW,
    fetchImpl: async () => fetchResponse(usagePayload({ limits: [fableLimit()] })),
  });
  await _api.recordStatuslineUsage(statuslinePayload({ at: BASE_NOW + 1000 }), {
    authReader: async () => auth,
    now: () => BASE_NOW + 1000,
  });

  let result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => BASE_NOW + 2000,
    fetchImpl: async () => fetchResponse({}, 503),
  });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.source, 'claude-statusline');
  assert.equal(result.data.five_hour.utilization, 36);
  assert.equal(result.data.model_scoped[0].utilization, 21);

  await _api.recordStatuslineUsage(statuslinePayload({ at: BASE_NOW + 400_000 }), {
    authReader: async () => auth,
    now: () => BASE_NOW + 400_000,
  });
  result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => BASE_NOW + 401_000,
    fetchImpl: async () => fetchResponse({}, 503),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.model_scoped, []);
});

test('a statusline snapshot arriving during OAuth refresh wins while keeping Fable', async () => {
  const auth = authFor('a');
  const pending = deferred();
  let nowMs = BASE_NOW;
  const refresh = _api.getUsage({
    force: true,
    authReader: async () => auth,
    now: () => nowMs,
    fetchImpl: async () => pending.promise,
  });
  await nextTurn();

  nowMs += 1000;
  await _api.recordStatuslineUsage(statuslinePayload({
    five: 24,
    weekly: 31,
    at: nowMs,
  }), {
    authReader: async () => auth,
    now: () => nowMs,
  });
  pending.resolve(fetchResponse(usagePayload({
    five: 90,
    weekly: 90,
    limits: [fableLimit()],
  })));

  const result = await refresh;
  assert.equal(result.source, 'claude-statusline');
  assert.equal(result.data.five_hour.utilization, 24);
  assert.equal(result.data.seven_day.utilization, 31);
  assert.equal(result.data.model_scoped[0].utilization, 21);
});

test('holds a transient same-generation regression and accepts a legitimate elapsed reset', async () => {
  const auth = authFor('a', { currentKind: 'claude-managed-key', oauthToken: null });
  let nowMs = BASE_NOW;
  const reader = async () => auth;
  await _api.recordStatuslineUsage(statuslinePayload({
    five: 64,
    weekly: 61,
    fiveReset: BASE_NOW + 60_000,
    weeklyReset: BASE_NOW + 60_000,
  }), { authReader: reader, now: () => nowMs });

  nowMs += 1000;
  const pending = await _api.recordStatuslineUsage(statuslinePayload({
    five: 1,
    weekly: 0,
    at: nowMs,
    fiveReset: BASE_NOW + 60_000,
    weeklyReset: BASE_NOW + 60_000,
  }), { authReader: reader, now: () => nowMs });
  assert.equal(pending.accepted, false);
  let account = _api.listClaudeUsageAccounts(auth.accountKey, nowMs)[0];
  assert.equal(account.usage.five_hour.utilization, 64);
  assert.equal(account.usage.seven_day.utilization, 61);
  assert.match(account.warning, /inconsistent/i);

  nowMs = BASE_NOW + 32_000;
  const confirmed = await _api.recordStatuslineUsage(statuslinePayload({
    five: 1,
    weekly: 0,
    at: nowMs,
    fiveReset: BASE_NOW + 60_000,
    weeklyReset: BASE_NOW + 60_000,
  }), { authReader: reader, now: () => nowMs });
  assert.equal(confirmed.accepted, true);
  account = _api.listClaudeUsageAccounts(auth.accountKey, nowMs)[0];
  assert.equal(account.usage.five_hour.utilization, 1);
  assert.equal(account.warning, null);

  nowMs = BASE_NOW + 61_000;
  const reset = await _api.recordStatuslineUsage(statuslinePayload({
    five: 1,
    weekly: 0,
    at: nowMs,
    fiveReset: BASE_NOW + 2 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 7 * 24 * 60 * 60 * 1000,
  }), { authReader: reader, now: () => nowMs });
  assert.equal(reset.accepted, true);
  account = _api.listClaudeUsageAccounts(auth.accountKey, nowMs)[0];
  assert.equal(account.usage.five_hour.utilization, 1);
  assert.equal(account.usage.seven_day.utilization, 0);
});

test('preserves last good values on invalid response and blocks force-refresh storms after 429', async () => {
  const auth = authFor('a');
  let nowMs = BASE_NOW;
  let mode = 'valid';
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    if (mode === 'invalid') return fetchResponse(usagePayload({ weekly: 150 }));
    if (mode === 'rate-limit') return fetchResponse({}, 429, { 'retry-after': '120' });
    return fetchResponse(usagePayload({ five: 36, weekly: 39 }));
  };

  let result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    fetchImpl,
    now: () => nowMs,
  });
  assert.equal(result.data.seven_day.utilization, 39);

  mode = 'invalid';
  nowMs += 1000;
  result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    fetchImpl,
    now: () => nowMs,
  });
  assert.equal(result.ok, false);
  assert.equal(result.data.seven_day.utilization, 39);
  assert.match(result.error, /between 0 and 100/);

  mode = 'rate-limit';
  nowMs += 1000;
  result = await _api.getUsage({
    force: true,
    authReader: async () => auth,
    fetchImpl,
    now: () => nowMs,
  });
  assert.equal(result.data.seven_day.utilization, 39);
  assert.match(result.error, /rate limited/);
  const after429Requests = requests;

  nowMs += 1000;
  await _api.getUsage({
    force: true,
    authReader: async () => auth,
    fetchImpl,
    now: () => nowMs,
  });
  assert.equal(requests, after429Requests);
});

test('joins the new-account request and never attaches the old result after auth switch', async () => {
  const authA = authFor('a');
  const authB = authFor('b');
  let currentAuth = authA;
  const calls = [];
  const fetchImpl = (_url, options) => {
    const pending = deferred();
    calls.push({ authorization: options.headers.Authorization, pending });
    return pending.promise;
  };

  const refreshA = _api.getUsage({
    force: true,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => BASE_NOW,
  });
  await nextTurn();
  currentAuth = authB;
  const refreshB = _api.getUsage({
    force: true,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => BASE_NOW + 1000,
  });
  await nextTurn();
  assert.deepEqual(calls.map((call) => call.authorization), [
    'Bearer oauth-secret-a',
    'Bearer oauth-secret-b',
  ]);

  calls[0].pending.resolve(fetchResponse(usagePayload({ five: 10, weekly: 10 })));
  await nextTurn();
  assert.equal(calls.length, 2);
  calls[1].pending.resolve(fetchResponse(usagePayload({ five: 40, weekly: 40 })));

  const [fromA, fromB] = await Promise.all([refreshA, refreshB]);
  assert.equal(fromA.currentAccountKey, authB.accountKey);
  assert.equal(fromB.currentAccountKey, authB.accountKey);
  assert.equal(fromA.accounts.find((account) => account.accountKey === authB.accountKey).usage.five_hour.utilization, 40);
  const historicalA = fromA.accounts.find((account) => account.accountKey === authA.accountKey);
  assert.equal(historicalA.usage, null);
  assert.equal(historicalA.lastError, null);
});

test('token rotation on the same stable account refetches and discards the old-token completion', async () => {
  const oldAuth = authFor('a', {
    oauthToken: 'oauth-old',
    tokenFingerprint: 'fingerprint-old',
  });
  const newAuth = authFor('a', {
    oauthToken: 'oauth-new',
    tokenFingerprint: 'fingerprint-new',
  });
  let currentAuth = oldAuth;
  const calls = [];
  const fetchImpl = (_url, options) => {
    const pending = deferred();
    calls.push({ authorization: options.headers.Authorization, pending });
    return pending.promise;
  };

  const oldRefresh = _api.getUsage({
    force: true,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => BASE_NOW,
  });
  await nextTurn();
  currentAuth = newAuth;
  const newRefresh = _api.getUsage({
    force: false,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => BASE_NOW + 1000,
  });
  await nextTurn();
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer oauth-old', 'Bearer oauth-new']);

  calls[0].pending.resolve(fetchResponse(usagePayload({ five: 20, weekly: 20 })));
  await nextTurn();
  calls[1].pending.resolve(fetchResponse(usagePayload({ five: 60, weekly: 60 })));
  const [oldResult, newResult] = await Promise.all([oldRefresh, newRefresh]);
  assert.equal(oldResult.currentAccountKey, oldAuth.accountKey);
  assert.equal(oldResult.data.five_hour.utilization, 60);
  assert.equal(newResult.data.seven_day.utilization, 60);
  assert.equal(calls.length, 2);
});

test('a statusline update cannot roll a rotated token back into repeated OAuth refreshes', async () => {
  const oldAuth = authFor('a', {
    oauthToken: 'oauth-old',
    tokenFingerprint: 'fingerprint-old',
  });
  const newAuth = authFor('a', {
    oauthToken: 'oauth-new',
    tokenFingerprint: 'fingerprint-new',
  });
  let currentAuth = oldAuth;
  let nowMs = BASE_NOW;
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return fetchResponse(usagePayload({ limits: [fableLimit()] }));
  };

  await _api.recordStatuslineUsage(statuslinePayload(), {
    authReader: async () => currentAuth,
    now: () => nowMs,
  });
  nowMs += 1000;
  await _api.getUsage({
    force: true,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => nowMs,
  });

  currentAuth = newAuth;
  nowMs += 1000;
  await _api.getUsage({
    force: true,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => nowMs,
  });
  assert.equal(requests, 2);

  nowMs += 1000;
  await _api.recordStatuslineUsage(statuslinePayload({ at: nowMs }), {
    authReader: async () => currentAuth,
    now: () => nowMs,
  });
  nowMs += 1000;
  const result = await _api.getUsage({
    force: false,
    authReader: async () => currentAuth,
    fetchImpl,
    now: () => nowMs,
  });

  assert.equal(requests, 2);
  assert.equal(result.source, 'claude-statusline');
  assert.equal(result.data.model_scoped[0].utilization, 21);
});

test('daily history requests only the selected account and never attributes unscoped rows', () => {
  const requestedKeys = [];
  const db = {
    getClaudeUsageSnapshots(_from, _to, key) {
      requestedKeys.push(key);
      return [];
    },
  };
  _api.setClaudeUsageProjectManagerForTests({ db });
  assert.deepEqual(_api.computeDailyHistory(7, accountKey('a')), []);
  assert.deepEqual(_api.computeDailyHistory(7, null), []);
  assert.deepEqual(requestedKeys, [accountKey('a')]);
});

test('keeps the Admin API key main-only while trusted billing can still use it', async (t) => {
  const touchedKeys = [
    'ANTHROPIC_ADMIN_API_KEY',
    'ANTHROPIC_ADMIN_KEY',
    'ANTHROPIC_API_KEY',
  ];
  const savedEnv = new Map(touchedKeys.map((key) => [
    key,
    {
      present: Object.hasOwn(process.env, key),
      value: process.env[key],
    },
  ]));
  const originalRequest = https.request;
  t.after(() => {
    https.request = originalRequest;
    for (const [key, original] of savedEnv) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
  });

  process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-ant-admin-integration-secret';
  delete process.env.ANTHROPIC_ADMIN_KEY;
  process.env.ANTHROPIC_API_KEY = 'ordinary-user-api-key';
  isolateMainProcessEnv();

  const childEnv = buildChildProcessEnv();
  assert.equal(Object.hasOwn(process.env, 'ANTHROPIC_ADMIN_API_KEY'), false);
  assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_ADMIN_API_KEY'), false);
  assert.equal(childEnv.ANTHROPIC_API_KEY, 'ordinary-user-api-key');
  assert.equal(childEnv.PATH, process.env.PATH);
  assert.equal(childEnv.HOME, process.env.HOME);

  const requests = [];
  https.request = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = (error) => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      queueMicrotask(() => {
        const isCostReport = String(url).includes('/cost_report');
        requests.push({
          url: String(url),
          headers: { ...options.headers },
        });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = isCostReport
          ? {}
          : { 'anthropic-organization-id': 'org-integration-test' };
        response.setEncoding = () => {};
        onResponse(response);
        response.emit('data', JSON.stringify(isCostReport
          ? {
              data: [{
                starting_at: '2030-01-10T00:00:00Z',
                results: [{ amount: '123', currency: 'USD' }],
              }],
            }
          : { data: [] }));
        response.emit('end');
      });
    };
    return request;
  };

  const billing = await _api.fetchApiPlatformBilling('sk-ant-api03-user-key', {
    accountKey: 'api:integration-test',
    force: true,
  });

  assert.equal(billing.ok, true);
  assert.equal(requests.length, 2);
  const costRequest = requests.find((request) => request.url.includes('/cost_report'));
  const modelRequest = requests.find((request) => request.url.includes('/models'));
  assert.equal(costRequest.headers['x-api-key'], 'sk-ant-admin-integration-secret');
  assert.equal(modelRequest.headers['x-api-key'], 'sk-ant-api03-user-key');
});

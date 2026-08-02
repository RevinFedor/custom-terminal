const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./codex-data');

function whamPayload(overrides = {}) {
  return {
    email: 'person@example.com',
    plan_type: 'pro_future',
    rate_limit: {
      primary_window: {
        used_percent: 34,
        limit_window_seconds: 18_000,
        reset_at: 1_800_000_000,
      },
      secondary_window: {
        used_percent: 100,
        limit_window_seconds: 604_800,
        reset_at: 1_800_600_000,
      },
    },
    ...overrides,
  };
}

function resetCreditsPayload(overrides = {}) {
  return {
    available_count: 2,
    total_earned_count: 0,
    credits: [
      {
        id: 'credit-a',
        reset_type: 'codex_rate_limits',
        is_supported_by_plan: true,
        status: 'available',
        expires_at: '2030-07-31T19:10:31.038193Z',
        title: 'Full reset',
      },
      {
        id: 'credit-b',
        reset_type: 'codex_rate_limits',
        is_supported_by_plan: true,
        status: 'available',
        expires_at: '2030-08-12T18:11:58.357747Z',
        title: 'Full reset',
      },
    ],
    ...overrides,
  };
}

const BASE_NOW = Date.parse('2027-07-10T17:20:00Z');

function iso(ms) {
  return new Date(ms).toISOString();
}

function usageResult({
  accountKey = 'account-a',
  five = 36,
  weekly = 39,
  fiveReset = BASE_NOW + 60 * 60 * 1000,
  weeklyReset = BASE_NOW + 3 * 24 * 60 * 60 * 1000,
  fetchedAt = BASE_NOW,
  label = 'pe***@example.com',
} = {}) {
  const usage = _api.buildCodexUsageFromRateLimits({
    primary: five == null ? null : {
      used_percent: five,
      window_minutes: 5 * 60,
      resets_at: iso(fiveReset),
    },
    secondary: weekly == null ? null : {
      used_percent: weekly,
      window_minutes: 7 * 24 * 60,
      resets_at: iso(weeklyReset),
    },
    plan_type: 'pro',
  }, iso(fetchedAt));
  return {
    account: {
      accountKey,
      label,
      accountHint: label,
      accountIdHint: 'workspac...',
      plan_type: 'pro',
      timestamp: iso(fetchedAt),
      source: 'openai-usage-api',
      usage,
    },
    fetchedAt,
  };
}

function acceptedEntry(result, overrides = {}) {
  return {
    account: result.account,
    fetchedAt: result.fetchedAt,
    pending: null,
    warning: null,
    ...overrides,
  };
}

function authFor(accountKey, overrides = {}) {
  return {
    accessToken: `token-${accountKey}`,
    tokenFingerprint: `fingerprint-${accountKey}`,
    accountId: `workspace-${accountKey}`,
    accountKey,
    email: `${accountKey}@example.com`,
    userId: `user-${accountKey}`,
    ...overrides,
  };
}

function whamUsageFor(auth, {
  five = 34,
  weekly = 39,
  fiveReset = 1_900_000_000,
  weeklyReset = 1_900_600_000,
  email = auth.email,
  accountId = auth.userId || auth.accountId,
} = {}) {
  return whamPayload({
    email,
    account_id: accountId,
    rate_limit: {
      primary_window: {
        used_percent: five,
        limit_window_seconds: 18_000,
        reset_at: fiveReset,
      },
      secondary_window: {
        used_percent: weekly,
        limit_window_seconds: 604_800,
        reset_at: weeklyReset,
      },
    },
  });
}

function fetchResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
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

function createFakeUsageStore(initialValue = null) {
  let value = initialValue == null ? null : JSON.parse(JSON.stringify(initialValue));
  const writes = [];
  return {
    writes,
    getAppState() {
      return value == null ? null : JSON.parse(JSON.stringify(value));
    },
    setAppState(_key, nextValue) {
      value = JSON.parse(JSON.stringify(nextValue));
      writes.push(JSON.parse(JSON.stringify(nextValue)));
    },
    snapshot() {
      return value == null ? null : JSON.parse(JSON.stringify(value));
    },
  };
}

test('maps five-hour and weekly windows by duration, not response position', () => {
  const payload = whamPayload({
    rate_limit: {
      primary_window: {
        used_percent: 80,
        limit_window_seconds: 604_800,
        reset_at: 1_800_600_000,
      },
      secondary_window: {
        used_percent: 20,
        limit_window_seconds: 18_000,
        reset_at: 1_800_000_000,
      },
    },
  });

  const usage = _api.buildCodexUsageFromWhamResponse(payload, 1_790_000_000_000);
  assert.equal(usage.five_hour.utilization, 20);
  assert.equal(usage.seven_day.utilization, 80);
  assert.equal(usage.plan_type, 'pro_future');
});

test('maps official app-server limits, credits, and model-specific buckets', () => {
  const mapped = _api.buildCodexUsageFromAppServerRateLimits({
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      planType: 'pro',
      primary: { usedPercent: 18, windowDurationMins: 7 * 24 * 60, resetsAt: 1_900_600_000 },
      secondary: { usedPercent: 7, windowDurationMins: 5 * 60, resetsAt: 1_900_000_000 },
      credits: { hasCredits: true, unlimited: false, balance: '12.5' },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'pro',
        primary: { usedPercent: 18, windowDurationMins: 7 * 24 * 60, resetsAt: 1_900_600_000 },
        secondary: { usedPercent: 7, windowDurationMins: 5 * 60, resetsAt: 1_900_000_000 },
      },
      codex_model: {
        limitId: 'codex_model',
        limitName: 'Codex model',
        planType: 'pro',
        primary: { usedPercent: 22, windowDurationMins: 7 * 24 * 60, resetsAt: 1_900_600_000 },
        secondary: null,
      },
    },
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{ status: 'available', expiresAt: 1_900_700_000, title: 'Full reset' }],
    },
  }, 1_800_000_000_000);

  assert.equal(mapped.usage.five_hour.utilization, 7);
  assert.equal(mapped.usage.seven_day.utilization, 18);
  assert.equal(mapped.usage.credits.balance, 12.5);
  assert.equal(mapped.usage.additional_rate_limits[0].key, 'codex_model');
  assert.equal(mapped.usage.additional_rate_limits[0].seven_day.utilization, 22);
  assert.equal(mapped.resetCredits.available_count, 1);
  assert.equal(mapped.resetCredits.credits[0].title, 'Full reset');
});

test('maps weekly-only main and model-specific limits without reviving a removed five-hour window', () => {
  const payload = whamPayload({
    credits: { has_credits: true, unlimited: false, balance: '12.5' },
    rate_limit: {
      primary_window: {
        used_percent: 54,
        limit_window_seconds: 604_800,
        reset_at: 1_800_600_000,
      },
      secondary_window: null,
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: {
            used_percent: 6,
            limit_window_seconds: 604_800,
            reset_at: 1_800_700_000,
          },
          secondary_window: null,
        },
      },
    ],
  });
  const current = _api.buildCodexUsageFromWhamResponse(payload, 1_790_000_000_000);
  assert.equal(current.authoritative_windows, true);
  assert.equal(current.five_hour, null);
  assert.equal(current.seven_day.utilization, 54);
  assert.equal(current.additional_rate_limits.length, 1);
  assert.equal(current.additional_rate_limits[0].key, 'codex_bengalfox');
  assert.equal(current.additional_rate_limits[0].seven_day.utilization, 6);
  assert.equal(current.additional_rate_limits[0].five_hour, null);
  assert.equal(current.credits.balance, 12.5);

  const previous = usageResult({ five: 100, weekly: 53 }).account.usage;
  const reconciled = _api.canonicalizeCodexUsage(current, previous);
  assert.equal(reconciled.five_hour, null);
  assert.equal(reconciled.seven_day.utilization, 54);

  const returned = _api.buildCodexUsageFromWhamResponse(whamPayload({
    rate_limit: {
      primary_window: { used_percent: 55, limit_window_seconds: 604_800, reset_at: 1_800_600_000 },
      secondary_window: { used_percent: 8, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
    },
  }), 1_790_000_001_000);
  const restored = _api.canonicalizeCodexUsage(returned, reconciled);
  assert.equal(restored.five_hour.utilization, 8);
  assert.equal(restored.seven_day.utilization, 55);
});

test('drops malformed and duplicate additional limits without disturbing main usage', () => {
  const usage = _api.buildCodexUsageFromWhamResponse(whamPayload({
    additional_rate_limits: [
      null,
      { limit_name: 'Unknown', metered_feature: 'unknown', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 86_400 }, secondary_window: null } },
      { limit_name: 'Spark', metered_feature: 'spark', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_at: 1_900_000_000 }, secondary_window: null } },
      { limit_name: 'Spark duplicate', metered_feature: 'spark', rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: 1_900_000_000 }, secondary_window: null } },
      { limit_name: 'Broken', metered_feature: 'broken', rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 604_800 }, secondary_window: null } },
    ],
  }), 1_790_000_000_000);
  assert.equal(usage.five_hour.utilization, 34);
  assert.equal(usage.seven_day.utilization, 100);
  assert.equal(usage.additional_rate_limits.length, 1);
  assert.equal(usage.additional_rate_limits[0].key, 'spark');
  assert.equal(usage.additional_rate_limits[0].seven_day.utilization, 10);
});

test('compares reset generations by duration after windows change position', () => {
  const newer = _api.buildCodexUsageFromWhamResponse(whamPayload({
    rate_limit: {
      primary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: 2_000_000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_000_000 },
    },
  }), Date.parse('2027-01-01T00:00:00Z'));
  const older = _api.buildCodexUsageFromWhamResponse(whamPayload({
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_500_000 },
      secondary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: 1_500_000 },
    },
  }), Date.parse('2027-01-02T00:00:00Z'));

  assert.ok(_api.compareCodexUsageFreshness(newer, older) > 0);
});

test('keeps an unknown window without mislabeling it as five-hour or weekly', () => {
  const payload = whamPayload({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 2_592_000,
        reset_at: 1_800_000_000,
      },
      secondary_window: null,
    },
  });

  const usage = _api.buildCodexUsageFromWhamResponse(payload, 1_790_000_000_000);
  assert.equal(usage.primary.utilization, 10);
  assert.equal(usage.five_hour, null);
  assert.equal(usage.seven_day, null);
});

test('treats empty or malformed windows as unavailable, never as zero remaining', () => {
  assert.throws(
    () => _api.buildCodexUsageFromWhamResponse(whamPayload({
      rate_limit: { primary_window: null, secondary_window: null },
    })),
    (error) => error.code === 'invalid_response'
  );
  assert.throws(
    () => _api.buildCodexUsageFromWhamResponse(whamPayload({
      rate_limit: { primary_window: { used_percent: 150 }, secondary_window: null },
    })),
    (error) => error.code === 'invalid_response'
  );
  const localUsage = _api.buildCodexUsageFromRateLimits({
    primary: { used_percent: 150, window_minutes: 300, resets_at: Number.MAX_VALUE },
  });
  assert.equal(localUsage.five_hour.utilization, null);
  assert.equal(localUsage.five_hour.resets_at, null);
  for (const malformed of ['', '   ', false]) {
    assert.throws(
      () => _api.buildCodexUsageFromWhamResponse(whamPayload({
        rate_limit: {
          primary_window: { used_percent: malformed, limit_window_seconds: 18_000 },
          secondary_window: null,
        },
      })),
      (error) => error.code === 'invalid_response'
    );
  }
  const falseLocalUsage = _api.buildCodexUsageFromRateLimits({
    primary: { used_percent: false, window_minutes: 300 },
  });
  assert.equal(falseLocalUsage.five_hour.utilization, null);
});

test('starts the expensive local scan only as a fallback', () => {
  const remoteAccount = { accountKey: 'current-account', isCurrent: true, stale: false };
  assert.equal(_api.shouldLoadCodexFallbackUsage({ accounts: [remoteAccount], error: null }), false);
  assert.equal(
    _api.shouldLoadCodexFallbackUsage({ accounts: [remoteAccount], error: null }, 'current-account'),
    false
  );
  assert.equal(
    _api.shouldLoadCodexFallbackUsage({ accounts: [remoteAccount], error: null }, 'historical-account'),
    true
  );
  assert.equal(
    _api.shouldLoadCodexFallbackUsage({
      accounts: [remoteAccount, { accountKey: 'historical-account', isCurrent: false, stale: true }],
      error: null,
    }, 'historical-account'),
    true
  );
  assert.equal(_api.shouldLoadCodexFallbackUsage({ accounts: [], error: null }), true);
  assert.equal(_api.shouldLoadCodexFallbackUsage({ accounts: [remoteAccount], error: 'offline' }), true);
});

test('reads the latest fallback snapshot from a bounded JSONL tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-tail-'));
  const filePath = path.join(dir, 'rollout-test.jsonl');
  try {
    const first = JSON.stringify({
      type: 'event_msg',
      timestamp: '2027-01-01T00:00:00Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 10, window_minutes: 300 },
          secondary: { used_percent: 20, window_minutes: 10_080 },
        },
      },
    });
    const latest = JSON.stringify({
      type: 'event_msg',
      timestamp: '2027-01-02T00:00:00Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 30, window_minutes: 300 },
          secondary: { used_percent: 40, window_minutes: 10_080 },
        },
      },
    });
    fs.writeFileSync(filePath, `${first}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'message', text: 'я'.repeat(300) } })}\n${latest}\n`);

    const usage = await _api.findLatestCodexUsageInFile(filePath, { maxBytes: 4096, chunkBytes: 73 });
    assert.equal(usage.five_hour.utilization, 30);
    assert.equal(usage.seven_day.utilization, 40);
    assert.equal(usage.timestamp, '2027-01-02T00:00:00Z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uses account-bound OAuth headers and maps a valid OpenAI response', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'date' ? 'Tue, 14 Jan 2027 12:00:00 GMT' : null },
      json: async () => whamPayload(),
    };
  };
  const auth = {
    accessToken: 'secret-token',
    accountId: 'workspace-1',
    accountKey: 'account-key-1',
    email: 'person@example.com',
  };

  const result = await _api.fetchCodexUsageFromOpenAI(auth, {
    fetchImpl,
    now: () => Date.parse('2027-01-14T12:00:01Z'),
  });

  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'workspace-1');
  assert.equal(result.account.accountKey, 'account-key-1');
  assert.equal(result.account.source, 'openai-usage-api');
  assert.equal(result.account.usage.five_hour.utilization, 34);
  assert.equal(result.account.usage.seven_day.utilization, 100);
});

test('filters reset-credit inventory to available supported future Codex resets', () => {
  const snapshot = _api.buildCodexResetCreditsFromResponse(resetCreditsPayload({
    available_count: 6,
    credits: [
      ...resetCreditsPayload().credits,
      { reset_type: 'other', is_supported_by_plan: true, status: 'available', expires_at: '2030-09-01T00:00:00Z', title: 'Wrong type' },
      { reset_type: 'codex_rate_limits', is_supported_by_plan: false, status: 'available', expires_at: '2030-09-01T00:00:00Z', title: 'Unsupported' },
      { reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'redeemed', expires_at: '2030-09-01T00:00:00Z', title: 'Redeemed' },
      { reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'available', expires_at: '2020-09-01T00:00:00Z', title: 'Expired' },
    ],
  }), Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(snapshot.available_count, 2);
  assert.equal(snapshot.credits.length, 2);
  assert.deepEqual(Object.keys(snapshot.credits[0]).sort(), ['expires_at', 'title']);
  assert.ok(Date.parse(snapshot.credits[0].expires_at) < Date.parse(snapshot.credits[1].expires_at));
  assert.doesNotMatch(JSON.stringify(snapshot), /credit-a|description|profile/i);
});

test('uses account-bound OAuth headers for reset-credit inventory', async () => {
  let request;
  const result = await _api.fetchCodexResetCreditsFromOpenAI(authFor('reset'), {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return fetchResponse(resetCreditsPayload());
    },
    now: () => Date.parse('2027-01-01T00:00:00Z'),
  });
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(request.options.headers.Authorization, 'Bearer token-reset');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'workspace-reset');
  assert.equal(result.available_count, 2);
});

test('rejects a response attributed to a different email', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => whamPayload({ email: 'other@example.com' }),
  });

  await assert.rejects(
    _api.fetchCodexUsageFromOpenAI({
      accessToken: 'secret-token',
      accountId: 'workspace-1',
      accountKey: 'account-key-1',
      email: 'person@example.com',
    }, { fetchImpl }),
    (error) => error.code === 'account_mismatch'
  );
});

test('rejects a response attributed to a different authenticated user id', async () => {
  const auth = {
    accessToken: 'secret-token',
    accountId: 'workspace-1',
    accountKey: 'account-key-1',
    email: 'person@example.com',
    userId: 'user-a',
  };
  const response = (userId) => fetchResponse(whamPayload({
    email: 'person@example.com',
    account_id: userId,
  }));

  await assert.rejects(
    _api.fetchCodexUsageFromOpenAI(auth, { fetchImpl: async () => response('user-b') }),
    (error) => error.code === 'account_mismatch'
  );
  const matched = await _api.fetchCodexUsageFromOpenAI(auth, {
    fetchImpl: async () => response('user-a'),
  });
  assert.equal(matched.account.accountKey, 'account-key-1');
});

test('classifies 429 and physically aborts a hung request', async () => {
  await assert.rejects(
    _api.fetchCodexUsageFromOpenAI({
      accessToken: 'secret-token',
      accountId: 'workspace-1',
      accountKey: 'account-key-1',
      email: 'person@example.com',
    }, {
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    (error) => error.code === 'rate_limited'
  );

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
    _api.fetchCodexUsageFromOpenAI({
      accessToken: 'secret-token',
      accountId: 'workspace-1',
      accountKey: 'account-key-1',
      email: 'person@example.com',
    }, { fetchImpl: hungFetch, timeoutMs: 5 }),
    (error) => error.code === 'timeout'
  );
  assert.equal(aborted, true);
});

test('classifies expired OAuth without replacing the previous value', async () => {
  await assert.rejects(
    _api.fetchCodexUsageFromOpenAI({
      accessToken: 'expired-token',
      accountId: 'workspace-1',
      accountKey: 'account-key-1',
      email: 'person@example.com',
    }, {
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    (error) => error.code === 'unauthorized'
  );
});

test('never lets a known different account overwrite the selected account', () => {
  const base = {
    activeUsage: { timestamp: '2027-01-01T00:00:00Z' },
    sessionId: 'same-thread',
    selectedSourceThreadId: 'same-thread',
  };
  assert.equal(_api.codexActiveUsageMatchesSelected({
    ...base,
    activeAccountKey: 'account-b',
    selectedAccountKey: 'account-a',
  }), false);
  assert.equal(_api.codexActiveUsageMatchesSelected({
    ...base,
    activeAccountKey: 'account-a',
    selectedAccountKey: 'account-a',
  }), true);
  assert.equal(_api.codexActiveUsageMatchesSelected({
    ...base,
    activeAccountKey: null,
    selectedAccountKey: 'account-a',
  }), true);
  assert.equal(_api.codexActiveUsageMatchesSelected({
    ...base,
    activeAccountKey: null,
    selectedAccountKey: null,
    selectedSourceThreadId: null,
  }), false);
  assert.equal(_api.codexActiveUsageMatchesSelected({
    ...base,
    activeAccountKey: 'account-a',
    selectedAccountKey: null,
    selectedSourceThreadId: null,
  }), true);
});

test('preferred server account replaces only the matching cached account', () => {
  const cached = [
    { accountKey: 'a', timestamp: '2027-01-01T00:00:00Z', usage: { marker: 'old-a' } },
    { accountKey: 'b', timestamp: '2027-01-01T00:00:00Z', usage: { marker: 'old-b' } },
  ];
  const server = [
    { accountKey: 'a', isCurrent: true, timestamp: '2027-01-02T00:00:00Z', usage: { marker: 'server-a' } },
  ];
  const merged = _api.mergeCodexPreferredAccounts(cached, server);
  assert.equal(merged.find((item) => item.accountKey === 'a').usage.marker, 'server-a');
  assert.equal(merged.find((item) => item.accountKey === 'b').usage.marker, 'old-b');
});

test('fetches reset credits once alongside initial usage consensus and keeps them runtime-only', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('credits');
  const store = createFakeUsageStore();
  _api.setCodexUsageStateStoreForTests(store);
  let usageRequests = 0;
  let resetRequests = 0;
  const result = await _api.getCodexRemoteUsage({
    force: true,
    verifyInitial: true,
    authReader: () => auth,
    fetchImpl: async () => {
      usageRequests += 1;
      return fetchResponse(whamUsageFor(auth));
    },
    resetCreditsFetchImpl: async () => {
      resetRequests += 1;
      return fetchResponse(resetCreditsPayload());
    },
  });
  assert.equal(usageRequests, 3);
  assert.equal(resetRequests, 1);
  assert.equal(result.accounts[0].reset_credits.available_count, 2);
  assert.equal(result.accounts[0].reset_credits.credits.length, 2);
  assert.equal(store.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /reset_credits|credit-a|credit-b/);
  _api.resetCodexUsageStateForTests();
});

test('keeps verified usage when the optional reset-credit request fails', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('optional');
  const result = await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => auth,
    fetchImpl: async () => fetchResponse(whamUsageFor(auth, { five: 22, weekly: 33 })),
    resetCreditsFetchImpl: async () => fetchResponse({ error: 'temporary' }, 503),
  });
  assert.equal(result.error, null);
  assert.equal(result.accounts[0].usage.five_hour.utilization, 22);
  assert.equal(result.accounts[0].usage.seven_day.utilization, 33);
  assert.equal(result.accounts[0].reset_credits, null);
  _api.resetCodexUsageStateForTests();
});

test('coalesces concurrent refreshes for the same account', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = {
    accessToken: 'token-a',
    tokenFingerprint: 'fingerprint-a',
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'person@example.com',
  };
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => whamPayload(),
    };
  };

  const [first, second] = await Promise.all([
    _api.getCodexRemoteUsage({ force: true, fetchImpl, authReader: () => auth }),
    _api.getCodexRemoteUsage({ force: true, fetchImpl, authReader: () => auth }),
  ]);

  assert.equal(requests, 1);
  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.equal(first.currentAccountKey, 'account-a');
  _api.resetCodexUsageStateForTests();
});

test('joins the new account inflight request when auth switches during an older account refresh', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = authFor('a');
  const authB = authFor('b');
  let currentAuth = authA;
  const calls = [];
  const fetchImpl = (_url, options) => {
    const pending = deferred();
    calls.push({ authorization: options.headers.Authorization, pending });
    return pending.promise;
  };

  const refreshA = _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => currentAuth,
  });
  await nextTurn();
  currentAuth = authB;
  const refreshB = _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => currentAuth,
  });
  await nextTurn();

  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer token-a', 'Bearer token-b']);
  calls[0].pending.resolve(fetchResponse(whamUsageFor(authA, { five: 10, weekly: 10 })));
  await nextTurn();
  assert.equal(calls.length, 2);

  calls[1].pending.resolve(fetchResponse(whamUsageFor(authB, { five: 40, weekly: 40 })));
  const [fromA, fromB] = await Promise.all([refreshA, refreshB]);
  assert.equal(calls.length, 2);
  assert.equal(fromA.currentAccountKey, 'b');
  assert.equal(fromB.currentAccountKey, 'b');
  assert.equal(fromA.accounts.find((account) => account.accountKey === 'b').usage.five_hour.utilization, 40);
  assert.equal(fromB.accounts.find((account) => account.accountKey === 'b').usage.five_hour.utilization, 40);

  const cached = await _api.getCodexRemoteUsage({
    fetchImpl,
    authReader: () => currentAuth,
  });
  assert.equal(calls.length, 2);
  assert.equal(cached.accounts.find((account) => account.accountKey === 'b').usage.five_hour.utilization, 40);
  _api.resetCodexUsageStateForTests();
});

test('reuses the completed new-account cache when it finishes before the old account request', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = authFor('a');
  const authB = authFor('b');
  let currentAuth = authA;
  const calls = [];
  const fetchImpl = (_url, options) => {
    const pending = deferred();
    calls.push({ authorization: options.headers.Authorization, pending });
    return pending.promise;
  };

  const refreshA = _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => currentAuth,
  });
  await nextTurn();
  currentAuth = authB;
  const refreshB = _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => currentAuth,
  });
  await nextTurn();

  calls[1].pending.resolve(fetchResponse(whamUsageFor(authB, { five: 40, weekly: 40 })));
  const fromB = await refreshB;
  assert.equal(fromB.accounts.find((account) => account.accountKey === 'b').usage.five_hour.utilization, 40);

  calls[0].pending.resolve(fetchResponse(whamUsageFor(authA, { five: 10, weekly: 10 })));
  const fromA = await refreshA;
  assert.deepEqual(calls.map((call) => call.authorization), ['Bearer token-a', 'Bearer token-b']);
  assert.equal(fromA.currentAccountKey, 'b');
  assert.equal(fromA.accounts.find((account) => account.accountKey === 'b').usage.five_hour.utilization, 40);
  _api.resetCodexUsageStateForTests();
});

test('discards an in-flight response when Codex auth disappears', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = authFor('a');
  let currentAuth = authA;
  let pendingRefresh = null;
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    if (requests === 1) return fetchResponse(whamUsageFor(authA, { five: 34, weekly: 39 }));
    pendingRefresh = deferred();
    return pendingRefresh.promise;
  };

  const seeded = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => currentAuth,
  });
  assert.equal(seeded.accounts[0].usage.five_hour.utilization, 34);

  const refresh = _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => currentAuth,
  });
  while (!pendingRefresh) await nextTurn();
  currentAuth = null;
  pendingRefresh.resolve(fetchResponse(whamUsageFor(authA, { five: 90, weekly: 90 })));

  const result = await refresh;
  assert.equal(result.currentAccountKey, null);
  assert.match(result.error, /not signed in/i);
  const historicalA = result.accounts.find((account) => account.accountKey === 'a');
  assert.ok(historicalA);
  assert.equal(historicalA.isCurrent, false);
  assert.equal(historicalA.usage.five_hour.utilization, 34);
  assert.equal(historicalA.usage.seven_day.utilization, 39);
  assert.equal(historicalA.lastError, null);
  _api.resetCodexUsageStateForTests();
});

test('verifies a new account with three requests and keeps the matching majority', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = {
    accessToken: 'token-a',
    tokenFingerprint: 'fingerprint-a',
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'person@example.com',
  };
  const payloads = [
    whamPayload({
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_at: 1_800_000_600 },
        secondary_window: { used_percent: 1, limit_window_seconds: 604_800, reset_at: 1_800_600_600 },
      },
    }),
    whamPayload(),
    whamPayload({
      rate_limit: {
        primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 99, limit_window_seconds: 604_800, reset_at: 1_800_600_000 },
      },
    }),
  ];
  let requests = 0;
  const result = await _api.getCodexRemoteUsage({
    force: true,
    verifyInitial: true,
    authReader: () => auth,
    fetchImpl: async () => {
      const payload = payloads[requests] || payloads[payloads.length - 1];
      requests += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => payload,
      };
    },
  });

  assert.equal(requests, 3);
  assert.equal(result.error, null);
  const current = result.accounts.find((account) => account.isCurrent);
  assert.equal(current.usage.five_hour.utilization, 35);
  assert.equal(current.usage.seven_day.utilization, 99);
  _api.resetCodexUsageStateForTests();
});

test('stores nothing when initial verification has no consensus or both confirmations fail', async () => {
  const auth = authFor('a');

  for (const mode of ['disagree', 'confirmation-errors']) {
    _api.resetCodexUsageStateForTests();
    const store = createFakeUsageStore();
    _api.setCodexUsageStateStoreForTests(store);
    let requests = 0;
    const result = await _api.getCodexRemoteUsage({
      force: true,
      verifyInitial: true,
      authReader: () => auth,
      fetchImpl: async () => {
        const index = requests++;
        if (mode === 'confirmation-errors' && index > 0) throw new Error('confirmation failed');
        const used = mode === 'disagree' ? [0, 50, 100][index] : 34;
        return fetchResponse(whamUsageFor(auth, { five: used, weekly: used }));
      },
    });

    assert.equal(requests, 3, mode);
    assert.match(result.error, /inconsistent/i, mode);
    assert.equal(result.accounts.some((account) => account.usage), false, mode);
    assert.equal(store.writes.length, 0, mode);
    assert.equal(store.snapshot(), null, mode);
  }
  _api.resetCodexUsageStateForTests();
});

test('discards an old-account response and retries once with the new auth snapshot', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = {
    accessToken: 'token-a',
    tokenFingerprint: 'fingerprint-a',
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'a@example.com',
  };
  const authB = {
    accessToken: 'token-b',
    tokenFingerprint: 'fingerprint-b',
    accountId: 'workspace-b',
    accountKey: 'account-b',
    email: 'b@example.com',
  };
  let authReads = 0;
  const authReader = () => authReads++ === 0 ? authA : authB;
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests += 1;
    const isB = options.headers.Authorization === 'Bearer token-b';
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => whamPayload({ email: isB ? 'b@example.com' : 'a@example.com' }),
    };
  };

  const result = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader,
  });

  assert.equal(requests, 2);
  assert.equal(result.error, null);
  assert.equal(result.currentAccountKey, 'account-b');
  assert.equal(result.accounts.some((account) => account.accountKey === 'account-a'), false);
  assert.equal(result.accounts.some((account) => account.accountKey === 'account-b'), true);
  _api.resetCodexUsageStateForTests();
});

test('retries a stale-token error once after Codex rotates OAuth', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = {
    accessToken: 'token-a',
    tokenFingerprint: 'fingerprint-a',
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'person@example.com',
  };
  const authB = { ...authA, accessToken: 'token-b', tokenFingerprint: 'fingerprint-b' };
  let authReads = 0;
  let requests = 0;
  const result = await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => authReads++ === 0 ? authA : authB,
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (options.headers.Authorization === 'Bearer token-a') {
        return { ok: false, status: 401, headers: { get: () => null } };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => whamPayload(),
      };
    },
  });

  assert.equal(requests, 2);
  assert.equal(result.error, null);
  assert.equal(result.currentAccountKey, 'account-a');
  _api.resetCodexUsageStateForTests();
});

test('does not reuse a fresh cache entry after the OAuth token changes', async () => {
  _api.resetCodexUsageStateForTests();
  const baseAuth = {
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'person@example.com',
  };
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => whamPayload(),
    };
  };
  await _api.getCodexRemoteUsage({
    fetchImpl,
    authReader: () => ({ ...baseAuth, accessToken: 'token-a', tokenFingerprint: 'fingerprint-a' }),
  });
  await _api.getCodexRemoteUsage({
    fetchImpl,
    authReader: () => ({ ...baseAuth, accessToken: 'token-b', tokenFingerprint: 'fingerprint-b' }),
  });

  assert.equal(requests, 2);
  _api.resetCodexUsageStateForTests();
});

test('retains cached usage when OAuth returns 401 or is already expired', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('a');
  const store = createFakeUsageStore();
  _api.setCodexUsageStateStoreForTests(store);
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    if (requests === 1) {
      return fetchResponse(whamUsageFor(auth, { five: 34, weekly: 39 }));
    }
    return fetchResponse(null, 401);
  };

  const seeded = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  assert.equal(seeded.error, null);
  assert.equal(store.writes.length, 1);

  const unauthorized = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  assert.match(unauthorized.error, /login expired/i);
  assert.equal(unauthorized.currentAccountKey, 'a');
  assert.equal(unauthorized.accounts[0].usage.five_hour.utilization, 34);
  assert.equal(unauthorized.accounts[0].usage.seven_day.utilization, 39);
  assert.equal(store.writes.length, 1);

  const expired = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => ({ ...auth, accessExpiresAtMs: Date.now() - 1 }),
  });
  assert.equal(requests, 2);
  assert.match(expired.error, /login expired/i);
  assert.equal(expired.currentAccountKey, 'a');
  assert.equal(expired.accounts[0].usage.five_hour.utilization, 34);
  assert.equal(expired.accounts[0].usage.seven_day.utilization, 39);
  assert.equal(store.writes.length, 1);
  _api.resetCodexUsageStateForTests();
});

test('does not attach an old-account network error when the replacement auth is unusable', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = {
    accessToken: 'token-a',
    tokenFingerprint: 'fingerprint-a',
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'a@example.com',
  };
  const authB = {
    accessToken: null,
    tokenFingerprint: 'fingerprint-b',
    accountId: 'workspace-b',
    accountKey: 'account-b',
    email: 'b@example.com',
  };
  let authReads = 0;
  const result = await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => authReads++ === 0 ? authA : authB,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  assert.equal(result.currentAccountKey, null);
  assert.match(result.error, /not signed in/i);
  assert.equal(result.accounts.some((account) => account.isCurrent), false);
  assert.equal(result.accounts.some((account) => account.accountKey === 'account-b' && account.lastError), false);
  _api.resetCodexUsageStateForTests();
});

test('does not reuse cached usage from account A when account B fails', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = {
    accessToken: 'token-a',
    tokenFingerprint: 'fingerprint-a',
    accountId: 'workspace-a',
    accountKey: 'account-a',
    email: 'a@example.com',
  };
  const authB = {
    accessToken: 'token-b',
    tokenFingerprint: 'fingerprint-b',
    accountId: 'workspace-b',
    accountKey: 'account-b',
    email: 'b@example.com',
  };
  await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => authA,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => whamPayload({ email: 'a@example.com' }),
    }),
  });

  const result = await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => authB,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  assert.equal(result.currentAccountKey, 'account-b');
  assert.match(result.error, /refresh/i);
  assert.equal(result.accounts.some((account) => account.accountKey === 'account-a' && account.isCurrent), false);
  assert.equal(result.accounts.some((account) => account.accountKey === 'account-b' && account.usage), false);
  _api.resetCodexUsageStateForTests();
});

test('holds a one-request 99/100 regression and clears it when the normal branch returns', () => {
  const previous = usageResult();
  const outlier = usageResult({
    five: 0,
    weekly: 1,
    fiveReset: BASE_NOW + 70 * 60 * 1000,
    weeklyReset: BASE_NOW + 3 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
    fetchedAt: BASE_NOW + 1000,
  });

  const held = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(previous),
    outlier,
    BASE_NOW + 1000
  );
  assert.equal(held.status, 'pending');
  assert.equal(held.accepted, false);
  assert.equal(held.entry.account.usage.five_hour.utilization, 36);
  assert.equal(held.entry.account.usage.seven_day.utilization, 39);
  assert.equal(held.entry.pending.account.usage.five_hour.utilization, 0);
  assert.equal(held.entry.pending.account.usage.seven_day.utilization, 1);

  const normal = usageResult({ fetchedAt: BASE_NOW + 2000 });
  const restored = _api.reconcileCodexUsageSnapshot(held.entry, normal, BASE_NOW + 2000);
  assert.equal(restored.status, 'accepted');
  assert.equal(restored.accepted, true);
  assert.equal(restored.entry.pending, null);
  assert.equal(restored.entry.warning, null);
  assert.equal(restored.entry.account.usage.five_hour.utilization, 36);
  assert.equal(restored.entry.account.usage.seven_day.utilization, 39);
});

test('accepts a repeated new branch only after it remains stable for 30 seconds', () => {
  const previous = usageResult({ five: 34, weekly: 100 });
  const resetFive = BASE_NOW + 6 * 60 * 60 * 1000;
  const resetWeekly = BASE_NOW + 4 * 24 * 60 * 60 * 1000;
  const firstReset = usageResult({
    five: 0,
    weekly: 1,
    fiveReset: resetFive,
    weeklyReset: resetWeekly,
    fetchedAt: BASE_NOW + 1000,
  });
  const pending = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(previous),
    firstReset,
    BASE_NOW + 1000
  );
  assert.equal(pending.status, 'pending');
  assert.equal(pending.entry.account.usage.five_hour.utilization, 34);
  assert.equal(pending.entry.account.usage.seven_day.utilization, 100);

  const confirmedReset = usageResult({
    five: 1,
    weekly: 7,
    fiveReset: resetFive,
    weeklyReset: resetWeekly,
    fetchedAt: BASE_NOW + 32_000,
  });
  const confirmed = _api.reconcileCodexUsageSnapshot(
    pending.entry,
    confirmedReset,
    BASE_NOW + 32_000
  );
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.entry.pending, null);
  assert.equal(confirmed.entry.account.usage.five_hour.utilization, 1);
  assert.equal(confirmed.entry.account.usage.seven_day.utilization, 7);
});

test('does not accept two matching suspicious responses inside 30 seconds', () => {
  const previous = usageResult({ five: 34, weekly: 100 });
  const candidate = usageResult({
    five: 0,
    weekly: 1,
    fiveReset: BASE_NOW + 6 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 4 * 24 * 60 * 60 * 1000,
    fetchedAt: BASE_NOW + 1000,
  });
  const first = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(previous),
    candidate,
    BASE_NOW + 1000
  );
  const second = _api.reconcileCodexUsageSnapshot(
    first.entry,
    { ...candidate, fetchedAt: BASE_NOW + 29_000 },
    BASE_NOW + 29_000
  );

  assert.equal(second.status, 'pending');
  assert.equal(second.accepted, false);
  assert.equal(second.entry.pending.firstSeenAt, BASE_NOW + 1000);
  assert.equal(second.entry.account.usage.five_hour.utilization, 34);
  assert.equal(second.entry.account.usage.seven_day.utilization, 100);
});

test('accepts an elapsed five-hour reset but still holds a false weekly reset', () => {
  const previous = usageResult({
    five: 100,
    weekly: 80,
    fiveReset: BASE_NOW - 1000,
    weeklyReset: BASE_NOW + 3 * 24 * 60 * 60 * 1000,
  });
  const legitimateFiveHourReset = usageResult({
    five: 1,
    weekly: 80,
    fiveReset: BASE_NOW + 5 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 3 * 24 * 60 * 60 * 1000,
    fetchedAt: BASE_NOW + 1000,
  });
  const accepted = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(previous),
    legitimateFiveHourReset,
    BASE_NOW + 1000
  );
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.entry.account.usage.five_hour.utilization, 1);

  const falseWeeklyReset = usageResult({
    five: 2,
    weekly: 0,
    fiveReset: BASE_NOW + 5 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 3 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
    fetchedAt: BASE_NOW + 2000,
  });
  const held = _api.reconcileCodexUsageSnapshot(
    accepted.entry,
    falseWeeklyReset,
    BASE_NOW + 2000
  );
  assert.equal(held.status, 'pending');
  assert.equal(held.accepted, false);
  assert.equal(held.entry.account.usage.five_hour.utilization, 1);
  assert.equal(held.entry.account.usage.seven_day.utilization, 80);
});

test('rejects an older reset generation after a newer generation was accepted', () => {
  const newer = usageResult({
    five: 5,
    weekly: 8,
    fiveReset: BASE_NOW + 5 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 7 * 24 * 60 * 60 * 1000,
  });
  const older = usageResult({
    five: 95,
    weekly: 70,
    fiveReset: BASE_NOW + 4 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 6 * 24 * 60 * 60 * 1000,
    fetchedAt: BASE_NOW + 1000,
  });

  const result = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(newer),
    older,
    BASE_NOW + 1000
  );
  assert.equal(result.status, 'obsolete');
  assert.equal(result.accepted, false);
  assert.equal(result.entry.pending, null);
  assert.equal(result.entry.account.usage.five_hour.utilization, 5);
  assert.equal(result.entry.account.usage.seven_day.utilization, 8);
});

test('never confirms a mixed snapshot with an older five-hour reset and newer weekly reset', () => {
  const previous = usageResult({
    five: 40,
    weekly: 50,
    fiveReset: BASE_NOW + 5 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 4 * 24 * 60 * 60 * 1000,
  });
  const mixed = usageResult({
    five: 45,
    weekly: 10,
    fiveReset: BASE_NOW + 4 * 60 * 60 * 1000,
    weeklyReset: BASE_NOW + 5 * 24 * 60 * 60 * 1000,
    fetchedAt: BASE_NOW + 1000,
  });

  const first = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(previous),
    mixed,
    BASE_NOW + 1000
  );
  assert.equal(first.status, 'obsolete');
  assert.equal(first.accepted, false);
  assert.equal(first.entry.pending, null);

  const repeated = _api.reconcileCodexUsageSnapshot(
    first.entry,
    { ...mixed, fetchedAt: BASE_NOW + 32_000 },
    BASE_NOW + 32_000
  );
  assert.equal(repeated.status, 'obsolete');
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.entry.pending, null);
  assert.equal(repeated.entry.account.usage.five_hour.utilization, 40);
  assert.equal(repeated.entry.account.usage.seven_day.utilization, 50);
});

test('preserves the previous window when OpenAI returns only one window', () => {
  const previous = usageResult({ five: 30, weekly: 50 });
  const partial = usageResult({
    five: 31,
    weekly: null,
    fetchedAt: BASE_NOW + 1000,
  });

  const result = _api.reconcileCodexUsageSnapshot(
    acceptedEntry(previous),
    partial,
    BASE_NOW + 1000
  );
  assert.equal(result.status, 'accepted');
  assert.equal(result.entry.account.usage.five_hour.utilization, 31);
  assert.equal(result.entry.account.usage.seven_day.utilization, 50);
});

test('initial consensus selects the matching normal pair over one outlier', () => {
  const normalA = usageResult({ fetchedAt: BASE_NOW + 1000 });
  const outlier = usageResult({
    five: 0,
    weekly: 1,
    fiveReset: BASE_NOW + 70 * 60 * 1000,
    weeklyReset: BASE_NOW + 3 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
    fetchedAt: BASE_NOW + 3000,
  });
  const normalB = usageResult({ five: 37, weekly: 40, fetchedAt: BASE_NOW + 2000 });

  const result = _api.selectCodexInitialUsageConsensus([normalA, outlier, normalB]);
  assert.strictEqual(result, normalB);
});

test('manual refresh verifies a suspicious usage branch immediately with matching consensus', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('manual-consensus');
  let responseMode = 'seed';
  let refreshRequests = 0;
  const fetchImpl = async () => {
    if (responseMode === 'seed') {
      return fetchResponse(whamUsageFor(auth, {
        five: 88,
        weekly: 89,
        fiveReset: 1_900_000_000,
        weeklyReset: 1_900_600_000,
      }));
    }
    refreshRequests += 1;
    return fetchResponse(whamUsageFor(auth, {
      five: 0,
      weekly: 0,
      fiveReset: 1_900_000_600,
      weeklyReset: 1_900_600_600,
    }));
  };

  const seeded = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  assert.equal(seeded.warning, null);
  assert.equal(seeded.accounts[0].usage.seven_day.utilization, 89);

  responseMode = 'refresh';
  const refreshed = await _api.getCodexRemoteUsage({
    force: true,
    verifyInitial: true,
    fetchImpl,
    authReader: () => auth,
  });

  assert.equal(refreshRequests, 3);
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.warning, null);
  assert.equal(refreshed.accounts[0].stale, false);
  assert.equal(refreshed.accounts[0].usage.five_hour.utilization, 0);
  assert.equal(refreshed.accounts[0].usage.seven_day.utilization, 0);
  _api.resetCodexUsageStateForTests();
});

test('manual refresh keeps the verified snapshot when confirmation responses disagree', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('manual-disagreement');
  let responses = [whamUsageFor(auth, { five: 70, weekly: 80 })];
  const fetchImpl = async () => fetchResponse(responses.shift());

  await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  responses = [
    whamUsageFor(auth, { five: 0, weekly: 0, fiveReset: 1_900_000_600, weeklyReset: 1_900_600_600 }),
    whamUsageFor(auth, { five: 40, weekly: 40, fiveReset: 1_900_000_600, weeklyReset: 1_900_600_600 }),
    whamUsageFor(auth, { five: 90, weekly: 90, fiveReset: 1_900_000_600, weeklyReset: 1_900_600_600 }),
  ];

  const refreshed = await _api.getCodexRemoteUsage({
    force: true,
    verifyInitial: true,
    fetchImpl,
    authReader: () => auth,
  });

  assert.match(refreshed.error, /inconsistent/i);
  assert.equal(refreshed.accounts[0].usage.five_hour.utilization, 70);
  assert.equal(refreshed.accounts[0].usage.seven_day.utilization, 80);
  _api.resetCodexUsageStateForTests();
});

test('persists at most eight sanitized account snapshots and safely ignores corrupt state', () => {
  const entries = new Map();
  for (let index = 0; index < 10; index++) {
    const result = usageResult({
      accountKey: `account-${index}`,
      label: `ac***${index}@example.com`,
      five: 10 + index,
      weekly: 20 + index,
      fetchedAt: BASE_NOW + index,
    });
    if (index === 9) {
      result.account.usage = {
        ...result.account.usage,
        authoritative_windows: true,
        additional_rate_limits_observed: true,
        additional_rate_limits: [{
          key: 'codex_bengalfox',
          label: 'GPT-5.3-Codex-Spark',
          five_hour: null,
          seven_day: {
            utilization: 6,
            resets_at: iso(BASE_NOW + 4 * 24 * 60 * 60 * 1000),
            window_minutes: 10_080,
          },
        }],
        credits: { has_credits: true, unlimited: false, balance: 12.5 },
      };
      result.account.reset_credits = resetCreditsPayload();
    }
    entries.set(result.account.accountKey, {
      ...acceptedEntry({
        ...result,
        account: {
          ...result.account,
          accessToken: `secret-token-${index}`,
          token: `secret-${index}`,
          email: `full-${index}@example.com`,
          accountId: `workspace-secret-${index}`,
        },
      }),
      tokenFingerprint: `fingerprint-${index}`,
      error: `error-${index}`,
      pending: { secret: `pending-${index}` },
    });
  }

  const serialized = _api.serializeCodexUsageState(entries);
  assert.equal(serialized.version, 1);
  assert.equal(serialized.accounts.length, 8);
  assert.equal(serialized.accounts[0].account.accountKey, 'account-9');
  const encoded = JSON.stringify(serialized);
  assert.doesNotMatch(encoded, /secret-token|workspace-secret|full-\d@example\.com/);
  assert.doesNotMatch(encoded, /tokenFingerprint|"error"|"pending"/);
  for (const item of serialized.accounts) {
    assert.equal(Object.hasOwn(item.account, 'accessToken'), false);
    assert.equal(Object.hasOwn(item.account, 'email'), false);
    assert.equal(Object.hasOwn(item.account, 'accountId'), false);
  }

  const restored = _api.parseCodexUsageState(encoded);
  assert.equal(restored.length, 8);
  assert.equal(restored[0].account.accountKey, 'account-9');
  assert.equal(restored[0].tokenFingerprint, null);
  assert.equal(restored[0].pending, null);
  assert.equal(restored[0].error, null);
  assert.equal(restored[0].account.usage.authoritative_windows, true);
  assert.equal(restored[0].account.usage.additional_rate_limits.length, 1);
  assert.equal(restored[0].account.usage.additional_rate_limits[0].seven_day.utilization, 6);
  assert.equal(restored[0].account.usage.credits.balance, 12.5);
  assert.equal(Object.hasOwn(restored[0].account, 'reset_credits'), false);

  assert.deepEqual(_api.parseCodexUsageState('{broken json'), []);
  assert.deepEqual(_api.parseCodexUsageState({ version: 2, accounts: serialized.accounts }), []);
  assert.deepEqual(_api.parseCodexUsageState({
    version: 1,
    accounts: [
      null,
      { account: { accountKey: '', usage: {} } },
      { account: { accountKey: 'bad-usage', usage: { five_hour: { utilization: 'not-a-number' } } } },
      { account: { accountKey: 'null-usage', usage: { five_hour: { utilization: null, window_minutes: 300 } } } },
      { account: { accountKey: 'infinite-usage', usage: { seven_day: { utilization: Infinity, window_minutes: 10_080 } } } },
    ],
  }), []);
});

test('keeps an authoritative weekly-only account weekly-only after persistence roundtrip', () => {
  const usage = _api.buildCodexUsageFromWhamResponse(whamPayload({
    rate_limit: {
      primary_window: { used_percent: 54, limit_window_seconds: 604_800, reset_at: 1_900_000_000 },
      secondary_window: null,
    },
  }), Date.parse('2027-01-01T00:00:00Z'));
  const result = usageResult();
  result.account.usage = usage;
  const serialized = _api.serializeCodexUsageState(new Map([
    [result.account.accountKey, acceptedEntry(result)],
  ]));
  const [restored] = _api.parseCodexUsageState(serialized);
  assert.equal(restored.account.usage.authoritative_windows, true);
  assert.equal(restored.account.usage.five_hour, null);
  assert.equal(restored.account.usage.seven_day.utilization, 54);
});

test('accepts an explicit five-hour removal and restores it when the API returns it again', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('window-transition');
  const responses = [
    whamUsageFor(auth, { five: 20, weekly: 40 }),
    whamUsageFor(auth, { five: null, weekly: 41 }),
    whamUsageFor(auth, { five: 7, weekly: 42 }),
  ];
  let requestIndex = 0;
  const fetchImpl = async () => fetchResponse(responses[requestIndex++]);

  const present = await _api.getCodexRemoteUsage({ force: true, fetchImpl, authReader: () => auth });
  assert.equal(present.accounts[0].usage.five_hour.utilization, 20);

  const absent = await _api.getCodexRemoteUsage({ force: true, fetchImpl, authReader: () => auth });
  assert.equal(absent.warning, null);
  assert.equal(absent.accounts[0].usage.five_hour, null);
  assert.equal(absent.accounts[0].usage.seven_day.utilization, 41);

  const returned = await _api.getCodexRemoteUsage({ force: true, fetchImpl, authReader: () => auth });
  assert.equal(returned.warning, null);
  assert.equal(returned.accounts[0].usage.five_hour.utilization, 7);
  assert.equal(returned.accounts[0].usage.seven_day.utilization, 42);
  assert.equal(requestIndex, 3);
  _api.resetCodexUsageStateForTests();
});

test('keeps the verified value and persisted state across a forced 99/100 upstream outlier', async () => {
  _api.resetCodexUsageStateForTests();
  const auth = authFor('a');
  const store = createFakeUsageStore();
  _api.setCodexUsageStateStoreForTests(store);
  const normal = whamUsageFor(auth, { five: 36, weekly: 39 });
  const outlier = whamUsageFor(auth, {
    five: 0,
    weekly: 1,
    fiveReset: 1_900_000_600,
    weeklyReset: 1_900_600_600,
  });
  const responses = [normal, outlier, normal];
  let requests = 0;
  const fetchImpl = async () => fetchResponse(responses[requests++]);

  const accepted = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  assert.equal(accepted.error, null);
  assert.equal(accepted.accounts[0].usage.five_hour.utilization, 36);
  assert.equal(accepted.accounts[0].usage.seven_day.utilization, 39);
  assert.equal(store.writes.length, 1);
  const persistedBeforeOutlier = store.snapshot();

  const held = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  assert.equal(held.error, null);
  assert.match(held.warning, /inconsistent/i);
  assert.equal(held.accounts[0].stale, true);
  assert.equal(held.accounts[0].usage.five_hour.utilization, 36);
  assert.equal(held.accounts[0].usage.seven_day.utilization, 39);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.snapshot(), persistedBeforeOutlier);

  const restored = await _api.getCodexRemoteUsage({
    force: true,
    fetchImpl,
    authReader: () => auth,
  });
  assert.equal(requests, 3);
  assert.equal(restored.error, null);
  assert.equal(restored.warning, null);
  assert.equal(restored.accounts[0].stale, false);
  assert.equal(restored.accounts[0].usage.five_hour.utilization, 36);
  assert.equal(restored.accounts[0].usage.seven_day.utilization, 39);
  assert.equal(store.writes.length, 2);
  _api.resetCodexUsageStateForTests();
});

test('restores multiple accounts after restart and refetches the live account', async () => {
  _api.resetCodexUsageStateForTests();
  const authA = authFor('a');
  const authB = authFor('b');
  const store = createFakeUsageStore();
  _api.setCodexUsageStateStoreForTests(store);

  await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => authA,
    fetchImpl: async () => fetchResponse(whamUsageFor(authA, { five: 30, weekly: 40 })),
  });
  await _api.getCodexRemoteUsage({
    force: true,
    authReader: () => authB,
    fetchImpl: async () => fetchResponse(whamUsageFor(authB, { five: 44, weekly: 49 })),
  });
  assert.equal(store.writes.length, 2);
  assert.equal(store.snapshot().accounts.length, 2);

  _api.resetCodexUsageStateForTests();
  _api.setCodexUsageStateStoreForTests(store);
  const signedOut = await _api.getCodexRemoteUsage({ authReader: () => null });
  assert.equal(signedOut.currentAccountKey, null);
  assert.equal(signedOut.accounts.length, 2);
  assert.equal(signedOut.accounts.some((account) => account.isCurrent), false);

  let refetches = 0;
  const restored = await _api.getCodexRemoteUsage({
    authReader: () => authB,
    fetchImpl: async () => {
      refetches += 1;
      return fetchResponse(whamUsageFor(authB, { five: 45, weekly: 50 }));
    },
  });
  assert.equal(refetches, 1);
  assert.equal(restored.currentAccountKey, 'b');
  assert.equal(restored.accounts.length, 2);
  assert.equal(restored.accounts.find((account) => account.accountKey === 'b').isCurrent, true);
  assert.equal(restored.accounts.find((account) => account.accountKey === 'b').usage.five_hour.utilization, 45);
  assert.equal(restored.accounts.find((account) => account.accountKey === 'a').isCurrent, false);
  assert.equal(restored.accounts.find((account) => account.accountKey === 'a').usage.five_hour.utilization, 30);
  _api.resetCodexUsageStateForTests();
});

test('does not replace a selected persisted OpenAI snapshot with a local fallback', () => {
  const persisted = {
    accountKey: 'historical-account',
    source: 'openai-usage-api',
    usage: usageResult().account.usage,
    isCurrent: false,
    stale: true,
  };
  assert.equal(_api.shouldLoadCodexFallbackUsage({
    accounts: [
      { accountKey: 'current-account', isCurrent: true, stale: false },
      persisted,
    ],
    error: null,
  }, 'historical-account'), false);
});

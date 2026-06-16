// Claude usage limits IPC.
//
// Reads the OAuth access token from the macOS Keychain entry
// "Claude Code-credentials" (created by claude CLI when the user signs in),
// then queries https://api.anthropic.com/api/oauth/usage — same endpoint the
// Blimp-Labs claude-usage-bar app uses. Returns weekly + 5-hour utilization +
// extra-credits usage. Response is cached in-process for 5 minutes to avoid
// rate-limiting (server polls every 30m by default).
//
// Schema (relevant fields):
//   five_hour:  { utilization: %, resets_at: ISO }
//   seven_day:  { utilization: %, resets_at: ISO }
//   seven_day_opus / seven_day_sonnet: same shape
//   extra_usage: { is_enabled, utilization, used_credits, monthly_limit, currency }

const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const https = require('https');
const crypto = require('crypto');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ADMIN_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
const KEYCHAIN_API_SERVICE = 'Claude Code';
const KEYCHAIN_OAUTH_SERVICE = 'Claude Code-credentials';
// Polling cadence — renderer ticks every 3 min, cache TTL чуть меньше, чтобы
// каждый плановый poll реально дёргал сеть, а не сидел на кэше. Anthropic
// `/oauth/usage` rate-limit раздаёт 429 даже при 1 запросе/мин — 3 мин
// заметно реже триггерит окно. См. fact-claude-usage-chip.md::Polling cadence.
const CACHE_TTL_MS = 170 * 1000;

// `lastErrorAt` — when the most recent live fetch failed. While the last
// network attempt is still recent we refuse to make another live request even
// on cache miss, to avoid hammering Anthropic during a 429 window. Force-
// refresh from the UI ignores this gate. Cooldown = ~polling interval so
// ретрай совпадает со следующим плановым тиком.
let cache = { at: 0, accountKey: null, data: null, error: null, lastErrorAt: 0, lastAttemptAt: 0 };
const ERROR_COOLDOWN_MS = 180 * 1000;
let apiBillingCache = { at: 0, accountKey: null, data: null, error: null, lastAttemptAt: 0 };
const API_BILLING_CACHE_TTL_MS = 10 * 60 * 1000;

// Reconstruct minimal /oauth/usage-shaped object from the last persisted
// snapshot. Used as fallback when the in-memory cache is empty (cold start)
// AND the live fetch is unavailable (429, network drop, etc) — without this
// the chip falls back to '—' even though we have a recent reading on disk.
// Missing fields (extra_usage, opus / sonnet breakdown) — we only persist the
// scalars, so the popover's optional rows disappear; this is acceptable
// degradation vs a completely blank chip.
function snapshotToUsageData(snap) {
  if (!snap) return null;
  const utilOrNull = (v) => (v == null ? null : Number(v));
  const opus = utilOrNull(snap.weekly_opus_pct);
  const sonnet = utilOrNull(snap.weekly_sonnet_pct);
  return {
    five_hour: snap.five_hour_pct != null
      ? { utilization: Number(snap.five_hour_pct), resets_at: snap.five_hour_resets_at || null }
      : null,
    seven_day: snap.weekly_pct != null
      ? { utilization: Number(snap.weekly_pct), resets_at: snap.weekly_resets_at || null }
      : null,
    seven_day_opus: opus != null
      ? { utilization: opus, resets_at: snap.weekly_resets_at || null }
      : null,
    seven_day_sonnet: sonnet != null
      ? { utilization: sonnet, resets_at: snap.weekly_resets_at || null }
      : null,
  };
}

function loadFallbackFromSnapshot() {
  if (!_projectManager?.db) return null;
  try {
    const snap = _projectManager.db.getLatestClaudeUsageSnapshot?.();
    if (!snap) return null;
    return { data: snapshotToUsageData(snap), at: snap.ts * 1000 };
  } catch (e) {
    console.error('[ClaudeUsage] snapshot fallback failed:', e.message);
    return null;
  }
}
let _projectManager = null;

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

function maskOrgId(value) {
  if (!value || typeof value !== 'string') return null;
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function getAdminApiKey() {
  const value = process.env.ANTHROPIC_ADMIN_API_KEY || process.env.ANTHROPIC_ADMIN_KEY || '';
  const trimmed = value.trim();
  return trimmed.startsWith('sk-ant-admin') ? trimmed : null;
}

function readKeychainService(service) {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toString().trim());
    });
  });
}

function parseKeychainPayload(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function findNestedString(obj, keyRegex) {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (keyRegex.test(key) && typeof nested === 'string' && nested.trim()) {
        return nested.trim();
      }
      const found = walk(nested);
      if (found) return found;
    }
    return null;
  };
  return walk(obj);
}

function extractOauthToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload?.claudeAiOauth?.accessToken
    || payload?.oauth?.accessToken
    || payload?.accessToken
    || findNestedString(payload, /^accessToken$/i);
}

function extractApiKey(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') {
    const value = payload.trim();
    return value.startsWith('sk-ant-') ? value : null;
  }
  if (typeof payload !== 'object') return null;
  const value = payload?.apiKey
    || payload?.anthropicApiKey
    || payload?.ANTHROPIC_API_KEY
    || findNestedString(payload, /^(apiKey|anthropicApiKey|ANTHROPIC_API_KEY)$/);
  return typeof value === 'string' && value.trim().startsWith('sk-ant-') ? value.trim() : null;
}

function maskEmail(value) {
  if (!value || typeof value !== 'string' || !value.includes('@')) return null;
  const [local, domain] = value.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string' || token.split('.').length < 3) return null;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function readClaudeAuthState() {
  const [apiRaw, oauthRaw] = await Promise.all([
    readKeychainService(KEYCHAIN_API_SERVICE),
    readKeychainService(KEYCHAIN_OAUTH_SERVICE),
  ]);

  const apiPayload = parseKeychainPayload(apiRaw);
  const oauthPayload = parseKeychainPayload(oauthRaw);
  const apiKeyFromApiService = extractApiKey(apiPayload);
  const apiKeyFromOauthService = extractApiKey(oauthPayload);
  const oauthFromApiService = extractOauthToken(apiPayload);
  const oauthFromOauthService = extractOauthToken(oauthPayload);
  const apiKey = apiKeyFromApiService || apiKeyFromOauthService || null;
  const oauthToken = oauthFromApiService || oauthFromOauthService || null;
  const oauthClaims = decodeJwtPayload(oauthToken);
  const email = maskEmail(
    findNestedString(apiPayload, /email/i)
    || findNestedString(oauthPayload, /email/i)
    || findNestedString(oauthClaims, /email/i)
  );

  return {
    apiKey,
    apiKeySource: apiKeyFromApiService ? KEYCHAIN_API_SERVICE : (apiKeyFromOauthService ? KEYCHAIN_OAUTH_SERVICE : null),
    oauthToken,
    oauthSource: oauthFromApiService ? KEYCHAIN_API_SERVICE : (oauthFromOauthService ? KEYCHAIN_OAUTH_SERVICE : null),
    email,
    currentKind: apiKeyFromApiService ? 'api-platform' : (oauthFromApiService || oauthFromOauthService ? 'max-oauth' : (apiKey ? 'api-platform' : null)),
  };
}

function buildClaudeUsageAccounts(authState, usageData = null) {
  const accounts = [];
  const oauthKey = authState?.oauthToken ? `oauth:${shortHash(authState.oauthToken)}` : null;
  const apiKey = authState?.apiKey ? `api:${shortHash(authState.apiKey)}` : null;
  const apiKeySuffix = authState?.apiKey ? authState.apiKey.slice(-4).toUpperCase() : null;

  const apiAccount = apiKey ? {
    accountKey: apiKey,
    kind: 'api-platform',
    label: `API ${apiKeySuffix || apiKey.slice(-4).toUpperCase()}`,
    accountHint: 'Anthropic API Platform',
    accountIdHint: apiKeySuffix ? `key ${apiKeySuffix}` : null,
    source: `keychain:${authState.apiKeySource || KEYCHAIN_API_SERVICE}`,
    isCurrent: authState.currentKind === 'api-platform',
    usage: null,
    notice: null,
    error: null,
  } : null;

  const oauthAccount = oauthKey ? {
    accountKey: oauthKey,
    kind: 'max-oauth',
    label: authState.email || 'Max OAuth',
    accountHint: 'Claude Max subscription',
    accountIdHint: `oauth ${oauthKey.slice(6).toUpperCase()}`,
    source: `keychain:${authState.oauthSource || KEYCHAIN_OAUTH_SERVICE}`,
    isCurrent: authState.currentKind === 'max-oauth',
    usage: usageData || null,
    error: null,
  } : null;

  if (authState?.currentKind === 'api-platform') {
    if (apiAccount) accounts.push(apiAccount);
    if (oauthAccount) accounts.push(oauthAccount);
  } else {
    if (oauthAccount) accounts.push(oauthAccount);
    if (apiAccount) accounts.push(apiAccount);
  }

  if (!accounts.length && usageData) {
    accounts.push({
      accountKey: 'oauth:cached',
      kind: 'max-oauth',
      label: 'Max cached',
      accountHint: 'Last persisted Claude Max snapshot',
      accountIdHint: null,
      source: 'sqlite:claude_usage_snapshots',
      isCurrent: false,
      usage: usageData,
      error: null,
    });
  }

  return accounts;
}

function pickClaudeAccount(accounts, requestedAccountKey = null) {
  if (!accounts.length) return null;
  if (requestedAccountKey) {
    const requested = accounts.find((account) => account.accountKey === requestedAccountKey);
    if (requested) return requested;
  }
  return accounts.find((account) => account.isCurrent) || accounts[0];
}

function readKeychainToken() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN_OAUTH_SERVICE, '-w'], (err, stdout) => {
      if (err) return reject(new Error(`Keychain entry "${KEYCHAIN_OAUTH_SERVICE}" not found. Sign in via claude CLI.`));
      try {
        const j = JSON.parse(stdout.toString().trim());
        const token = extractOauthToken(j);
        if (!token) return reject(new Error('No accessToken in keychain payload.'));
        resolve(token);
      } catch (e) {
        reject(new Error('Failed to parse keychain payload: ' + e.message));
      }
    });
  });
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'noted-terminal/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function fetchJson(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let body = null;
        if (buf) {
          try { body = JSON.parse(buf); }
          catch (e) {
            return reject(new Error(`Bad JSON from ${new URL(url).pathname}: ${e.message}`));
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = body?.error?.message || body?.message || buf.slice(0, 200) || `HTTP ${res.statusCode}`;
          return reject(new Error(`HTTP ${res.statusCode}: ${message}`));
        }
        resolve({ body, headers: res.headers, statusCode: res.statusCode });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcMonthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseCostAmountMinor(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

function summarizeCostReport(response, now = Date.now()) {
  const buckets = Array.isArray(response?.data) ? response.data : [];
  const monthStart = utcMonthStart(now);
  const last7Start = utcDayStart(now) - 6 * 24 * 60 * 60 * 1000;
  let monthMinor = 0;
  let last7Minor = 0;
  let totalMinor = 0;
  let currency = 'USD';
  let latestBucketAt = null;
  const daily = [];

  for (const bucket of buckets) {
    const startMs = Date.parse(bucket?.starting_at || '');
    if (!Number.isFinite(startMs)) continue;
    let bucketMinor = 0;
    for (const result of bucket.results || []) {
      bucketMinor += parseCostAmountMinor(result?.amount);
      if (result?.currency) currency = String(result.currency).toUpperCase();
    }
    totalMinor += bucketMinor;
    if (startMs >= monthStart) monthMinor += bucketMinor;
    if (startMs >= last7Start) last7Minor += bucketMinor;
    latestBucketAt = latestBucketAt == null ? startMs : Math.max(latestBucketAt, startMs);
    daily.push({
      date: String(bucket.starting_at).slice(0, 10),
      amountUsd: bucketMinor / 100,
    });
  }

  return {
    ok: true,
    source: 'admin-api',
    adminKeyConfigured: true,
    currency,
    monthSpendUsd: monthMinor / 100,
    last7dSpendUsd: last7Minor / 100,
    last31dSpendUsd: totalMinor / 100,
    bucketCount: daily.length,
    latestBucketDate: latestBucketAt == null ? null : new Date(latestBucketAt).toISOString().slice(0, 10),
    balanceAvailable: false,
    balanceNote: 'Remaining API credits / balance are not exposed by the public Admin API; use Claude Console Billing for that number.',
    daily,
  };
}

async function fetchApiKeyStatus(apiKey) {
  if (!apiKey) return null;
  const res = await fetchJson(MODELS_URL, {
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey,
    'User-Agent': 'noted-terminal/1.0',
  }, 10000);
  const orgId = res.headers?.['anthropic-organization-id'] || null;
  return {
    ok: true,
    orgId,
    orgIdShort: maskOrgId(orgId),
  };
}

async function fetchApiPlatformBilling(apiKey, opts = {}) {
  const now = Date.now();
  const accountKey = opts.accountKey || (apiKey ? `api:${shortHash(apiKey)}` : 'api:none');
  const force = !!opts.force;
  if (!force && apiBillingCache.data && apiBillingCache.accountKey === accountKey && (now - apiBillingCache.at) < API_BILLING_CACHE_TTL_MS) {
    return { ...apiBillingCache.data, cachedMsAgo: now - apiBillingCache.at, lastAttemptAt: apiBillingCache.lastAttemptAt };
  }

  const adminKey = getAdminApiKey();
  if (!adminKey) {
    const data = {
      ok: false,
      source: 'admin-api',
      adminKeyConfigured: false,
      error: null,
      balanceAvailable: false,
      balanceNote: 'Set ANTHROPIC_ADMIN_API_KEY to show API spend. Regular Claude API keys cannot read cost reports.',
      lastAttemptAt: apiBillingCache.lastAttemptAt,
    };
    apiBillingCache = { at: now, accountKey, data, error: null, lastAttemptAt: apiBillingCache.lastAttemptAt };
    return data;
  }

  apiBillingCache.lastAttemptAt = now;
  const end = utcDayStart(now) + 24 * 60 * 60 * 1000;
  const start = end - 31 * 24 * 60 * 60 * 1000;
  const url = new URL(ADMIN_COST_URL);
  url.searchParams.set('starting_at', isoUtc(start));
  url.searchParams.set('ending_at', isoUtc(end));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', '31');

  try {
    const [costResult, keyStatusResult] = await Promise.allSettled([
      fetchJson(url.toString(), {
        'anthropic-version': '2023-06-01',
        'x-api-key': adminKey,
        'Content-Type': 'application/json',
        'User-Agent': 'noted-terminal/1.0',
      }, 20000),
      fetchApiKeyStatus(apiKey),
    ]);

    if (costResult.status === 'rejected') throw costResult.reason;
    const summary = summarizeCostReport(costResult.value.body, now);
    if (keyStatusResult.status === 'fulfilled' && keyStatusResult.value) {
      summary.apiKeyStatus = keyStatusResult.value;
    } else if (keyStatusResult.status === 'rejected') {
      summary.apiKeyStatus = {
        ok: false,
        error: keyStatusResult.reason?.message || String(keyStatusResult.reason),
      };
    }
    summary.lastAttemptAt = now;
    apiBillingCache = { at: now, accountKey, data: summary, error: null, lastAttemptAt: now };
    console.log(`[ClaudeUsage] api-platform billing fetched account=${accountKey.slice(0, 14)} month=$${summary.monthSpendUsd.toFixed(2)} last7d=$${summary.last7dSpendUsd.toFixed(2)} org=${summary.apiKeyStatus?.orgIdShort || 'unknown'}`);
    return summary;
  } catch (e) {
    const data = {
      ok: false,
      source: 'admin-api',
      adminKeyConfigured: true,
      error: e.message || String(e),
      balanceAvailable: false,
      balanceNote: 'Remaining API credits / balance are not exposed by the public Admin API; use Claude Console Billing for that number.',
      lastAttemptAt: now,
    };
    apiBillingCache = { at: now, accountKey, data, error: data.error, lastAttemptAt: now };
    console.warn(`[ClaudeUsage] api-platform billing failed: ${data.error}`);
    return data;
  }
}

async function getUsage(opts = {}) {
  const force = !!(typeof opts === 'boolean' ? opts : opts.force);
  const requestedAccountKey = typeof opts === 'object' && opts ? opts.accountKey || null : null;
  const now = Date.now();
  const authState = await readClaudeAuthState();
  let accounts = buildClaudeUsageAccounts(authState, null);
  let selectedAccount = pickClaudeAccount(accounts, requestedAccountKey);

  if (!selectedAccount) {
    return {
      ok: false,
      data: null,
      accounts: [],
      selectedAccountKey: null,
      currentAccountKey: null,
      error: `No Claude OAuth token or API key found in keychain items "${KEYCHAIN_API_SERVICE}" / "${KEYCHAIN_OAUTH_SERVICE}".`,
      lastAttemptAt: cache.lastAttemptAt,
    };
  }

  if (selectedAccount.kind === 'api-platform') {
    const billing = await fetchApiPlatformBilling(authState.apiKey, {
      force,
      accountKey: selectedAccount.accountKey,
    });
    accounts = accounts.map((account) => (
      account.accountKey === selectedAccount.accountKey
        ? { ...account, billing }
        : account
    ));
    selectedAccount = accounts.find((account) => account.accountKey === selectedAccount.accountKey) || selectedAccount;
    console.log(`[ClaudeUsage] account selected kind=api-platform accounts=${accounts.length} selected=${selectedAccount.label} billing=${billing?.ok ? 'ok' : (billing?.adminKeyConfigured ? 'error' : 'missing-admin-key')}`);
    return {
      ok: true,
      data: null,
      accounts,
      selectedAccountKey: selectedAccount.accountKey,
      currentAccountKey: accounts.find((account) => account.isCurrent)?.accountKey || selectedAccount.accountKey,
      authKind: selectedAccount.kind,
      billing,
      notice: selectedAccount.notice,
      error: null,
      lastAttemptAt: billing?.lastAttemptAt || cache.lastAttemptAt,
    };
  }

  const selectedAccountKey = selectedAccount.accountKey;
  // Cache hit — explicitly clear the previous error in cache so callers know
  // the world is fine again (previous behaviour left a stale `cache.error`
  // pointing at a long-passed 429, and the renderer's banner survived even
  // through successful polling cycles).
  if (!force && cache.data && cache.accountKey === selectedAccountKey && (now - cache.at) < CACHE_TTL_MS) {
    accounts = buildClaudeUsageAccounts(authState, cache.data);
    return {
      ok: true,
      data: cache.data,
      accounts,
      selectedAccountKey,
      currentAccountKey: accounts.find((account) => account.isCurrent)?.accountKey || selectedAccountKey,
      authKind: selectedAccount.kind,
      cachedMsAgo: now - cache.at,
      error: null,
      lastAttemptAt: cache.lastAttemptAt,
    };
  }
  // Background polling honours an error-cooldown to avoid pummeling Anthropic
  // while a 429 window is active. Force refresh (user pressed the refresh
  // button) bypasses this — they explicitly want a live attempt.
  if (!force && cache.accountKey === selectedAccountKey && cache.lastErrorAt && (now - cache.lastErrorAt) < ERROR_COOLDOWN_MS) {
    // Cold-start case: cooldown active but no in-memory data yet — seed from
    // last persisted snapshot so the chip isn't blank during the wait.
    if (!cache.data) {
      const fb = loadFallbackFromSnapshot();
      if (fb) { cache.data = fb.data; cache.at = fb.at; cache.accountKey = selectedAccountKey; }
    }
    accounts = buildClaudeUsageAccounts(authState, cache.data);
    return {
      ok: !!cache.data && !cache.error,
      data: cache.data || null,
      accounts,
      selectedAccountKey,
      currentAccountKey: accounts.find((account) => account.isCurrent)?.accountKey || selectedAccountKey,
      authKind: selectedAccount.kind,
      error: cache.error || null,
      cachedMsAgo: cache.at ? now - cache.at : null,
      cooldownMsLeft: ERROR_COOLDOWN_MS - (now - cache.lastErrorAt),
      lastAttemptAt: cache.lastAttemptAt,
    };
  }
  cache.lastAttemptAt = now;
  try {
    const token = authState.oauthToken;
    if (!token) throw new Error('No Claude OAuth accessToken available for Max usage. Current Claude auth may be API Platform only.');
    const data = await fetchUsage(token);
    cache = { at: now, accountKey: selectedAccountKey, data, error: null, lastErrorAt: 0, lastAttemptAt: now };
    accounts = buildClaudeUsageAccounts(authState, data);
    console.log('[ClaudeUsage] fetched account=' + (selectedAccount.label || selectedAccount.kind) + ' accounts=' + accounts.length + ' 5h=' + (data?.five_hour?.utilization ?? '?') + '% 7d=' + (data?.seven_day?.utilization ?? '?') + '%');
    // Persist snapshot for daily-history aggregation. Run on every real
    // network fetch (not on cache hits) — gives ~1 snapshot/min when chip is
    // visible. Failed network fetches don't reach here, so we don't store
    // bogus rows.
    if (_projectManager?.db) {
      try {
        _projectManager.db.saveClaudeUsageSnapshot({
          ts: Math.floor(now / 1000),
          weekly_pct: data?.seven_day?.utilization ?? null,
          five_hour_pct: data?.five_hour?.utilization ?? null,
          weekly_opus_pct: data?.seven_day_opus?.utilization ?? null,
          weekly_sonnet_pct: data?.seven_day_sonnet?.utilization ?? null,
          weekly_resets_at: data?.seven_day?.resets_at ?? null,
          five_hour_resets_at: data?.five_hour?.resets_at ?? null,
        });
      } catch (e) {
        console.error('[ClaudeUsage] snapshot save failed:', e.message);
      }
    }
    return {
      ok: true,
      data,
      accounts,
      selectedAccountKey,
      currentAccountKey: accounts.find((account) => account.isCurrent)?.accountKey || selectedAccountKey,
      authKind: selectedAccount.kind,
      cachedMsAgo: 0,
      error: null,
      lastAttemptAt: now,
    };
  } catch (e) {
    console.error('[ClaudeUsage] fetch failed:', e.message);
    if (cache.accountKey !== selectedAccountKey) {
      cache.data = null;
      cache.at = 0;
    }
    cache.error = e.message;
    cache.lastErrorAt = now;
    cache.lastAttemptAt = now;
    cache.accountKey = selectedAccountKey;
    // Cold-start: live fetch failed AND no in-memory data — seed from
    // persisted snapshot so renderer still gets real numbers. `error` поле
    // remains set so banner is visible, but chip shows %, не прочерк.
    if (!cache.data) {
      const fb = loadFallbackFromSnapshot();
      if (fb) { cache.data = fb.data; cache.at = fb.at; cache.accountKey = selectedAccountKey; }
    }
    accounts = buildClaudeUsageAccounts(authState, cache.data);
    return {
      ok: false,
      error: e.message,
      data: cache.data || null,
      accounts,
      selectedAccountKey,
      currentAccountKey: accounts.find((account) => account.isCurrent)?.accountKey || selectedAccountKey,
      authKind: selectedAccount.kind,
      lastAttemptAt: now,
    };
  }
}

// Aggregate snapshots into per-day buckets. Day boundary = local midnight
// (user-perceived "today" is local-time-based, not UTC). Returns descending
// array of { date: 'YYYY-MM-DD', delta, max, was_reset } for the last N days.
//
// Reset detection — TWO signals, ANY of which fires marks the boundary:
//
//  1. `resets_at` rotation by CALENDAR DAY. Anthropic weekly buckets rotate
//     once a week, ~7 days apart. Each snapshot carries the bucket's planned
//     reset moment in `weekly_resets_at` (string with microsecond jitter, do
//     NOT compare raw). Slicing just the date portion (YYYY-MM-DD) is the
//     correct resolution: real rotations cross days, jitter never does.
//
//     Example from production:
//       2026-05-20 22:00 → 22% (resets_at = "2026-05-26T00:00:00Z")
//       2026-05-21 07:57 → 21% (resets_at = "2026-05-27T01:00:00.xxx+00:00")
//       Different reset DAYS → bucket rotated overnight → today's 21% is
//       NOT a continuation of yesterday's 22%; the 22→21 transition is NOT
//       new activity, it's a fresh weekly bucket.
//
//  2. Hard drop > 10pp between consecutive snapshots in the SAME bucket. Used
//     when resets_at happens to be missing (NULL) or to catch the rare case
//     where Anthropic ratejitters a bucket day boundary itself by minutes —
//     a sane fallback that almost never fires.
function resetsAtDay(s) {
  if (!s) return null;
  return String(s).slice(0, 10); // YYYY-MM-DD
}

function computeDailyHistory(days = 7) {
  if (!_projectManager?.db) return [];
  const now = Math.floor(Date.now() / 1000);
  const fromTs = now - (days * 24 * 60 * 60) - (24 * 60 * 60); // +1 day buffer for cross-midnight last sample
  const rows = _projectManager.db.getClaudeUsageSnapshots(fromTs, now);
  if (rows.length === 0) return [];

  // Bucket by local date (YYYY-MM-DD)
  const byDay = new Map();
  for (const row of rows) {
    const d = new Date(row.ts * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  // For each day: detect reset, compute usage from day-start to day-end.
  // Day-start baseline = the previous day's last snapshot weekly_pct (or 0
  // if no data). Day-delta = max during the day - day-start baseline,
  // unless reset happened — then = post-reset max.
  const sortedDays = Array.from(byDay.keys()).sort();
  const out = [];
  let prevDayLastWeekly = null;
  let prevDayLastResetDay = null;
  for (const day of sortedDays) {
    const snapshots = byDay.get(day);
    let dayMax = 0;
    let dayMaxFiveHour = 0;
    let wasReset = false;
    let postResetStart = null;

    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      const w = s.weekly_pct ?? 0;
      const fh = s.five_hour_pct ?? 0;
      if (fh > dayMaxFiveHour) dayMaxFiveHour = fh;

      const curResetDay = resetsAtDay(s.weekly_resets_at);

      if (i === 0) {
        // Boundary check between yesterday and today: either reset_day shifted
        // (bucket rotated) or weekly% fell hard (no resets_at info).
        const dayShifted = prevDayLastResetDay && curResetDay && curResetDay !== prevDayLastResetDay;
        const dropped = prevDayLastWeekly != null && (prevDayLastWeekly - w > 10);
        if (dayShifted || dropped) {
          wasReset = true;
          postResetStart = w;
        }
      } else {
        // Within the day: same signals.
        const prevSnap = snapshots[i - 1];
        const prevResetDay = resetsAtDay(prevSnap.weekly_resets_at);
        const prevW = prevSnap.weekly_pct ?? 0;
        const dayShifted = prevResetDay && curResetDay && curResetDay !== prevResetDay;
        const dropped = prevW - w > 10;
        if (dayShifted || dropped) {
          wasReset = true;
          postResetStart = w;
        }
      }

      if (w > dayMax) dayMax = w;
    }

    const lastInDay = snapshots[snapshots.length - 1];
    const baseline = wasReset
      ? (postResetStart ?? 0)
      : (prevDayLastWeekly ?? (snapshots[0].weekly_pct ?? 0));
    const delta = Math.max(0, dayMax - baseline);

    out.push({
      date: day,
      delta: Math.round(delta * 10) / 10,
      max: Math.round(dayMax * 10) / 10,
      fiveHourMax: Math.round(dayMaxFiveHour * 10) / 10,
      wasReset,
      sampleCount: snapshots.length,
    });

    prevDayLastWeekly = lastInDay.weekly_pct;
    prevDayLastResetDay = resetsAtDay(lastInDay.weekly_resets_at);
  }

  // Cap to requested window, descending (today first)
  return out.slice(-days).reverse();
}

// ========== AGENT ACTIVITY AGGREGATION ==========
//
// Raw rows are CLOSED intervals (start_ts/end_ts ms) with a denormalized
// identity snapshot. We aggregate three ways for the popover's "Activity"
// section: by local day, by project, by tab. "Active time" = wall-clock union:
// if two agents run in parallel for an hour, the total is one hour, not two.
//
// Intervals can straddle local midnight, so by-day buckets split each interval
// at midnight boundaries (same local-date convention as the usage chart).

const ACTIVITY_ENGINES = ['claude', 'claude-sdk', 'gemini', 'codex'];

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Next local-midnight strictly after `ms`, as an epoch-ms number.
function nextLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0); // rolls into next day at 00:00:00.000 local
  return d.getTime();
}

function emptyActivityEngineMap() {
  return { claude: 0, 'claude-sdk': 0, gemini: 0, codex: 0 };
}

function normalizeActivityEngine(engine) {
  return ACTIVITY_ENGINES.includes(engine) ? engine : 'claude';
}

function computeUnionActivity(slices) {
  const events = [];
  for (const slice of slices || []) {
    const start = Number(slice.start);
    const end = Number(slice.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const engine = normalizeActivityEngine(slice.engine);
    events.push({ t: start, engine, delta: 1 });
    events.push({ t: end, engine, delta: -1 });
  }
  if (events.length === 0) return { ms: 0, byEngine: emptyActivityEngineMap() };

  events.sort((a, b) => (a.t - b.t) || (b.delta - a.delta));

  const active = new Map();
  const byEngine = emptyActivityEngineMap();
  let totalMs = 0;
  let prev = events[0].t;
  let i = 0;

  while (i < events.length) {
    const t = events[i].t;
    if (t > prev) {
      const activeEngines = ACTIVITY_ENGINES.filter((engine) => (active.get(engine) || 0) > 0);
      if (activeEngines.length > 0) {
        const dur = t - prev;
        totalMs += dur;
        // The day bar is a wall-clock bar. If Claude and Codex overlap for the
        // same slice, split that visual slice between them so segments still sum
        // to 100% while preserving the union total.
        const share = dur / activeEngines.length;
        for (const engine of activeEngines) byEngine[engine] += share;
      }
    }

    while (i < events.length && events[i].t === t) {
      const event = events[i];
      active.set(event.engine, Math.max(0, (active.get(event.engine) || 0) + event.delta));
      i += 1;
    }
    prev = t;
  }

  return { ms: Math.round(totalMs), byEngine };
}

function computeActivityStatsFromRows(rows, days = 14, now = Date.now()) {
  const fromTs = now - days * 24 * 60 * 60 * 1000;
  const allSlices = [];
  const byDay = new Map();      // date → [{ start, end, engine }]
  const byProject = new Map();  // projectId|path → { projectName, projectPath, ms, tabs:Set }
  const byTab = new Map();      // tabId → { tabName, projectName, engine, ms }

  for (const r of rows || []) {
    // Clip to window
    const start = Math.max(Number(r.start_ts), fromTs);
    const end = Math.min(Number(r.end_ts), now);
    if (end <= start) continue;
    const engine = normalizeActivityEngine(r.engine);
    allSlices.push({ start, end, engine });

    // By day — split across local-midnight boundaries.
    let cursor = start;
    while (cursor < end) {
      const boundary = Math.min(nextLocalMidnight(cursor), end);
      const key = localDayKey(cursor);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ start: cursor, end: boundary, engine });
      cursor = boundary;
    }

    // By project — key on id when present, else path, else '∅'.
    const pKey = r.project_id || r.project_path || '∅';
    if (!byProject.has(pKey)) {
      byProject.set(pKey, {
        projectId: r.project_id || null,
        projectName: r.project_name || null,
        projectPath: r.project_path || null,
        intervals: [],
        tabs: new Set(),
      });
    }
    const p = byProject.get(pKey);
    p.intervals.push({ start, end, engine });
    if (r.tab_id) p.tabs.add(r.tab_id);
    if (!p.projectName && r.project_name) p.projectName = r.project_name;

    // By tab.
    const tKey = r.tab_id || `${pKey}:${r.tab_name || '?'}`;
    if (!byTab.has(tKey)) {
      byTab.set(tKey, {
        tabId: r.tab_id || null,
        tabName: r.tab_name || null,
        projectName: r.project_name || null,
        engine,
        intervals: [],
      });
    }
    byTab.get(tKey).intervals.push({ start, end, engine });
  }

  const totalMs = computeUnionActivity(allSlices).ms;

  const byDayArr = Array.from(byDay.entries())
    .map(([date, slices]) => {
      const union = computeUnionActivity(slices);
      return { date, ms: union.ms, byEngine: union.byEngine };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // descending (today first)

  const byProjectArr = Array.from(byProject.values())
    .map((p) => {
      const union = computeUnionActivity(p.intervals);
      return {
        projectId: p.projectId,
        projectName: p.projectName,
        projectPath: p.projectPath,
        ms: union.ms,
        tabCount: p.tabs.size,
      };
    })
    .sort((a, b) => b.ms - a.ms);

  const byTabArr = Array.from(byTab.values())
    .map((t) => ({
      tabId: t.tabId,
      tabName: t.tabName,
      projectName: t.projectName,
      engine: t.engine,
      ms: computeUnionActivity(t.intervals).ms,
    }))
    .sort((a, b) => b.ms - a.ms);

  return { ok: true, totalMs, byDay: byDayArr, byProject: byProjectArr, byTab: byTabArr };
}

function computeActivityStats(days = 14) {
  if (!_projectManager?.db) return { ok: true, totalMs: 0, byDay: [], byProject: [], byTab: [] };
  const now = Date.now();
  const fromTs = now - days * 24 * 60 * 60 * 1000;
  const rows = _projectManager.db.getActivityIntervals(fromTs, now);
  return computeActivityStatsFromRows(rows, days, now);
}

function register({ projectManager }) {
  _projectManager = projectManager;

  ipcMain.handle('claude-usage:get', async (_e, opts) => {
    return getUsage({
      force: !!(opts && opts.force),
      accountKey: opts && opts.accountKey ? String(opts.accountKey) : null,
    });
  });

  ipcMain.handle('claude-usage:activity', async (_e, opts) => {
    try {
      const days = (opts && Number.isFinite(opts.days)) ? opts.days : 14;
      return computeActivityStats(days);
    } catch (e) {
      console.error('[ClaudeUsage] activity stats failed:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('claude-usage:daily-history', async (_e, opts) => {
    try {
      const days = (opts && Number.isFinite(opts.days)) ? opts.days : 7;
      const history = computeDailyHistory(days);
      return { ok: true, history };
    } catch (e) {
      console.error('[ClaudeUsage] daily-history failed:', e.message);
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  _api: {
    buildClaudeUsageAccounts,
    computeActivityStatsFromRows,
    computeUnionActivity,
    fetchApiPlatformBilling,
    getUsage,
    readClaudeAuthState,
    summarizeCostReport,
  },
};

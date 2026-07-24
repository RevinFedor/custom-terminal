// Claude usage limits IPC.
//
// Current Claude identity comes from `claude auth status --json`. Quota data
// primarily arrives through Claude Code's official statusLine `rate_limits`
// payload and is recorded by the existing bridge watcher in main.js. Older
// OAuth credentials may also query /api/oauth/usage. A `/login managed key`
// is deliberately not treated as OAuth: it is an API-shaped credential and
// Anthropic rejects it on the OAuth usage endpoint.

const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const {
  buildChildProcessEnv,
  getMainProcessEnvValue,
} = require('../child-process-env');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ADMIN_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
const KEYCHAIN_API_SERVICE = 'Claude Code';
const KEYCHAIN_OAUTH_SERVICE = 'Claude Code-credentials';
const CACHE_TTL_MS = 170 * 1000;
const ERROR_COOLDOWN_MS = 180 * 1000;
const API_BILLING_CACHE_TTL_MS = 10 * 60 * 1000;
const USAGE_TIMEOUT_MS = 8 * 1000;
const USAGE_STALE_MS = 6 * 60 * 1000;
const AUTH_STATUS_TIMEOUT_MS = 5 * 1000;
const CLAUDE_USAGE_PERSISTENCE_KEY = 'claudeUsageAccounts.v1';
const CLAUDE_USAGE_PENDING_CONFIRM_MS = 30 * 1000;
const CLAUDE_USAGE_REGRESSION_POINTS = 10;
const CLAUDE_USAGE_RESET_TOLERANCE_MS = 2 * 60 * 1000;
const CLAUDE_USAGE_INCONSISTENT_WARNING = 'Claude returned inconsistent usage. Showing the last verified value.';

let _projectManager = null;
let claudeUsageStateStore = null;
let claudeUsageStateHydrated = false;
let apiBillingCache = { at: 0, accountKey: null, data: null, error: null, lastAttemptAt: 0 };
const claudeUsageByAccount = new Map();
const claudeUsageInflight = new Map();
const statuslineSessionBindings = new Map();
const statuslineBindingInflight = new Map();

class ClaudeUsageError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'ClaudeUsageError';
    this.code = code;
    this.status = status;
  }
}

function shortHash(value, length = 20) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function maskOrgId(value) {
  if (!value || typeof value !== 'string') return null;
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function getAdminApiKey() {
  const value = getMainProcessEnvValue('ANTHROPIC_ADMIN_API_KEY')
    || getMainProcessEnvValue('ANTHROPIC_ADMIN_KEY')
    || '';
  const trimmed = value.trim();
  return trimmed.startsWith('sk-ant-admin') ? trimmed : null;
}

function readKeychainService(service) {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 5000,
      env: buildChildProcessEnv(),
    }, (err, stdout) => {
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
  // Do not recurse. `Claude Code-credentials` is also an MCP OAuth container;
  // a nested Figma/other accessToken is not a Claude credential.
  return payload?.claudeAiOauth?.accessToken
    || payload?.oauth?.accessToken
    || payload?.accessToken
    || null;
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

function readClaudeAuthStatus() {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      {
        timeout: AUTH_STATUS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: buildChildProcessEnv(),
      },
      (error, stdout) => {
        const raw = String(stdout || '').trim();
        if (!raw) return resolve(null);
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && typeof parsed === 'object' ? parsed : null);
        } catch {
          if (error) return resolve(null);
          resolve(null);
        }
      },
    );
  });
}

function stableClaudeAccountKey(status, credentialFingerprint = null) {
  const authMethod = String(status?.authMethod || '').trim().toLowerCase();
  const orgId = String(status?.orgId || '').trim().toLowerCase();
  const email = String(status?.email || '').trim().toLowerCase();
  const stableParts = [authMethod, orgId, email].filter(Boolean);
  if (stableParts.length > 1) {
    return `claude:${shortHash(`identity-v1|${stableParts.join('|')}`)}`;
  }
  return credentialFingerprint ? `claude:${shortHash(`credential-v1|${credentialFingerprint}`)}` : null;
}

function classifyClaudeAuth(status, { apiKey, oauthToken }) {
  if (status && status.loggedIn === false) return null;
  const method = String(status?.authMethod || '').trim().toLowerCase();
  const keySource = String(status?.apiKeySource || '').trim().toLowerCase();
  const isClaudeLogin = method.includes('claude.ai') || keySource.includes('/login managed key');
  if (isClaudeLogin) {
    // `/login managed key` is authoritative. A stale Claude OAuth token may
    // coexist in another Keychain item and must not change the current login.
    if (!apiKey && !keySource.includes('/login managed key') && oauthToken) {
      return { kind: 'max-oauth', credentialKind: 'oauth-bearer', usageEndpointEligible: true };
    }
    return {
      kind: 'claude-managed-key',
      credentialKind: apiKey ? 'managed-api-key' : 'managed-session',
      usageEndpointEligible: false,
    };
  }
  if (oauthToken) {
    return {
      kind: 'max-oauth',
      credentialKind: 'oauth-bearer',
      usageEndpointEligible: true,
    };
  }
  if (apiKey) {
    return {
      kind: 'api-platform',
      credentialKind: 'api-key',
      usageEndpointEligible: false,
    };
  }
  return null;
}

async function readClaudeAuthState({
  statusReader = readClaudeAuthStatus,
  keychainReader = readKeychainService,
} = {}) {
  const [statusResult, apiRaw, oauthRaw] = await Promise.all([
    Promise.resolve().then(() => statusReader()).catch(() => null),
    Promise.resolve().then(() => keychainReader(KEYCHAIN_API_SERVICE)).catch(() => null),
    Promise.resolve().then(() => keychainReader(KEYCHAIN_OAUTH_SERVICE)).catch(() => null),
  ]);

  const status = statusResult && typeof statusResult === 'object' ? statusResult : null;
  const apiPayload = parseKeychainPayload(apiRaw);
  const oauthPayload = parseKeychainPayload(oauthRaw);
  const apiKeyFromApiService = extractApiKey(apiPayload);
  const apiKeyFromOauthService = extractApiKey(oauthPayload);
  const oauthFromApiService = extractOauthToken(apiPayload);
  const oauthFromOauthService = extractOauthToken(oauthPayload);
  const apiKey = apiKeyFromApiService || apiKeyFromOauthService || null;
  const oauthToken = oauthFromApiService || oauthFromOauthService || null;
  const classification = classifyClaudeAuth(status, { apiKey, oauthToken });
  if (!classification) return null;

  const activeCredential = classification.credentialKind === 'oauth-bearer' ? oauthToken : apiKey;
  const tokenFingerprint = activeCredential ? shortHash(activeCredential) : null;
  const accountKey = stableClaudeAccountKey(status, tokenFingerprint);
  if (!accountKey) return null;

  const email = String(status?.email || '').trim()
    || findNestedString(apiPayload, /email/i)
    || findNestedString(oauthPayload, /email/i)
    || null;
  const label = maskEmail(email)
    || (classification.kind === 'api-platform'
      ? 'Anthropic API'
      : (classification.kind === 'claude-managed-key' ? 'Claude login' : 'Claude Max'));
  const accountHint = classification.kind === 'api-platform'
    ? 'Anthropic API Platform'
    : (classification.kind === 'claude-managed-key' ? 'Claude.ai managed login' : 'Claude subscription');
  const notice = classification.kind === 'claude-managed-key'
    ? 'Quota updates after Claude replies through the official status line.'
    : null;

  return {
    accountKey,
    tokenFingerprint,
    label,
    accountHint,
    accountIdHint: null,
    email,
    orgId: String(status?.orgId || '').trim() || null,
    orgName: String(status?.orgName || '').trim() || null,
    authMethod: String(status?.authMethod || '').trim() || null,
    apiProvider: String(status?.apiProvider || '').trim() || null,
    apiKey,
    apiKeySource: apiKeyFromApiService ? KEYCHAIN_API_SERVICE : (apiKeyFromOauthService ? KEYCHAIN_OAUTH_SERVICE : null),
    oauthToken,
    oauthSource: oauthFromApiService ? KEYCHAIN_API_SERVICE : (oauthFromOauthService ? KEYCHAIN_OAUTH_SERVICE : null),
    currentKind: classification.kind,
    credentialKind: classification.credentialKind,
    usageEndpointEligible: classification.usageEndpointEligible,
    notice,
  };
}

function normalizePercent(value, field) {
  if (typeof value === 'boolean' || value == null || (typeof value === 'string' && !value.trim())) {
    throw new ClaudeUsageError('invalid_response', `${field} is missing`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new ClaudeUsageError('invalid_response', `${field} must be between 0 and 100`);
  }
  return number;
}

function normalizeResetAt(value, field) {
  if (value == null || value === '') return null;
  let ms;
  if (typeof value === 'number') {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    ms = numeric < 1e12 ? numeric * 1000 : numeric;
  } else {
    ms = Date.parse(String(value));
  }
  if (!Number.isFinite(ms)) {
    throw new ClaudeUsageError('invalid_response', `${field} is not a valid timestamp`);
  }
  return new Date(ms).toISOString();
}

function normalizeUsageBucket(raw, field, percentKey = 'utilization') {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClaudeUsageError('invalid_response', `${field} must be an object`);
  }
  const percent = raw[percentKey] ?? raw.utilization ?? raw.used_percentage ?? raw.used_percent;
  return {
    utilization: normalizePercent(percent, `${field}.utilization`),
    resets_at: normalizeResetAt(raw.resets_at ?? raw.reset_at ?? null, `${field}.resets_at`),
  };
}

function normalizeExtraUsage(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClaudeUsageError('invalid_response', 'extra_usage must be an object');
  }
  const result = {
    is_enabled: raw.is_enabled === true,
    utilization: raw.utilization == null ? null : normalizePercent(raw.utilization, 'extra_usage.utilization'),
    used_credits: raw.used_credits == null ? null : Number(raw.used_credits),
    monthly_limit: raw.monthly_limit == null ? null : Number(raw.monthly_limit),
    currency: typeof raw.currency === 'string' ? raw.currency.slice(0, 16) : null,
  };
  if (result.used_credits != null && (!Number.isFinite(result.used_credits) || result.used_credits < 0)) {
    throw new ClaudeUsageError('invalid_response', 'extra_usage.used_credits is invalid');
  }
  if (result.monthly_limit != null && (!Number.isFinite(result.monthly_limit) || result.monthly_limit < 0)) {
    throw new ClaudeUsageError('invalid_response', 'extra_usage.monthly_limit is invalid');
  }
  return result;
}

function normalizeClaudeUsageData(raw, { statusline = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClaudeUsageError('invalid_response', 'Claude usage response must be an object');
  }
  const data = {
    five_hour: normalizeUsageBucket(raw.five_hour, 'five_hour', statusline ? 'used_percentage' : 'utilization'),
    seven_day: normalizeUsageBucket(raw.seven_day, 'seven_day', statusline ? 'used_percentage' : 'utilization'),
    seven_day_opus: normalizeUsageBucket(raw.seven_day_opus, 'seven_day_opus'),
    seven_day_sonnet: normalizeUsageBucket(raw.seven_day_sonnet, 'seven_day_sonnet'),
    extra_usage: normalizeExtraUsage(raw.extra_usage),
  };
  if (!data.five_hour && !data.seven_day) {
    throw new ClaudeUsageError('invalid_response', 'Claude usage has no five-hour or seven-day window');
  }
  return data;
}

function retryAfterDelayMs(value, nowMs = Date.now()) {
  if (value == null || value === '') return ERROR_COOLDOWN_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, Math.min(60 * 60 * 1000, seconds * 1000));
  }
  const dateMs = Date.parse(String(value));
  if (Number.isFinite(dateMs)) {
    return Math.max(1000, Math.min(60 * 60 * 1000, dateMs - nowMs));
  }
  return ERROR_COOLDOWN_MS;
}

function usageBucketSnapshot(data, key) {
  const bucket = data?.[key];
  const utilization = Number(bucket?.utilization);
  if (!Number.isFinite(utilization)) return null;
  const resetMs = Date.parse(bucket?.resets_at || '');
  return {
    utilization,
    resetMs: Number.isFinite(resetMs) ? resetMs : null,
  };
}

function mergeClaudeUsageData(previous, candidate) {
  if (!previous) return candidate;
  return {
    ...previous,
    ...candidate,
    five_hour: candidate?.five_hour || previous.five_hour || null,
    seven_day: candidate?.seven_day || previous.seven_day || null,
    seven_day_opus: candidate?.seven_day_opus || previous.seven_day_opus || null,
    seven_day_sonnet: candidate?.seven_day_sonnet || previous.seven_day_sonnet || null,
    extra_usage: candidate?.extra_usage || previous.extra_usage || null,
  };
}

function claudeUsageSnapshotsMatch(left, right) {
  for (const key of ['five_hour', 'seven_day']) {
    const a = usageBucketSnapshot(left, key);
    const b = usageBucketSnapshot(right, key);
    if (!a && !b) continue;
    if (!a || !b || Math.abs(a.utilization - b.utilization) > 0.01) return false;
    if (a.resetMs == null && b.resetMs == null) continue;
    if (a.resetMs == null || b.resetMs == null || Math.abs(a.resetMs - b.resetMs) > 1000) return false;
  }
  return true;
}

function classifyClaudeUsageSnapshot(previous, candidate, nowMs = Date.now()) {
  let suspicious = false;
  for (const key of ['five_hour', 'seven_day']) {
    const oldBucket = usageBucketSnapshot(previous, key);
    const newBucket = usageBucketSnapshot(candidate, key);
    if (!oldBucket || !newBucket) continue;
    const previousResetElapsed = oldBucket.resetMs != null && oldBucket.resetMs <= nowMs;
    if (oldBucket.resetMs != null && newBucket.resetMs != null) {
      const resetDelta = newBucket.resetMs - oldBucket.resetMs;
      if (resetDelta < -CLAUDE_USAGE_RESET_TOLERANCE_MS) return 'obsolete';
      if (!previousResetElapsed && Math.abs(resetDelta) > CLAUDE_USAGE_RESET_TOLERANCE_MS) {
        suspicious = true;
      }
    }
    if (!previousResetElapsed
      && oldBucket.utilization - newBucket.utilization >= CLAUDE_USAGE_REGRESSION_POINTS) {
      suspicious = true;
    }
  }
  return suspicious ? 'suspicious' : 'accept';
}

function reconcileClaudeUsageSnapshot(previousEntry, candidate, nowMs = Date.now()) {
  const previousUsage = previousEntry?.account?.usage || null;
  const mergedUsage = mergeClaudeUsageData(previousUsage, candidate?.data);
  if (!mergedUsage) return { entry: previousEntry || null, accepted: false, status: 'invalid' };
  if (!previousUsage) {
    return {
      entry: {
        ...(previousEntry || {}),
        account: {
          ...(previousEntry?.account || {}),
          usage: mergedUsage,
          source: candidate.source,
          timestamp: new Date(candidate.fetchedAt).toISOString(),
        },
        fetchedAt: candidate.fetchedAt,
        pending: null,
        warning: null,
      },
      accepted: true,
      status: 'accepted',
    };
  }
  const classification = classifyClaudeUsageSnapshot(previousUsage, mergedUsage, nowMs);
  if (classification === 'accept') {
    return {
      entry: {
        ...previousEntry,
        account: {
          ...previousEntry.account,
          usage: mergedUsage,
          source: candidate.source,
          timestamp: new Date(candidate.fetchedAt).toISOString(),
        },
        fetchedAt: candidate.fetchedAt,
        pending: null,
        warning: null,
      },
      accepted: true,
      status: 'accepted',
    };
  }
  if (classification === 'obsolete') {
    return {
      entry: {
        ...previousEntry,
        pending: null,
        warning: CLAUDE_USAGE_INCONSISTENT_WARNING,
      },
      accepted: false,
      status: 'obsolete',
    };
  }
  const pending = previousEntry?.pending || null;
  const pendingMatches = pending?.data && claudeUsageSnapshotsMatch(pending.data, mergedUsage);
  if (pendingMatches && nowMs - Number(pending.firstSeenAt || nowMs) >= CLAUDE_USAGE_PENDING_CONFIRM_MS) {
    return {
      entry: {
        ...previousEntry,
        account: {
          ...previousEntry.account,
          usage: mergedUsage,
          source: candidate.source,
          timestamp: new Date(candidate.fetchedAt).toISOString(),
        },
        fetchedAt: candidate.fetchedAt,
        pending: null,
        warning: null,
      },
      accepted: true,
      status: 'confirmed',
    };
  }
  return {
    entry: {
      ...previousEntry,
      pending: {
        data: mergedUsage,
        source: candidate.source,
        fetchedAt: candidate.fetchedAt,
        firstSeenAt: pendingMatches ? pending.firstSeenAt : nowMs,
        lastSeenAt: nowMs,
      },
      warning: CLAUDE_USAGE_INCONSISTENT_WARNING,
    },
    accepted: false,
    status: 'pending',
  };
}

async function fetchUsage(token, {
  fetchImpl = global.fetch,
  timeoutMs = USAGE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (!token) throw new ClaudeUsageError('auth_missing', 'Claude OAuth token is unavailable');
  if (typeof fetchImpl !== 'function') throw new ClaudeUsageError('network_error', 'Fetch is unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'noted-terminal/1.0',
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new ClaudeUsageError('unauthorized', 'Claude OAuth token is invalid', response.status);
    }
    if (response.status === 429) {
      const error = new ClaudeUsageError('rate_limited', 'Anthropic usage endpoint is rate limited', response.status);
      error.retryAfterMs = retryAfterDelayMs(response.headers?.get?.('retry-after'), now());
      throw error;
    }
    if (!response.ok) {
      throw new ClaudeUsageError('server_error', 'Anthropic usage endpoint failed', response.status);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ClaudeUsageError('invalid_response', 'Anthropic usage response is not JSON');
    }
    return {
      data: normalizeClaudeUsageData(payload),
      fetchedAt: now(),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ClaudeUsageError('timeout', 'Anthropic usage request timed out');
    }
    if (error instanceof ClaudeUsageError) throw error;
    throw new ClaudeUsageError('network_error', error?.message || String(error));
  } finally {
    clearTimeout(timeout);
  }
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

function authMatches(left, right) {
  return !!left && !!right
    && left.accountKey === right.accountKey
    && left.tokenFingerprint === right.tokenFingerprint
    && left.currentKind === right.currentKind;
}

function accountFromAuth(auth) {
  if (!auth?.accountKey) return null;
  return {
    accountKey: auth.accountKey,
    kind: auth.currentKind,
    credentialKind: auth.credentialKind,
    usageEndpointEligible: auth.usageEndpointEligible === true,
    label: auth.label || 'Claude account',
    accountHint: auth.accountHint || null,
    accountIdHint: null,
    source: 'claude-auth-status',
    timestamp: null,
    usage: null,
    notice: auth.notice || null,
  };
}

function sanitizePersistedText(value, max = 120) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

function sanitizeClaudePersistedAccount(raw) {
  const accountKey = sanitizePersistedText(raw?.accountKey, 80);
  if (!accountKey || !/^claude:[a-f0-9]{20}$/.test(accountKey)) return null;
  const allowedKinds = new Set(['max-oauth', 'api-platform', 'claude-managed-key']);
  const kind = allowedKinds.has(raw?.kind) ? raw.kind : 'claude-managed-key';
  let usage = null;
  if (raw?.usage) {
    try {
      usage = normalizeClaudeUsageData(raw.usage);
    } catch {
      return null;
    }
  }
  const rawLabel = sanitizePersistedText(raw?.label, 80);
  const label = rawLabel?.includes('@') ? maskEmail(rawLabel) : rawLabel;
  const source = ['claude-statusline', 'anthropic-oauth-api', 'claude-auth-status']
    .includes(raw?.source) ? raw.source : 'claude-auth-status';
  const timestampMs = Date.parse(raw?.timestamp || '');
  return {
    accountKey,
    kind,
    credentialKind: ['oauth-bearer', 'api-key', 'managed-api-key', 'managed-session']
      .includes(raw?.credentialKind) ? raw.credentialKind : null,
    usageEndpointEligible: raw?.usageEndpointEligible === true,
    label: label || 'Claude account',
    accountHint: sanitizePersistedText(raw?.accountHint, 80),
    accountIdHint: null,
    source,
    timestamp: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null,
    usage,
    notice: kind === 'claude-managed-key'
      ? 'Quota updates after Claude replies through the official status line.'
      : null,
  };
}

function serializeClaudeUsageState(entries = claudeUsageByAccount) {
  const accounts = [...entries.entries()]
    .map(([accountKey, entry]) => {
      const account = sanitizeClaudePersistedAccount({ ...entry?.account, accountKey });
      if (!account) return null;
      return {
        account,
        fetchedAt: Number(entry?.fetchedAt || 0) || 0,
        lastAttemptAt: Number(entry?.lastAttemptAt || 0) || null,
        touchedAt: Number(entry?.touchedAt || entry?.fetchedAt || 0) || 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.touchedAt - left.touchedAt)
    .slice(0, 8);
  return { version: 1, accounts };
}

function parseClaudeUsageState(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) return [];
  return parsed.accounts.slice(0, 8).map((item) => {
    const account = sanitizeClaudePersistedAccount(item?.account);
    if (!account) return null;
    return {
      account,
      tokenFingerprint: null,
      fetchedAt: Number(item?.fetchedAt || 0) || 0,
      lastAttemptAt: Number(item?.lastAttemptAt || 0) || null,
      touchedAt: Number(item?.touchedAt || item?.fetchedAt || 0) || 0,
      error: null,
      errorAt: 0,
      billing: null,
      pending: null,
      warning: null,
      retryNotBefore: 0,
    };
  }).filter(Boolean);
}

function usageStateStore() {
  return claudeUsageStateStore || _projectManager?.db || null;
}

function hydrateClaudeUsageState() {
  if (claudeUsageStateHydrated) return;
  const store = usageStateStore();
  if (!store?.getAppState) return;
  claudeUsageStateHydrated = true;
  try {
    for (const entry of parseClaudeUsageState(store.getAppState(CLAUDE_USAGE_PERSISTENCE_KEY))) {
      claudeUsageByAccount.set(entry.account.accountKey, entry);
    }
  } catch (error) {
    console.warn('[ClaudeUsage] persisted accounts restore failed:', error?.message || String(error));
  }
}

function persistClaudeUsageState() {
  const store = usageStateStore();
  if (!store?.setAppState) return;
  try {
    store.setAppState(CLAUDE_USAGE_PERSISTENCE_KEY, serializeClaudeUsageState());
  } catch (error) {
    console.warn('[ClaudeUsage] persisted accounts save failed:', error?.message || String(error));
  }
}

function pruneClaudeUsageAccounts(currentAccountKey = null) {
  if (claudeUsageByAccount.size <= 8) return;
  const removable = [...claudeUsageByAccount.entries()]
    .filter(([accountKey]) => accountKey !== currentAccountKey)
    .sort((left, right) => Number(left[1]?.touchedAt || 0) - Number(right[1]?.touchedAt || 0));
  while (claudeUsageByAccount.size > 8 && removable.length > 0) {
    claudeUsageByAccount.delete(removable.shift()[0]);
  }
}

function ensureCurrentAuthAccount(auth, now = Date.now()) {
  if (!auth?.accountKey) return null;
  const descriptor = accountFromAuth(auth);
  const previous = claudeUsageByAccount.get(auth.accountKey) || null;
  const next = {
    ...previous,
    account: {
      ...descriptor,
      ...(previous?.account || {}),
      ...descriptor,
      usage: previous?.account?.usage || null,
      source: previous?.account?.usage ? previous.account.source : descriptor.source,
      timestamp: previous?.account?.usage ? previous.account.timestamp : null,
    },
    tokenFingerprint: auth.tokenFingerprint,
    touchedAt: now,
    error: previous?.error || null,
    errorAt: previous?.errorAt || 0,
    billing: previous?.billing || null,
    pending: previous?.pending || null,
    warning: previous?.warning || null,
    retryNotBefore: previous?.retryNotBefore || 0,
  };
  claudeUsageByAccount.set(auth.accountKey, next);
  pruneClaudeUsageAccounts(auth.accountKey);
  persistClaudeUsageState();
  return next;
}

function listClaudeUsageAccounts(currentAccountKey = null, now = Date.now()) {
  return [...claudeUsageByAccount.entries()]
    .map(([accountKey, entry]) => {
      const account = entry?.account;
      if (!account) return null;
      const isCurrent = accountKey === currentAccountKey;
      const fetchedAt = Number(entry.fetchedAt || 0);
      return {
        ...account,
        isCurrent,
        stale: !isCurrent || !account.usage || !!entry.error || !!entry.warning
          || !fetchedAt || now - fetchedAt > USAGE_STALE_MS,
        lastError: isCurrent ? (entry.error || null) : null,
        warning: isCurrent ? (entry.warning || null) : null,
        lastAttemptAt: entry.lastAttemptAt || null,
        billing: isCurrent ? (entry.billing || null) : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (!!left.isCurrent !== !!right.isCurrent) return left.isCurrent ? -1 : 1;
      const leftAt = Date.parse(left.timestamp || '') || 0;
      const rightAt = Date.parse(right.timestamp || '') || 0;
      return rightAt - leftAt;
    });
}

function selectClaudeUsageAccount(accounts, requestedAccountKey, currentAccountKey) {
  if (requestedAccountKey) {
    const requested = accounts.find((account) => account.accountKey === requestedAccountKey);
    if (requested) return requested;
  }
  return accounts.find((account) => account.accountKey === currentAccountKey)
    || accounts[0]
    || null;
}

function buildUsageResponse({
  requestedAccountKey = null,
  currentAccountKey = null,
  now = Date.now(),
  error = undefined,
} = {}) {
  const accounts = listClaudeUsageAccounts(currentAccountKey, now);
  const selected = selectClaudeUsageAccount(accounts, requestedAccountKey, currentAccountKey);
  const selectedEntry = selected ? claudeUsageByAccount.get(selected.accountKey) : null;
  const selectedError = error === undefined
    ? (selected?.isCurrent ? selectedEntry?.error || null : null)
    : error;
  const fetchedAt = Number(selectedEntry?.fetchedAt || 0);
  return {
    ok: !!selected && !selectedError,
    data: selected?.usage || null,
    accounts,
    selectedAccountKey: selected?.accountKey || null,
    currentAccountKey,
    authKind: selected?.kind || null,
    billing: selected?.billing || null,
    notice: selected?.notice || null,
    source: selected?.source || null,
    stale: selected?.stale ?? true,
    cachedMsAgo: fetchedAt ? Math.max(0, now - fetchedAt) : null,
    lastAttemptAt: selected?.lastAttemptAt || null,
    lastSuccessAt: selected?.timestamp || null,
    warning: selected?.warning || null,
    error: selectedError || null,
  };
}

function saveUsageSnapshot(accountKey, data, fetchedAt) {
  if (!_projectManager?.db?.saveClaudeUsageSnapshot || !accountKey || !data) return;
  try {
    _projectManager.db.saveClaudeUsageSnapshot({
      account_key: accountKey,
      ts: Math.floor(fetchedAt / 1000),
      weekly_pct: data?.seven_day?.utilization ?? null,
      five_hour_pct: data?.five_hour?.utilization ?? null,
      weekly_opus_pct: data?.seven_day_opus?.utilization ?? null,
      weekly_sonnet_pct: data?.seven_day_sonnet?.utilization ?? null,
      weekly_resets_at: data?.seven_day?.resets_at ?? null,
      five_hour_resets_at: data?.five_hour?.resets_at ?? null,
    });
  } catch (error) {
    console.error('[ClaudeUsage] snapshot save failed:', error?.message || String(error));
  }
}

async function bindStatuslineSession(bindingKey, authReader) {
  const existing = statuslineSessionBindings.get(bindingKey);
  if (existing) return existing;
  let inflight = statuslineBindingInflight.get(bindingKey);
  if (!inflight) {
    inflight = (async () => {
      const before = await authReader();
      if (!before?.accountKey) return null;
      const after = await authReader();
      if (!authMatches(before, after)) return null;
      const binding = {
        accountKey: after.accountKey,
        tokenFingerprint: after.tokenFingerprint,
        account: accountFromAuth(after),
      };
      statuslineSessionBindings.set(bindingKey, binding);
      return binding;
    })();
    statuslineBindingInflight.set(bindingKey, inflight);
    inflight.finally(() => {
      if (statuslineBindingInflight.get(bindingKey) === inflight) {
        statuslineBindingInflight.delete(bindingKey);
      }
    }).catch(() => {});
  }
  return inflight;
}

async function recordStatuslineUsage(data, {
  authReader = readClaudeAuthState,
  now = Date.now,
} = {}) {
  hydrateClaudeUsageState();
  const sessionId = sanitizePersistedText(data?.session_id, 160);
  const processId = Number(data?.ppid);
  if (!sessionId || !Number.isFinite(processId) || processId <= 0 || !data?.rate_limits) {
    return { accepted: false, reason: 'missing-rate-limits' };
  }
  let usage;
  try {
    usage = normalizeClaudeUsageData(data.rate_limits, { statusline: true });
  } catch (error) {
    console.warn('[ClaudeUsage] rejected invalid statusline rate_limits:', error?.message || String(error));
    return { accepted: false, reason: error?.code || 'invalid-response' };
  }
  const binding = await bindStatuslineSession(`${sessionId}:${Math.trunc(processId)}`, authReader);
  if (!binding?.accountKey) return { accepted: false, reason: 'auth-changed' };
  const nowMs = now();
  const bridgeAt = Number(data.updated_at);
  const fetchedAt = Number.isFinite(bridgeAt) && bridgeAt > 0
    ? Math.min(nowMs, bridgeAt * 1000)
    : nowMs;
  const previous = claudeUsageByAccount.get(binding.accountKey) || null;
  const timestamp = new Date(fetchedAt).toISOString();
  const reconciled = reconcileClaudeUsageSnapshot(previous, {
    data: usage,
    source: 'claude-statusline',
    fetchedAt,
  }, nowMs);
  const next = {
    ...(reconciled.entry || previous || {}),
    account: {
      ...binding.account,
      ...(reconciled.entry?.account || previous?.account || {}),
    },
    tokenFingerprint: binding.tokenFingerprint,
    lastAttemptAt: fetchedAt,
    touchedAt: nowMs,
    error: null,
    errorAt: 0,
    billing: previous?.billing || null,
    retryNotBefore: 0,
  };
  claudeUsageByAccount.set(binding.accountKey, next);
  pruneClaudeUsageAccounts(null);
  if (reconciled.accepted) {
    persistClaudeUsageState();
    saveUsageSnapshot(binding.accountKey, next.account.usage, next.fetchedAt);
  }
  return {
    accepted: reconciled.accepted,
    reason: reconciled.status,
    accountKey: binding.accountKey,
    timestamp: reconciled.accepted ? timestamp : previous?.account?.timestamp || null,
  };
}

async function fetchCurrentClaudeUsage(auth, {
  force,
  authReader,
  fetchImpl,
  now,
} = {}) {
  const inflightKey = `${auth.accountKey}:${auth.tokenFingerprint || 'session'}:${auth.currentKind}`;
  let request = claudeUsageInflight.get(inflightKey);
  if (!request) {
    request = (async () => {
      let result;
      if (auth.currentKind === 'api-platform') {
        result = {
          billing: await fetchApiPlatformBilling(auth.apiKey, {
            force,
            accountKey: `${auth.accountKey}:${auth.tokenFingerprint || 'key'}`,
          }),
          fetchedAt: now(),
        };
      } else {
        result = await fetchUsage(auth.oauthToken, { fetchImpl, now });
      }
      const latestAuth = await authReader();
      if (!authMatches(auth, latestAuth)) {
        const changed = new ClaudeUsageError('account_changed', 'Claude login changed during usage refresh');
        changed.authSnapshot = auth;
        throw changed;
      }
      return { ...result, auth: latestAuth };
    })();
    claudeUsageInflight.set(inflightKey, request);
    request.finally(() => {
      if (claudeUsageInflight.get(inflightKey) === request) {
        claudeUsageInflight.delete(inflightKey);
      }
    }).catch(() => {});
  }
  return request;
}

async function getUsage(opts = {}) {
  hydrateClaudeUsageState();
  const options = typeof opts === 'boolean' ? { force: opts } : (opts || {});
  const force = !!options.force;
  const requestedAccountKey = options.accountKey ? String(options.accountKey) : null;
  const authReader = options.authReader || readClaudeAuthState;
  const fetchImpl = options.fetchImpl || global.fetch;
  const now = options.now || Date.now;
  const authRetryCount = Number(options.authRetryCount || 0);
  let auth = await authReader();
  const nowMs = now();
  if (auth?.accountKey) ensureCurrentAuthAccount(auth, nowMs);
  const currentAccountKey = auth?.accountKey || null;

  let response = buildUsageResponse({
    requestedAccountKey,
    currentAccountKey,
    now: nowMs,
  });
  const selectedIsHistorical = response.selectedAccountKey
    && response.selectedAccountKey !== currentAccountKey;
  if (selectedIsHistorical || !auth?.accountKey) {
    if (!response.selectedAccountKey) {
      response = {
        ...response,
        ok: false,
        error: 'Claude is not signed in and no saved account snapshot is available.',
      };
    }
    return response;
  }

  const current = claudeUsageByAccount.get(auth.accountKey) || null;
  const hasFreshPrimarySnapshot = current?.account?.usage
    && current.account.source === 'claude-statusline'
    && nowMs - Number(current.fetchedAt || 0) < CACHE_TTL_MS;

  // Managed /login credentials cannot call /api/oauth/usage. The official
  // statusLine snapshot is the only quota source; refresh re-reads auth but
  // never sends the API-shaped key as a bearer token.
  if (auth.currentKind === 'claude-managed-key') {
    return buildUsageResponse({
      requestedAccountKey,
      currentAccountKey,
      now: nowMs,
      error: null,
    });
  }

  if (auth.currentKind !== 'api-platform' && hasFreshPrimarySnapshot) {
    return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
  }
  if (current?.retryNotBefore && nowMs < current.retryNotBefore) {
    return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
  }
  if (!force && current?.errorAt
    && current.tokenFingerprint === auth.tokenFingerprint
    && nowMs - current.errorAt < ERROR_COOLDOWN_MS) {
    return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
  }
  if (!force && !current?.error && current?.account?.usage
    && current.tokenFingerprint === auth.tokenFingerprint
    && nowMs - Number(current.fetchedAt || 0) < CACHE_TTL_MS) {
    return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
  }

  const lastAttemptAt = now();
  try {
    const result = await fetchCurrentClaudeUsage(auth, {
      force,
      authReader,
      fetchImpl,
      now,
    });
    auth = result.auth || auth;
    const previous = claudeUsageByAccount.get(auth.accountKey) || null;
    if (auth.currentKind === 'api-platform') {
      claudeUsageByAccount.set(auth.accountKey, {
        ...previous,
        account: { ...(previous?.account || {}), ...accountFromAuth(auth) },
        tokenFingerprint: auth.tokenFingerprint,
        billing: result.billing,
        lastAttemptAt,
        touchedAt: lastAttemptAt,
        error: result.billing?.error || null,
        errorAt: result.billing?.error ? lastAttemptAt : 0,
        retryNotBefore: 0,
      });
    } else {
      const reconciled = reconcileClaudeUsageSnapshot(previous, {
        data: result.data,
        source: 'anthropic-oauth-api',
        fetchedAt: result.fetchedAt,
      }, lastAttemptAt);
      const next = {
        ...(reconciled.entry || previous || {}),
        account: {
          ...accountFromAuth(auth),
          ...(reconciled.entry?.account || previous?.account || {}),
        },
        tokenFingerprint: auth.tokenFingerprint,
        lastAttemptAt,
        touchedAt: lastAttemptAt,
        error: null,
        errorAt: 0,
        retryNotBefore: 0,
      };
      claudeUsageByAccount.set(auth.accountKey, next);
      if (reconciled.accepted) {
        saveUsageSnapshot(auth.accountKey, next.account.usage, next.fetchedAt);
      }
    }
    pruneClaudeUsageAccounts(auth.accountKey);
    persistClaudeUsageState();
    return buildUsageResponse({
      requestedAccountKey,
      currentAccountKey: auth.accountKey,
      now: now(),
    });
  } catch (error) {
    const latestAuth = await authReader();
    const authChanged = !authMatches(auth, latestAuth);
    if (authChanged) {
      if (latestAuth?.accountKey && authRetryCount < 1) {
        return getUsage({
          ...options,
          force: false,
          authReader,
          fetchImpl,
          now,
          authRetryCount: authRetryCount + 1,
        });
      }
      return buildUsageResponse({
        requestedAccountKey,
        currentAccountKey: latestAuth?.accountKey || null,
        now: now(),
        error: latestAuth?.accountKey ? 'Claude login changed during usage refresh.' : 'Claude is not signed in.',
      });
    }
    const previous = claudeUsageByAccount.get(auth.accountKey) || null;
    claudeUsageByAccount.set(auth.accountKey, {
      ...previous,
      tokenFingerprint: auth.tokenFingerprint,
      lastAttemptAt,
      touchedAt: lastAttemptAt,
      error: error?.message || String(error),
      errorAt: now(),
      retryNotBefore: error?.code === 'rate_limited'
        ? now() + Number(error.retryAfterMs || ERROR_COOLDOWN_MS)
        : (previous?.retryNotBefore || 0),
    });
    pruneClaudeUsageAccounts(auth.accountKey);
    console.warn('[ClaudeUsage] refresh failed account=' + auth.label + ' code=' + (error?.code || 'network_error'));
    return buildUsageResponse({
      requestedAccountKey,
      currentAccountKey: auth.accountKey,
      now: now(),
    });
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

function computeDailyHistory(days = 7, accountKey = null) {
  if (!_projectManager?.db || !accountKey) return [];
  const now = Math.floor(Date.now() / 1000);
  const fromTs = now - (days * 24 * 60 * 60) - (24 * 60 * 60); // +1 day buffer for cross-midnight last sample
  const rows = _projectManager.db.getClaudeUsageSnapshots(fromTs, now, accountKey);
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

function buildClaudeUsageAccounts(authState, usageData = null) {
  const account = accountFromAuth(authState);
  if (!account) return [];
  return [{
    ...account,
    usage: usageData || null,
    source: usageData ? 'anthropic-oauth-api' : account.source,
    timestamp: usageData ? new Date().toISOString() : null,
    isCurrent: true,
    stale: !usageData,
  }];
}

function setClaudeUsageStateStoreForTests(store) {
  claudeUsageStateStore = store || null;
  claudeUsageStateHydrated = false;
}

function setClaudeUsageProjectManagerForTests(projectManager) {
  _projectManager = projectManager || null;
  claudeUsageStateHydrated = false;
}

function resetClaudeUsageStateForTests() {
  claudeUsageByAccount.clear();
  claudeUsageInflight.clear();
  statuslineSessionBindings.clear();
  statuslineBindingInflight.clear();
  claudeUsageStateStore = null;
  claudeUsageStateHydrated = false;
  apiBillingCache = { at: 0, accountKey: null, data: null, error: null, lastAttemptAt: 0 };
  _projectManager = null;
}

function register({ projectManager }) {
  _projectManager = projectManager;
  claudeUsageStateStore = projectManager?.db || null;
  claudeUsageStateHydrated = false;
  hydrateClaudeUsageState();

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
      let accountKey = opts?.accountKey ? String(opts.accountKey) : null;
      if (!accountKey) {
        const auth = await readClaudeAuthState();
        accountKey = auth?.accountKey || null;
      }
      const history = computeDailyHistory(days, accountKey);
      return { ok: true, history, accountKey };
    } catch (e) {
      console.error('[ClaudeUsage] daily-history failed:', e.message);
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  recordStatuslineUsage,
  _api: {
    buildClaudeUsageAccounts,
    buildUsageResponse,
    classifyClaudeAuth,
    computeActivityStatsFromRows,
    computeDailyHistory,
    computeUnionActivity,
    fetchUsage,
    fetchApiPlatformBilling,
    getUsage,
    listClaudeUsageAccounts,
    normalizeClaudeUsageData,
    parseClaudeUsageState,
    readClaudeAuthState,
    recordStatuslineUsage,
    resetClaudeUsageStateForTests,
    sanitizeClaudePersistedAccount,
    serializeClaudeUsageState,
    setClaudeUsageProjectManagerForTests,
    setClaudeUsageStateStoreForTests,
    stableClaudeAccountKey,
    summarizeCostReport,
  },
};

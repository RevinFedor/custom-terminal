// Claude usage limits IPC.
//
// Current Claude identity comes from `claude auth status --json`. OAuth
// subscriptions read one atomic quota snapshot from /api/oauth/usage.
// Claude Code's official statusLine `rate_limits` remains the fallback for
// managed logins and temporary OAuth failures. A `/login managed key` is
// deliberately not treated as OAuth: it is an API-shaped credential and
// Anthropic rejects it on the OAuth usage endpoint.

const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const { captureClaudeUsageAuthNamespace, readClaudeUsageCredentialFile } = require('../claude-usage-auth-namespace');
const {
  buildChildProcessEnv,
  getMainProcessEnvValue,
} = require('../child-process-env');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ADMIN_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
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
const CLAUDE_STATUSLINE_BINDING_LIMIT = 512;
const CLAUDE_STATUSLINE_PERSISTED_BINDING_LIMIT = 128;

let _projectManager = null;
let claudeUsageStateStore = null;
let claudeUsageStateHydrated = false;
let apiBillingCache = { at: 0, accountKey: null, data: null, error: null, lastAttemptAt: 0 };
const claudeUsageByAccount = new Map();
const claudeUsageInflight = new Map();
const statuslineSessionBindings = new Map();
const statuslineBindingInflight = new Map();
const persistedStatuslineBindings = new Map();

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

function readKeychainService(service, scope, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-a', scope.account, '-s', service, '-w'], {
      timeout: 5000,
      env: scope.env,
      signal,
    }, (err, stdout) => {
      if (err) {
        const aborted = signal?.aborted === true || err.name === 'AbortError' || err.code === 'ABORT_ERR';
        const missing = !aborted && err.killed !== true && Number(err.code) === 44;
        if (missing) return resolve(null);
        return reject(new ClaudeUsageError(
          aborted ? 'auth_read_timeout' : 'auth_source_unavailable',
          aborted ? 'Claude usage authentication check timed out' : 'Claude credential source could not be observed',
        ));
      }
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

function readClaudeAuthStatus(scope, { signal } = {}) {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      {
        timeout: AUTH_STATUS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: scope.env,
        signal,
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

function stableClaudeAccountKey(status, credentialFingerprint = null, namespaceKey = 'default') {
  const authMethod = String(status?.authMethod || '').trim().toLowerCase();
  const orgId = String(status?.orgId || '').trim().toLowerCase();
  const email = String(status?.email || '').trim().toLowerCase();
  const stableParts = [authMethod, orgId, email].filter(Boolean);
  const scope = namespaceKey === 'default' ? '' : `namespace-v1|${namespaceKey}|`;
  if (stableParts.length > 1) return `claude:${shortHash(`${scope}identity-v1|${stableParts.join('|')}`)}`;
  return credentialFingerprint ? `claude:${shortHash(`${scope}credential-v1|${credentialFingerprint}`)}` : null;
}

function classifyClaudeAuth(status, { apiKey, oauthToken }) {
  if (status && status.loggedIn === false) return null;
  const method = String(status?.authMethod || '').trim().toLowerCase();
  const keySource = String(status?.apiKeySource || '').trim().toLowerCase();
  const isClaudeLogin = method.includes('claude.ai') || keySource.includes('/login managed key');
  if (isClaudeLogin) {
    // `/login managed key` is authoritative. A stale Claude OAuth token may
    // coexist in another Keychain item and must not change the current login.
    if (!keySource.includes('/login managed key') && oauthToken) {
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

async function readClaudeAuthState(options = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ClaudeUsageError('auth_read_timeout', 'Claude usage authentication check timed out'));
      controller.abort();
    }, options.authReadTimeoutMs ?? AUTH_STATUS_TIMEOUT_MS);
    timer.unref?.();
  });
  try { return await Promise.race([readClaudeAuthStateSnapshot({ ...options, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function readClaudeAuthStateSnapshot({
  statusReader = readClaudeAuthStatus,
  keychainReader = readKeychainService,
  fileReader = readClaudeUsageCredentialFile,
  namespaceReader = captureClaudeUsageAuthNamespace,
  signal,
} = {}) {
  const namespace = namespaceReader();
  const statusResult = await statusReader(namespace, { signal });
  signal.throwIfAborted();
  const status = statusResult && typeof statusResult === 'object' ? statusResult : null;
  // Keychain entries can outlive a login and cannot identify which account is
  // currently active on their own. Without the authoritative CLI status, keep
  // saved snapshots stale instead of inventing a current account.
  if (!status || status.loggedIn === false) return null;
  if (typeof status.configDirectory === 'string' && status.configDirectory.normalize('NFC') !== namespace.configDir) {
    throw new ClaudeUsageError('auth_namespace_mismatch', 'Claude auth status belongs to a different config namespace');
  }
  const method = String(status.authMethod || '').toLowerCase();
  const keySource = String(status.apiKeySource || '').toLowerCase();
  const managed = keySource.includes('/login managed key');
  const oauthLogin = method.includes('claude.ai') && !managed;
  const envApiKey = keySource === 'anthropic_api_key';
  if (oauthLogin && (namespace.env.CLAUDE_CODE_OAUTH_TOKEN || namespace.env.ANTHROPIC_AUTH_TOKEN)) {
    throw new ClaudeUsageError('auth_source_unsupported', 'Claude active external token is not the stored subscription credential');
  }
  if (!method.includes('claude.ai') && method !== 'api_key') {
    throw new ClaudeUsageError('auth_source_unsupported', 'Claude usage does not support the active credential source');
  }
  const statusIdentity = value => JSON.stringify(['loggedIn', 'authMethod', 'apiKeySource',
    'apiProvider', 'email', 'orgId', 'configDirectory'].map(key => value?.[key] ?? null));
  const readCredentials = async () => {
    signal.throwIfAborted();
    if (envApiKey) return { apiRaw: null, oauthRaw: null, oauthSource: null };
    const apiRaw = oauthLogin ? null : await keychainReader(namespace.apiService, namespace, { signal });
    signal.throwIfAborted();
    if (!oauthLogin && extractApiKey(parseKeychainPayload(apiRaw))) return { apiRaw, oauthRaw: null, oauthSource: null };
    const storedOauth = await keychainReader(namespace.oauthService, namespace, { signal });
    signal.throwIfAborted();
    // A present Keychain document is authoritative even if it contains no
    // Claude token (e.g. MCP-only). Never merge it with an older fallback file.
    const fallback = storedOauth == null ? await fileReader(namespace.credentialsFile, namespace) : null;
    return { apiRaw, oauthRaw: storedOauth ?? fallback,
      oauthSource: storedOauth == null && fallback != null ? 'credentials-file' : namespace.oauthService };
  };
  const credentials = await readCredentials();
  signal.throwIfAborted();
  const [afterStatus, afterCredentials] = await Promise.all([statusReader(namespace, { signal }), readCredentials()]);
  signal.throwIfAborted();
  const afterNamespace = namespaceReader();
  if (afterNamespace.scopeKey !== namespace.scopeKey
    || (envApiKey && afterNamespace.env.ANTHROPIC_API_KEY !== namespace.env.ANTHROPIC_API_KEY)
    || statusIdentity(afterStatus) !== statusIdentity(status)
    || JSON.stringify(afterCredentials) !== JSON.stringify(credentials)) {
    throw new ClaudeUsageError('auth_changed', 'Claude login changed while reading usage credentials');
  }
  const { apiRaw, oauthRaw } = credentials;
  const apiPayload = parseKeychainPayload(apiRaw);
  const oauthPayload = parseKeychainPayload(oauthRaw);
  const apiKeyFromApiService = extractApiKey(apiPayload);
  const apiKeyFromOauthService = extractApiKey(oauthPayload);
  const oauthFromOauthService = extractOauthToken(oauthPayload);
  const apiKey = envApiKey ? extractApiKey(namespace.env.ANTHROPIC_API_KEY)
    : apiKeyFromApiService || apiKeyFromOauthService || null;
  const oauthToken = oauthFromOauthService || null;
  if ((oauthLogin && !oauthToken) || (envApiKey && !apiKey)) {
    throw new ClaudeUsageError('auth_missing', 'Claude active credential is missing from its own namespace');
  }
  const identityPayload = oauthLogin ? oauthPayload : envApiKey ? null
    : apiKeyFromApiService ? apiPayload : oauthPayload;
  for (const payload of [identityPayload]) {
    // Only explicit Claude identity fields count, never a nested MCP identity.
    for (const identity of [payload, payload?.claudeAiOauth, payload?.oauth,
      payload?.tokenAccount, payload?.claudeAiOauth?.tokenAccount, payload?.oauth?.tokenAccount]) {
      if (!identity || typeof identity !== 'object') continue;
      for (const key of ['email', 'orgId']) {
        const credentialValue = identity[key] || identity[key === 'email' ? 'emailAddress' : 'organizationUuid'];
        if (status[key] && credentialValue && String(status[key]).toLowerCase() !== String(credentialValue).toLowerCase()) {
          throw new ClaudeUsageError('account_mismatch', 'Claude credential account does not match its auth status');
        }
      }
    }
  }
  const classification = classifyClaudeAuth(status, { apiKey, oauthToken: method === 'api_key' ? null : oauthToken });
  if (!classification) return null;

  const activeCredential = classification.credentialKind === 'oauth-bearer' ? oauthToken : apiKey;
  const tokenFingerprint = activeCredential ? shortHash(activeCredential) : null;
  const accountKey = stableClaudeAccountKey(status, tokenFingerprint, namespace.key);
  if (!accountKey) return null;

  const email = String(status?.email || '').trim() || null;
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
    namespaceKey: namespace.key,
    credentialScopeKey: namespace.scopeKey,
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
    apiKeySource: envApiKey ? 'ANTHROPIC_API_KEY' : apiKeyFromApiService ? namespace.apiService : (apiKeyFromOauthService ? credentials.oauthSource : null),
    oauthToken,
    oauthSource: oauthFromOauthService ? credentials.oauthSource : null,
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

function normalizeModelScopedUsage(raw) {
  let source = null;
  let fromLimits = false;
  if (Array.isArray(raw?.model_scoped)) {
    source = raw.model_scoped;
  } else if (Array.isArray(raw?.limits)) {
    source = raw.limits;
    fromLimits = true;
  }
  if (!source) return [];

  const normalized = new Map();
  for (const item of source.slice(0, 64)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (fromLimits && (item.kind !== 'weekly_scoped' || item.group !== 'weekly')) continue;
    const rawName = fromLimits ? item?.scope?.model?.display_name : item.display_name;
    if (typeof rawName !== 'string') continue;
    const displayName = rawName.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!displayName) continue;
    try {
      const utilization = normalizePercent(
        fromLimits ? item.percent : item.utilization,
        `model_scoped.${displayName}.utilization`,
      );
      const resetsAt = normalizeResetAt(
        item.resets_at ?? item.reset_at ?? null,
        `model_scoped.${displayName}.resets_at`,
      );
      normalized.set(displayName.toLocaleLowerCase('en-US'), {
        display_name: displayName,
        utilization,
        resets_at: resetsAt,
      });
    } catch {
      // Model-specific limits are optional. One malformed entry must not hide
      // otherwise valid five-hour and weekly usage.
    }
    if (normalized.size >= 16) break;
  }
  return [...normalized.values()];
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
  if (!statusline) {
    data.model_scoped = normalizeModelScopedUsage(raw);
  }
  if (!data.five_hour && !data.seven_day) {
    throw new ClaudeUsageError('invalid_response', 'Claude usage has no five-hour or seven-day window');
  }
  return data;
}

function requireCompleteOAuthUsage(data) {
  if (!data?.five_hour || !data?.seven_day) {
    throw new ClaudeUsageError(
      'invalid_response',
      'Claude OAuth usage must contain both five-hour and seven-day windows',
    );
  }
  return data;
}

function statuslineUsageOnly(data) {
  return {
    five_hour: data?.five_hour || null,
    seven_day: data?.seven_day || null,
    model_scoped: [],
  };
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

function modelScopedUsageSnapshots(data) {
  const result = new Map();
  for (const item of Array.isArray(data?.model_scoped) ? data.model_scoped : []) {
    const name = typeof item?.display_name === 'string'
      ? item.display_name.trim().toLocaleLowerCase('en-US')
      : '';
    const utilization = Number(item?.utilization);
    if (!name || !Number.isFinite(utilization)) continue;
    const resetMs = Date.parse(item?.resets_at || '');
    result.set(name, {
      utilization,
      resetMs: Number.isFinite(resetMs) ? resetMs : null,
    });
  }
  return result;
}

function usageBucketsMatch(left, right) {
  if (!left && !right) return true;
  if (!left || !right || Math.abs(left.utilization - right.utilization) > 0.01) return false;
  if (left.resetMs == null && right.resetMs == null) return true;
  return left.resetMs != null
    && right.resetMs != null
    && Math.abs(left.resetMs - right.resetMs) <= 1000;
}

function claudeUsageSnapshotsMatch(left, right) {
  for (const key of ['five_hour', 'seven_day']) {
    if (!usageBucketsMatch(usageBucketSnapshot(left, key), usageBucketSnapshot(right, key))) {
      return false;
    }
  }
  const leftModels = modelScopedUsageSnapshots(left);
  const rightModels = modelScopedUsageSnapshots(right);
  if (leftModels.size !== rightModels.size) return false;
  for (const [name, leftBucket] of leftModels) {
    if (!usageBucketsMatch(leftBucket, rightModels.get(name) || null)) return false;
  }
  return true;
}

function classifyUsageBucket(oldBucket, newBucket, nowMs) {
  if (!oldBucket || !newBucket) return 'accept';
  const previousResetElapsed = oldBucket.resetMs != null && oldBucket.resetMs <= nowMs;
  if (oldBucket.resetMs != null && newBucket.resetMs != null) {
    const resetDelta = newBucket.resetMs - oldBucket.resetMs;
    if (resetDelta < -CLAUDE_USAGE_RESET_TOLERANCE_MS) return 'obsolete';
    if (!previousResetElapsed && Math.abs(resetDelta) > CLAUDE_USAGE_RESET_TOLERANCE_MS) {
      return 'suspicious';
    }
  }
  if (!previousResetElapsed
    && oldBucket.utilization - newBucket.utilization >= CLAUDE_USAGE_REGRESSION_POINTS) {
    return 'suspicious';
  }
  return 'accept';
}

function classifyClaudeUsageSnapshot(previous, candidate, nowMs = Date.now()) {
  let suspicious = false;
  for (const key of ['five_hour', 'seven_day']) {
    const classification = classifyUsageBucket(
      usageBucketSnapshot(previous, key),
      usageBucketSnapshot(candidate, key),
      nowMs,
    );
    if (classification === 'obsolete') return 'obsolete';
    if (classification === 'suspicious') suspicious = true;
  }
  const oldModels = modelScopedUsageSnapshots(previous);
  const newModels = modelScopedUsageSnapshots(candidate);
  for (const [name, oldBucket] of oldModels) {
    const newBucket = newModels.get(name);
    if (!newBucket) continue;
    const classification = classifyUsageBucket(oldBucket, newBucket, nowMs);
    if (classification === 'obsolete') return 'obsolete';
    if (classification === 'suspicious') suspicious = true;
  }
  return suspicious ? 'suspicious' : 'accept';
}

function reconcileClaudeUsageSourceSnapshot(
  previousSnapshot,
  candidate,
  nowMs = Date.now(),
) {
  const previousUsage = previousSnapshot?.usage || null;
  const nextUsage = candidate?.data || null;
  if (!nextUsage) {
    return { snapshot: previousSnapshot || null, accepted: false, status: 'invalid' };
  }
  const acceptedSnapshot = {
    usage: nextUsage,
    source: candidate.source,
    timestamp: new Date(candidate.fetchedAt).toISOString(),
    fetchedAt: candidate.fetchedAt,
    pending: null,
    warning: null,
  };
  if (!previousUsage) {
    return {
      snapshot: acceptedSnapshot,
      accepted: true,
      status: 'accepted',
    };
  }
  const classification = classifyClaudeUsageSnapshot(previousUsage, nextUsage, nowMs);
  if (classification === 'accept') {
    return {
      snapshot: acceptedSnapshot,
      accepted: true,
      status: 'accepted',
    };
  }
  if (classification === 'obsolete') {
    return {
      snapshot: {
        ...previousSnapshot,
        pending: null,
        warning: CLAUDE_USAGE_INCONSISTENT_WARNING,
      },
      accepted: false,
      status: 'obsolete',
    };
  }
  const pending = previousSnapshot?.pending || null;
  const pendingMatches = pending?.source === candidate.source
    && pending?.data
    && claudeUsageSnapshotsMatch(pending.data, nextUsage);
  if (pendingMatches && nowMs - Number(pending.firstSeenAt || nowMs) >= CLAUDE_USAGE_PENDING_CONFIRM_MS) {
    return {
      snapshot: acceptedSnapshot,
      accepted: true,
      status: 'confirmed',
    };
  }
  return {
    snapshot: {
      ...previousSnapshot,
      pending: {
        data: nextUsage,
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
      data: requireCompleteOAuthUsage(normalizeClaudeUsageData(payload)),
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
    && (left.namespaceKey || 'default') === (right.namespaceKey || 'default')
    && (left.credentialScopeKey || null) === (right.credentialScopeKey || null)
    && (left.oauthSource || null) === (right.oauthSource || null)
    && (left.apiKeySource || null) === (right.apiKeySource || null)
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
    accountHint: kind === 'api-platform'
      ? 'Anthropic API Platform'
      : (kind === 'claude-managed-key' ? 'Claude.ai managed login' : 'Claude subscription'),
    accountIdHint: null,
    source,
    timestamp: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null,
    usage,
    notice: kind === 'claude-managed-key'
      ? 'Quota updates after Claude replies through the official status line.'
      : null,
  };
}

function sanitizePersistedUsageSnapshot(raw, source, { requireComplete = false } = {}) {
  if (!raw?.usage) return null;
  let usage;
  try {
    usage = normalizeClaudeUsageData(raw.usage);
    if (requireComplete) requireCompleteOAuthUsage(usage);
  } catch {
    return null;
  }
  if (source === 'claude-statusline') {
    usage = statuslineUsageOnly(usage);
  }
  const fetchedAt = Number(raw.fetchedAt || 0);
  const timestampMs = Date.parse(raw.timestamp || '');
  const normalizedFetchedAt = fetchedAt > 0
    ? fetchedAt
    : (Number.isFinite(timestampMs) ? timestampMs : 0);
  if (!normalizedFetchedAt) return null;
  return {
    usage,
    source,
    timestamp: new Date(normalizedFetchedAt).toISOString(),
    fetchedAt: normalizedFetchedAt,
    pending: null,
    warning: null,
  };
}

function serializeClaudeUsageState(entries = claudeUsageByAccount) {
  const accounts = [...entries.entries()]
    .map(([accountKey, entry]) => {
      const account = sanitizeClaudePersistedAccount({ ...entry?.account, accountKey });
      if (!account) return null;
      return {
        account,
        oauthSnapshot: sanitizePersistedUsageSnapshot(
          entry?.oauthSnapshot,
          'anthropic-oauth-api',
          { requireComplete: true },
        ),
        statuslineSnapshot: sanitizePersistedUsageSnapshot(
          entry?.statuslineSnapshot,
          'claude-statusline',
        ),
        fetchedAt: Number(entry?.fetchedAt || 0) || 0,
        lastAttemptAt: Number(entry?.lastAttemptAt || 0) || null,
        touchedAt: Number(entry?.touchedAt || entry?.fetchedAt || 0) || 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.touchedAt - left.touchedAt)
    .slice(0, 8);
  const sessionBindings = [...persistedStatuslineBindings.entries()]
    .map(([bindingHash, binding]) => (
      /^[a-f0-9]{32}$/.test(bindingHash)
      && claudeUsageByAccount.has(binding?.accountKey)
        ? {
            bindingHash,
            accountKey: binding.accountKey,
            touchedAt: Number(binding.touchedAt || 0) || 0,
          }
        : null
    ))
    .filter(Boolean)
    .sort((left, right) => right.touchedAt - left.touchedAt)
    .slice(0, CLAUDE_STATUSLINE_PERSISTED_BINDING_LIMIT);
  return { version: 2, accounts, sessionBindings };
}

function parseClaudeUsageState(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!parsed || ![1, 2].includes(parsed.version) || !Array.isArray(parsed.accounts)) return [];
  return parsed.accounts.slice(0, 8).map((item) => {
    const account = sanitizeClaudePersistedAccount(item?.account);
    if (!account) return null;
    let oauthSnapshot = parsed.version === 2
      ? sanitizePersistedUsageSnapshot(
        item?.oauthSnapshot,
        'anthropic-oauth-api',
        { requireComplete: true },
      )
      : null;
    let statuslineSnapshot = parsed.version === 2
      ? sanitizePersistedUsageSnapshot(item?.statuslineSnapshot, 'claude-statusline')
      : null;
    if (parsed.version === 1 && account.usage) {
      const legacySnapshot = {
        usage: account.usage,
        timestamp: account.timestamp,
        fetchedAt: Number(item?.fetchedAt || 0) || Date.parse(account.timestamp || ''),
      };
      if (account.source === 'anthropic-oauth-api') {
        oauthSnapshot = sanitizePersistedUsageSnapshot(
          legacySnapshot,
          'anthropic-oauth-api',
          { requireComplete: true },
        );
      } else if (account.source === 'claude-statusline') {
        statuslineSnapshot = sanitizePersistedUsageSnapshot(
          legacySnapshot,
          'claude-statusline',
        );
        if (statuslineSnapshot) {
          account.usage = statuslineSnapshot.usage;
        }
      }
    }
    return {
      account,
      oauthSnapshot,
      statuslineSnapshot,
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
      needsLiveRefresh: true,
    };
  }).filter(Boolean);
}

function parseClaudeStatuslineBindings(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!parsed || ![1, 2].includes(parsed.version) || !Array.isArray(parsed.sessionBindings)) return [];
  return parsed.sessionBindings.slice(0, CLAUDE_STATUSLINE_PERSISTED_BINDING_LIMIT).map((item) => {
    const bindingHash = sanitizePersistedText(item?.bindingHash, 32);
    const accountKey = sanitizePersistedText(item?.accountKey, 80);
    if (!bindingHash || !/^[a-f0-9]{32}$/.test(bindingHash)) return null;
    if (!accountKey || !/^claude:[a-f0-9]{20}$/.test(accountKey)) return null;
    return {
      bindingHash,
      accountKey,
      touchedAt: Number(item?.touchedAt || 0) || 0,
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
    const raw = store.getAppState(CLAUDE_USAGE_PERSISTENCE_KEY);
    for (const entry of parseClaudeUsageState(raw)) {
      claudeUsageByAccount.set(entry.account.accountKey, entry);
    }
    for (const binding of parseClaudeStatuslineBindings(raw)) {
      if (claudeUsageByAccount.has(binding.accountKey)) {
        persistedStatuslineBindings.set(binding.bindingHash, binding);
      }
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
  for (const [bindingHash, binding] of persistedStatuslineBindings) {
    if (!claudeUsageByAccount.has(binding.accountKey)) {
      persistedStatuslineBindings.delete(bindingHash);
    }
  }
}

function pruneClaudeStatuslineBindings() {
  while (statuslineSessionBindings.size > CLAUDE_STATUSLINE_BINDING_LIMIT) {
    statuslineSessionBindings.delete(statuslineSessionBindings.keys().next().value);
  }
  while (persistedStatuslineBindings.size > CLAUDE_STATUSLINE_PERSISTED_BINDING_LIMIT) {
    let oldestKey = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [bindingHash, binding] of persistedStatuslineBindings) {
      const touchedAt = Number(binding?.touchedAt || 0);
      if (touchedAt < oldestAt) {
        oldestKey = bindingHash;
        oldestAt = touchedAt;
      }
    }
    if (!oldestKey) break;
    persistedStatuslineBindings.delete(oldestKey);
  }
}

function displayClaudeUsageSnapshot(entry, snapshot) {
  if (!entry || !snapshot?.usage) return entry;
  return {
    ...entry,
    account: {
      ...(entry.account || {}),
      usage: snapshot.usage,
      source: snapshot.source,
      timestamp: snapshot.timestamp,
    },
    fetchedAt: snapshot.fetchedAt,
    pending: snapshot.pending || null,
    warning: snapshot.warning || null,
  };
}

function hasFreshOAuthUsageSnapshot(entry, tokenFingerprint, nowMs) {
  const snapshot = entry?.oauthSnapshot;
  return !!snapshot?.usage
    && entry?.tokenFingerprint === tokenFingerprint
    && !entry?.needsLiveRefresh
    && Number(snapshot.fetchedAt || 0) > 0
    && nowMs - Number(snapshot.fetchedAt) < CACHE_TTL_MS;
}

function ensureCurrentAuthAccount(auth, now = Date.now()) {
  if (!auth?.accountKey) return null;
  const descriptor = accountFromAuth(auth);
  const previous = claudeUsageByAccount.get(auth.accountKey) || null;
  const tokenChanged = previous?.tokenFingerprint != null
    && previous.tokenFingerprint !== auth.tokenFingerprint;
  const oauthSnapshot = tokenChanged && previous?.oauthSnapshot
    ? { ...previous.oauthSnapshot, pending: null, warning: null }
    : (previous?.oauthSnapshot || null);
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
    oauthSnapshot,
    statuslineSnapshot: previous?.statuslineSnapshot || null,
    tokenFingerprint: auth.tokenFingerprint,
    touchedAt: now,
    error: previous?.error || null,
    errorAt: previous?.errorAt || 0,
    oauthErrorAt: tokenChanged ? 0 : (previous?.oauthErrorAt || 0),
    oauthRetryNotBefore: previous?.oauthRetryNotBefore || 0,
    billing: previous?.billing || null,
    pending: tokenChanged ? null : (previous?.pending || null),
    warning: tokenChanged ? null : (previous?.warning || null),
    retryNotBefore: previous?.retryNotBefore || 0,
    needsLiveRefresh: previous
      ? (previous.needsLiveRefresh === true
        || tokenChanged)
      : false,
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
        stale: !isCurrent || !account.usage || !!entry.error || !!entry.warning || !!entry.needsLiveRefresh
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

async function bindStatuslineSession(bindingKey, authReader, namespaceKey = 'default') {
  const existing = statuslineSessionBindings.get(bindingKey);
  if (existing) return existing;
  const bindingHash = shortHash(`statusline-binding-v1|${bindingKey}`, 32);
  const persisted = persistedStatuslineBindings.get(bindingHash);
  const persistedAccount = persisted
    ? claudeUsageByAccount.get(persisted.accountKey)?.account
    : null;
  if (persistedAccount) {
    const binding = {
      accountKey: persisted.accountKey,
      tokenFingerprint: null,
      account: persistedAccount,
    };
    statuslineSessionBindings.set(bindingKey, binding);
    persistedStatuslineBindings.set(bindingHash, {
      ...persisted,
      touchedAt: Date.now(),
    });
    pruneClaudeStatuslineBindings();
    return binding;
  }
  let inflight = statuslineBindingInflight.get(bindingKey);
  if (!inflight) {
    inflight = (async () => {
      const before = await authReader();
      if (!before?.accountKey) return null;
      if ((before.namespaceKey || 'default') !== namespaceKey) return null;
      const after = await authReader();
      if (!authMatches(before, after)) return null;
      const binding = {
        accountKey: after.accountKey,
        tokenFingerprint: after.tokenFingerprint,
        account: accountFromAuth(after),
      };
      statuslineSessionBindings.set(bindingKey, binding);
      persistedStatuslineBindings.set(bindingHash, {
        bindingHash,
        accountKey: after.accountKey,
        touchedAt: Date.now(),
      });
      pruneClaudeStatuslineBindings();
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
  namespaceReader = captureClaudeUsageAuthNamespace,
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
    usage = statuslineUsageOnly(
      normalizeClaudeUsageData(data.rate_limits, { statusline: true }),
    );
  } catch (error) {
    console.warn('[ClaudeUsage] rejected invalid statusline rate_limits:', error?.message || String(error));
    return { accepted: false, reason: error?.code || 'invalid-response' };
  }
  const namespaceKey = namespaceReader().key;
  const bindingKey = (namespaceKey === 'default' ? '' : namespaceKey + ':') + `${sessionId}:${Math.trunc(processId)}`;
  const binding = await bindStatuslineSession(bindingKey, authReader, namespaceKey);
  if (!binding?.accountKey) return { accepted: false, reason: 'auth-changed' };
  const nowMs = now();
  const bridgeAt = Number(data.updated_at);
  const fetchedAt = Number.isFinite(bridgeAt) && bridgeAt > 0
    ? Math.min(nowMs, bridgeAt * 1000)
    : nowMs;
  const previous = claudeUsageByAccount.get(binding.accountKey) || null;
  const accountKind = previous?.account?.kind || binding.account?.kind || 'claude-managed-key';
  const timestamp = new Date(fetchedAt).toISOString();
  const reconciled = reconcileClaudeUsageSourceSnapshot(previous?.statuslineSnapshot || null, {
    data: usage,
    source: 'claude-statusline',
    fetchedAt,
  }, nowMs);
  let next = {
    ...(previous || {}),
    account: {
      ...binding.account,
      ...(previous?.account || {}),
    },
    statuslineSnapshot: reconciled.snapshot,
    tokenFingerprint: previous?.tokenFingerprint || binding.tokenFingerprint,
    lastAttemptAt: fetchedAt,
    touchedAt: nowMs,
    billing: previous?.billing || null,
    needsLiveRefresh: accountKind === 'max-oauth'
      ? (previous?.needsLiveRefresh === true || !previous?.oauthSnapshot?.usage)
      : (reconciled.accepted ? false : (previous?.needsLiveRefresh || false)),
  };
  if (accountKind !== 'max-oauth') {
    next = {
      ...next,
      error: null,
      errorAt: 0,
      retryNotBefore: 0,
    };
  }
  const oauthIsDisplayed = accountKind === 'max-oauth'
    && previous?.account?.source === 'anthropic-oauth-api'
    && previous?.account?.usage;
  const fallbackSupersedesFailedOAuth = accountKind === 'max-oauth'
    && Number(previous?.oauthErrorAt || 0) > 0
    && Number(reconciled.snapshot?.fetchedAt || 0) >= Number(previous?.oauthSnapshot?.fetchedAt || 0);
  if (!oauthIsDisplayed || fallbackSupersedesFailedOAuth) {
    next = displayClaudeUsageSnapshot(next, reconciled.snapshot);
    if (accountKind === 'max-oauth') {
      next = {
        ...next,
        error: null,
        errorAt: 0,
        needsLiveRefresh: false,
      };
    }
  }
  claudeUsageByAccount.set(binding.accountKey, next);
  pruneClaudeUsageAccounts(binding.accountKey);
  if (reconciled.accepted) {
    persistClaudeUsageState();
    if (accountKind !== 'max-oauth') {
      saveUsageSnapshot(binding.accountKey, next.account.usage, next.fetchedAt);
    }
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
  const inflightKey = `${auth.accountKey}:${auth.tokenFingerprint || 'session'}:${auth.currentKind}:full`;
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
  let auth = null, authError = null;
  try { auth = await authReader(); }
  catch (error) { authError = error; }
  const nowMs = now();
  if (auth?.accountKey) ensureCurrentAuthAccount(auth, nowMs);
  const currentAccountKey = auth?.accountKey || null;

  let response = buildUsageResponse({
    requestedAccountKey,
    currentAccountKey,
    now: nowMs,
    ...(authError ? { error: String(authError.code || 'auth_source_unavailable') + ': ' + authError.message } : {}),
  });
  const selectedIsHistorical = response.selectedAccountKey
    && response.selectedAccountKey !== currentAccountKey;
  if (selectedIsHistorical || !auth?.accountKey) {
    if (!response.selectedAccountKey && !authError) {
      response = {
        ...response,
        ok: false,
        error: 'Claude is not signed in and no saved account snapshot is available.',
      };
    }
    return response;
  }

  const current = claudeUsageByAccount.get(auth.accountKey) || null;

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

  if (auth.currentKind === 'max-oauth') {
    if (current?.oauthRetryNotBefore && nowMs < current.oauthRetryNotBefore) {
      return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
    }
    if (!force && current?.oauthErrorAt
      && nowMs - current.oauthErrorAt < ERROR_COOLDOWN_MS) {
      return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
    }
    if (!force && hasFreshOAuthUsageSnapshot(current, auth.tokenFingerprint, nowMs)) {
      return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
    }
  }
  if (auth.currentKind === 'api-platform'
    && current?.retryNotBefore && nowMs < current.retryNotBefore) {
    return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
  }
  if (auth.currentKind === 'api-platform'
    && !force && current?.errorAt
    && current.tokenFingerprint === auth.tokenFingerprint
    && nowMs - current.errorAt < ERROR_COOLDOWN_MS) {
    return buildUsageResponse({ requestedAccountKey, currentAccountKey, now: nowMs });
  }
  if (auth.currentKind === 'api-platform'
    && !force && !current?.error && current?.account?.usage
    && !current.needsLiveRefresh
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
        needsLiveRefresh: false,
      });
    } else {
      const reconciled = reconcileClaudeUsageSourceSnapshot(previous?.oauthSnapshot || null, {
        data: result.data,
        source: 'anthropic-oauth-api',
        fetchedAt: result.fetchedAt,
      }, lastAttemptAt);
      let next = {
        ...previous,
        account: {
          ...accountFromAuth(auth),
          ...(previous?.account || {}),
        },
        oauthSnapshot: reconciled.snapshot,
        tokenFingerprint: auth.tokenFingerprint,
        touchedAt: lastAttemptAt,
        lastAttemptAt,
        error: null,
        errorAt: 0,
        retryNotBefore: 0,
        oauthErrorAt: 0,
        oauthRetryNotBefore: 0,
        needsLiveRefresh: reconciled.accepted ? false : (previous?.needsLiveRefresh || false),
      };
      next = displayClaudeUsageSnapshot(next, reconciled.snapshot);
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
    let latestAuth = null;
    let latestAuthReadError = null;
    try { latestAuth = await authReader(); } catch (authError) { latestAuthReadError = authError; }
    if (latestAuthReadError) {
      return buildUsageResponse({
        requestedAccountKey,
        currentAccountKey: null,
        now: now(),
        error: latestAuthReadError,
      });
    }
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
    const failureAt = now();
    if (auth.currentKind === 'max-oauth' && previous?.statuslineSnapshot?.usage) {
      const fallback = previous.statuslineSnapshot;
      const oauthFetchedAt = Number(previous?.oauthSnapshot?.fetchedAt || 0);
      const shouldUseFallback = previous?.account?.source === 'claude-statusline'
        || Number(fallback.fetchedAt || 0) >= oauthFetchedAt;
      let next = {
        ...previous,
        tokenFingerprint: auth.tokenFingerprint,
        lastAttemptAt,
        touchedAt: lastAttemptAt,
        oauthErrorAt: failureAt,
        oauthRetryNotBefore: error?.code === 'rate_limited'
          ? failureAt + Number(error.retryAfterMs || ERROR_COOLDOWN_MS)
          : 0,
      };
      if (shouldUseFallback) {
        const fallbackWasAlreadyDisplayed = previous?.account?.source === 'claude-statusline'
          && Number(previous?.fetchedAt || 0) === Number(fallback.fetchedAt || 0);
        next = displayClaudeUsageSnapshot({
          ...next,
          error: null,
          errorAt: 0,
          retryNotBefore: 0,
          needsLiveRefresh: false,
        }, fallback);
        if (!fallbackWasAlreadyDisplayed) {
          saveUsageSnapshot(auth.accountKey, fallback.usage, fallback.fetchedAt);
        }
      } else {
        next = {
          ...next,
          error: error?.message || String(error),
          errorAt: failureAt,
          needsLiveRefresh: true,
        };
      }
      claudeUsageByAccount.set(auth.accountKey, next);
      pruneClaudeUsageAccounts(auth.accountKey);
      persistClaudeUsageState();
      console.warn(
        '[ClaudeUsage] OAuth usage refresh failed account=' + auth.label
        + ' display=' + (shouldUseFallback ? 'statusline-fallback' : 'last-oauth')
        + ' code=' + (error?.code || 'network_error'),
      );
      return buildUsageResponse({
        requestedAccountKey,
        currentAccountKey: auth.accountKey,
        now: now(),
      });
    }
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
      oauthErrorAt: auth.currentKind === 'max-oauth' ? failureAt : (previous?.oauthErrorAt || 0),
      oauthRetryNotBefore: auth.currentKind === 'max-oauth' && error?.code === 'rate_limited'
        ? failureAt + Number(error.retryAfterMs || ERROR_COOLDOWN_MS)
        : (previous?.oauthRetryNotBefore || 0),
      needsLiveRefresh: auth.currentKind === 'max-oauth'
        ? true
        : (previous?.needsLiveRefresh || false),
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
  persistedStatuslineBindings.clear();
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

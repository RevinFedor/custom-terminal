'use strict';

const PROVIDERS = new Set(['claude', 'codex']);
const SOURCES = new Set(['admin-api', 'anthropic-oauth-api', 'claude-auth-status', 'claude-statusline',
  'active-session-rollout', 'openai-usage-api', 'codex-app-server', 'codex-log', 'account-log',
  'latest-rollout-unverified', 'none']);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const percent = value => finite(value) !== null && value >= 0 && value <= 100 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const stamp = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (value === '' || (typeof value === 'number' && value <= 0)) return null;
  const millis = typeof value === 'number' ? value : Date.parse(value);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const key = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : null;
const label = (value, fallback) => {
  if (typeof value !== 'string' || /(?:[A-Za-z]:[\\/]|(?:^|\s)(?:\/|~\/)|auth\.json|Bearer\s|sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{20})/i.test(value)) return fallback;
  return value.replace(/[\w.+-]+@([\w.-]+)/g, (email, domain) => email.slice(0, 2) + '***@' + domain)
    .replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) || fallback;
};
const source = value => SOURCES.has(value) ? value : 'unknown';

function publicUsageError(error) {
  if (!error) return null;
  const value = typeof error === 'string' ? error : String(error?.code || '') + ' ' + String(error?.message || '');
  if (/auth_read_timeout/i.test(value)) return { code: 'timeout', message: 'Не удалось вовремя проверить источник лимитов.' };
  if (/auth_source_unavailable|auth_changed/i.test(value)) return { code: 'usage_unavailable', message: 'Не удалось проверить источник лимитов. Показан сохранённый снимок.' };
  if (/auth_namespace|auth_source_unsupported|account.*mismatch|different.*account/i.test(value)) {
    return { code: 'account_mismatch', message: 'Не удалось подтвердить, что источник лимитов относится к выбранному аккаунту.' };
  }
  if (/401|403|unauthor|auth_missing|not signed in|login|credential|вход|авторизац/i.test(value)) {
    return { code: 'auth_required', message: 'Для обновления лимитов требуется вход на компьютере.' };
  }
  if (/429|rate.?limit|cooldown|retry.after/i.test(value)) return { code: 'rate_limited', message: 'Обновление лимитов временно ограничено. Повторите позже.' };
  if (/timeout|timed out|deadline/i.test(value)) return { code: 'timeout', message: 'Источник лимитов не ответил вовремя.' };
  return { code: 'usage_unavailable', message: 'Не удалось обновить лимиты. Последний снимок может быть устаревшим.' };
}

function publicUsageWindows(provider, usage) {
  const windows = [];
  const add = (id, title, bucket, minutes, extra = {}) => windows.push({ id, label: title,
    usedPct: percent(bucket?.utilization), resetAt: stamp(bucket?.resets_at),
    windowMinutes: minutes, status: percent(bucket?.utilization) === null ? 'unknown' : 'known',
    resetPolicy: 'own-window', ...extra });
  if (provider === 'codex') {
    // Semantic buckets were already validated by the SAME desktop source.
    // Never recreate an omitted 5h from primary/secondary or from old snapshots.
    if (usage?.seven_day) add('weekly', 'Weekly', usage.seven_day, 10080);
    if (usage?.five_hour) add('five-hour', '5-hour', usage.five_hour, 300);
    for (const item of Array.isArray(usage?.additional_rate_limits) ? usage.additional_rate_limits : []) {
      const id = key(item.key); if (!id) continue;
      const name = label(item.label, 'Model');
      if (item.seven_day) add(id + ':weekly', name + ' · Weekly', item.seven_day, 10080, { modelScope: name });
      if (item.five_hour) add(id + ':five-hour', name + ' · 5-hour', item.five_hour, 300, { modelScope: name });
    }
  } else {
    add('weekly', 'Weekly', usage?.seven_day, 10080);
    add('five-hour', '5-hour', usage?.five_hour, 300);
    const fable = (Array.isArray(usage?.model_scoped) ? usage.model_scoped : [])
      .find(item => /^fable(?:\s+\d+(?:\.\d+)?)?$/i.test(String(item?.display_name || '').trim()));
    add('fable', 'Fable', fable, 10080, { modelScope: 'Fable', resetAt: null,
      resetPolicy: 'shared-weekly', sharedWith: 'weekly' });
  }
  return windows;
}

function publicUsageExtras(provider, usage, selected) {
  let credits = null;
  let fullResets = null;
  if (provider === 'codex') {
    const value = usage?.credits;
    if (value && (value.has_credits === true || value.unlimited === true || finite(value.balance) > 0)) {
      credits = { kind: 'codex', balance: finite(value.balance), unlimited: value.unlimited === true,
        hasCredits: value.has_credits === true, overageLimitReached: value.overage_limit_reached === true };
    }
    const reset = selected?.reset_credits;
    fullResets = { status: reset && count(reset.available_count) !== null ? 'known' : 'unavailable',
      availableCount: count(reset?.available_count), timestamp: stamp(reset?.timestamp),
      items: (Array.isArray(reset?.credits) ? reset.credits : []).flatMap(item => {
        const expiresAt = stamp(item.expires_at);
        return expiresAt ? [{ label: label(item.title, 'Full reset'), expiresAt }] : [];
      }) };
  } else if (usage?.extra_usage && typeof usage.extra_usage === 'object') {
    const value = usage.extra_usage;
    credits = { kind: 'claude-extra', enabled: value.is_enabled === true, usedPct: percent(value.utilization),
      usedCredits: finite(value.used_credits), monthlyLimit: finite(value.monthly_limit),
      currency: typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null };
  }
  return { credits, fullResets };
}

function projectPublicAgentUsage(provider, data = {}, requestedAccountKey = null) {
  const nativeAccounts = (Array.isArray(data.accounts) ? data.accounts : []).filter(account => key(account.accountKey));
  const selectedKey = requestedAccountKey || key(data.selectedAccountKey) || null;
  const selected = nativeAccounts.find(account => account.accountKey === selectedKey) || null;
  const selectionMissing = !!requestedAccountKey && !selected;
  const usage = selected?.usage || (!requestedAccountKey ? data.data : null) || null;
  const rawError = selected?.lastError || selected?.error || (!selectionMissing ? data.error : null);
  const error = selectionMissing ? { code: 'account_not_found', message: 'Этот аккаунт больше не доступен в списке.' }
    : publicUsageError(rawError) || (!usage ? { code: 'usage_unavailable', message: 'Данные лимитов пока недоступны.' } : null);
  const stale = selected ? selected.stale === true : data.stale !== false;
  const sourceName = source(selected?.source || data.source);
  const accounts = nativeAccounts.map(account => ({ key: account.accountKey,
    label: label(account.label, provider === 'claude' ? 'Claude account' : 'Codex account'),
    current: account.isCurrent === true, connected: account.connected === true || account.isCurrent === true,
    stale: account.stale === true, source: source(account.source), timestamp: stamp(account.timestamp),
    status: account.lastError || account.error ? 'error' : !account.usage ? 'unavailable' : account.stale ? 'stale' : 'ok' }));
  return { version: 1, provider, ok: !error, status: error ? 'error' : stale ? 'stale' : 'ok',
    accounts, selectedAccountKey: selected?.accountKey || null,
    currentAccountKey: accounts.find(account => account.current)?.key || null,
    windows: publicUsageWindows(provider, usage), ...publicUsageExtras(provider, usage, selected),
    freshness: { stale, source: sourceName, timestamp: stamp(selected?.timestamp || data.lastSuccessAt || usage?.timestamp),
      lastAttemptAt: stamp(selected?.lastAttemptAt || data.lastAttemptAt),
      cacheAgeMs: finite(data.cachedMsAgo ?? data.cacheAgeMs) }, error };
}

function createPublicAgentUsageReader({ getClaudeUsage, getCodexUsage }) {
  return async ({ provider, accountKey = null } = {}) => {
    if (!PROVIDERS.has(provider)) throw Object.assign(new Error('provider must be claude or codex'), { statusCode: 400, code: 'invalid_provider' });
    if (accountKey !== null && !key(accountKey)) throw Object.assign(new Error('invalid account key'), { statusCode: 400, code: 'invalid_account_key' });
    const read = provider === 'claude' ? getClaudeUsage : getCodexUsage;
    try {
      // HTTP refresh is a normal reread: no force flag, no new fetcher/cache,
      // no active-tab fallback or profile/login action reachable from input.
      return projectPublicAgentUsage(provider, await read({ accountKey, force: false }), accountKey);
    } catch (error) {
      return projectPublicAgentUsage(provider, { error, stale: true }, accountKey);
    }
  };
}

module.exports = { createPublicAgentUsageReader, projectPublicAgentUsage, publicUsageError };

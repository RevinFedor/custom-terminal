'use strict';

function creditAmount(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeCreditExpiration(payload, now = Date.now()) {
  const balance = creditAmount(payload?.balance);
  if (balance == null || !Array.isArray(payload.expiring_balance_details)
    || payload.expiring_balance_details.length > 256) return null;
  const byExpiry = new Map();
  let total = 0;
  for (const grant of payload.expiring_balance_details) {
    const amount = creditAmount(grant?.amount_remaining);
    if (amount == null) return null;
    total += amount;
    if (!amount || grant.expiry_date === null) continue;
    if (typeof grant.expiry_date !== 'string') return null;
    const expiry = Date.parse(grant.expiry_date);
    if (!Number.isFinite(expiry)) return null;
    const expiresAt = new Date(expiry).toISOString();
    byExpiry.set(expiresAt, (byExpiry.get(expiresAt) || 0) + amount);
  }
  if (total > balance + 0.000001) return null;
  return {
    balance,
    fetchedAt: new Date(now).toISOString(),
    expirations: [...byExpiry].map(([expiresAt, amount]) => ({ expiresAt, amount }))
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
  };
}

async function fetchCodexCreditExpiration(auth, { fetchImpl, timeoutMs = 4000, now = Date.now } = {}) {
  if (!auth?.accessToken || !auth.accountId || !auth.accountKey) throw new Error('credit_expiry_auth_missing');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://chatgpt.com/backend-api/accounts/'
      + encodeURIComponent(auth.accountId) + '/remaining_balance', {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: controller.signal,
      headers: { Authorization: 'Bearer ' + auth.accessToken, 'ChatGPT-Account-Id': auth.accountId, Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = new Error('credit_expiry_http_' + response.status);
      const retry = response.headers?.get?.('retry-after');
      const seconds = retry == null || !retry.trim() ? NaN : Number(retry);
      error.retryAt = Number.isFinite(seconds) ? now() + Math.max(0, seconds) * 1000 : Date.parse(retry || '');
      throw error;
    }
    const value = normalizeCreditExpiration(await response.json(), now());
    if (!value) throw new Error('credit_expiry_invalid_response');
    return value;
  } finally { clearTimeout(timer); }
}

function createCodexCreditExpirationReader({ fetchImpl, now = Date.now, ttlMs = 25_000, cooldownMs = 60_000 } = {}) {
  const cache = new Map();
  const inflight = new Map();
  return {
    async read(auth, { force = false } = {}) {
      const key = auth.accountKey + ':' + auth.tokenFingerprint;
      const cached = cache.get(key);
      if (cached?.retryAt > now()) return null;
      if (!force && cached?.value && now() - cached.at < ttlMs) return cached.value;
      if (inflight.has(key)) return inflight.get(key);
      const request = fetchCodexCreditExpiration(auth, { fetchImpl, now }).then(value => {
        cache.set(key, { value, at: now(), retryAt: 0 });
        return value;
      }, error => {
        cache.set(key, { value: null, at: now(), retryAt: Math.max(now() + cooldownMs, error.retryAt || 0) });
        return null;
      }).finally(() => {
        inflight.delete(key);
        while (cache.size > 8) cache.delete(cache.keys().next().value);
      });
      inflight.set(key, request);
      return request;
    },
  };
}

module.exports = { normalizeCreditExpiration, fetchCodexCreditExpiration, createCodexCreditExpirationReader };

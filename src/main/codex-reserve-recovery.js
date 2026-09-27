'use strict';

const { CodexAppServerClient } = require('./codex-account-profiles');
const clean = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isReserve = value => clean(value) === 'gpt-reserve';
const pair = value => value && clean(value.model) && clean(value.model) !== 'none'
  && clean(value.effort) && clean(value.effort) !== 'none'
  ? { model: clean(value.model), effort: clean(value.effort) } : null;

// The explicit choice wins over the temporary provider fallback. A historical
// choice belongs to its source session; another imported/forked source cannot
// borrow it merely because it occupies the same tab.
function codexReserveReturnChoice({ sessionId, intent, preference } = {}) {
  const requested = pair(intent);
  if (requested && isReserve(requested.model)) return null;
  if (requested && intent.appliedOwnerId === sessionId
    && intent.appliedRevision === intent.revision) {
    return { ...requested, sessionId, revision: intent.revision,
      actionSequence: Number(intent.actionSequence || 0), source: 'user-choice' };
  }
  const remembered = pair(preference);
  if (remembered && !isReserve(remembered.model) && preference.sessionId === sessionId
    && Number(preference.actionSequence || 0) === Number(intent?.actionSequence || 0)) {
    return { ...remembered, sessionId, revision: Number(intent?.revision || 0),
      actionSequence: Number(intent?.actionSequence || 0), source: 'before-usage-fallback' };
  }
  return null;
}

function captureCodexReserveReturnPreference({ sessionId, intent, observed, previous } = {}) {
  if (!sessionId || isReserve(intent?.model)) return null;
  const requested = pair(intent);
  const actual = pair(observed);
  const chosen = requested && intent.appliedOwnerId === sessionId
    && intent.appliedRevision === intent.revision && !isReserve(requested.model) ? requested
    : actual && !isReserve(actual.model) ? actual : null;
  if (!chosen) return previous?.sessionId === sessionId ? previous : null;
  return { ...chosen, sessionId, actionSequence: Number(intent?.actionSequence || 0) };
}

function sameCodexReserveReturnChoice(a, b) {
  return !!a && !!b && ['model', 'effort', 'sessionId', 'revision', 'actionSequence', 'source']
    .every(key => a[key] === b[key]);
}

function planCodexReserveReturn(choice, availability) {
  if (!choice) return { restore: false, reason: 'previous-choice-unproven' };
  if (availability?.ordinaryUsageAllowed !== true) return { restore: false,
    reason: availability?.ordinaryUsageAllowed === false ? 'ordinary-usage-exhausted'
      : availability?.reason || 'ordinary-usage-unknown' };
  const model = availability.models?.find(row => row.model === choice.model);
  if (!model || !model.efforts.includes(choice.effort)) {
    return { restore: false, reason: 'previous-pair-unavailable' };
  }
  return { restore: true, model: choice.model, effort: choice.effort,
    reason: 'ordinary-usage-available' };
}

// Memory-only, account AND credential scoped. One read serves a restart burst;
// no persisted quota, percentages, reset credits, or catalog alone grant return.
function createCodexReserveAvailabilityProbe({ readAuth,
  clientFactory = options => new CodexAppServerClient(options), now = Date.now,
  cacheMs = 5000, proofMs = 15000 } = {}) {
  const cache = new Map(), inflight = new Map();
  const identity = home => {
    try {
      const auth = readAuth(home);
      return auth?.accountId && auth?.tokenFingerprint ? {
        accountId: auth.accountId,
        key: JSON.stringify([home, auth.accountId, auth.userId, auth.tokenFingerprint]),
      } : null;
    } catch { return null; }
  };
  const current = (home, result) => !!result?.identityKey
    && identity(home)?.key === result.identityKey
    && now() - result.checkedAt >= 0 && now() - result.checkedAt <= proofMs;
  async function read(home) {
    const owner = identity(home);
    if (!owner) return { ordinaryUsageAllowed: null, reason: 'account-unproven' };
    const cached = cache.get(owner.key);
    if (cached && now() - cached.checkedAt < cacheMs && current(home, cached)) return cached;
    if (inflight.has(owner.key)) return inflight.get(owner.key);
    const work = (async () => {
      let client, deadline;
      const finish = data => {
        const result = { ...data, identityKey: owner.key, checkedAt: now() };
        if (!current(home, result)) return { ordinaryUsageAllowed: null, reason: 'account-changed' };
        cache.set(owner.key, result);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
        return result;
      };
      try {
        client = clientFactory({ codexHome: home, requestTimeoutMs: 8000 });
        deadline = setTimeout(() => client.close(), 15000);
        deadline.unref?.();
        await client.start();
        const auth = await client.request('account/read', { refreshToken: false });
        if (auth?.account?.type !== 'chatgpt') return finish({ ordinaryUsageAllowed: null, reason: 'chatgpt-account-unproven' });
        const usage = await client.request('account/rateLimits/read', {});
        if (usage?.accountId !== owner.accountId) return finish({ ordinaryUsageAllowed: null, reason: 'account-mismatch' });
        const ordinaryUsageAllowed = typeof usage.ordinaryUsageAllowed === 'boolean'
          ? usage.ordinaryUsageAllowed : null;
        const models = [];
        if (ordinaryUsageAllowed === true) {
          let cursor = null;
          const seen = new Set();
          do {
            const result = await client.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
            if (!Array.isArray(result?.data)) throw Error('model-list-unavailable');
            for (const row of result.data) if (row.hidden !== true && clean(row.model || row.id)) {
              models.push({ model: clean(row.model || row.id), efforts: (row.supportedReasoningEfforts || [])
                .map(e => clean(e.reasoningEffort)).filter(Boolean) });
            }
            cursor = result.nextCursor;
            if (cursor && (seen.has(cursor) || seen.size >= 10)) throw Error('model-list-incomplete');
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        return finish({ ordinaryUsageAllowed, models,
          reason: ordinaryUsageAllowed == null ? 'ordinary-usage-unknown' : null });
      } catch {
        return finish({ ordinaryUsageAllowed: null, reason: 'availability-read-failed' });
      } finally { clearTimeout(deadline); try { client?.close(); } catch {} }
    })();
    inflight.set(owner.key, work);
    try { return await work; } finally { if (inflight.get(owner.key) === work) inflight.delete(owner.key); }
  }
  return { read, current };
}

module.exports = { isCodexReserveModel: isReserve, codexReserveReturnChoice,
  captureCodexReserveReturnPreference, sameCodexReserveReturnChoice,
  planCodexReserveReturn, createCodexReserveAvailabilityProbe };

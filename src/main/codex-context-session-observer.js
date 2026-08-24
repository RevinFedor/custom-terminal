'use strict';

function createCodexContextSessionObserver({
  transcriptService,
  listBoundTabs,
  listCachedSessions,
  readContextState,
  commitContextValue,
  invalidateContextState,
  clearPersistedContext,
  publishContextFrame,
  log = console,
} = {}) {
  if (!transcriptService || typeof transcriptService.subscribe !== 'function') {
    throw new Error('codex_context_transcript_service_required');
  }
  const bindings = new Map();
  let hydrationTimer = null;

  function observe(detail) {
    if (detail?.toolType !== 'codex' || !detail?.sessionId) return;
    const observation = detail.observation || null;
    if (!observation || (observation.kind !== 'value' && observation.kind !== 'invalidated')) return;
    const rows = typeof listBoundTabs === 'function'
      ? listBoundTabs(detail.sessionId) || []
      : [];
    for (const row of rows) {
      const tabId = String(row?.tabId || row?.tab_id || '').trim();
      if (!tabId) continue;
      if (observation.kind === 'invalidated') {
        const cleared = clearPersistedContext?.(tabId, detail.sessionId) === true;
        if (!cleared) continue;
        invalidateContextState?.(tabId, detail.sessionId);
        publishContextFrame?.(tabId, detail.sessionId, null, {
          invalidated: true,
          reason: observation.reason || 'compacted',
          source: detail.source || observation.source || 'transcript',
        });
        log.log?.('[CodexContext:Session] invalidated tab=' + tabId.slice(-12)
          + ' session=' + detail.sessionId.slice(0, 8)
          + ' reason=' + (observation.reason || 'compacted')
          + ' source=' + (detail.source || observation.source || 'transcript'));
        continue;
      }

      const previous = readContextState?.(tabId, detail.sessionId) || null;
      const snapshot = commitContextValue?.({
        tabId,
        sessionId: detail.sessionId,
        contextPct: observation.contextPct,
        source: detail.source === 'tail-seed' ? 'rollout-tail-seed' : 'rollout-token-count',
      }) || null;
      if (!snapshot || snapshot.persistenceAccepted === false) continue;
      if (previous?.contextPct === snapshot.contextPct) continue;
      publishContextFrame?.(tabId, detail.sessionId, snapshot.contextPct, {
        reason: observation.reason || 'token_count',
        source: detail.source || observation.source || 'transcript',
      });
      log.log?.('[CodexContext:Session] value tab=' + tabId.slice(-12)
        + ' session=' + detail.sessionId.slice(0, 8)
        + ' pct=' + snapshot.contextPct.toFixed(1)
        + ' source=' + (detail.source || observation.source || 'transcript'));
    }
  }

  async function ensure(sessionId, cwd = null) {
    const exactSessionId = String(sessionId || '').trim();
    if (!exactSessionId) return false;
    const existing = bindings.get(exactSessionId);
    if (existing) return existing.promise;
    const consumerId = 'main:codex-context:' + exactSessionId;
    const binding = { consumerId, cwd: cwd || null, promise: null };
    binding.promise = transcriptService.subscribe({
      toolType: 'codex',
      sessionId: exactSessionId,
      cwd: cwd || null,
      consumerId,
    }).then((result) => {
      if (result?.success === true) return true;
      bindings.delete(exactSessionId);
      log.warn?.('[CodexContext:Observer] subscribe failed session='
        + exactSessionId.slice(0, 8) + ' error=' + (result?.error || 'unknown'));
      return false;
    }).catch((error) => {
      bindings.delete(exactSessionId);
      log.warn?.('[CodexContext:Observer] subscribe error session='
        + exactSessionId.slice(0, 8) + ' error=' + (error?.message || error));
      return false;
    });
    bindings.set(exactSessionId, binding);
    return binding.promise;
  }

  async function hydrate() {
    const rows = typeof listCachedSessions === 'function'
      ? listCachedSessions() || []
      : [];
    let attached = 0;
    for (const row of rows) {
      const sessionId = row?.sessionId || row?.codex_session_id || null;
      const cwd = row?.cwd || null;
      if (await ensure(sessionId, cwd)) attached += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
    log.log?.('[CodexContext:Observer] hydrated=' + attached + '/' + rows.length);
    return { attached, total: rows.length };
  }

  function scheduleHydration(delayMs = 750) {
    if (hydrationTimer) clearTimeout(hydrationTimer);
    hydrationTimer = setTimeout(() => {
      hydrationTimer = null;
      void hydrate();
    }, Math.max(0, Number(delayMs) || 0));
    hydrationTimer.unref?.();
  }

  return {
    observe,
    ensure,
    hydrate,
    scheduleHydration,
    bindingCount: () => bindings.size,
  };
}

module.exports = {
  createCodexContextSessionObserver,
};

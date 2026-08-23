'use strict';

const CODEX_RESPONSE_HEADER_TIMEOUT_MS = 60_000;
const CODEX_METADATA_HEADER_TIMEOUT_MS = 15_000;
const CODEX_WEBSOCKET_HEARTBEAT_MS = 15_000;

function countAgentBucket(bucket) {
  return Object.values(bucket || {}).reduce(
    (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
    0,
  );
}

function providerProxyAgentLoad(agent) {
  return {
    active: countAgentBucket(agent?.sockets),
    free: countAgentBucket(agent?.freeSockets),
    queued: countAgentBucket(agent?.requests),
  };
}

function codexResponseHeaderTimeoutMs(pathname) {
  return /\/responses(?:\?|$)/.test(String(pathname || ''))
    ? CODEX_RESPONSE_HEADER_TIMEOUT_MS
    : CODEX_METADATA_HEADER_TIMEOUT_MS;
}

function providerProxyLifecycleError(reason, cause = null) {
  const error = cause instanceof Error
    ? cause
    : new Error('Provider proxy ' + String(reason || 'transport failure'));
  if (!error.code) {
    if (reason === 'upstream-response-header-timeout') error.code = 'ETIMEDOUT';
    else if (String(reason || '').startsWith('downstream-')) error.code = 'ECLIENTABORT';
    else error.code = 'EPROXYLIFECYCLE';
  }
  error.providerProxyReason = reason;
  return error;
}

/**
 * Bind the two independent halves of one HTTP proxy request.
 *
 * A downstream Codex abort must destroy the queued/active upstream request;
 * otherwise Node's shared Agent keeps the slot even though the CLI has already
 * fallen back. The absolute header deadline starts before socket assignment so
 * a request queued behind poisoned sockets cannot wait forever.
 */
function createProviderProxyHttpLifecycle({
  downstreamRequest,
  downstreamResponse,
  upstreamRequest,
  agent = null,
  requestId = '',
  timeoutMs = CODEX_RESPONSE_HEADER_TIMEOUT_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onEvent = () => {},
} = {}) {
  if (!upstreamRequest || typeof upstreamRequest.destroy !== 'function') {
    throw new TypeError('upstreamRequest.destroy is required');
  }

  const startedAt = now();
  let state = 'waiting-headers';
  let headerTimer = null;
  let upstreamResponse = null;

  const emit = (event, extra = {}) => {
    try {
      onEvent({
        event,
        requestId,
        state,
        elapsedMs: Math.max(0, now() - startedAt),
        load: providerProxyAgentLoad(agent),
        ...extra,
      });
    } catch {}
  };

  const removeDownstreamListeners = () => {
    downstreamRequest?.removeListener?.('aborted', onDownstreamAborted);
    downstreamResponse?.removeListener?.('close', onDownstreamClose);
  };

  const clearHeaderTimer = () => {
    if (!headerTimer) return;
    clearTimer(headerTimer);
    headerTimer = null;
  };

  const terminate = (reason, cause = null) => {
    if (state === 'completed' || state === 'terminated') return false;
    state = 'terminated';
    clearHeaderTimer();
    removeDownstreamListeners();
    const error = providerProxyLifecycleError(reason, cause);
    if (upstreamResponse && !upstreamResponse.destroyed) {
      try { upstreamResponse.destroy(error); } catch {}
    }
    if (!upstreamRequest.destroyed) {
      try { upstreamRequest.destroy(error); } catch {}
    }
    emit('terminated', { reason, code: error.code || null });
    return true;
  };

  const complete = (reason = 'upstream-response-end') => {
    if (state === 'completed' || state === 'terminated') return false;
    state = 'completed';
    clearHeaderTimer();
    removeDownstreamListeners();
    emit('completed', { reason });
    return true;
  };

  function onDownstreamAborted() {
    terminate('downstream-request-aborted');
  }

  function onDownstreamClose() {
    if (downstreamResponse?.writableEnded === true) return;
    terminate('downstream-response-closed');
  }

  downstreamRequest?.once?.('aborted', onDownstreamAborted);
  downstreamResponse?.once?.('close', onDownstreamClose);
  upstreamRequest.once?.('socket', (socket) => {
    try { socket?.setKeepAlive?.(true, CODEX_WEBSOCKET_HEARTBEAT_MS); } catch {}
    emit('socket-assigned', { reusedSocket: upstreamRequest.reusedSocket === true });
  });

  headerTimer = setTimer(() => {
    if (state === 'waiting-headers') terminate('upstream-response-header-timeout');
  }, Math.max(1, Number(timeoutMs) || CODEX_RESPONSE_HEADER_TIMEOUT_MS));
  headerTimer?.unref?.();
  emit('accepted');

  return {
    attachUpstreamResponse(response, statusCode = response?.statusCode || null) {
      if (state !== 'waiting-headers') {
        try { response?.destroy?.(providerProxyLifecycleError('late-upstream-response')); } catch {}
        return false;
      }
      clearHeaderTimer();
      state = 'streaming';
      upstreamResponse = response;
      emit('response-headers', { statusCode });
      response?.once?.('aborted', () => terminate('upstream-response-aborted'));
      response?.once?.('error', (error) => terminate('upstream-response-error', error));
      response?.once?.('end', () => complete('upstream-response-end'));
      response?.once?.('close', () => {
        if (state === 'streaming') terminate('upstream-response-closed');
      });
      return true;
    },
    complete,
    terminate,
    getState() {
      return state;
    },
  };
}

/**
 * The proxy terminates the native WebSocket into two separate connections.
 * The ws library answers control frames locally, so a healthy local half does
 * not prove the upstream half is alive. Ping the upstream explicitly and tear
 * it down when no pong arrives; its normal close handler then closes Codex's
 * local half and allows HTTPS fallback.
 */
function startProviderProxyWebSocketHeartbeat({
  upstream,
  intervalMs = CODEX_WEBSOCKET_HEARTBEAT_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onTimeout = () => {},
  onEvent = () => {},
} = {}) {
  if (!upstream || typeof upstream.on !== 'function') {
    throw new TypeError('upstream WebSocket is required');
  }

  let alive = true;
  let stopped = false;
  let timer = null;

  const onPong = () => {
    alive = true;
    try { onEvent({ event: 'pong' }); } catch {}
  };

  const stop = (reason = 'stopped') => {
    if (stopped) return false;
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    upstream.removeListener?.('pong', onPong);
    upstream.removeListener?.('close', onClose);
    upstream.removeListener?.('error', onError);
    try { onEvent({ event: 'heartbeat-stopped', reason }); } catch {}
    return true;
  };

  const timeout = () => {
    if (stopped) return;
    stop('upstream-heartbeat-timeout');
    try { onTimeout(); } catch {}
    try { upstream.terminate?.(); } catch {}
  };

  const tick = () => {
    if (stopped || upstream.readyState !== 1) return;
    if (!alive) {
      timeout();
      return;
    }
    alive = false;
    try {
      upstream.ping();
      try { onEvent({ event: 'ping' }); } catch {}
    } catch (error) {
      stop('upstream-ping-error');
      try { onTimeout(error); } catch {}
      try { upstream.terminate?.(); } catch {}
    }
  };

  function onClose() {
    stop('upstream-close');
  }

  function onError() {
    stop('upstream-error');
  }

  upstream.on('pong', onPong);
  upstream.once('close', onClose);
  upstream.once('error', onError);
  timer = setIntervalFn(tick, Math.max(1, Number(intervalMs) || CODEX_WEBSOCKET_HEARTBEAT_MS));
  timer?.unref?.();

  return { stop, tick };
}

module.exports = {
  CODEX_METADATA_HEADER_TIMEOUT_MS,
  CODEX_RESPONSE_HEADER_TIMEOUT_MS,
  CODEX_WEBSOCKET_HEARTBEAT_MS,
  codexResponseHeaderTimeoutMs,
  createProviderProxyHttpLifecycle,
  providerProxyAgentLoad,
  providerProxyLifecycleError,
  startProviderProxyWebSocketHeartbeat,
};

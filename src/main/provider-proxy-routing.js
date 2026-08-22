'use strict';

function decodeTabId(value) {
  try { return decodeURIComponent(value); } catch { return String(value || ''); }
}

function parseProviderProxyRoute(url) {
  const requestUrl = String(url || '/');
  const codex = requestUrl.match(/^\/codex\/t\/([^/?]+)(\/.*|\?.*|$)/);
  if (codex) {
    return {
      provider: 'codex',
      tabId: decodeTabId(codex[1]),
      forwardUrl: codex[2] || '/',
    };
  }
  const claude = requestUrl.match(/^\/t\/([^/?]+)(\/.*|\?.*|$)/);
  if (claude) {
    return {
      provider: 'claude',
      tabId: decodeTabId(claude[1]),
      forwardUrl: claude[2] || '/',
    };
  }
  return { provider: 'claude', tabId: null, forwardUrl: requestUrl };
}

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? String(value[0] || '') : String(value || '');
  }
  return '';
}

function joinUpstreamPath(prefix, forwardUrl) {
  const suffix = String(forwardUrl || '/');
  if (suffix.startsWith('?')) return String(prefix || '').replace(/\/$/, '') + '/' + suffix;
  return String(prefix || '').replace(/\/$/, '') + '/' + suffix.replace(/^\//, '');
}

function resolveCodexUpstream({ headers = {}, forwardUrl = '/' } = {}) {
  const subscription = !!headerValue(headers, 'chatgpt-account-id');
  return subscription
    ? {
        subscription: true,
        hostname: 'chatgpt.com',
        port: 443,
        path: joinUpstreamPath('/backend-api/codex', forwardUrl),
      }
    : {
        subscription: false,
        hostname: 'api.openai.com',
        port: 443,
        path: joinUpstreamPath('/v1', forwardUrl),
      };
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(headers, { websocket = false } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (lower === 'host' || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (websocket && (
      lower === 'sec-websocket-key'
      || lower === 'sec-websocket-version'
      || lower === 'sec-websocket-extensions'
      || lower === 'sec-websocket-protocol'
    )) continue;
    result[key] = value;
  }
  return result;
}

function codexProxyBaseUrl(port, tabId) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535 || !tabId) return null;
  return 'http://127.0.0.1:' + numericPort + '/codex/t/' + encodeURIComponent(String(tabId));
}

module.exports = {
  HOP_BY_HOP_HEADERS,
  codexProxyBaseUrl,
  decodeTabId,
  forwardHeaders,
  headerValue,
  joinUpstreamPath,
  parseProviderProxyRoute,
  resolveCodexUpstream,
};

'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

const PROVIDER = 'noted_authenticated_profile';
const ROUTE_ENV = 'NOTED_CODEX_ROUTE_TOKEN';
const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });

// Explicit server-owned auth source; private CODEX_HOME continues to own all
// CLI configuration and rollouts. Only this existing proxy sees the provider
// token. The CLI receives a local route capability, never an auth.json copy.
function createCodexAuthProfileRoute({ configuration, readAuth, captureTab, now = Date.now, randomBytes = crypto.randomBytes }) {
  if (!configuration) return null;
  const { homePath, accountKey, fixtureCwd } = configuration;
  if (!path.isAbsolute(homePath || '') || !path.isAbsolute(fixtureCwd || '')
    || !/^[a-f0-9]{16}$/.test(accountKey || '')) throw fail('codex_auth_profile_configuration_invalid');
  const bindings = new Map();
  const routeToken = randomBytes(32).toString('hex');

  function readCurrentAuth() {
    const auth = readAuth(homePath);
    if (!auth?.accessToken || !auth.accountId) throw fail('codex_auth_profile_unavailable', 503);
    if (auth.accountKey !== accountKey) throw fail('codex_auth_profile_changed');
    if (!Number.isFinite(auth.accessExpiresAtMs) || auth.accessExpiresAtMs <= now()) throw fail('codex_auth_profile_expired', 401);
    return auth;
  }
  function currentBinding(tabId, launchId) {
    const binding = bindings.get(tabId), current = captureTab(tabId);
    if (!binding || !current?.terminal || current.cwd !== fixtureCwd
      || current.terminal !== binding.terminal || current.launchId !== binding.launchId
      || launchId !== binding.launchId) {
      throw fail('codex_auth_route_owner_changed');
    }
    return binding;
  }
  function bind(tabId) {
    const current = captureTab(tabId);
    if (!current?.terminal || !current.launchId || current.cwd !== fixtureCwd) throw fail('codex_auth_route_scope_mismatch');
    readCurrentAuth();
    bindings.set(tabId, { terminal: current.terminal, launchId: current.launchId });
  }
  function authorize(tabId, headers, launchId) {
    currentBinding(tabId, launchId);
    const incoming = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    const apiIncoming = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'x-api-key')?.[1];
    const candidate = typeof incoming === 'string' && incoming.startsWith('Bearer ')
      ? incoming.slice(7) : typeof apiIncoming === 'string' ? apiIncoming : '';
    const bytes = Buffer.from(candidate);
    if (bytes.length !== routeToken.length || !crypto.timingSafeEqual(bytes, Buffer.from(routeToken))) throw fail('codex_auth_route_unauthorized', 401);
    const auth = readCurrentAuth();
    const forwarded = Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !['authorization', 'chatgpt-account-id', 'x-api-key'].includes(key.toLowerCase())));
    forwarded.authorization = 'Bearer ' + auth.accessToken;
    forwarded['chatgpt-account-id'] = auth.accountId;
    return forwarded;
  }
  function inspect() {
    const auth = readCurrentAuth();
    const email = String(auth.email || '');
    const label = email.includes('@') ? email.slice(0, 2) + '***@' + email.split('@')[1] : 'Codex profile';
    return { provider: 'codex', mode: 'server-profile', accountKey, label, configured: true,
      credentialCurrent: true, source: 'existing-profile', observedAt: new Date(now()).toISOString() };
  }
  function launchOverrides(tabId, baseUrl) {
    bind(tabId);
    if (!/^http:\/\/127\.0\.0\.1:\d+\/codex\/t\//.test(baseUrl || '')) throw fail('codex_auth_route_proxy_required');
    return [
      'model_provider=' + JSON.stringify(PROVIDER),
      `model_providers.${PROVIDER}.name="Noted authenticated profile"`,
      `model_providers.${PROVIDER}.base_url=` + JSON.stringify(baseUrl + '/_noted_profile/' + encodeURIComponent(bindings.get(tabId).launchId)),
      `model_providers.${PROVIDER}.env_key=` + JSON.stringify(ROUTE_ENV),
      `model_providers.${PROVIDER}.wire_api="responses"`,
      `model_providers.${PROVIDER}.supports_websockets=true`,
    ];
  }
  function authorizeRequest(tabId, forwardUrl, headers) {
    const parts = String(forwardUrl || '').match(/^\/_noted_profile\/([^/?]+)(\/.*|\?.*|$)/);
    if (!parts) throw fail('codex_auth_route_launch_required', 401);
    let launchId;
    try { launchId = decodeURIComponent(parts[1]); } catch { throw fail('codex_auth_route_launch_invalid', 401); }
    return { launchId, headers: authorize(tabId, headers, launchId), forwardUrl: parts[2] || '/' };
  }
  return { bind, authorize, authorizeRequest, inspect, readCurrentAuth, launchOverrides,
    childEnvironment: () => ({ [ROUTE_ENV]: routeToken }),
    assertCurrent: (tabId, launchId) => { currentBinding(tabId, launchId); readCurrentAuth(); },
    unbind: (tabId, launchId) => bindings.get(tabId)?.launchId === launchId && bindings.delete(tabId),
  };
}
module.exports = { createCodexAuthProfileRoute, PROVIDER, ROUTE_ENV };

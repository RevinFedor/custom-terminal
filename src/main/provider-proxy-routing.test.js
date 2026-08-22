'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  codexProxyBaseUrl,
  forwardHeaders,
  parseProviderProxyRoute,
  resolveCodexUpstream,
} = require('./provider-proxy-routing');

test('proxy routes Claude legacy and Codex semantic paths without guessing tab identity', () => {
  assert.deepEqual(parseProviderProxyRoute('/t/tab%20one/v1/messages?beta=1'), {
    provider: 'claude',
    tabId: 'tab one',
    forwardUrl: '/v1/messages?beta=1',
  });
  assert.deepEqual(parseProviderProxyRoute('/codex/t/tab%2Ftwo/responses'), {
    provider: 'codex',
    tabId: 'tab/two',
    forwardUrl: '/responses',
  });
});

test('Codex subscription and API-key traffic keep their native upstream paths', () => {
  assert.deepEqual(resolveCodexUpstream({
    headers: { 'ChatGPT-Account-Id': 'acct' },
    forwardUrl: '/responses',
  }), {
    subscription: true,
    hostname: 'chatgpt.com',
    port: 443,
    path: '/backend-api/codex/responses',
  });
  assert.deepEqual(resolveCodexUpstream({
    headers: { authorization: 'Bearer sk-test' },
    forwardUrl: '/responses',
  }), {
    subscription: false,
    hostname: 'api.openai.com',
    port: 443,
    path: '/v1/responses',
  });
});

test('WebSocket relay strips hop-by-hop handshake headers but preserves auth and Codex identity', () => {
  assert.deepEqual(forwardHeaders({
    host: '127.0.0.1:4001',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': 'secret',
    authorization: 'Bearer token',
    'chatgpt-account-id': 'acct',
    'x-codex-turn-state': 'state',
  }, { websocket: true }), {
    authorization: 'Bearer token',
    'chatgpt-account-id': 'acct',
    'x-codex-turn-state': 'state',
  });
});

test('Codex proxy base URL carries the exact encoded tab', () => {
  assert.equal(
    codexProxyBaseUrl(4003, 'project/tab id'),
    'http://127.0.0.1:4003/codex/t/project%2Ftab%20id',
  );
  assert.equal(codexProxyBaseUrl(0, 'tab'), null);
});

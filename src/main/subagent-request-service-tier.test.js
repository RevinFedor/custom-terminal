'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderSemanticShadow, MAX_CODEX_SUBAGENT_TIERS } = require('./provider-semantic-shadow');

const request = (tier = 'priority', child = 'child-A', extra = {}) => ({
  type: 'response.create', service_tier: tier,
  client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ session_id: child,
    thread_id: child, turn_id: 'turn-' + child }), 'x-openai-subagent': 'worker' },
  ...extra,
});
const query = (child = 'child-A', parent = 'parent-A', tab = 'tab-A') => ({
  tabId: tab, parentSessionId: parent, sessionId: child,
});
function setup() {
  const logs = []; let owner = 'launch-A';
  const shadow = createProviderSemanticShadow({ log: {log: line => logs.push(line), warn: line => logs.push(line)},
    now: () => 1000, authorizeCodexSubagentRequest: ({sourceId}) => ({
      allowed: sourceId === owner, parentSessionId: 'parent-A',
    }) });
  return {shadow, logs, connection: shadow.createCodexConnection({tabId: 'tab-A', sourceId: 'launch-A'}),
    replace() { owner = 'launch-B'; } };
}

test('own WS request tier is retained independently of missing JSONL launch settings', () => {
  const {shadow, connection, logs} = setup();
  const wire = JSON.stringify(request());
  connection.observeClientFrame(wire);
  const proof = shadow.getCodexSubagentServiceTier(query());
  assert.equal(proof.serviceTier, 'priority');
  assert.equal(proof.source, 'own-provider-request');
  assert.equal(proof.parentSessionId, 'parent-A');
  assert.equal(proof.sessionId, 'child-A');
  assert.equal(proof.turnId, 'turn-child-A');
  assert.ok(proof.requestId);
  assert.equal(wire, JSON.stringify(request()), 'observation does not rewrite the request');
  assert.ok(logs.some(line => line.includes('serviceTier=priority')));
  for (const q of [query('child-B'), query('child-A', 'parent-B'), query('child-A', 'parent-A', 'tab-B')]) {
    assert.equal(shadow.getCodexSubagentServiceTier(q), null, 'no cross-child/parent/tab substitution');
  }
});

test('HTTP metadata headers and response wrapper use the same exact child proof', () => {
  const {shadow} = setup();
  const http = shadow.createCodexConnection({tabId: 'tab-A', sourceId: 'launch-A', transport: 'http-sse'});
  http.observeHttpRequest(Buffer.from(JSON.stringify({service_tier: 'default'})), {
    'x-openai-subagent': 'worker', 'x-codex-turn-metadata': JSON.stringify({
      session_id: 'child-A', thread_id: 'child-A', turn_id: 'http-turn',
    }),
  });
  assert.equal(shadow.getCodexSubagentServiceTier(query()).serviceTier, 'default');
  http.beginRequest({response: {...request('priority'), type: undefined}});
  assert.equal(shadow.getCodexSubagentServiceTier(query()).serviceTier, 'priority');
});

test('WS handshake identity headers work without copying credentials into request metadata', () => {
  const {shadow} = setup();
  const connection = shadow.createCodexConnection({tabId: 'tab-A', sourceId: 'launch-A', headers: {
    'x-openai-subagent': 'worker', Authorization: 'SECRET_CREDENTIAL',
    'x-codex-turn-metadata': JSON.stringify({session_id: 'parent-A', thread_id: 'child-A', turn_id: 'turn-A'}),
  }});
  connection.observeClientFrame(JSON.stringify({type: 'response.create', service_tier: 'priority'}));
  assert.equal(shadow.getCodexSubagentServiceTier(query()).serviceTier, 'priority');
  assert.ok(!JSON.stringify(shadow.snapshot('tab-A')).includes('SECRET_CREDENTIAL'));
});

test('missing/null/auto/unsupported tier is unknown, never copied from parent or prior request', () => {
  for (const [value, reason] of [[undefined, 'tier-field-absent'], [null, 'tier-null'],
    ['auto', 'tier-unsupported-string'], ['PRIVATE_UNKNOWN_VALUE', 'tier-unsupported-string'],
    [12, 'tier-invalid-type']]) {
    const {shadow, connection, logs} = setup();
    connection.beginRequest(request('priority'));
    const next = request(value); if (value === undefined) delete next.service_tier;
    next.input = [{role: 'user', content: 'private body service_tier=priority'}];
    connection.beginRequest(next);
    const proof = shadow.getCodexSubagentServiceTier(query());
    assert.equal(proof.serviceTier, null);
    assert.equal(proof.reason, reason);
    assert.ok(!JSON.stringify(proof).includes('PRIVATE_UNKNOWN_VALUE'));
    assert.ok(logs.every(line => !line.includes('PRIVATE_UNKNOWN_VALUE') && !line.includes('private body')));
  }
});

test('main/side/prewarm/incomplete identity and unowned connections cannot create a child tier', () => {
  for (const candidate of [request('priority', 'child-A', {client_metadata: {}}),
    request('priority', 'parent-A'), request('priority', 'child-A', {request_kind: 'prewarm'}),
    request('priority', 'child-A', {request_kind: 'compaction'}),
    request('priority', 'child-A', {client_metadata: {'x-openai-subagent': 'worker'}})]) {
    const {shadow, connection} = setup(); connection.beginRequest(candidate);
    assert.equal(shadow.getCodexSubagentServiceTier(query()), null);
  }
  const shadow = createProviderSemanticShadow({log: {log() {}}});
  shadow.createCodexConnection({tabId: 'tab-A', sourceId: 'launch-A'}).beginRequest(request());
  assert.equal(shadow.getCodexSubagentServiceTier(query()), null, 'no default allow without Main owner');
});

test('late old connection is rejected after owner replacement; clear removes only its own tab', () => {
  const h = setup(); h.connection.beginRequest(request());
  h.replace(); h.connection.beginRequest(request('default'));
  assert.equal(h.shadow.getCodexSubagentServiceTier(query()).serviceTier, 'priority');
  const next = h.shadow.createCodexConnection({tabId: 'tab-A', sourceId: 'launch-B'});
  next.beginRequest(request('default'));
  assert.equal(h.shadow.getCodexSubagentServiceTier(query()).serviceTier, 'default');
  h.shadow.createCodexConnection({tabId: 'tab-B', sourceId: 'launch-B'}).beginRequest(request());
  h.shadow.clear('tab-A', 'test-release');
  assert.equal(h.shadow.getCodexSubagentServiceTier(query()), null);
  assert.equal(h.shadow.getCodexSubagentServiceTier(query('child-A', 'parent-A', 'tab-B')).serviceTier, 'priority');
});

test('PTY Stop preserves historical child request metadata but cannot authorize a late old request', () => {
  const h = setup(); h.connection.beginRequest(request());
  h.shadow.clear('tab-A', 'terminal-kill'); h.replace();
  assert.equal(h.shadow.getCodexSubagentServiceTier(query()).serviceTier, 'priority');
  h.connection.beginRequest(request('default'));
  assert.equal(h.shadow.getCodexSubagentServiceTier(query()).serviceTier, 'priority');
  const restartedApp = setup();
  assert.equal(restartedApp.shadow.getCodexSubagentServiceTier(query()), null, 'no invented metadata after app restart');
});

test('request tier retention is bounded and snapshot contains only scalar diagnostics', () => {
  const {shadow, connection} = setup();
  assert.ok(MAX_CODEX_SUBAGENT_TIERS > 0 && MAX_CODEX_SUBAGENT_TIERS <= 1024);
  for (let i = 0; i <= MAX_CODEX_SUBAGENT_TIERS; i++) connection.beginRequest(request('priority', 'child-' + i));
  assert.equal(shadow.getCodexSubagentServiceTier(query('child-0')), null);
  assert.equal(shadow.getCodexSubagentServiceTier(query('child-' + MAX_CODEX_SUBAGENT_TIERS)).serviceTier, 'priority');
  assert.ok(shadow.snapshot('tab-A')[0].events.length <= 96);
});

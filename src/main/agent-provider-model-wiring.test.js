'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('orchestration validates provider and model before durable reservation or target creation', () => {
  const routeStart = webSource.indexOf("if (parsed.pathname === '/api/orchestrations' && req.method === 'POST')");
  const routeEnd = webSource.indexOf('const orchestrationResultMatch =', routeStart);
  const route = webSource.slice(routeStart, routeEnd);
  const validation = route.indexOf('assertAgentProviderModel({ provider: target.toolType, model: requestedModel })');
  const reservation = route.indexOf('reserveOrGet({');
  const creation = route.indexOf("bridgeRequest('createAgentTab'");

  assert.ok(validation >= 0, 'orchestration must validate the actual target provider');
  assert.ok(reservation > validation, 'validation must happen before a durable run is reserved');
  assert.ok(creation > reservation, 'target creation must remain after durable reservation');
});

test('direct create, send, Inbox, and main start use the shared provider-model contract', () => {
  const webCalls = webSource.match(/assertAgentProviderModel\(/g) || [];
  assert.ok(webCalls.length >= 4, 'all model-bearing Project API entry points must share validation');

  const startRoute = mainSource.slice(
    mainSource.indexOf("req.url === '/terminal/ai-start'"),
    mainSource.indexOf("req.url === '/terminal/create'"),
  );
  const validation = startRoute.indexOf('assertAgentProviderModel({ provider: engine, model })');
  const terminalLookup = startRoute.indexOf('terminals.get(tabId)');
  assert.ok(validation >= 0, 'Terminal MCP start must validate the pair');
  assert.ok(terminalLookup > validation, 'start validation must precede terminal/runtime mutation');
});

test('orchestration sends carry durable operation identity and retain late exact receipts', () => {
  const dispatchStart = webSource.indexOf('async function dispatchDeferredOrchestrationRun');
  const dispatchEnd = webSource.indexOf('\nasync function ', dispatchStart + 20);
  const dispatch = webSource.slice(dispatchStart, dispatchEnd);
  assert.match(dispatch, /sendOperationKey: targetSendOperationKey/);
  assert.match(dispatch, /sendSurface: 'orchestration'/);
  assert.match(dispatch, /sendRunId: current\.runId/);
  assert.match(dispatch, /onLateReceipt:/);

  const bridgeStart = webSource.indexOf('function bridgeRequest(');
  const bridgeEnd = webSource.indexOf('\nfunction registerBridgeReplyHandler', bridgeStart);
  const bridge = webSource.slice(bridgeStart, bridgeEnd);
  assert.match(bridge, /pending\.timedOut = true/);
  assert.match(bridge, /lateCleanupTimer/);
});

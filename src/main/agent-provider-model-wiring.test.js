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
  const validation = route.indexOf('const requestedModel = (await resolveProjectAgentModelRequest(projectManager, {');
  const reservation = route.indexOf('reserveOrGet({');
  const creation = route.indexOf('materializeReservedOrchestrationTarget(');

  assert.ok(validation >= 0, 'orchestration must resolve and validate against the actual target provider');
  assert.ok(reservation > validation, 'validation must happen before a durable run is reserved');
  assert.ok(creation > reservation, 'target creation must remain after durable reservation');
});

test('orchestration persists and dispatches the resolved model rather than the caller alias', () => {
  const routeStart = webSource.indexOf("if (parsed.pathname === '/api/orchestrations' && req.method === 'POST')");
  const routeEnd = webSource.indexOf('const orchestrationResultMatch =', routeStart);
  const route = webSource.slice(routeStart, routeEnd);
  const resolution = route.indexOf('const requestedModel = (await resolveProjectAgentModelRequest(projectManager, {');
  const fingerprint = route.indexOf('model: requestedModel,', resolution);
  const deliveryIntent = route.indexOf('deliveryIntent:', fingerprint);
  const persistedModel = route.indexOf('model: requestedModel,', deliveryIntent);
  const materializeStart = webSource.indexOf('async function materializeReservedOrchestrationTarget');
  const materializeEnd = webSource.indexOf('\nfunction persistOrchestrationForkEvent', materializeStart);
  const materialize = webSource.slice(materializeStart, materializeEnd);

  assert.ok(resolution >= 0);
  assert.ok(fingerprint > resolution, 'idempotency identity must use the exact resolved model');
  assert.ok(persistedModel > deliveryIntent, 'restart intent must retain the exact resolved model');
  assert.match(materialize, /codexModel: intent\?\.model \|\| undefined/,
    'new target launch must receive the exact resolved model from durable intent');
});

test('direct create, send, Inbox, and main start use the shared provider-model contract', () => {
  const settingsAwareCalls = webSource.match(/resolveProjectAgentModelRequest\(/g) || [];
  const providerValidationCalls = webSource.match(/assertAgentProviderModel\(/g) || [];
  assert.ok(
    settingsAwareCalls.length >= 4,
    'Settings-aware Project API entry points must resolve aliases to exact model IDs',
  );
  assert.ok(
    providerValidationCalls.length >= 2,
    'legacy model-bearing entry points must retain provider/model validation',
  );

  const startRoute = mainSource.slice(
    mainSource.indexOf("req.url === '/terminal/ai-start'"),
    mainSource.indexOf("req.url === '/terminal/create'"),
  );
  const validation = startRoute.indexOf('assertAgentProviderModel({ provider: engine, model })');
  const terminalLookup = startRoute.indexOf('terminals.get(tabId)');
  assert.ok(validation >= 0, 'Terminal MCP start must validate the pair');
  assert.ok(terminalLookup > validation, 'start validation must precede terminal/runtime mutation');
});

test('typed model selection is capability-advertised and resolved before mutations', () => {
  assert.match(webSource, /agentModelSelection:[\s\S]*?version: 1/);
  assert.match(webSource, /parsed\.pathname === '\/api\/agent-models\/resolve'/);
  assert.match(webSource, /resolveAgentModelRequest\(\{/);

  const routeStart = webSource.indexOf("if (parsed.pathname === '/api/orchestrations' && req.method === 'POST')");
  const routeEnd = webSource.indexOf('const orchestrationResultMatch =', routeStart);
  const route = webSource.slice(routeStart, routeEnd);
  const typedResolution = route.indexOf('modelSelection: body.modelSelection');
  const reservation = route.indexOf('reserveOrGet({');
  assert.ok(typedResolution >= 0 && typedResolution < reservation);
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

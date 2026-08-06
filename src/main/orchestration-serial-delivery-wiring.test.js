const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test('OID-3: durable orchestration delivery never uses the provider busy queue', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const dispatcher = between(
    source,
    'async function dispatchDeferredOrchestrationRun',
    '\nasync function dispatchNextDeferredOrchestrationForTarget',
  );
  const receiptProjection = between(
    source,
    'async function applyOrchestrationTargetSendReceipt',
    '\nasync function dispatchDeferredOrchestrationRun',
  );

  assert.match(dispatcher, /claimDeferredDelivery\(runId/);
  assert.match(dispatcher, /queue:\s*false/);
  assert.match(dispatcher, /applyOrchestrationTargetSendReceipt\(runId/);
  assert.match(receiptProjection, /reconcileOrchestrationRun\(runId/);
  assert.doesNotMatch(dispatcher, /queue:\s*true/);
});

test('stopped targets enter the shared resume-and-send scenario exactly once', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const dispatcher = between(
    source,
    'async function dispatchDeferredOrchestrationRun',
    '\nasync function dispatchNextDeferredOrchestrationForTarget',
  );

  assert.match(dispatcher, /resolveOrchestrationDeliveryAdmission\(status\)/);
  assert.match(dispatcher, /claimDeferredDelivery\(runId/);
  assert.match(dispatcher, /runAgentSendScenario\(\{[\s\S]*statusAtSend:\s*deliveryAdmission\.statusAtSend/);
  assert.equal((dispatcher.match(/runAgentSendScenario\(\{/g) || []).length, 1);
  assert.doesNotMatch(dispatcher, /startAgent|resumeAgent|waitForAgentReady/);
});

test('an inactive lifecycle snapshot wakes a deferred orchestration for resume', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const lifecycle = between(
    source,
    'async function processOrchestrationLifecycle',
    '\nasync function reconcileOrchestrationRun',
  );

  assert.match(lifecycle, /resolveOrchestrationDeliveryAdmission\(payload\)/);
  assert.match(lifecycle, /snapshotAdmission\?\.canDispatch === true/);
  assert.match(lifecycle, /dispatchNextDeferredOrchestrationForTarget\(tabId/);
});

test('OID-3: dispatch readiness comes from live presence, not metadata-only tab info', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const resolver = between(
    source,
    'async function resolveAgentSessionInfo',
    '\nfunction registerBridgeReplyHandler',
  );

  assert.match(resolver, /bridgeRequest\('getClaudeTabStatus'/);
  assert.doesNotMatch(resolver, /bridgeRequest\('getTabSessionInfo'/);
});

test('OID-3: the Project API persists a prompt before dispatch and wakes it after exact predecessor result', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const route = between(
    source,
    "if (parsed.pathname === '/api/orchestrations' && req.method === 'POST')",
    '\n  const orchestrationResultMatch = parsed.pathname.match(',
  );
  const finalizer = between(
    source,
    'async function finalizeSettledOrchestration',
    '\nasync function finalizeSettledOrchestrations',
  );

  const persistAt = route.indexOf('deliveryIntent: {');
  const dispatchAt = route.indexOf('dispatchDeferredOrchestrationRun(run.runId');
  assert.ok(persistAt >= 0, 'the durable prompt envelope must be persisted');
  assert.ok(dispatchAt > persistAt, 'dispatch must happen only after durable persistence');
  assert.match(route, /predecessorBlocksDelivery/);
  assert.match(route, /deferDelivery\(run\.runId/);
  assert.match(finalizer, /dispatchNextDeferredOrchestrationForTarget\([\s\S]*'predecessor-result-proved'/);
});

test('an explicit orchestration persists intent before restoring a closed target and dispatching it', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const route = between(
    source,
    "if (parsed.pathname === '/api/orchestrations' && req.method === 'POST')",
    '\n  const orchestrationResultMatch = parsed.pathname.match(',
  );

  const persistAt = route.indexOf('deliveryIntent: {');
  const restoreAt = route.indexOf('ensureExplicitAgentTabOpen(targetTabId');
  const dispatchAt = route.indexOf('dispatchDeferredOrchestrationRun(run.runId');
  assert.ok(persistAt >= 0);
  assert.ok(restoreAt > persistAt, 'closed-tab restore is a side effect after durable intent');
  assert.ok(dispatchAt > restoreAt, 'send starts only after exact identity restore');
  assert.match(route, /status:\s*targetCreated \|\| targetNeedsRestore \? 'starting' : 'sending'/);
});

test('only explicit send boundaries may restore a closed agent tab', () => {
  const server = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const dispatcher = between(
    server,
    'async function dispatchDeferredOrchestrationRun',
    '\nasync function dispatchNextDeferredOrchestrationForTarget',
  );
  const sendRoute = between(
    server,
    'm = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/send$/);',
    "\n  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/completion-notification",
  );

  assert.doesNotMatch(dispatcher, /ensureExplicitAgentTabOpen/);
  assert.match(
    sendRoute,
    /prepareSend:\s*\(\) => ensureExplicitAgentTabOpen\(tabId, restorable\)/,
    'direct send must restore only inside the physical send attempt',
  );
  assert.ok(
    sendRoute.indexOf('runAgentSendScenario({')
      < sendRoute.indexOf('prepareSend: () => ensureExplicitAgentTabOpen(tabId, restorable)'),
    'an idempotent receipt replay must be resolved before any closed-tab restore side effect',
  );
});

test('closed-tab renderer restore preserves identity but delegates launch to the shared send scenario', () => {
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'App.tsx'),
    'utf8',
  );
  const action = between(
    renderer,
    "if (action === 'restoreClosedAgentTab')",
    "\n        if (action === 'createAgentTab')",
  );

  assert.match(action, /expectedTabId/);
  assert.match(action, /resumePolicy:\s*'never'/);
  assert.match(action, /requireExactCwd:\s*true/);
  assert.doesNotMatch(action, /startAgent|resumeClaude|run-command/);
});

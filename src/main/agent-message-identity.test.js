'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const ts = require('typescript');
const { messageRuntimeIdentity, scenarioDestination, identityUnavailable } = require('./agent-message-identity');
const { agentSendTargetPreconditionFailure: checkTarget } = require('./agent-send-target-precondition');
const { resolveCausalSourceExecutionContext } = require('./orchestration-runs');
const { resolveAgentProvider } = require('./agent-provider-model-contract');
const { orchestrationRequestFingerprint } = require('./orchestration-request-identity');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { createAgentSendReceiptRegistry, fingerprintAgentSendRequest, RECEIPT_STATES } = require('./agent-send-receipt-registry');
const { withPromptOriginPresentation } = require('./history-prompt-presentations');
const { bindStructuredAuthoringPresentation } = require('./structured-authoring');
const externalRequest = require('./external-research-request');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
};
const plain = value => JSON.parse(JSON.stringify(value));
const descriptor = { tabId: 'source', tabName: 'Source', projectId: 'project',
  projectPath: '/synthetic', toolType: 'codex', sessionId: 'saved-stale', tabType: 'terminal' };
const live = (overrides = {}) => ({ coherent: true, status: 'busy', toolType: 'codex',
  sessionId: 'history-only', sendTarget: { toolType: 'codex', sessionId: 'writer-a',
    terminalInstanceId: 'terminal-a', launchId: 'launch-a' }, ...overrides });

function wrapperContext(overrides = {}) {
  const context = vm.createContext({ messageRuntimeIdentity, scenarioDestination, identityUnavailable,
    require, path, srcMainDir: __dirname,
    findOrchestrationTabDescriptor: () => descriptor,
    readAgentRuntimeSnapshot: async () => live(), tabMessageSdkSessions: new Map(), ...overrides });
  vm.runInContext(['resolveTabMessageIdentity', 'readScenarioDestination', 'captureOrchestrationSourceTarget']
    .map(declaration).join('\n'), context);
  return context;
}

test('known identity takes the coherent writer pair, not descriptor or history SID', () => {
  const actual = messageRuntimeIdentity(descriptor, live());
  assert.equal(actual.provider, 'codex');
  assert.equal(actual.sessionId, 'writer-a');
  assert.deepEqual(actual.sendTarget, { toolType: 'codex', sessionId: 'writer-a' });
  assert.equal(actual.projectId, descriptor.projectId);
  assert.equal(checkTarget(actual.sendTarget, scenarioDestination(live())), null);
});

test('replacement session or provider cannot satisfy a previously captured target', () => {
  const pinned = messageRuntimeIdentity(descriptor, live()).sendTarget;
  for (const sendTarget of [{ toolType: 'codex', sessionId: 'writer-b' },
    { toolType: 'claude', sessionId: 'writer-a' }]) {
    const current = live({ toolType: sendTarget.toolType, sendTarget });
    assert.equal(checkTarget(pinned, scenarioDestination(current)).code, 'agent_send_target_changed');
    const resolved = messageRuntimeIdentity(descriptor, current);
    assert.equal(resolved.provider, sendTarget.toolType);
    assert.equal(resolved.sessionId, sendTarget.sessionId);
  }
});

test('same writer and exact accepted Resume pass without accepting unrelated lineage', () => {
  const pinned = messageRuntimeIdentity(descriptor, live()).sendTarget;
  const resumed = live({ sendTarget: { toolType: 'codex', sessionId: 'writer-b',
    acceptedResumeSourceSessionId: 'writer-a', terminalInstanceId: 'terminal-b', launchId: 'launch-b' } });
  assert.equal(checkTarget(pinned, scenarioDestination(live())), null);
  assert.equal(checkTarget(pinned, scenarioDestination(resumed)), null);
  assert.equal(messageRuntimeIdentity(descriptor, resumed).acceptedResumeSourceSessionId, 'writer-a');
  const unrelated = live({ sendTarget: { ...resumed.sendTarget, acceptedResumeSourceSessionId: 'other' } });
  assert.equal(checkTarget(pinned, scenarioDestination(unrelated)).code, 'agent_send_target_changed');
});

test('stopped resumable source preserves its known binding without inventing a live writer', () => {
  const stopped = live({ status: 'inactive', canResume: true, sessionId: 'resume-source', sendTarget: null });
  assert.deepEqual(messageRuntimeIdentity(descriptor, stopped).sendTarget,
    { toolType: 'codex', sessionId: 'resume-source' });
  assert.deepEqual(scenarioDestination(stopped), { toolType: 'codex', sessionId: 'resume-source' });
  assert.throws(() => messageRuntimeIdentity(descriptor, { ...stopped, canResume: false }),
    { code: 'message_runtime_identity_unavailable', submitted: false });
});

test('fresh source pins the exact launch; writer adoption is allowed but a replacement launch is not', () => {
  const fresh = live({ status: 'starting', sessionId: null,
    sendTarget: { toolType: 'codex', sessionId: null, terminalInstanceId: 'terminal-a', launchId: 'launch-a' } });
  const captured = messageRuntimeIdentity(descriptor, fresh);
  assert.equal(captured.sessionId, null);
  assert.deepEqual(captured.sendTarget, { toolType: 'codex', terminalInstanceId: 'terminal-a', launchId: 'launch-a' });
  assert.equal(checkTarget(captured.sendTarget, scenarioDestination(fresh)), null);
  assert.equal(checkTarget(captured.sendTarget, scenarioDestination(live())), null);
  for (const patch of [{ terminalInstanceId: 'replacement' }, { launchId: 'replacement' }]) {
    assert.equal(checkTarget(captured.sendTarget, { ...live().sendTarget, ...patch }).code, 'agent_send_target_changed');
  }
  for (const patch of [{ terminalInstanceId: null }, { launchId: null }]) {
    assert.throws(() => messageRuntimeIdentity(descriptor, { ...fresh, sendTarget: { ...fresh.sendTarget, ...patch } }),
      { code: 'message_runtime_identity_unavailable' });
  }
});

test('unknown, incoherent and incomplete live identity never borrow a saved SID', () => {
  for (const snapshot of [null, live({ coherent: false }), live({ status: 'unknown' }),
    live({ status: null }), live({ sendTarget: null }), live({ sendTarget: { toolType: 'codex' } })]) {
    assert.throws(() => messageRuntimeIdentity(descriptor, snapshot),
      { code: 'message_runtime_identity_unavailable', statusCode: 503, submitted: false });
  }
  assert.equal(messageRuntimeIdentity(null, live()), null);
  for (const snapshot of [live({ toolType: 'claude' }), live({ toolType: 'shell', sendTarget: { toolType: 'shell', sessionId: 's' } })]) {
    assert.throws(() => messageRuntimeIdentity(descriptor, snapshot), { code: 'message_runtime_provider_unavailable' });
  }
});

test('actual resolver propagates unstable runtime and never uses descriptor fallback for PTY identity', async () => {
  const error = Object.assign(new Error('unstable'), { code: 'runtime_snapshot_unstable' });
  const context = wrapperContext({ readAgentRuntimeSnapshot: async () => { throw error; } });
  await assert.rejects(context.resolveTabMessageIdentity('source'), value => value === error);
  await assert.rejects(context.readScenarioDestination('source'), value => value === error);
  const absent = wrapperContext({ readAgentRuntimeSnapshot: null });
  await assert.rejects(absent.resolveTabMessageIdentity('source'), { code: 'message_runtime_identity_unavailable' });
  assert.equal(await absent.readScenarioDestination('source'), descriptor, 'only isolated legacy scenario hosts keep the descriptor fallback');
});

test('actual SDK resolver uses its dedicated session map without calling the PTY reader', async () => {
  const context = wrapperContext({
    findOrchestrationTabDescriptor: () => ({ ...descriptor, tabType: 'claude-sdk', toolType: 'claude' }),
    tabMessageSdkSessions: new Map([['source', { sessionId: 'sdk-writer' }]]),
    readAgentRuntimeSnapshot: async () => { throw new Error('PTY reader must not run for SDK'); },
  });
  assert.deepEqual(plain((await context.resolveTabMessageIdentity('source')).sendTarget),
    { toolType: 'claude', sessionId: 'sdk-writer' });
  assert.deepEqual(plain(await context.readScenarioDestination('source')),
    { toolType: 'claude', sessionId: 'sdk-writer' });
});

test('actual scenario wrapper carries authoritative Resume proof past the stale descriptor', async () => {
  const expected = { toolType: 'codex', sessionId: 'writer-a' };
  const sendTarget = { toolType: 'codex', sessionId: 'writer-b', acceptedResumeSourceSessionId: 'writer-a' };
  const context = wrapperContext({ readAgentRuntimeSnapshot: async () => live({ sendTarget }) });
  assert.equal(checkTarget(expected, await context.readScenarioDestination('source')), null);
});

for (const toolType of ['codex', 'claude']) {
  test(`actual ${toolType} completion wrapper delivers the full provisional A pin after materialization and rejects replacement B`, async () => {
    const provisionalA = { toolType, sessionId: null, terminalInstanceId: 'terminal-A', launchId: 'launch-A', runSeq: 7 };
    const expectedTarget = Object.freeze({ toolType, terminalInstanceId: 'terminal-A', launchId: 'launch-A', runSeq: 7 });
    const materializedA = { ...provisionalA, sessionId: 'session-A' };
    const replacementB = { toolType, sessionId: 'session-B', terminalInstanceId: 'terminal-B', launchId: 'launch-B', runSeq: 8 };
    assert.equal(checkTarget(expectedTarget, provisionalA), null);
    assert.equal(checkTarget(expectedTarget, materializedA), null, 'materialization in the original launch must remain allowed');
    let current = materializedA;
    const preflightTargets = [], bridgeCalls = [];
    const context = wrapperContext({
      findOrchestrationTabDescriptor: () => ({ ...descriptor, toolType, sessionId: current.sessionId }),
      readAgentRuntimeSnapshot: async () => {
        preflightTargets.push({ ...current });
        return live({ toolType, sessionId: current.sessionId, sendTarget: { ...current } });
      },
      agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000,
      // This wrapper case deliberately has no durable web operation. Real
      // SQLite receipt owners are exercised by the delivery integration suite.
      agentSendReceiptStore: null, agentSendReceiptRegistry: createAgentSendReceiptRegistry(),
      AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES,
      tabWorkContext: null, promptAuditFingerprint, fingerprintAgentSendRequest,
      bindStructuredAuthoringPresentation, withPromptOriginPresentation,
      agentSendTargetPreconditionFailure: checkTarget,
      bridgeRequest: async (action, payload) => {
        bridgeCalls.push({ action, payload });
        // The old launch passed main preflight. Replace it while the request
        // crosses the async renderer boundary; no real renderer or PTY runs.
        await Promise.resolve();
        current = replacementB;
        const rejected = checkTarget(payload.expectedTarget, current);
        return rejected || { success: true, submitted: true, status: 'sent' };
      },
      console: { log() {}, warn() {} },
    });
    vm.runInContext(declaration('runAgentSendScenario') + '\n' + declaration('runPreparedAgentSendScenario'), context);
    const result = await context.runAgentSendScenario({
      tabId: 'source', prompt: 'Synthetic completion', workContextPrepared: true,
      handoffId: 'orchestration-complete:provisional-' + toolType,
      source: 'orchestration-completion:provisional-' + toolType,
      provider: toolType, sessionId: 'session-A', expectedTarget, queue: true, ownership: 'project',
      // Completion gets its History receipt downstream. There is deliberately
      // no web sendOperationKey to carry expectedTarget in an attempt sidecar.
    });
    assert.equal(bridgeCalls.length, 1, 'same-launch materialization must reach the bridge: ' + JSON.stringify(result));
    assert.equal(preflightTargets.length, 1);
    assert.deepEqual(preflightTargets[0], materializedA);
    const { action, payload } = bridgeCalls[0];
    assert.equal(action, 'sendAgentPromptScenario');
    assert.equal(payload.sendOperationKey, null);
    assert.equal(payload.sendAttemptId, null);
    assert.ok(payload.expectedTarget, 'the complete original pin must cross the bridge without a durable web attempt');
    assert.deepEqual(plain(payload.expectedTarget), expectedTarget, 'do not reduce the pin to a SID or replace it with observed A/B');
    assert.equal(payload.expectedTarget.terminalInstanceId, 'terminal-A');
    assert.equal(payload.expectedTarget.launchId, 'launch-A');
    assert.equal(payload.expectedTarget.runSeq, 7);
    assert.equal(result.code, 'agent_send_target_changed');
    assert.equal(result.submitted, false);
    assert.equal(result.pasteWritten, false);
    assert.equal(result.enterWritten, false);
  });
}

test('actual capture preserves an existing source pin or unpinned legacy run without a runtime read', async () => {
  let reads = 0;
  const context = wrapperContext({ readAgentRuntimeSnapshot: async () => { reads++; throw new Error('must not rebind'); } });
  const sourceSendTarget = { toolType: 'claude', sessionId: 'original-source' };
  assert.equal(await context.captureOrchestrationSourceTarget(descriptor, { sourceSendTarget }), sourceSendTarget);
  assert.equal(await context.captureOrchestrationSourceTarget(descriptor, { runId: 'legacy' }), null);
  assert.equal(reads, 0);
});

test('actual capture reads a new source pin independently of causal execution context', async () => {
  const context = wrapperContext();
  assert.deepEqual(plain(await context.captureOrchestrationSourceTarget(descriptor, null)),
    { toolType: 'codex', sessionId: 'writer-a' });
});

function reservationBody(route) {
  const handleApi = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleApi');
  const branch = handleApi.body.statements.find(n => ts.isIfStatement(n)
    && n.expression.getText(ast) === `parsed.pathname === '${route}' && req.method === 'POST'`);
  assert.ok(branch, route);
  const attempt = branch.thenStatement.statements.find(ts.isTryStatement);
  const statements = [...attempt.tryBlock.statements];
  const end = statements.findIndex(n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText(ast) === 'reservation'));
  assert.ok(end >= 0, 'actual reservation statement');
  // Run the actual HTTP admission through reserveOrGet, never the dispatch to
  // a real agent/browser. No assertions depend on a copied reservation object.
  return 'async function reserveFromHttp(req, res, parsed) { let preparedWorkContext = null;\n'
    + statements.slice(0, end + 1).map(n => n.getText(ast)).join('\n') + '\nreturn reservation; }';
}

function reservationHarness(route, { snapshot = live(), priorRun = null, notifySource = true } = {}) {
  const browser = route === '/api/external-research/orchestrations';
  const body = { runId: 'identity-regression', sourceTabId: 'source', targetTabId: 'target',
    prompt: 'Synthetic task', notifySource, ...(browser ? { provider: 'chatgpt' } : { toolType: 'codex' }) };
  const target = { ...descriptor, tabId: 'target', tabName: 'Target', sessionId: 'target-saved' };
  let runtimeReads = 0, reserved = null, causalReads = 0;
  const context = wrapperContext({
    ...externalRequest, crypto, resolveAgentProvider, resolveCausalSourceExecutionContext,
    orchestrationRequestFingerprint, promptAuditFingerprint,
    readBody: async () => body,
    projectManager: {}, tabWorkContext: null,
    findOrchestrationTabDescriptor: id => id === 'source' ? descriptor : id === 'target' ? target : null,
    getAgentExecutionContext: () => { causalReads++; throw new Error('raw HTTP does not grant causal execution identity'); },
    readAgentRuntimeSnapshot: async () => { runtimeReads++; return snapshot; },
    resolveSendPromptPresentation: async (_manager, _body, prompt) => ({ prompt, identityPrompt: prompt, contextFiles: [], promptChips: [] }),
    resolveProjectAgentModelRequest: async () => ({ model: null }),
    assertExternalResearchCapabilities: async () => {},
    getScExternalResearchClient: () => ({}), // Omitted default browser: this source-identity fixture performs no SC RPC.
    getOrchestrationRunStore: () => ({
      getInternal: async () => priorRun,
      reserveOrGet: async input => { reserved = input; return { created: !priorRun, run: priorRun || input }; },
    }),
    sendJson: (_res, statusCode, result) => { throw Object.assign(new Error(JSON.stringify(result)), { statusCode }); },
  });
  vm.runInContext(declaration('cleanOptionalString') + '\n' + declaration('promptFingerprint')
    + '\n' + reservationBody(route), context);
  return { invoke: () => context.reserveFromHttp({ method: 'POST' }, {}, { pathname: route }),
    get reserved() { return reserved; }, get runtimeReads() { return runtimeReads; }, get causalReads() { return causalReads; } };
}

for (const route of ['/api/orchestrations', '/api/external-research/orchestrations']) {
  test(`actual ${route} raw HTTP reservation pins a new source without sourceMeta`, async () => {
    const h = reservationHarness(route);
    await h.invoke();
    assert.equal(h.reserved.sourceExecutionContext, null);
    assert.equal(h.causalReads, 0);
    assert.equal(h.runtimeReads, 1);
    assert.deepEqual(plain(h.reserved.sourceSendTarget), { toolType: 'codex', sessionId: 'writer-a' });
  });

  test(`actual ${route} replacement provider remains coherent in source proof metadata`, async () => {
    const snapshot = live({ toolType: 'claude', sendTarget: { toolType: 'claude', sessionId: 'claude-writer' } });
    const h = reservationHarness(route, { snapshot });
    await h.invoke();
    assert.deepEqual(plain(h.reserved.sourceSendTarget), { toolType: 'claude', sessionId: 'claude-writer' });
    assert.equal(h.reserved.sourceToolType, 'claude', 'source proof must read the same provider as the pinned notification destination');
  });

  test(`actual ${route} retry does not recapture a changed source or upgrade legacy pinning`, async () => {
    for (const sourceSendTarget of [{ toolType: 'claude', sessionId: 'original' }, null]) {
      const priorRun = { runId: 'identity-regression', ...(sourceSendTarget ? { sourceSendTarget } : {}) };
      const h = reservationHarness(route, { priorRun, snapshot: null });
      await h.invoke();
      assert.equal(h.runtimeReads, 0);
      assert.equal(h.reserved.sourceSendTarget, sourceSendTarget);
    }
  });

  test(`actual ${route} fresh source keeps its exact launch and notifySource=false needs no pin`, async () => {
    const snapshot = live({ status: 'starting', sessionId: null,
      sendTarget: { toolType: 'codex', terminalInstanceId: 'terminal-a', launchId: 'launch-a' } });
    const h = reservationHarness(route, { snapshot });
    await h.invoke();
    assert.deepEqual(plain(h.reserved.sourceSendTarget),
      { toolType: 'codex', terminalInstanceId: 'terminal-a', launchId: 'launch-a' });
    const quiet = reservationHarness(route, { notifySource: false, snapshot: null });
    await quiet.invoke();
    assert.equal(quiet.runtimeReads, 0);
    assert.equal(quiet.reserved.sourceSendTarget, null);
  });
}

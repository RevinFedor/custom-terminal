'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { agentSendTargetPreconditionFailure: check } = require('./agent-send-target-precondition');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
function declaration(source, name) {
  const ast = ts.createSourceFile('source.js', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}

test('ordinary tab sends are unchanged; explicit destinations never accept saved sibling IDs', () => {
  assert.equal(check(null, null), null);
  assert.equal(check({ sessionId: 'A', toolType: 'codex' }, { sessionId: 'A', toolType: 'codex' }), null);
  for (const actual of [null, { sessionId: 'B', toolType: 'codex', codexSavedSessionId: 'A' },
    { sessionId: 'A', toolType: 'claude' }]) {
    const result = check({ sessionId: 'A', toolType: 'codex' }, actual);
    assert.equal(result.code, 'agent_send_target_changed');
    assert.equal(result.submitted, false);
    assert.equal(result.pasteWritten, false);
    assert.equal(result.enterWritten, false);
  }
});

test('current accepted Resume may change physical writer; stale launch/PID cannot authorize that transition', () => {
  const term = {};
  const writer = { sessionId: 'B', sourceSessionId: 'A', launchId: 'L',
    terminalToken: term, runSeq: 7, lifecycleGeneration: 'G' };
  const codexLaunch = { command: 'codex-c', sessionId: 'A', terminalToken: term,
    runSeq: 7, lifecycleGeneration: 'G', launchId: 'L' };
  const claudeLaunch = { launchMode: 'resume', sessionIdHint: 'A', generation: 'C', pid: 123 };
  claudeLaunch.firstAcceptedBridge = { sessionId: 'B', pid: 123, generation: 'C',
    terminalToken: term, runSeq: 7, lifecycleGeneration: 'G' };
  const context = vm.createContext({
    getCodexWriterProofSnapshot: () => writer,
    codexTurnWatchers: new Map(),
    codexLastRunCommandPayload: new Map([['tab', codexLaunch]]),
    getCodexResumeReadIdentityLeaseForTab: () => null,
    terminals: new Map([['tab', term]]),
    terminalCommandState: new Map([['tab', { runSeq: 7 }]]),
    getTerminalLifecycleGeneration: () => 'G',
    bridgeKnownSessions: new Map([['tab', 'B']]),
    claudeLaunchGenerationByTab: new Map([['tab', claudeLaunch]]),
    findClaudePidByTab: () => 123,
  });
  vm.runInContext(declaration(main, 'currentCodexAcceptedResumeSourceProof') + '\n'
    + declaration(main, 'readAgentSendDestinationAtWriteBoundary'), context);
  for (const provider of ['codex', 'claude']) {
    const actual = context.readAgentSendDestinationAtWriteBoundary('tab', provider, 'stale-A');
    assert.equal(actual.sessionId, 'B');
    assert.equal(check({ sessionId: 'A', toolType: provider }, actual), null);
  }
  context.bridgeKnownSessions.set('tab', 'native-resume-C');
  const nativeResume = context.readAgentSendDestinationAtWriteBoundary('tab', 'claude');
  assert.equal(check({ sessionId: 'A', toolType: 'claude' }, nativeResume)?.submitted, false,
    'a later same-PID native Resume is not the first accepted launch writer');
  assert.equal(check({ sessionId: 'native-resume-C', toolType: 'claude' }, nativeResume), null);
  context.bridgeKnownSessions.set('tab', 'B');
  writer.acceptedResumeSource = context.currentCodexAcceptedResumeSourceProof('tab', writer);
  context.codexLastRunCommandPayload.delete('tab');
  assert.equal(check({ sessionId: 'A', toolType: 'codex' },
    context.readAgentSendDestinationAtWriteBoundary('tab', 'codex')), null,
  'retiring startup payload and exclusive read lease does not erase proven Resume source');
  writer.runSeq = 9;
  assert.equal(check({ sessionId: 'A', toolType: 'codex' },
    context.readAgentSendDestinationAtWriteBoundary('tab', 'codex'))?.submitted, false);
  writer.runSeq = 7;
  context.codexLastRunCommandPayload.set('tab', codexLaunch);
  codexLaunch.runSeq = 8;
  claudeLaunch.pid = 124;
  for (const provider of ['codex', 'claude']) {
    const actual = context.readAgentSendDestinationAtWriteBoundary('tab', provider, 'stale-A');
    assert.equal(check({ sessionId: 'A', toolType: provider }, actual)?.submitted, false);
  }
});

test('exact source precondition is fingerprinted, persisted on the attempt and rechecked before physical paste', () => {
  const scenario = declaration(web, 'runAgentSendScenario');
  assert.match(scenario, /\.\.\.\(expectedTarget \? \{ expectedTarget \} : \{\}\)/);
  const checkAt = scenario.indexOf('agentSendTargetPreconditionFailure(expectedTarget, currentTarget)');
  const beginAt = scenario.indexOf('agentSendReceiptStore.beginAttempt');
  const recordAt = scenario.indexOf('agentSendReceiptStore.stageAttemptContext');
  const bridgeAt = scenario.indexOf("bridgeRequest('sendAgentPromptScenario'");
  assert.ok(checkAt > 0 && checkAt < beginAt && beginAt < recordAt && recordAt < bridgeAt);
  const paste = declaration(main, '_safePasteAndSubmitInner');
  assert.match(paste, /destinationRecord\?\.attemptId === sendAttemptId/);
  assert.match(paste, /destinationRecord\.receipt\?\.expectedTarget/);
  const checkBeforePaste = paste.indexOf('const destinationBeforePaste = destinationFailure()');
  assert.ok(checkBeforePaste > 0 && checkBeforePaste < paste.indexOf('durablePreSubmitBoundary = isCodexPasteSource'));
  assert.match(paste, /if \(destinationBeforePaste\) return destinationBeforePaste/);
});

test('real Project send rejects a destination that changes while preparation is awaited', async () => {
  let target = { toolType: 'codex', sessionId: 'A' };
  const calls = [];
  const context = vm.createContext({
    agentSendBridgeTimeoutMs: 1000,
    agentSendReceiptStartupReady: Promise.resolve(),
    promptAuditFingerprint: () => 'prompt-hash',
    fingerprintAgentSendRequest: request => JSON.stringify(request),
    agentSendReceiptStore: null,
    findOrchestrationTabDescriptor: () => target,
    agentSendTargetPreconditionFailure: check,
    bridgeRequest: async () => { calls.push('bridge'); return { success: true, submitted: true }; },
  });
  vm.runInContext(declaration(web, 'runAgentSendScenario'), context);
  const result = await context.runAgentSendScenario({
    tabId: 'tab', prompt: 'callback', expectedTarget: { toolType: 'codex', sessionId: 'A' },
    prepareSend: async () => {
      target = { toolType: 'codex', sessionId: 'B' };
      return { descriptor: target };
    },
  });
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(result.submitted, false);
  assert.deepEqual(calls, []);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { agentSendTargetPreconditionFailure } = require('../../main/agent-send-target-precondition');

function parsed(name) {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}
const preparation = parsed('agentSendPreparation.ts');
const adapter = parsed('agentSendAdapter.ts');
const scenarios = parsed('agentScenarios.ts');
function namedSource(ast, name) {
  const node = ast.statements.find(item => (
    (ts.isFunctionDeclaration(item) && item.name?.text === name)
    || (ts.isVariableStatement(item) && item.declarationList.declarations
      .some(declaration => declaration.name.getText(ast) === name))
  ));
  assert.ok(node, name);
  return node.getText(ast).replace(/^export /, '');
}
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

async function harness({ toolType = 'codex', status = 'active', sessionId = 'A', liveSessionId = 'A',
  acceptedResumeSourceSessionId = null, afterStartupGate = null, afterReady = null,
  resumeTo = null, joinStarting = false, fresh = false, materializationSessionId = null,
  hidden = false, expectedTarget = undefined, liveTarget = null } = {}) {
  let current = { toolType, sessionId: liveSessionId, acceptedResumeSourceSessionId,
    lifecycleGeneration: 'generation-a', terminalInstanceId: 'terminal-instance', launchId: 'launch-a',
    ...liveTarget };
  let phase = status;
  let reads = 0;
  const events = [];
  const sendOptions = [];
  const beforeReadyScopes = [];
  const draft = { text: 'original authoring text', untouched: true };
  const runtime = {
    toolType, label: toolType, readyEvent: toolType + ':ready',
    getPresence: async () => {
      reads++;
      if (joinStarting && reads > 1) {
        phase = 'busy';
        current = { ...current, sessionId: 'B', acceptedResumeSourceSessionId: 'A',
          lifecycleGeneration: 'same-launch-after-first-osc' };
      }
      beforeReadyScopes.push({ ...current });
      return { status: phase, inputReady: !hidden && ['active', 'busy'].includes(phase), isBusy: phase === 'busy',
        sessionId: materializationSessionId || current.sessionId,
        ...(toolType === 'claude' ? { sendTarget: { ...current } }
          : { runtimeSnapshot: { sendTarget: { ...current } } }) };
    },
    resume: async ({ sessionId: requested }) => {
      events.push(['resume', requested]);
      phase = 'active';
      current = { ...current, sessionId: resumeTo || requested,
        acceptedResumeSourceSessionId: resumeTo ? requested : null, lifecycleGeneration: 'resumed-generation' };
      return { success: true };
    },
    startFresh: async () => {
      events.push(['startFresh']); phase = 'active';
      current = { ...current, sessionId: fresh ? 'fresh-session' : null };
      return { success: true, sessionId: current.sessionId };
    },
    sendPrompt: async (_tab, prompt, options) => {
      sendOptions.push(options);
      const failure = agentSendTargetPreconditionFailure(options.expectedTarget, current);
      if (failure) return failure;
      events.push(['paste', current.sessionId, prompt]);
      return { success: true, submitted: true, status: 'sent' };
    },
    ...(hidden ? {
      inspectDraft: () => ({ source: 'no-terminal', hasDraft: null }),
      probeDraft: async () => ({ source: 'headless-main', hasDraft: false, proofOutcome: 'absent' }),
    } : {}),
  };
  const providerContract = {
    toolType, allowUnmountedActiveComposer: hidden, carriesExactEmptyEvidence: false,
    passCancellationGuardToTransport: false,
    classifySubmitCapability: presence => presence?.status === 'busy' ? 'queue'
      : presence?.status === 'active' && presence.inputReady ? 'direct' : 'blocked',
    startupGateOwnsComposer: () => false,
    waitForStartupGate: async () => {
      if (afterStartupGate) current = { ...current, ...afterStartupGate };
    },
  };
  const context = vm.createContext({
    manualActionContract: require('../../shared/agent-manual-action.cjs'),
    console: { log() {}, warn() {} }, setTimeout, clearTimeout,
    ipcRenderer: { on() {}, removeListener() {} },
    terminalRegistry: { get: () => hidden ? null : ({}), getDraftDiagnosticSnapshot: () => ({}) },
    isCoordinatedAgentSendCancellationRequested: () => false,
    getCoordinatedAgentSendCancellation: () => null,
    createCoordinatedAgentSendCancellationWait: () => null,
    getAgentSendProviderContract: () => providerContract,
    prepareAgentRecordContext: async () => ({ complete: false, historyContextResult: null, restartPerformed: false }),
    agentSendSettingsContractError: () => null,
    agentSendTargetPreconditionFailure,
    ...(await import('./agentDraftPreflight.mjs')),
    ...(await import('./agentSendOutcome.mjs')),
    ...(await import('./agentSendFlow.mjs')),
  });
  const shared = path.join(__dirname, '../../shared/agent-send-target-precondition.cjs');
  if (fs.existsSync(shared)) Object.assign(context, require(shared));
  for (const name of ['needsExactDraftCapture', 'createAgentReadyWait',
    'prepareAgentRuntimeForSend', 'proveAgentComposerForSend']) {
    vm.runInContext(compile(namedSource(preparation, name)), context);
  }
  vm.runInContext(compile(namedSource(adapter, 'createAgentSendAdapter')), context);
  vm.runInContext(compile(namedSource(scenarios, 'normalizeStatus') + '\n'
    + namedSource(scenarios, 'runAgentPromptScenario')), context);
  return {
    events, sendOptions, draft, beforeReadyScopes,
    send: async () => {
      try {
        return await context.runAgentPromptScenario({ tabId: 'tab', toolType, runtime,
          sessionId, expectedTarget, prompt: draft.text, handoffId: 'same-handoff', settingsIntent: { kind: 'none' },
          source: 'history-panel', statusAtSend: status,
          onReadyForSend: () => { if (afterReady) current = { ...current, ...afterReady }; },
        });
      } catch (error) { return error.sendReceipt || { error: error.message, code: error.code }; }
    },
  };
}

for (const toolType of ['claude', 'codex']) {
  for (const status of ['active', 'busy']) {
    test(toolType + ' ' + status + ' cannot accept the readiness of unrelated conversation B for Send A', async () => {
      const h = await harness({ toolType, status, liveSessionId: 'B' });
      const result = await h.send();
      assert.equal(result.code, 'agent_send_target_changed');
      assert.equal(result.submitted, false);
      assert.equal(h.sendOptions.length, 0, 'reject before the provider adapter or composer can mutate B');
      assert.equal(h.draft.text, 'original authoring text');
    });
  }
}

test('a new writer after the startup gate cannot borrow an earlier ready read', async () => {
  const h = await harness({ afterStartupGate: { sessionId: 'B' } });
  const result = await h.send();
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(h.sendOptions.length, 0);
});

test('Claude materialization ID A is not live destination authority for actual writer B', async () => {
  const h = await harness({ toolType: 'claude', liveSessionId: 'B', materializationSessionId: 'A' });
  assert.equal((await h.send()).code, 'agent_send_target_changed');
  assert.equal(h.sendOptions.length, 0);
});

test('the actual scenario and adapter retain the original target through the last provider call', async () => {
  const h = await harness({ afterReady: { sessionId: 'B' } });
  const result = await h.send();
  assert.equal(result.submitted, false);
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(h.sendOptions[0].expectedTarget.sessionId, 'A');
  assert.equal(h.sendOptions[0].expectedTarget.toolType, 'codex');
  assert.equal(h.events.some(event => event[0] === 'paste'), false);
});

for (const toolType of ['claude', 'codex']) {
  test(toolType + ' initiating Resume A may consume its exact accepted writer B without retargeting the intent', async () => {
    const h = await harness({ toolType, status: 'inactive', resumeTo: 'B' });
    const result = await h.send();
    assert.equal(result.success, true);
    assert.deepEqual(h.events.filter(event => event[0] === 'resume'), [['resume', 'A']]);
    assert.equal(h.sendOptions[0].expectedTarget.sessionId, 'A');
    assert.equal(h.events.filter(event => event[0] === 'paste').length, 1);
  });
}

test('joining the same accepted starting Resume preserves its source-to-writer strengthening', async () => {
  const h = await harness({ status: 'starting', joinStarting: true });
  assert.equal((await h.send()).success, true);
  assert.equal(h.events.some(event => event[0] === 'resume' || event[0] === 'startFresh'), false);
  assert.equal(h.sendOptions[0].expectedTarget.sessionId, 'A');
  assert.equal(h.beforeReadyScopes[0].lifecycleGeneration, 'generation-a');
  assert.equal(h.sendOptions[0].expectedTarget.lifecycleGeneration, 'same-launch-after-first-osc',
    'readiness uses the final accepted scope, not the earlier compatibility read');
  assert.equal(h.events.filter(event => event[0] === 'paste').length, 1);
});

test('fresh launch and hidden unchanged composer remain supported', async () => {
  const fresh = await harness({ status: 'inactive', sessionId: null, liveSessionId: null, fresh: true });
  assert.equal((await fresh.send()).success, true);
  assert.equal(fresh.events.filter(event => event[0] === 'startFresh').length, 1);
  const hidden = await harness({ hidden: true });
  assert.equal((await hidden.send()).success, true);
  assert.equal(hidden.sendOptions[0].expectedTarget.sessionId, 'A');
});

test('unresolved public writer identity reaches the main admission without a false startup refusal', async () => {
  const h = await harness({ status: 'busy', sessionId: 'A', liveSessionId: null, afterReady: { sessionId: 'A' } });
  assert.equal((await h.send()).success, true);
  assert.equal(h.sendOptions[0].expectedTarget.sessionId, 'A');
  assert.equal(h.events.some(event => event[0] === 'resume' || event[0] === 'startFresh'), false);
  assert.equal(h.events.filter(event => event[0] === 'paste').length, 1);
});

for (const toolType of ['claude', 'codex']) {
  const provisionalPin = () => Object.freeze({ toolType,
    terminalInstanceId: 'terminal-instance', launchId: 'launch-a', runSeq: 7 });

  test(toolType + ' full provisional pin survives actual readiness materialization and reaches the provider intact', async () => {
    const expectedTarget = provisionalPin();
    const h = await harness({ toolType, expectedTarget, sessionId: 'stale-renderer-SID',
      liveSessionId: null, liveTarget: { runSeq: 7 },
      afterStartupGate: { sessionId: 'materialized-A', runSeq: 8 } });
    const result = await h.send();
    assert.equal(result.submitted, true);
    assert.equal(h.beforeReadyScopes[0].sessionId, null);
    assert.equal(h.beforeReadyScopes.at(-1).sessionId, 'materialized-A');
    assert.equal(h.sendOptions.length, 1);
    const target = h.sendOptions[0].expectedTarget;
    assert.equal(target.toolType, toolType);
    assert.equal(target.sessionId, 'materialized-A', 'the original launch may acquire its first writer');
    assert.equal(target.terminalInstanceId, expectedTarget.terminalInstanceId);
    assert.equal(target.launchId, expectedTarget.launchId);
    assert.equal(target.runSeq, expectedTarget.runSeq, 'the supplied scope is not rebuilt from a later readiness snapshot');
    assert.equal(Object.hasOwn(expectedTarget, 'sessionId'), false, 'readiness must not mutate the caller pin');
    assert.equal(h.events.some(event => event[0] === 'startFresh' || event[0] === 'resume'), false);
    assert.deepEqual(h.events.filter(event => event[0] === 'paste'), [['paste', 'materialized-A', h.draft.text]]);
  });

  test(toolType + ' full pin rejects a replacement instance or launch even before a SID exists', async () => {
    for (const liveTarget of [{ terminalInstanceId: 'terminal-B' }, { launchId: 'launch-B' }]) {
      const h = await harness({ toolType, status: 'busy', sessionId: null, liveSessionId: null,
        expectedTarget: provisionalPin(), liveTarget });
      const result = await h.send();
      assert.equal(result.code, 'agent_send_target_changed');
      assert.equal(result.submitted, false);
      assert.equal(h.sendOptions.length, 0, 'replacement must fail before the provider adapter');
      assert.equal(h.events.some(event => event[0] === 'paste'), false);
      assert.equal(h.draft.text, 'original authoring text');
    }
  });

  test(toolType + ' replacement after provisional readiness cannot overwrite the pin during the startup gate', async () => {
    const h = await harness({ toolType, sessionId: null, liveSessionId: null, expectedTarget: provisionalPin(),
      afterStartupGate: { sessionId: 'writer-B', terminalInstanceId: 'terminal-B', launchId: 'launch-B' } });
    const result = await h.send();
    assert.equal(result.code, 'agent_send_target_changed');
    assert.equal(result.submitted, false);
    assert.equal(h.beforeReadyScopes[0].sessionId, null);
    assert.equal(h.beforeReadyScopes.at(-1).sessionId, 'writer-B');
    assert.equal(h.sendOptions.length, 0);
    assert.equal(h.events.some(event => event[0] === 'paste'), false);
  });

  test(toolType + ' materialized provisional pin remains original if replacement occurs immediately before the provider', async () => {
    const expectedTarget = provisionalPin();
    const h = await harness({ toolType, expectedTarget, sessionId: 'renderer-SID', liveSessionId: null,
      afterStartupGate: { sessionId: 'materialized-A' },
      afterReady: { sessionId: 'writer-B', terminalInstanceId: 'terminal-B', launchId: 'launch-B' } });
    const result = await h.send();
    assert.equal(result.code, 'agent_send_target_changed');
    assert.equal(result.submitted, false);
    assert.equal(h.sendOptions.length, 1, 'the provider boundary receives the exact original expectation');
    const target = h.sendOptions[0].expectedTarget;
    assert.equal(target.sessionId, 'materialized-A');
    assert.equal(target.terminalInstanceId, expectedTarget.terminalInstanceId);
    assert.equal(target.launchId, expectedTarget.launchId);
    assert.equal(target.runSeq, expectedTarget.runSeq);
    assert.equal(h.events.some(event => event[0] === 'paste'), false);
  });

  test(toolType + ' supplied session pin permits only its exact accepted Resume rather than the renderer SID', async () => {
    const expectedTarget = Object.freeze({ toolType, sessionId: 'original-A' });
    const accepted = await harness({ toolType, expectedTarget, sessionId: 'stale-renderer-SID',
      liveSessionId: 'writer-B', acceptedResumeSourceSessionId: 'original-A' });
    assert.equal((await accepted.send()).submitted, true);
    assert.equal(accepted.sendOptions[0].expectedTarget.sessionId, 'original-A');
    assert.deepEqual(accepted.events.filter(event => event[0] === 'paste'), [['paste', 'writer-B', accepted.draft.text]]);
    assert.equal(accepted.events.some(event => event[0] === 'resume' || event[0] === 'startFresh'), false);
    const unrelated = await harness({ toolType, expectedTarget, sessionId: 'writer-B',
      liveSessionId: 'writer-B', acceptedResumeSourceSessionId: 'unrelated-C' });
    assert.equal((await unrelated.send()).code, 'agent_send_target_changed');
    assert.equal(unrelated.sendOptions.length, 0);
  });
}

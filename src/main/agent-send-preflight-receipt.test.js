'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { pathToFileURL } = require('node:url');
const { classifyAgentSendRegistryReceipt } = require('./agent-send-receipt-registry');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test('real readiness failure crosses the App bridge with its negative receipt intact', async () => {
  const { runAgentSendFlow } = await import(pathToFileURL(path.join(__dirname,
    '../renderer/utils/agentSendFlow.mjs')).href);
  let error;
  try {
    await runAgentSendFlow({
      prepareContext: async () => ({}),
      ensureReady: async () => { throw Object.assign(new Error('Codex did not become ready for send'), {
        code: 'agent_input_readiness_timeout',
      }); },
      proveComposer: async () => assert.fail('no composer call'),
      runProviderOperation: async () => assert.fail('no transport call'),
    });
  } catch (caught) { error = caught; }
  assert.ok(error);
  const app = read('../renderer/App.tsx');
  const start = app.indexOf('} catch (err: any) {', app.indexOf("return reply(false, null, 'unknown action: ' + action)"));
  const end = app.indexOf('\n      }', start);
  assert.ok(start > 0 && end > start);
  const body = app.slice(start + '} catch (err: any) {'.length, end);
  for (const action of ['sendAgentPromptScenario', 'sendMessageAuto']) {
    const context = vm.createContext({
      err: error, action, payload: { tabId: 'exact-tab', handoffId: 'exact-handoff' },
      reply: (ok, data) => ({ ok, data }),
    });
    vm.runInContext(compile('function forward(){' + body + '}'), context);
    const forwarded = context.forward();
    assert.equal(forwarded.ok, true);
    assert.equal(forwarded.data.submitted, false);
    assert.equal(forwarded.data.code, 'agent_input_readiness_timeout');
    assert.equal(forwarded.data.handoffId, 'exact-handoff');
    assert.equal(classifyAgentSendRegistryReceipt(forwarded.data), 'not-submitted');
  }
});

test('Main-issued preflight scope survives actual scenario, flow, and App error bridge', async () => {
  const { runAgentSendFlow } = await import(pathToFileURL(path.join(__dirname,
    '../renderer/utils/agentSendFlow.mjs')).href);
  const source = read('../renderer/utils/agentScenarios.ts');
  const ast = ts.createSourceFile('scenario.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runAgentPromptScenario');
  const scope = { version: 1, id: 'main-scope', operationKey: 'O', attemptId: 'A',
    tabId: 'T', handoffId: 'H', provider: 'codex' };
  const launch = { success: false, accepted: false, launchWritten: false, protocolVersion: 1,
    launchStage: 'no-launch', launchAttempt: 1,
    launchIntent: { intentId: 'launch:fixture:1', token: 1, tabId: 'T', toolType: 'codex' },
    sendReceipt: { submitted: null, deliveryUnknown: true, status: 'delivery-unknown', operationKey: 'O', attemptId: 'A' } };
  const context = vm.createContext({ runAgentSendFlow, normalizeStatus: x => x,
    agentSendSettingsContractError: () => null,
    createAgentSendAdapter: () => ({
      prepareRecordContext: async () => ({ complete: false }),
      ensureReady: async () => { throw Object.assign(new Error('known no-launch'), launch); },
      proveComposer: () => assert.fail('must not read composer'),
      runProviderOperation: () => assert.fail('must not submit'),
    }), console: { log() {} } });
  vm.runInContext(compile(fn.getText(ast)), context);
  let error;
  await assert.rejects(context.runAgentPromptScenario({ tabId: 'T', toolType: 'codex', runtime: {},
    prompt: 'immutable', handoffId: 'H', sendOperationKey: 'O', sendAttemptId: 'A', preflightScope: scope,
    settingsIntent: { kind: 'none' } }), caught => { error = caught; return true; });
  const app = read('../renderer/App.tsx');
  const start = app.indexOf('} catch (err: any) {', app.indexOf("return reply(false, null, 'unknown action: ' + action)"));
  const end = app.indexOf('\n      }', start);
  const bridge = vm.createContext({ err: error, action: 'sendAgentPromptScenario',
    payload: { tabId: 'T', handoffId: 'H' }, reply: (ok, data) => ({ ok, data }) });
  vm.runInContext(compile('function forward(){' + app.slice(start + '} catch (err: any) {'.length, end) + '}'), bridge);
  const response = bridge.forward();
  assert.equal(response.ok, true);
  assert.equal(response.data.deliveryUnknown, true, 'renderer alone does not reclassify a durable receipt');
  assert.deepEqual(response.data.preflightRefusal.scope, scope);
  assert.equal(response.data.preflightRefusal.providerOperationStarted, false);
});

async function runCodexRefusal({ blocked = false, hasDraft = false, mainReceipt = null } = {}) {
  const source = read('../renderer/utils/historyAgentRuntimes.ts');
  const file = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'sendCodexPrompt');
  assert.ok(declaration);
  const auditTimeoutHelper = file.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'isSubmittedCodexAuditTimeout');
  assert.ok(auditTimeoutHelper, 'actual Codex audit timeout classifier');
  const errorTextHelper = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(file) === 'errorText'));
  assert.ok(errorTextHelper, 'actual renderer error formatter');
  const calls = [];
  const requests = [];
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    findTabRuntimeContext: () => ({ tab: {}, projectId: 'project' }),
    resolveCodexSettingsRuntimeProof: () => ({ activeWriterSessionId: 'writer' }),
    resolveCodexEffectiveSettings: () => ({ model: 'old', effort: 'medium' }),
    planCodexHistorySettings: () => ({ blocked, hasRequestedSettings: true,
      code: 'codex_settings_change_requires_idle', error: 'busy', model: 'new', effort: 'medium' }),
    shortTab: id => id,
    codexSendInflight: new Map(),
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    isStandaloneCodexLocalSlashCommand: () => false,
    terminalRegistry: { getCodexDraftState: () => ({ hasDraft }) },
    readCodexDraftAuthority: async () => ({ hasDraft, source: 'main' }),
    codexSettingsProofMatchesRuntimeOwner: () => false,
    isCompleteCodexSettingsRequest: () => true,
    isSubmittedCodexAuditTimeout: () => false,
    ipcRenderer: { async invoke(channel) {
      calls.push(channel);
      const args = Array.from(arguments).slice(1);
      requests.push({ channel, args });
      assert.equal(channel, 'codex:send-command',
        'settings and prompt are sent together to the main transaction, not a separate picker channel');
      if (mainReceipt) return mainReceipt;
      if (blocked) return { success: false, submitted: false, pasteWritten: false,
        enterWritten: false, code: 'codex_settings_change_requires_idle', error: 'busy' };
      return { success: false, submitted: false, pasteWritten: false,
        enterWritten: false, code: 'codex_draft_state_unknown_before_paste',
        error: 'Codex draft state is unknown' };
    } },
  });
  vm.runInContext(compile(errorTextHelper.getText(file)), context);
  vm.runInContext(compile(auditTimeoutHelper.getText(file)), context);
  const draftProbe = file.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'probeCodexDraft');
  assert.ok(draftProbe, 'actual shared Codex draft probe');
  vm.runInContext(compile(draftProbe.getText(file)), context);
  vm.runInContext(compile(declaration.getText(file)), context);
  const result = await context.sendCodexPrompt('tab', 'user prompt', {
    model: 'new', effort: 'medium', runtimeSnapshot: {},
  });
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.equal(result.enterWritten, false);
  assert.equal(classifyAgentSendRegistryReceipt(result), 'not-submitted');
  assert.equal(requests[0].args[1], 'user prompt');
  assert.equal(requests[0].args[2].model, 'new');
  assert.equal(requests[0].args[2].effort, 'medium');
  return { result, calls, requests };
}

test('History renderer preserves atomic main refusals and recovered draft data', async () => {
  const blocked = await runCodexRefusal({ blocked: true });
  assert.deepEqual(blocked.calls, ['codex:send-command']);
  assert.equal(blocked.result.code, 'codex_settings_change_requires_idle');
  const unknownDraft = await runCodexRefusal({ hasDraft: null });
  assert.deepEqual(unknownDraft.calls, ['codex:send-command']);
  assert.equal(unknownDraft.result.code, 'codex_draft_state_unknown_before_paste');
  const draftTransfer = { id: 'capture', text: 'unmodified draft', imagePaths: ['/image.png'] };
  const { result, calls } = await runCodexRefusal({
    mainReceipt: { success: false, submitted: false, pasteWritten: false,
      enterWritten: false, error: 'codex_turn_busy', code: 'codex_turn_busy', draftTransfer },
  });
  assert.deepEqual(calls, ['codex:send-command']);
  assert.equal(result.error, 'codex_turn_busy');
  assert.equal(result.submitted, false);
  assert.equal(result.draftTransfer, draftTransfer);
});

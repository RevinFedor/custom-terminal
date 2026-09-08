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

async function runCodexRefusal({ blocked = false, hasDraft = false, pickerResult = {} } = {}) {
  const source = read('../renderer/utils/historyAgentRuntimes.ts');
  const file = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'sendCodexPrompt');
  assert.ok(declaration);
  const calls = [];
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
    applyCodexPickerResultForTab: () => ({ allowed: false, code: 'proof-unowned' }),
    ipcRenderer: { async invoke(channel) {
      calls.push(channel);
      assert.equal(channel, 'codex:select-model-effort', 'user prompt must not reach transport');
      return pickerResult;
    } },
  });
  vm.runInContext(compile(declaration.getText(file)), context);
  const result = await context.sendCodexPrompt('tab', 'user prompt', {
    model: 'new', effort: 'medium', runtimeSnapshot: {},
  });
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.equal(result.enterWritten, false);
  assert.equal(classifyAgentSendRegistryReceipt(result), 'not-submitted');
  return { result, calls };
}

test('real Codex settings refusals prove no user prompt paste, and retain recovered data', async () => {
  assert.deepEqual((await runCodexRefusal({ blocked: true })).calls, []);
  assert.deepEqual((await runCodexRefusal({ hasDraft: null })).calls, []);
  const draftTransfer = { id: 'capture', text: 'unmodified draft', imagePaths: ['/image.png'] };
  const { result } = await runCodexRefusal({
    pickerResult: { success: false, error: 'codex_turn_busy', draftTransfer },
  });
  assert.equal(result.error, 'codex_turn_busy');
  assert.equal(result.draftTransfer, draftTransfer);
});

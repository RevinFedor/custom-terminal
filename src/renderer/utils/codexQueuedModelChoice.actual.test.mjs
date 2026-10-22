import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import * as currentPresentation from './agentSettingsPresentation.mjs';
import { controlBarBusyTarget } from './controlBarBusyTarget.mjs';

const presentation = process.env.MODEL_CHOICE_PRESENTATION_SOURCE
  ? await import(pathToFileURL(process.env.MODEL_CHOICE_PRESENTATION_SOURCE).href) : currentPresentation;
const source = fs.readFileSync(process.env.MODEL_CHOICE_CONTROLBAR_SOURCE
  || new URL('../components/Workspace/ClaudeControlBar.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ControlBar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.getText(ast); ts.forEachChild(node, visit); };
  visit(ast); assert.ok(found, name); return 'const ' + found + ';';
}
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;

function harness({ active = false, replaceable = false, localPending = 0, fail = false } = {}) {
  const writes = [], notices = [], logs = [], calls = [];
  let state = { type: 'codex', codexSettingsIntentModel: 'gpt-6.1-sol', codexSettingsIntentEffort: 'max',
    codexSettingsIntentRevision: 18, codexSettingsIntentAppliedRevision: 17, codexSettingsIntentControl: 'model' };
  const actions = { current: { tabId: 'T', seq: 1, pending: localPending } };
  const ctx = vm.createContext({ ...presentation, controlBarBusyTarget,
    tabId: 'T', isCodex: true, canQueueClaudeSettings: false, isCommandRunning: true,
    codexModels: [{ id: 'gpt-6.1-sol', efforts: ['max'] }, { id: 'gpt-6-astra', efforts: ['max'] }], CODEX_EFFORT_LEVELS: ['max'],
    isLocalBusy: false, localBusyReason: null, providerState: state,
    codexIntentWaiting: presentation.codexSettingsIntentIsWaiting({ isCodex: true, isCommandRunning: true, providerState: state }),
    settingsActivity: { busy: active, target: active ? 'model' : null, replaceable },
    claudeSettingActionsRef: actions, providerBindingRef: { current: 'T' },
    claudeSettingActionIsCurrent: seq => seq === actions.current.seq,
    beginControlAction() { throw Error('Codex must use its existing revisioned intent'); },
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    setPinnedPopup() {}, setHoveredTrigger() {}, setHoveredPopup() {}, setHoveredModelMenuModel() {},
    setLocalBusy(busy) { writes.push(['local-busy', busy]); }, focusTerminal() {},
    clearQuickCodexToggle() {}, recoverAgentDraftTransferToHistory: async () => {},
    useUIStore: { getState: () => ({ showToast: (...args) => notices.push(args) }) },
    showToast: (...args) => notices.push(args),
    adoptProviderState: next => { state = presentation.mergeTabProviderSnapshot({ tabId: 'T', state }, 'T', next).state; },
    ipcRenderer: { invoke: async (channel, input) => {
      calls.push({ channel, input });
      assert.equal(channel, 'codex:set-model-effort-intent');
      if (fail) throw Error('controlled IPC rejection');
      return { success: true, queued: true, intentRevision: 19,
        providerState: { ...state, codexSettingsIntentModel: input.model, codexSettingsIntentEffort: input.effort,
          codexSettingsIntentRevision: 19 } };
    } },
  });
  const names = ['settingsWritePresentation', 'settingsWriteBusy', 'beginModelEffortAction', 'endModelEffortAction',
    'rejectCodexLivePickerWithoutStateChange', 'applyCodexModelAndEffort', 'pickCodexModelEffort', 'pickModel'];
  // Failure logging needs only the existing displayed pair, not a provider.
  Object.assign(ctx, { codexModel: 'gpt-6.1-sol', codexEffort: 'max', isCommandRunning: true,
    codexTurnBusy: false, sessionId: 'S', isBusy: false });
  vm.runInContext(compile(names.map(declaration).join('\n')) + '\nglobalThis.pick = pickCodexModelEffort; globalThis.pickRow = pickModel;', ctx);
  return { ctx, calls, notices, logs, writes, state: () => state,
    pick: () => ctx.pick('gpt-6-astra', 'max'), pickRow: () => ctx.pickRow('gpt-6-astra') };
}

test('actual first Astra click during Resume replaces the queued Sol intent, without Send/Stop or fake application', async () => {
  const h = harness(); await h.pick();
  assert.equal(h.calls.length, 1, 'waiting for readiness must not silently swallow the first new choice');
  assert.equal(h.calls[0].input.model, 'gpt-6-astra');
  assert.equal(h.calls[0].input.effort, 'max');
  assert.equal(h.state().codexSettingsIntentRevision, 19);
  assert.equal(h.state().codexSettingsIntentAppliedRevision, 17);
  assert.deepEqual(presentation.codexSettingsSelection({ isCommandRunning: true, providerState: h.state(),
    effectiveSettings: { model: 'gpt-6.1-sol', effort: 'max' } }), { model: 'gpt-6-astra', effort: 'max' });
  assert.deepEqual(h.notices, []);
});

for (const options of [{ active: true }, { localPending: 1 }]) {
  test('actual physical/in-flight setting remains blocked with visible refusal: ' + JSON.stringify(options), async () => {
    const h = harness(options); await h.pick();
    assert.deepEqual(h.calls, []);
    assert.ok(h.logs.some(line => line.includes('blocked')), 'a rejected explicit click needs a reason');
    assert.equal(h.notices.length, 1);
  });
}

test('actual saved-intent IPC failure is visible and does not publish Astra as applied', async () => {
  const h = harness({ fail: true }); await h.pick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.notices.length, 1);
  assert.equal(h.state().codexSettingsIntentModel, 'gpt-6.1-sol');
  assert.equal(h.state().codexSettingsIntentAppliedRevision, 17);
});

test('actual model-only row queues Astra with the already selected compatible max during Resume', async () => {
  const h = harness(); await h.pickRow();
  assert.equal(h.calls.length, 1);
  assert.deepEqual({ ...h.calls[0].input }, { tabId: 'T', model: 'gpt-6-astra', effort: 'max', control: 'model' });
  assert.deepEqual(h.notices, []);
});

test('actual model choice also replaces Main preparation before its first owned control input', async () => {
  const h = harness({ active: true, replaceable: true }); await h.pickRow();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.notices, []);
});

test('actual model-effort flyout cannot remain enabled after its parent enters a settings write', () => {
  let gate;
  const visit = node => {
    if (ts.isJsxExpression(node) && node.expression?.getText(ast).startsWith('supportsModelEffortPair && openPopup')) {
      gate = node.expression.left.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(gate);
  const context = { supportsModelEffortPair: true, openPopup: 'model', hoveredModelMenuAnchor: {}, settingsWriteBusy: false };
  assert.equal(!!vm.runInNewContext(gate, context), true);
  assert.equal(!!vm.runInNewContext(gate, { ...context, settingsWriteBusy: true }), false);
});

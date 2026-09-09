'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const intent = require('./codex-model-effort-intent');
const picker = require('./codex-model-picker');
const { createCodexNativeSettingsIntentTracker } = require('./codex-native-settings-intent');
const { planCodexCommandLaunchSettings } = require('./codex-runtime-contract');

const root = path.join(__dirname, '../..');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const terminal = fs.readFileSync(path.join(root, 'src/renderer/components/Workspace/Terminal.tsx'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src/renderer/store/useWorkspaceStore.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
const mainAst = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = name => mainAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(mainAst) || '';
const part = (source, first, next) => {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end);
};
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

async function harness() {
  const effective = await import('../renderer/utils/codexEffectiveSettings.mjs');
  const requests = [];
  const writes = [];
  const durable = { settings: { model: 'gpt-5.6-sol', effort: 'max', proofSessionId: 'W1' }, providerState: null };
  let rendererProjection = () => {};
  const state = { ownerId: 'W1', runSeq: 1, lifecycle: 'L1', inputRevision: 2,
    frameSeq: 1, frame: 'Select Reasoning Level\n› 1. High\nPress enter to confirm or esc to go back',
    nativeModel: 'gpt-5.6-sol', nativeEffort: 'max', processRunning: true, rendererEnabled: true };
  const term = { write: value => writes.push(value) };
  const terms = new Map([['T', term]]);
  const initialProvider = { type: 'anthropic', codexSettingsIntentModel: 'gpt-5.6-sol',
    codexSettingsIntentEffort: 'max', codexSettingsIntentRevision: 1,
    codexSettingsIntentAppliedRevision: 1, codexSettingsIntentAppliedOwnerId: 'W1' };
  const providerStates = new Map([['T', initialProvider]]);
  durable.providerState = { ...initialProvider };
  const mirror = { writeSeq: 1, flushedSeq: 1, committedFrameGeneration: 1,
    complete: true, generation: 'M1', lastCommittedVisibleSnapshot: null };
  const frame = () => ({ success: true, authoritativeFrameCommitted: true, writeSeq: state.frameSeq,
    committedFrameGeneration: state.frameSeq, lines: state.frame.split('\n').map((text, row) => ({ text, row })) });
  const context = vm.createContext({
    ...intent, ...picker, ...effective, createCodexNativeSettingsIntentTracker, console: { log() {}, warn() {} },
    providerStates, terminals: terms, setImmediate,
    getProviderState: () => providerStates.get('T'),
    setProviderState: (tabId, value) => providerStates.set(tabId, value),
    broadcastProviderState() {},
    projectManager: { db: {
      db: { prepare: () => ({ get: () => ({ project_id: 'P',
        provider_state: durable.providerState ? JSON.stringify(durable.providerState) : null }) }) },
      updateTabProviderState: (_tabId, value) => { durable.providerState = structuredClone(value); },
      updateTabCodexSettings: (_project, _tabId, settings) => { durable.settings = { ...settings }; return true; },
    } },
    codexModelEffortIntentReconcileInflight: new Map(), codexModelEffortIntentReconcileRequested: new Set(),
    getCodexWriterProofSnapshot: () => state.ownerId?.startsWith('launch:') ? null : ({ sessionId: state.ownerId }),
    getCodexProvisionalSettingsSnapshot: () => state.ownerId?.startsWith('launch:')
      ? { codexProvisionalSettingsOwnerId: state.ownerId } : null,
    getCurrentCodexServiceTierProofIdentity: () => ({ success: true, ownerId: state.ownerId,
      terminalToken: terms.get('T'), terminalRunSeq: state.runSeq, terminalLifecycleGeneration: state.lifecycle }),
    terminalCommandState: { get: () => ({ isRunning: state.processRunning, runSeq: state.runSeq }) },
    getTerminalLifecycleGeneration: () => state.lifecycle,
    getTerminalInputRevision: () => state.inputRevision,
    getHeadlessTerminalMirror: () => mirror,
    getHeadlessVisibleBufferSnapshot: frame,
    armCodexCurrentLaunchSettingsProof: (_tabId, settings) => { state.launchProof = settings; },
    readCodexPersistentModelEffortProofForTab: async () => ({ success: true,
      model: 'gpt-5.6-sol', effort: 'max', codexSettingsProofSessionId: state.ownerId.startsWith('launch:') ? null : state.ownerId }),
    resetCodexTuiReadyDetection() {}, codexHasLivePtySubmitEvidence: () => true,
    isCodexTuiEffectivelyReady: () => !state.frame.includes('Press enter to confirm'),
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send(event, payload) {
      if (event === 'codex:model-effort-intent-applied' && state.rendererEnabled) rendererProjection(payload);
    } } },
    executeCodexSelectModelEffortRequest: async (_sender, request) => {
      requests.push(request);
      state.nativeModel = request.model; state.nativeEffort = request.effort;
      return { success: true, model: request.model, effort: request.effort,
        applicationProofSource: 'config:verified-write', codexSettingsProofSessionId: state.ownerId };
    },
  });
  vm.runInContext(part(main, '// Native selections have a dedicated business owner in main.', "ipcMain.handle('codex:set-model-effort-intent'")
    + declaration('tryHandleManualCodexActivePickerEnter')
    + declaration('confirmCodexIntentFromCurrentLaunchSettings'), context);

  const tab = { id: 'T', name: 'test', commandType: 'codex', codexSessionId: 'W1',
    codexModel: 'gpt-5.6-sol', codexEffort: 'max' };
  const rendererState = { openProjects: new Map([['P', { projectId: 'P', tabs: new Map([['T', tab]]) }]]) };
  const renderer = vm.createContext({
    ...effective, tabId: 'T', useRef: value => ({ current: value }), useCallback: callback => callback,
    useWorkspaceStore: { getState: () => rendererState }, get: () => rendererState, set() {},
    terminalRegistry: { getVisibleText: () => state.frame },
    projectTabSaveRevisions: new Map(),
    projectTabSaveQueue: { enqueue: (_project, work) => Promise.resolve().then(work) },
    ipcRenderer: { invoke: async (channel, payload) => {
      if (channel === 'project:save-tabs') {
        const saved = payload.tabs.find(value => value.tabId === 'T');
        durable.settings = { model: saved.codexModel, effort: saved.codexEffort,
          proofAt: saved.codexSettingsProofAt, proofSessionId: saved.codexSettingsProofSessionId };
        return { success: true };
      }
      return { success: false };
    } },
    handleCodexModelEffortIntentDeferred() {}, console: { warn() {}, log() {} },
  });
  vm.runInContext(compile(
    part(store, 'const saveTabs = (', 'const notifyProjectLayoutChanged =')
    + '\nglobalThis.methods = {'
    + part(store, '  getCodexSessionId: (tabId) => {', '  updateCodexLiveServiceTier:') + '};'
    + part(terminal, '  const nativeCodexPickerProofRef = useRef<', '  useEffect(() => {\n    if (isInitialized.current')
    + '\nglobalThis.armNativeCodexPickerProof = armNativeCodexPickerProof;'
    + '\nglobalThis.reconcileNativeCodexPickerOutput = reconcileNativeCodexPickerOutput;'
    + part(app, '    const handleCodexModelEffortIntentApplied = (', "    ipcRenderer.on('codex:tui-ready'")
    + '\nglobalThis.handleCodexModelEffortIntentApplied = handleCodexModelEffortIntentApplied;',
  ), renderer);
  Object.assign(rendererState, renderer.methods);
  rendererProjection = payload => renderer.handleCodexModelEffortIntentApplied({}, payload);
  return { state, context, renderer, mirror, frame, term, terms, tab, requests, writes, durable, providerStates,
    enter(origin = 'user') {
      if (state.rendererEnabled) renderer.armNativeCodexPickerProof(term, '\r', origin);
      // The actual intercepted picker helper owns the physical write; hooks
      // on the three later generic term.write paths cannot satisfy this test.
      return context.tryHandleManualCodexActivePickerEnter('T', term, '\r', 'test-native-picker', origin);
    },
    async acknowledge(model = 'gpt-5.6-luna', effort = 'high', mode = 'persistent-default', includeEffort = true) {
      const data = `\r\n• Model changed to ${model}${includeEffort ? ' ' + effort : ''}${mode === 'conversation-only' ? ' for this conversation' : ''}\r\n`;
      state.nativeModel = model; state.nativeEffort = effort;
      if (typeof context.observeCodexNativeSettingsIntentOutput === 'function') {
        context.observeCodexNativeSettingsIntentOutput('T', data, term);
      }
      if (state.rendererEnabled) renderer.reconcileNativeCodexPickerOutput(data);
      state.frameSeq += 1;
      state.frame = `›\n${model} ${effort} · /fixture`;
      mirror.writeSeq = state.frameSeq; mirror.flushedSeq = state.frameSeq;
      mirror.lastCommittedVisibleSnapshot = frame();
      if (typeof context.observeCodexNativeSettingsIntentFrame === 'function') {
        context.observeCodexNativeSettingsIntentFrame('T', mirror, mirror.lastCommittedVisibleSnapshot);
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('actual native Enter/callback/persistence cannot be rolled back by the old intent after writer handoff', async () => {
  const h = await harness();
  assert.equal(h.enter().handled, true);
  assert.deepEqual(h.writes, ['\r']);
  await h.acknowledge();
  assert.equal(h.durable.settings.model, 'gpt-5.6-luna', 'actual renderer store/saveTabs persisted the manual choice');
  assert.equal(h.tab.codexModel, 'gpt-5.6-luna');
  h.state.ownerId = 'W2';
  h.tab.codexSessionId = 'W2';
  h.state.runSeq += 1; h.state.lifecycle = 'L2';
  await h.context.scheduleCodexModelEffortIntentReconcile('T', 'writer-adopted');
  assert.equal(h.state.nativeModel, 'gpt-5.6-luna', 'a new writer must not resurrect the older app selection');
  assert.equal(h.state.nativeEffort, 'high');
  assert.equal(h.durable.providerState.codexSettingsIntentModel, 'gpt-5.6-luna');
});

test('native proof persists without any renderer callback or window', async () => {
  const h = await harness();
  h.state.rendererEnabled = false;
  h.context.mainWindow = null;
  h.enter();
  await h.acknowledge();
  assert.equal(h.durable.settings.model, 'gpt-5.6-luna');
  assert.equal(h.durable.providerState.codexSettingsIntentModel, 'gpt-5.6-luna');
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').appliedOwnerId, 'W1');
});

test('a footer or programmatic Enter alone cannot supersede an app intent', async () => {
  for (const origin of [null, 'terminal-response', 'programmatic']) {
    const h = await harness();
    if (origin) h.enter(origin);
    await h.acknowledge();
    assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-5.6-sol');
    assert.equal(h.durable.settings.model, 'gpt-5.6-sol');
  }
});

test('unknown-origin raw Enter preserves the existing user-owned fallback without accepting unarmed automatic output', async () => {
  const h = await harness();
  h.enter('unknown');
  await h.acknowledge();
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-5.6-luna');
  assert.equal(h.durable.settings.model, 'gpt-5.6-luna');
});

test('model-only preset acknowledgement takes effort from the proved footer, not from old intent', async () => {
  const h = await harness();
  h.enter();
  await h.acknowledge('codex-auto-review', 'high', 'persistent-default', false);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'codex-auto-review');
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').effort, 'high');
});

test('ACK and restored composer may arrive in separate frames, but a mismatching footer proves nothing', async () => {
  const h = await harness();
  h.enter();
  h.context.observeCodexNativeSettingsIntentOutput('T', '\n• Model changed to gpt-5.6-luna high\n', h.term);
  const commit = text => {
    h.state.frame = text; h.state.frameSeq += 1;
    h.mirror.writeSeq = h.state.frameSeq; h.mirror.flushedSeq = h.state.frameSeq;
    h.mirror.lastCommittedVisibleSnapshot = h.frame();
    return h.context.observeCodexNativeSettingsIntentFrame('T', h.mirror, h.mirror.lastCommittedVisibleSnapshot);
  };
  assert.equal(commit('Select Reasoning Level\n› High\nPress enter to confirm or esc to go back'), null);
  assert.equal(commit('›\ngpt-6-astra max · /fixture'), null);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-5.6-sol');
  assert.equal(commit('›\ngpt-5.6-luna high · /fixture').applied, true);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-5.6-luna');
});

test('raw acknowledgement before the exact manual Enter cannot be reused afterward', async () => {
  const h = await harness();
  h.context.observeCodexNativeSettingsIntentOutput('T', '\n• Model changed to gpt-5.6-luna high\n', h.term);
  h.enter();
  h.state.frame = '›\ngpt-5.6-luna high · /fixture'; h.state.frameSeq += 1;
  h.mirror.writeSeq = h.state.frameSeq; h.mirror.flushedSeq = h.state.frameSeq;
  h.mirror.lastCommittedVisibleSnapshot = h.frame();
  assert.equal(h.context.observeCodexNativeSettingsIntentFrame('T', h.mirror, h.mirror.lastCommittedVisibleSnapshot), null);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-5.6-sol');
});

test('late native B cannot overwrite newer UI C in provider state or per-tab persistence', async () => {
  const h = await harness();
  h.enter();
  h.context.persistCodexModelEffortIntent('T', 'gpt-6-astra', 'xhigh', 'user-selection');
  await h.acknowledge();
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-6-astra');
  assert.equal(h.durable.settings.model, 'gpt-5.6-sol', 'late renderer ACK is also observation-only');
  await h.context.scheduleCodexModelEffortIntentReconcile('T');
  assert.equal(h.state.nativeModel, 'gpt-6-astra');
});

test('same-pair newer UI A must reprove A after a pending native B gesture', async () => {
  const h = await harness();
  const olderApply = h.context.getCodexModelEffortIntentRecord('T');
  h.enter();
  const saved = h.context.persistCodexModelEffortIntent('T', 'gpt-5.6-sol', 'max', 'user-selection');
  assert.equal(saved.revision, 1, 'pair revision retains the existing no-change contract');
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').appliedRevision, 0,
    'old applied-owner A is not proof that the pending native gesture kept A');
  assert.equal(h.context.markCodexModelEffortIntentApplied('T', olderApply, 'W1').applied, false,
    'a delayed same-pair result must not finalize a newer action using the old action proof');
  h.context.updateCodexSettingsIntentError('T', olderApply.revision, 'older-failure', olderApply.actionSequence);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').providerState.codexSettingsIntentError, null);
  await h.acknowledge();
  assert.equal(h.durable.settings.model, 'gpt-5.6-sol');
  await h.context.scheduleCodexModelEffortIntentReconcile('T');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].model, 'gpt-5.6-sol');
  assert.equal(h.state.nativeModel, 'gpt-5.6-sol');
});

test('an ordinary unchanged explicit pair requires no extra picker', async () => {
  const h = await harness();
  h.state.frame = '›\ngpt-5.6-sol max · /fixture';
  h.mirror.lastCommittedVisibleSnapshot = h.frame();
  h.context.persistCodexModelEffortIntent('T', 'gpt-5.6-sol', 'max', 'user-selection');
  const result = await h.context.scheduleCodexModelEffortIntentReconcile('T');
  assert.equal(result.applied, true);
  assert.equal(h.requests.length, 0);
});

test('a contrary current footer refutes an old applied marker only after an explicit UI choice', async () => {
  const h = await harness();
  h.state.frame = '›\ngpt-5.6-luna high · /fixture';
  h.mirror.lastCommittedVisibleSnapshot = h.frame();
  h.context.observeCodexNativeSettingsIntentFrame('T', h.mirror, h.mirror.lastCommittedVisibleSnapshot);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-5.6-sol', 'footer alone is not a choice');
  h.context.persistCodexModelEffortIntent('T', 'gpt-5.6-sol', 'max', 'user-selection');
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').appliedRevision, 0);
  await h.context.scheduleCodexModelEffortIntentReconcile('T');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].model, 'gpt-5.6-sol');
});

test('PTY, writer, lifecycle and input changes invalidate a delayed native acknowledgement', async () => {
  for (const change of [
    h => h.terms.set('T', { write() {} }),
    h => { h.state.ownerId = 'W2'; },
    h => { h.state.runSeq += 1; h.state.lifecycle = 'L2'; },
    h => { h.state.inputRevision += 1; },
  ]) {
    const h = await harness();
    h.enter();
    change(h);
    await h.acknowledge();
    assert.equal(h.durable.providerState.codexSettingsIntentModel, 'gpt-5.6-sol');
    assert.equal(h.durable.settings.model, 'gpt-5.6-sol');
  }
});

test('conversation-only Ultra keeps its fallback and source Resume/Fork capability without becoming a fresh-thread default', async () => {
  for (const nextCommand of ['codex-c', 'codex-f', 'codex']) {
    const h = await harness();
    h.enter();
    await h.acknowledge('gpt-5.6-luna', 'ultra', 'conversation-only');
    assert.equal(h.tab.codexLiveEffort, 'ultra');
    assert.equal(h.durable.settings.effort, 'max');
    assert.equal(h.durable.settings.model, 'gpt-5.6-sol');
    const sourcePlan = planCodexCommandLaunchSettings({ command: nextCommand,
      model: 'gpt-5.6-luna', effort: 'ultra', sourceSettingsStatus: 'found',
      sourceModel: 'gpt-5.6-luna', sourceEffort: 'ultra' });
    assert.equal(sourcePlan.allowed, true);
    assert.equal(sourcePlan.effort, nextCommand === 'codex' ? null : 'ultra');
    // Same-SID Resume still starts another runtime; the source plan, not a
    // completed operation's old intent, owns restoration of conversation Ultra.
    h.state.runSeq += 1; h.state.lifecycle = 'L2';
    if (nextCommand !== 'codex-c') h.state.ownerId = 'W2';
    assert.equal(h.context.confirmCodexIntentFromCurrentLaunchSettings('T', {
      model: 'gpt-5.6-luna', effort: 'ultra', proof: 'verified-composer-footer',
    }, 'new-launch'), false, 'a new source footer must not renew the completed old operation scope');
    await h.context.scheduleCodexModelEffortIntentReconcile('T', 'new-runtime');
    assert.equal(h.context.getCodexModelEffortIntentRecord('T'), null);
    assert.equal(h.requests.length, 0, 'no stale operation replays Ultra into a fresh owner');
    assert.equal(h.durable.settings.effort, 'max');
  }
});

test('pending UI Ultra survives until its first proof and exact launch-to-writer handoff preserves that proof', async () => {
  const h = await harness();
  h.state.processRunning = false;
  h.context.persistCodexModelEffortIntent('T', 'gpt-5.6-luna', 'ultra', 'user-selection');
  assert.equal(h.context.retireCodexScopedModelEffortIntent('T'), false);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').effort, 'ultra');
  h.state.processRunning = true; h.state.ownerId = 'launch:fresh';
  const selected = h.context.getCodexModelEffortIntentRecord('T');
  h.context.markCodexModelEffortIntentApplied('T', selected, 'launch:fresh');
  const transfer = intent.planCodexModelEffortIntentOwnerHandoff({ ...h.context.getCodexModelEffortIntentRecord('T'),
    launchOwnerId: 'launch:fresh', writerOwnerId: 'W2', provenModel: selected.model, provenEffort: selected.effort });
  assert.equal(transfer.transfer, true);
  h.state.ownerId = 'W2';
  h.context.markCodexModelEffortIntentApplied('T', selected, 'W2', 'writer-adoption-owner-handoff');
  assert.equal(h.context.retireCodexScopedModelEffortIntent('T'), false);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').scope.ownerId, 'W2');
});

test('late Ultra fallback cannot write after a newer explicit pair', async () => {
  const h = await harness();
  let finish;
  h.context.readCodexPersistentModelEffortProofForTab = () => new Promise(resolve => { finish = resolve; });
  h.enter();
  await h.acknowledge('gpt-5.6-luna', 'ultra', 'conversation-only');
  h.context.persistCodexModelEffortIntent('T', 'gpt-6-astra', 'max', 'user-selection');
  finish({ success: true, model: 'unrelated-fallback', effort: 'high', codexSettingsProofSessionId: 'W1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').model, 'gpt-6-astra');
  assert.equal(h.durable.settings.model, 'gpt-5.6-sol');
  assert.notEqual(h.tab.codexModel, 'unrelated-fallback');
});

test('persistence failure preserves proven native B in memory and never replays keys', async () => {
  const h = await harness();
  h.state.rendererEnabled = false;
  h.context.projectManager.db.updateTabProviderState = () => { throw Error('disk unavailable'); };
  h.enter();
  await h.acknowledge();
  const current = h.context.getCodexModelEffortIntentRecord('T');
  assert.equal(current.model, 'gpt-5.6-luna');
  assert.match(current.providerState.codexSettingsIntentError, /persistence-failed/);
  assert.equal(h.state.nativeModel, 'gpt-5.6-luna');
  await h.context.scheduleCodexModelEffortIntentReconcile('T');
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.writes, ['\r']);
});

test('a swallowed provider-state DB failure cannot be reported as durable native intent', async () => {
  const h = await harness();
  h.state.rendererEnabled = false;
  h.context.projectManager.db.updateTabProviderState = () => {}; // actual legacy DB error behavior
  h.enter();
  await h.acknowledge();
  const current = h.context.getCodexModelEffortIntentRecord('T');
  assert.equal(current.model, 'gpt-5.6-luna');
  assert.match(current.providerState.codexSettingsIntentError, /persistence-unconfirmed/);
  assert.equal(h.durable.providerState.codexSettingsIntentModel, 'gpt-5.6-sol');
  assert.equal(h.durable.settings.model, 'gpt-5.6-sol');
  assert.equal(h.requests.length, 0);
});

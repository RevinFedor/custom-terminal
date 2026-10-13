'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');
const runtimeContract = require('./codex-runtime-contract');
const writerTransition = require('./codex-settings-writer-transition');
const { resolveConfiguredAgentModel } = require('./agent-provider-model-contract');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer/utils/historyAgentRuntimes.ts'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const rendererAst = ts.createSourceFile('runtime.ts', rendererSource, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };
const functionSource = (ast, name) => ast.statements.find(node => (
  ts.isFunctionDeclaration(node) && node.name?.text === name
))?.getText(ast);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function harness({ compete = false, busy = false, holdAudit = false, localCommand = '' } = {}) {
  const plan = await import('../renderer/utils/codexHistorySettingsPlan.mjs');
  const effective = await import('../renderer/utils/codexEffectiveSettings.mjs');
  let inputRevision = 1;
  let lifecycle = 'generation';
  let model = 'old-model';
  let effort = 'medium';
  let draft = false;
  let frameAvailable = true;
  let selectionFailure = null;
  let pasteFailure = null;
  let frameHook = null;
  let auditFailure = false;
  let afterSelection = null;
  let afterSlashResult = null;
  let slashServiceTier = null;
  let ownerId = 'writer';
  const term = { write() {} };
  const events = [];
  const logs = [];
  const bridge = [];
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const mirror = { complete: true, failed: false, generation: 'fixture-mirror',
    writeSeq: 10, flushedSeq: 10, redrawTrace: {}, synchronizedFrameWaiters: new Set() };
  const commands = new Map([['tab', { runSeq: 2, isRunning: true }]]);
  const terminals = new Map([['tab', term]]);
  let competing;
  let finishAudit;
  const auditGate = new Promise(resolve => { finishAudit = resolve; });
  const rendererTab = { codexSessionId: 'writer', codexModel: model, codexEffort: effort,
    codexSettingsProofSessionId: 'writer' };
  const context = vm.createContext({
    ...runtimeContract, ...writerTransition, ...require('./agent-send-target-precondition'),
    resolveConfiguredAgentModel,
    projectManager: { db: { getAppState: () => ({ models: [] }) } },
    codexModelEffortIntentReconcileInflight: new Map(),
    console: { ...quiet, log: line => logs.push(String(line)) }, terminals, terminalCommandState: commands,
    terminalLifecycleEpochs: new WeakMap([[term, 'terminal-instance']]),
    nodePerformance: { now: Date.now }, CODEX_PASTE_AUDIT_TIMEOUT_MS: 10,
    isPromptQueueAutomationSource: () => false,
    isCodexTuiEffectivelyReady: () => true,
    isCodexOperationalInputReady: () => true,
    prepareCodexMainComposerForSend: async () => ({ success: true }),
    getHeadlessTerminalMirror: () => mirror,
    readCodexAuthoritativeScreen: async () => {
      mirror.writeSeq++; mirror.flushedSeq = mirror.writeSeq;
      return { success: frameAvailable, snapshot: { authoritativeFrameCommitted: frameAvailable,
        writeSeq: mirror.writeSeq, lines: [{ text: '› Ask Codex to do anything' },
          { text: model + ' ' + effort + ' · Context 42% used' }] } };
    },
    codexLiveSettingsObserver: null,
    hasCodexEstablishedComposerLifecycle: () => true,
    codexHasLivePtySubmitEvidence: () => true,
    getTerminalInputRevision: () => inputRevision,
    getTerminalStopRevision: () => 0,
    getTerminalLifecycleGeneration: () => lifecycle,
    getCodexWriterProofSnapshot: () => ownerId.startsWith('launch:') ? null : ({
      sessionId: ownerId, terminalToken: terminals.get('tab'), runSeq: commands.get('tab').runSeq,
      lifecycleGeneration: lifecycle, launchId: 'launch',
    }),
    getCodexProvisionalSettingsSnapshot: () => ownerId.startsWith('launch:') ? ({
      codexProvisionalSettingsOwnerId: ownerId,
      codexProvisionalSettingsLaunchId: 'launch',
      codexProvisionalModel: model, codexProvisionalEffort: effort,
    }) : null,
    codexSettingsMutationQueue: createCodexSettingsMutationQueue(),
    codexSessionDiscoveryIntents: new Map(), codexLastRunCommandPayload: new Map(),
    codexWatchers: new Map(), codexTurnWatchers: new Map(), codexPendingSettingsProofHandoffs: new Map(),
    codexPickerQueue: new Map(), isOwnedDesktopHistorySendSource: () => true,
    terminalProjects: new Map([['tab', '/fixture']]), aiStoppingTabs: new Map(),
    beginAgentSettingsActivity: () => ({}),
    agentSettingsActivity: { end() { events.push({ kind: 'settings-activity-ended' }); } },
    resolveActiveCodexConfigForTab: async () => ({ status: 'found', configPath: '/fixture/config.toml' }),
    ensureCodexSubmissionWatcher: async () => ({ available: true, kind: 'writer', sessionId: ownerId }),
    getCodexResumeSourceLeaseForTab: () => null,
    getCodexResumeReadIdentityLeaseForTab: () => null,
    hasCodexPromptOrTurnInFlight: () => busy,
    getCurrentCodexServiceTierProofIdentity: () => ({ success: true, ownerId,
      terminalToken: terminals.get('tab'), terminalLifecycleGeneration: lifecycle,
      terminalRunSeq: commands.get('tab').runSeq,
      generationMode: ownerId.startsWith('launch:') ? 'launch' : 'terminal-run',
      generationId: ownerId.startsWith('launch:') ? ownerId.slice('launch:'.length) : lifecycle,
      launchId: ownerId.startsWith('launch:') ? ownerId.slice('launch:'.length) : null }),
    publishCodexServiceTierProof: (_tabId, serviceTier, source, explicitOwnerId, options) => {
      events.push({ kind: 'tier-publication', serviceTier, source, explicitOwnerId,
        expectedOwnerId: options?.expectedIdentity?.ownerId });
      return { ownerId: explicitOwnerId, serviceTier };
    },
    requestTerminalCodexDraftState: async () => ({ success: draft !== null, hasDraft: draft }),
    createCodexPickerDraftCapture: () => ({}),
    inspectCurrentCodexMcpStartupScreen: async () => {
      if (frameHook) frameHook();
      return ({
      success: frameAvailable, currentFrameText: model + '/' + effort,
      authoritativeFrameCommitted: true, synchronizedOutputOpen: false,
      liveSynchronizedOutputOpen: false, committedFrameReplay: false,
      destructiveProofAvailable: true, terminalToken: terminals.get('tab'),
      terminalRunSeq: commands.get('tab').runSeq, terminalLifecycleGeneration: lifecycle,
      inputRevision, inspected: { ready: true },
      });
    },
    parseCodexVerifiedComposerFooter: text => text ? { model, effort, proof: 'verified-composer-footer' } : null,
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, data) => {
      events.push({ kind: 'publication', channel, model: data?.model, effort: data?.effort });
    } } },
    ipcMain,
  });
  const lockStart = mainSource.indexOf('const pasteInflight = new WeakMap();');
  const lockEnd = mainSource.indexOf('\nfunction markActivePtySubmit(', lockStart);
  vm.runInContext(mainSource.slice(lockStart, lockEnd), context);
  context.selectCodexModelEffort = async (_term, request) => {
    const guard = request.writeGuard('select-pair');
    assert.equal(guard.allowed, true);
    model = request.model;
    effort = request.effort;
    events.push({ kind: 'settings', model, effort });
    if (compete && model === 'requested-model') {
      compete = false;
      competing = context.executeCodexSelectModelEffortRequest({}, {
        tabId: 'tab', model: 'other-model', effort: 'low', allowTurnBusy: true,
      });
    }
    const result = selectionFailure || {
      success: true, applied: true, model, effort,
      applicationProofSource: 'tui-conversation-ack', proofAt: Date.now(),
    };
    if (afterSelection) afterSelection();
    return result;
  };
  context.sendCodexLiveSlashCommand = async (_term, request) => {
    assert.equal(request.writeGuard('local-command-submit').allowed, true);
    events.push({ kind: 'slash', model, effort, content: request.command });
    const result = { success: true, submitted: true,
      ...(slashServiceTier ? { serviceTier: slashServiceTier, serviceTierSource: 'tui' } : {}) };
    if (afterSlashResult) afterSlashResult();
    return result;
  };
  context.safePasteAndSubmit = async (_term, content, options) => {
    let wrote = false;
    const physical = await context.withPtyWriteLock(_term, () => {
      if (draft !== false) return { success: false, submitted: false,
        error: draft ? 'codex_draft_present' : 'codex_draft_state_unknown' };
      if (pasteFailure === 'before') return { success: false, submitted: false,
        pasteWritten: false, enterWritten: false, error: 'fixture-before-enter' };
      inputRevision++;
      wrote = true;
      events.push({ kind: 'prompt', model, effort, content });
      if (pasteFailure === 'throw-after') throw new Error('fixture-after-enter');
      return { success: true, submitted: true, enterWritten: true };
    }, { kind: 'safe-paste' }, options.ptyWriteOwner || null);
    const finish = async () => {
      if (holdAudit && wrote) await auditGate;
      if (auditFailure && wrote) throw new Error('fixture-audit-failed');
      return { ...physical, ...(wrote ? { exactAuditConfirmed: true, status: 'sent' } : {}) };
    };
    return options.deferPostWriteResolution
      ? { submitted: physical.submitted, enterWritten: wrote, finishAfterPtyWrite: finish }
      : finish();
  };
  const helperPath = path.join(__dirname, 'codex-settings-send.js');
  if (fs.existsSync(helperPath)) Object.assign(context, require(helperPath));
  for (const name of ['readCodexSettingsSendScope', 'readCodexSettingsForSend',
    'codexPolicyFrame',
    'resolveConfiguredCodexSettingsModelIdentity',
    'agentSendRequestExpectedTargets', 'agentSendRequestTargetFailure',
    'currentCodexAcceptedResumeSourceProof', 'readAgentSendDestinationAtWriteBoundary',
    'resolveCodexServiceTierResultIdentity']) {
    const source = functionSource(mainAst, name);
    if (source) vm.runInContext(source, context);
  }
  const runtimeDeclaration = mainAst.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name?.getText(mainAst) === 'codexSettingsSendRuntime'));
  if (runtimeDeclaration) vm.runInContext(runtimeDeclaration.getText(mainAst), context);
  vm.runInContext(functionSource(mainAst, 'executeCodexSelectModelEffortRequest'), context);
  vm.runInContext(functionSource(mainAst, 'executeCodexLiveSlashCommandRequest'), context);
  const handler = mainAst.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(mainAst) === 'ipcMain.handle'
    && node.expression.arguments[0]?.text === 'codex:send-command');
  assert.ok(handler, 'actual Codex send IPC registration');
  vm.runInContext(handler.getText(mainAst), context);
  const slashHandler = mainAst.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(mainAst) === 'ipcMain.handle'
    && node.expression.arguments[0]?.text === 'codex:send-live-slash-command');
  vm.runInContext(slashHandler.getText(mainAst), context);

  const runtimeSnapshot = () => ({ liveLifecycle: true, writerConfirmed: true,
    provenWriterSessionId: ownerId, sessionId: ownerId,
    codexCurrentSettingsOwnerId: ownerId, codexCurrentModel: model, codexCurrentEffort: effort });
  const renderer = vm.createContext({ ...plan, ...effective, console: quiet,
    findTabRuntimeContext: () => ({ tab: rendererTab, projectId: 'project' }),
    codexSendInflight: new Map(),
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    isStandaloneCodexLocalSlashCommand: () => !!localCommand,
    normalizeCodexLocalSlashCommand: value => value.trim(),
    terminalRegistry: { getCodexDraftState: () => ({ hasDraft: draft }) },
    readCodexDraftAuthority: async () => ({ success: draft !== null, hasDraft: draft }),
    applyCodexPickerResultForTab: () => ({ allowed: true }),
    isSubmittedCodexAuditTimeout: () => false, shortTab: value => value, errorText: String,
    ipcRenderer: { invoke: async (channel, ...args) => {
      bridge.push({ channel, args });
      if (channel === 'codex:get-runtime-session') return runtimeSnapshot();
      if (channel === 'codex:select-model-effort') {
        const result = await context.executeCodexSelectModelEffortRequest({}, args[0]);
        if (competing) await competing;
        return result;
      }
      if (channel === 'codex:send-command') return handlers.get(channel)({ sender: {} }, ...args);
      if (channel === 'codex:send-live-slash-command') return handlers.get(channel)({ sender: {} }, ...args);
      throw new Error('unexpected IPC ' + channel);
    } },
  });
  vm.runInContext(compile(functionSource(rendererAst, 'sendCodexPrompt')), renderer);
  return { context, events, logs, bridge, terminals, commands,
    send: (options = {}) => renderer.sendCodexPrompt('tab', localCommand || 'one prompt', {
      model: 'requested-model', effort: 'high', source: 'project-api', handoffId: 'handoff',
      runtimeSnapshot: runtimeSnapshot(), statusAtSend: busy ? 'busy' : 'active', ...options,
    }),
    direct: (options = {}) => handlers.get('codex:send-command')({ sender: {} }, 'tab', 'one prompt', options),
    slash: (payload = {}) => handlers.get('codex:send-live-slash-command')({ sender: {} }, payload),
    finishAudit,
    competing: () => competing,
    set: change => {
      if ('model' in change) model = change.model;
      if ('effort' in change) effort = change.effort;
      if ('draft' in change) draft = change.draft;
      if ('frameAvailable' in change) frameAvailable = change.frameAvailable;
      if ('lifecycle' in change) lifecycle = change.lifecycle;
      if ('ownerId' in change) ownerId = change.ownerId;
      if ('selectionFailure' in change) selectionFailure = change.selectionFailure;
      if ('pasteFailure' in change) pasteFailure = change.pasteFailure;
      if ('frameHook' in change) frameHook = change.frameHook;
      if ('auditFailure' in change) auditFailure = change.auditFailure;
      if ('inputRevision' in change) inputRevision = change.inputRevision;
      if ('afterSelection' in change) afterSelection = change.afterSelection;
      if ('afterSlashResult' in change) afterSlashResult = change.afterSlashResult;
      if ('slashServiceTier' in change) slashServiceTier = change.slashServiceTier;
      if ('runSeq' in change) commands.get('tab').runSeq = change.runSeq;
    },
  };
}

test('actual picker measures preparation, writer check and native selection separately without changing the result', async () => {
  const h = await harness();
  let clock = 1000;
  h.context.Date = class extends Date { static now() { return clock; } };
  const config = h.context.resolveActiveCodexConfigForTab;
  h.context.resolveActiveCodexConfigForTab = async (...args) => { clock += 2; return config(...args); };
  const writer = h.context.ensureCodexSubmissionWatcher;
  h.context.ensureCodexSubmissionWatcher = async (...args) => { clock += 5500; return writer(...args); };
  const draft = h.context.requestTerminalCodexDraftState;
  h.context.requestTerminalCodexDraftState = async (...args) => { clock += 14; return draft(...args); };
  const picker = h.context.selectCodexModelEffort;
  h.context.selectCodexModelEffort = async (...args) => { clock += 515; return picker(...args); };
  const result = await h.context.executeCodexSelectModelEffortRequest({}, {
    tabId: 'tab', model: 'requested-model', effort: 'high', allowTurnBusy: true,
  });
  assert.equal(result.success, true);
  const phases = h.logs.filter(line => line.startsWith('[CodexSettingsLatency]'));
  for (const [phase, ms] of [['config', 2], ['writer', 5500], ['draft', 14], ['picker', 515]]) {
    assert.ok(phases.some(line => line.includes('phase=' + phase + ' ms=' + ms + ' ')), phase);
  }
  assert.ok(phases.some(line => line.includes('phase=settings-queue ')));
  assert.ok(phases.some(line => line.includes('phase=pty-queue ')));
  assert.ok(phases.some(line => line.includes('next=settled')));
  assert.equal(h.events.filter(event => event.kind === 'settings').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'prompt').length, 0);
});

test('actual renderer and main keep explicit settings with their prompt ahead of a competing picker', async () => {
  const h = await harness({ compete: true });
  const result = await h.send();
  await h.competing();
  assert.equal(result.success, true);
  const prompts = h.events.filter(event => event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].model, 'requested-model');
  assert.equal(prompts[0].effort, 'high');
  const finalSettings = h.events.filter(event => event.kind === 'settings').at(-1);
  assert.equal(finalSettings.model, 'other-model');
  assert.equal(h.bridge.filter(call => call.channel === 'codex:send-command').length, 1);
  assert.ok(h.events.findIndex(event => event.kind === 'publication')
    < h.events.findIndex(event => event.kind === 'settings-activity-ended'),
  'applied settings publish before the control is unlocked');
});

test('already-applied explicit settings still allow a busy prompt without a picker', async () => {
  const h = await harness({ busy: true });
  h.set({ model: 'requested-model', effort: 'high' });
  const result = await h.send();
  assert.equal(result.success, true);
  assert.equal(h.events.filter(event => event.kind === 'settings').length, 0);
  assert.equal(h.events.filter(event => event.kind === 'prompt').length, 1);
});

test('two concurrent explicit send IPC requests serialize complete pairs rather than conflict or interleave', async () => {
  const h = await harness();
  const results = await Promise.all([
    h.direct({ model: 'first-model', effort: 'high' }),
    h.direct({ model: 'second-model', effort: 'low' }),
  ]);
  assert.ok(results.every(result => result.success === true));
  assert.deepEqual(h.events.filter(event => event.kind === 'settings' || event.kind === 'prompt')
    .map(event => [event.kind, event.model, event.effort]), [
    ['settings', 'first-model', 'high'], ['prompt', 'first-model', 'high'],
    ['settings', 'second-model', 'low'], ['prompt', 'second-model', 'low'],
  ]);
});

test('the existing already-applied busy in-flight join does not create another physical send', async () => {
  const h = await harness({ busy: true, holdAudit: true });
  h.set({ model: 'requested-model', effort: 'high' });
  const first = h.send();
  await nextTurn();
  const joined = h.send();
  await nextTurn();
  h.finishAudit();
  assert.equal((await first).success, true);
  assert.equal((await joined).success, true);
  assert.equal(h.events.filter(event => event.kind === 'prompt').length, 1);
});

test('a competing picker and PTY writer both proceed before the associated prompt audit resolves', async () => {
  const h = await harness({ compete: true, holdAudit: true });
  let settled = false;
  const sending = h.send().then(result => { settled = true; return result; });
  await nextTurn();
  await h.competing();
  await h.context.withPtyWriteLock(h.terminals.get('tab'), () => {
    h.events.push({ kind: 'other-write' });
  });
  assert.equal(settled, false);
  assert.deepEqual(h.events.filter(event => ['settings', 'prompt', 'other-write'].includes(event.kind))
    .map(event => event.kind), ['settings', 'prompt', 'settings', 'other-write']);
  h.finishAudit();
  assert.equal((await sending).success, true);
});

for (const requested of [{ model: 'new-model' }, { effort: 'high' }]) {
  test('partial request inherits the live writer pair at the locked boundary: ' + Object.keys(requested)[0], async () => {
    const h = await harness();
    h.set({ model: 'live-model', effort: 'max' });
    const result = await h.direct(requested);
    assert.equal(result.success, true);
    assert.deepEqual(h.events.find(event => event.kind === 'prompt'), {
      kind: 'prompt', content: 'one prompt',
      model: requested.model || 'live-model', effort: requested.effort || 'max',
    });
  });
}

test('partial pre-writer request inherits only its exact launch pair', async () => {
  const h = await harness();
  h.set({ ownerId: 'launch:launch', model: 'launch-model', effort: 'medium' });
  const result = await h.direct({ effort: 'high', expectedWriterSessionId: 'launch:launch' });
  assert.equal(result.success, true);
  assert.equal(h.events.find(event => event.kind === 'prompt').model, 'launch-model');
});

test('a just-committed picker is authoritative before renderer persistence or footer catches up', async () => {
  const h = await harness();
  await h.context.executeCodexSelectModelEffortRequest({}, {
    tabId: 'tab', model: 'committed-model', effort: 'max',
  });
  h.set({ frameAvailable: false });
  const same = await h.direct({ model: 'committed-model', effort: 'max' });
  assert.equal(same.success, true);
  assert.equal(h.events.filter(event => event.kind === 'settings').length, 1);
  assert.equal(h.events.find(event => event.kind === 'prompt').model, 'committed-model');
});

test('partial request does not borrow stale renderer values after a preceding picker', async () => {
  const h = await harness();
  await h.context.executeCodexSelectModelEffortRequest({}, {
    tabId: 'tab', model: 'committed-model', effort: 'max',
  });
  h.set({ frameAvailable: false });
  const result = await h.send({ model: 'requested-model', effort: undefined,
    runtimeSnapshot: { liveLifecycle: true, writerConfirmed: true, provenWriterSessionId: 'writer',
      codexCurrentSettingsOwnerId: 'writer', codexCurrentModel: 'old-model', codexCurrentEffort: 'medium' } });
  assert.equal(result.success, true);
  assert.equal(h.events.find(event => event.kind === 'prompt').effort, 'max');
});

test('unknown partial settings and foreign writer cannot reach a picker or prompt', async () => {
  for (const fault of ['unknown', 'writer']) {
    const h = await harness();
    h.set({ frameAvailable: fault !== 'unknown' });
    const result = await h.direct({ effort: 'high',
      ...(fault === 'writer' ? { expectedWriterSessionId: 'foreign-writer' } : {}) });
    assert.equal(result.submitted, false);
    assert.equal(result.pasteWritten, false);
    assert.equal(h.events.length, 0);
  }
});

test('generation change while waiting in the existing global queue cancels before prompt mutation', async () => {
  const h = await harness();
  let release;
  const blocker = h.context.codexSettingsMutationQueue.run(() => new Promise(resolve => { release = resolve; }));
  await nextTurn();
  const sending = h.direct({ model: 'requested-model', effort: 'high' });
  // The existing native-question preparation is async before the settings
  // transaction captures its owner. Reach that queue before replacing it.
  await nextTurn();
  h.set({ lifecycle: 'replacement' });
  release();
  await blocker;
  const result = await sending;
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'codex_send_runtime_changed');
  assert.equal(h.events.length, 0);
});

test('manual input during the boundary frame read invalidates the same-pair shortcut', async () => {
  const h = await harness();
  h.set({ model: 'requested-model', effort: 'high', frameHook: () => {
    h.set({ inputRevision: 99 });
  } });
  const result = await h.direct({ model: 'requested-model', effort: 'high' });
  assert.equal(result.submitted, false);
  assert.equal(h.events.length, 0);
});

for (const draft of [null, true]) {
  test('unknown or real draft never gets mixed with the settings-associated prompt: ' + draft, async () => {
    const h = await harness();
    h.set({ draft });
    const result = await h.direct({ model: 'requested-model', effort: 'high' });
    assert.equal(result.submitted, false);
    assert.equal(h.events.filter(event => event.kind === 'prompt').length, 0);
  });
}

test('busy differing settings remain an explicit no-submit while ordinary busy prompts remain supported', async () => {
  const h = await harness({ busy: true });
  const refusal = await h.direct({ model: 'requested-model', effort: 'high', queue: true });
  assert.equal(refusal.submitted, false);
  assert.equal(refusal.code, 'codex_settings_change_requires_idle');
  assert.equal(h.events.length, 0);
  assert.equal((await h.direct({ queue: true })).success, true);
  assert.equal(h.events.filter(event => event.kind === 'prompt').length, 1);
});

for (const applied of [false, true]) {
  test('picker failure never sends the prompt and retains an actually applied pair: ' + applied, async () => {
    const h = await harness();
    h.set({ selectionFailure: { success: false, applied, model: 'requested-model', effort: 'high',
      ...(applied ? { applicationProofSource: 'tui-conversation-ack' } : {}), error: 'fixture-picker-failed' } });
    const result = await h.direct({ model: 'requested-model', effort: 'high' });
    assert.equal(result.submitted, false);
    assert.equal(result.enterWritten, false);
    assert.equal(h.events.filter(event => event.kind === 'prompt').length, 0);
    assert.equal(h.events.some(event => event.kind === 'publication'), applied);
  });
}

for (const fault of ['before', 'throw-after', 'audit']) {
  test('receipt preserves the physical prompt boundary after ' + fault, async () => {
    const h = await harness();
    h.set(fault === 'audit' ? { auditFailure: true } : { pasteFailure: fault });
    const result = await h.direct({ model: 'requested-model', effort: 'high' });
    assert.equal(h.events.filter(event => event.kind === 'prompt').length, fault === 'before' ? 0 : 1);
    if (fault === 'before') assert.equal(result.submitted, false);
    else {
      assert.equal(result.deliveryUnknown, true);
      assert.notEqual(result.submitted, false);
      if (fault === 'audit') assert.equal(result.submitted, true);
    }
  });
}

test('a forged renderer PTY owner cannot bypass the private settings queue', async () => {
  const h = await harness();
  const forged = await h.context.executeCodexSelectModelEffortRequest({}, {
    tabId: 'tab', model: 'requested-model', effort: 'high',
  }, { active: true });
  assert.equal(forged.error, 'pty_write_owner_expired');
  assert.equal(h.events.length, 0);
});

test('actual Codex renderer settings+prompt preserves target identity before any picker write', async () => {
  const h = await harness();
  const result = await h.send({ expectedTarget: { sessionId: 'another-conversation', toolType: 'codex' } });
  assert.equal(result.code, 'agent_send_target_changed', JSON.stringify(result));
  assert.equal(result.submitted, false);
  assert.equal(h.events.some(event => event.kind === 'settings' || event.kind === 'prompt'), false);
});

test('local slash plus explicit settings uses the same owner ahead of a competing picker', async () => {
  const h = await harness({ compete: true, localCommand: '/status' });
  const result = await h.send();
  await h.competing();
  assert.equal(result.success, true);
  assert.equal(result.localSlashCommand, true);
  const actions = h.events.filter(event => event.kind === 'settings' || event.kind === 'slash');
  assert.deepEqual(actions.map(event => [event.kind, event.model]), [
    ['settings', 'requested-model'], ['slash', 'requested-model'], ['settings', 'other-model'],
  ]);
  assert.equal(h.bridge.some(call => call.channel === 'codex:select-model-effort'), false);
});

test('late /fast acknowledgement from replaced writer stays historical and never publishes to successor', async () => {
  const h = await harness({ localCommand: '/fast' });
  h.set({ slashServiceTier: 'priority', afterSlashResult: () => {
    h.set({ ownerId: 'writer-B', lifecycle: 'G2', runSeq: 3, afterSlashResult: null });
  } });
  const result = await h.send();
  assert.equal(result.success, false);
  assert.equal(result.submitted, true, 'the old writer really received its one Enter');
  assert.equal(result.code, 'codex_service_tier_result_superseded');
  assert.equal(result.serviceTierProofSuperseded, true);
  assert.equal(h.events.filter(event => event.kind === 'slash').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'tier-publication').length, 0);
});

test('stable /fast acknowledgement publishes with the exact captured writer identity', async () => {
  const h = await harness({ localCommand: '/fast' });
  h.set({ slashServiceTier: 'priority' });
  const result = await h.send();
  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.deepEqual(h.events.filter(event => event.kind === 'tier-publication'), [{
    kind: 'tier-publication', serviceTier: 'priority', source: 'tui',
    explicitOwnerId: 'writer', expectedOwnerId: 'writer',
  }]);
});

test('late /fast acknowledgement follows only the exact launch into its first writer', async () => {
  const h = await harness({ localCommand: '/fast' });
  h.set({ ownerId: 'launch:launch', slashServiceTier: 'priority', afterSlashResult: () => {
    h.set({ ownerId: 'writer', afterSlashResult: null });
  } });
  const result = await h.send();
  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.deepEqual(h.events.filter(event => event.kind === 'tier-publication'), [{
    kind: 'tier-publication', serviceTier: 'priority', source: 'tui',
    explicitOwnerId: 'writer', expectedOwnerId: 'writer',
  }]);
});

test('a settings-associated slash preserves exact no-submit when its current composer is unknown', async () => {
  const h = await harness({ localCommand: '/status' });
  h.set({ model: 'requested-model', effort: 'high', draft: null });
  const result = await h.send();
  assert.equal(result.submitted, false);
  assert.equal(h.events.some(event => event.kind === 'slash'), false);
});

test('manual settings change during the final picker await cannot stamp old proof with the new input revision', async () => {
  const h = await harness();
  h.set({ afterSelection: () => {
    h.set({ model: 'manual-model', effort: 'low', inputRevision: 99, afterSelection: null });
  } });
  const first = await h.direct({ model: 'requested-model', effort: 'high' });
  assert.equal(first.submitted, false);
  assert.equal(first.settingsApplicationUnconfirmed, true);
  assert.equal(h.events.filter(event => event.kind === 'publication').length, 0);
  const second = await h.direct({ model: 'requested-model', effort: 'high' });
  assert.equal(second.success, true);
  assert.equal(h.events.filter(event => event.kind === 'settings').length, 2,
    'old A proof must not skip reapplying A after manual B');
  assert.equal(h.events.filter(event => event.kind === 'prompt').length, 1);
});

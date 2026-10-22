'use strict';

// Actual Main selector/owned-input/frame/queue code, with an explicit scripted
// CLI screen/config boundary. The inherited fixture owns private SQLite only.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Module = require('node:module'), ts = require('typescript');
const { fixture: base, tick } = require('./compact-preparation.cjs');
const preparation = require('../agent-send-preparation');
const settings = require('../codex-settings-send');
const { createAgentSettingsActivity } = require('../agent-settings-activity');
const repoMain = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(process.env.MODEL_MAIN_SOURCE || repoMain, 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['selectCodexModelEffort', 'executeCodexSelectModelEffortRequest',
  'sendCodexSlashCommand', 'waitForCodexOwnedModelPaste', 'readCodexSettingsSendScope',
  'captureCodexFrame', 'sendCodexKeyAndCapture', 'selectCodexPickerItem', 'moveCodexPickerTo',
  'ensureCodexPickerFrame', 'codexModelEffortConfirmationObservedInFrame', 'currentCodexPickerFrameText',
  'latestCodexSynchronizedFrameText', 'cleanCodexTuiFrame'];
const actual = names.map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw Error('missing actual ' + name);
  return node.getText(ast);
}).join('\n');
let runtimeFactory = settings.createCodexSettingsSendRuntime;
if (process.env.MODEL_SETTINGS_SOURCE) {
  const file = path.join(__dirname, '..', 'codex-settings-send.js');
  const loaded = new Module(file, module); loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(process.env.MODEL_SETTINGS_SOURCE, 'utf8'), file);
  runtimeFactory = loaded.exports.createCodexSettingsSendRuntime;
}

function fixture(t, options = {}) {
  const h = base(t, { capturedDraft: options.capturedDraft === true });
  const { ctx, term, clock, settingsQueue: queue } = h;
  const raw = new Set(), events = [], captures = [];
  const requested = { model: 'gpt-5.6-sol', effort: 'high' };
  let current = options.samePair ? { ...requested } : { model: 'gpt-5.6-luna', effort: 'medium' };
  let writerId = 'S', targetCurrent = true, screen = '', serviceEnters = 0, promptCalls = 0;
  let runtime;
  const settingsActivity = createAgentSettingsActivity();
  const emit = text => { screen = text; for (const onData of [...raw]) onData(text); };
  term.onData = onData => { raw.add(onData); captures.push({ at: clock.now() });
    return { dispose: () => raw.delete(onData) }; };
  term.write = bytes => {
    const operation = ctx.modelTestOperation();
    h.writes.push(bytes); events.push({ kind: 'write', bytes, phase: operation?.phase || null, at: clock.now() });
    if (bytes.includes('\x1b[200~')) {
      h.open();
      if (options.immediate) queueMicrotask(() => h.frame('/model'));
    } else if (bytes === '\r' && operation?.phase === 'slash-command-enter') {
      serviceEnters++;
      if (options.throwServiceEnter) throw Error('controlled service Enter throw');
      queueMicrotask(() => emit('Select Model and Effort\n› 1. gpt-5.6-sol (current)\n  2. gpt-5.6-luna\nPress enter to confirm or esc to go back'));
    } else if (bytes === '\r' && operation?.phase === 'picker-confirm-model') {
      current = { ...requested };
      queueMicrotask(() => emit('• Model changed to gpt-5.6-sol high\n› Ask Codex to do anything\ngpt-5.6-sol high · Context 42% used'));
    } else if (bytes === '\x01\x0b') queueMicrotask(() => h.frame(''));
  };
  Object.assign(ctx, settings, require('../codex-settings-writer-transition'), {
    stripVTControlCharacters: require('node:util').stripVTControlCharacters,
    aiStoppingTabs: new Map(), codexSessionDiscoveryIntents: new Map(), codexWatchers: new Map(),
    codexPendingSettingsProofHandoffs: new Map(),
    getCodexWriterProofSnapshot: () => ({ sessionId: writerId, terminalToken: ctx.terminals.get('T'),
      runSeq: 1, lifecycleGeneration: 'L1', launchId: 'launch' }),
    getCodexProvisionalSettingsSnapshot: () => null,
    getCodexResumeSourceLeaseForTab: () => null,
    hasCodexEstablishedComposerLifecycle: () => true,
    resolveConfiguredCodexSettingsModelIdentity: value => value,
    codexLiveSettingsObserver: { read: () => ({ ownerId: writerId, ...current, proofAt: 1 }) },
    resolveActiveCodexConfigForTab: async () => ({ status: 'found', configPath: '/controlled/config.toml' }),
    ensureCodexSubmissionWatcher: async () => ({ available: true, kind: 'writer', sessionId: writerId }),
    agentSendRequestTargetFailure: (_tab, _provider, identity) => {
      assertIdentity(identity);
      return targetCurrent ? null : { code: 'agent_send_target_changed' };
    },
    agentSendRequestExpectedTargets: () => [],
    readCodexAuthoritativeScreen: async () => ({ success: true, clean: screen }),
    waitForCodexModelEffortConfig: async expected => {
      events.push({ kind: 'config', expected, held: ctx.held(), queuePending: queue.pending });
      if (options.configTime) clock.advance(options.configTime);
      return { success: !options.configFailure, source: 'controlled-config' };
    },
    beginAgentSettingsActivity: (tabId, toolType, target, options) => { events.push({ kind: 'activity-begin' });
      return settingsActivity.begin({ tabId, toolType, target, ...options }); },
    agentSettingsActivity: { ...settingsActivity, end: token => { events.push({ kind: 'activity-end' }); return settingsActivity.end(token); } },
    attachCodexSettingsProofOwner: (result, sessionId) => ({ ...result, codexSettingsProofSessionId: sessionId }),
    closeCodexPickerToComposer: async () => { events.push({ kind: 'close-picker' }); return { success: true }; },
    emitAgentReadinessChanged: () => h.notifyFrame(),
    scheduleCodexModelEffortIntentReconcile: () => events.push({ kind: 'intent-reconcile-wake' }),
  });
  vm.runInContext(actual, ctx);
  vm.runInContext('globalThis.modelTestOperation = () => ptyActiveWriteOperation.get(terminals.get("T"));', ctx);
  const opts = { handoffId: 'H', sendOperationKey: h.identity.operationKey,
    sendAttemptId: h.begun.attemptId, expectedTarget: { toolType: 'codex', sessionId: 'S' },
    presentationSnapshot: { version: 1, marker: 'immutable-authoring' } };
  function assertIdentity(identity) {
    if (identity.sendOperationKey !== opts.sendOperationKey || identity.sendAttemptId !== opts.sendAttemptId)
      throw Error('frozen send identity changed');
  }
  runtime = runtimeFactory({ readScope: () => ctx.readCodexSettingsSendScope('T'),
    readSettings: async () => ({ ownerId: writerId, ...current }),
    withSettingsQueue: work => queue.run(work), withWriteLock: ctx.withPtyWriteLock,
    selectSettings: (sender, request, owner) => ctx.executeCodexSelectModelEffortRequest(sender, request, owner),
    publishSettings: (_tab, result) => events.push({ kind: 'publication', result }),
    paste: async (_term, text, pasteOptions) => {
      promptCalls++;
      if (pasteOptions.presentationSnapshot !== opts.presentationSnapshot) throw Error('authoring identity changed');
      assertIdentity(pasteOptions);
      return ctx.withPtyWriteLock(term, () => {
        const guard = pasteOptions.settingsWriteGuard();
        if (!guard.allowed) return { success: false, submitted: false, error: guard.reason };
        events.push({ kind: 'prompt', text, at: clock.now() });
        if (options.throwPromptEnter) throw Error('controlled prompt Enter throw');
        return { submitted: true, enterWritten: true, finishAfterPtyWrite: async () => ({ success: true, submitted: true }) };
      }, { kind: 'controlled-prompt' }, pasteOptions.ptyWriteOwner);
    },
  });
  ctx.codexSettingsSendRuntime = runtime;
  let cold = options.deadlineOffset ? { deadlineAt: h.scope.preparation.startedAt + options.deadlineOffset } : null;
  const prep = preparation.readAgentSendPreparation(h.store, 'T', opts, cold, clock.now);
  t.after(async () => {
    h.change('stop'); clock.advance(120000); await tick(150); clock.advance(1800); await tick(150);
  });
  return { ...h, events, captures, requested, prep, opts, queue, runtime,
    get restores() { return h.restores; },
    get serviceEnters() { return serviceEnters; }, get promptCalls() { return promptCalls; },
    start: () => runtime.sendPrompt({ tabId: 'T', content: 'frozen original prompt', sender: null,
      ...requested, preparation: prep, expectedTarget: opts.expectedTarget,
      expectedWriterSessionId: 'S', pasteOptions: opts }),
    select: () => ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...requested,
      ...opts, preparation: prep, expectedWriterSessionId: 'S' }),
    otherSettingsJob: () => {
      const otherTerm = { write() {} };
      const other = runtimeFactory({
        readScope: () => ({ terminal: otherTerm, lifecycleGeneration: 'L-B', runSeq: 1,
          live: true, ownerId: 'S-B', inputRevision: 1, settingsObservationKey: null }),
        readSettings: async () => ({ ownerId: 'S-B', ...requested }),
        withSettingsQueue: work => queue.run(work), withWriteLock: ctx.withPtyWriteLock,
        selectSettings: () => { throw Error('same-pair B needs no picker'); },
        paste: (_term, _text, input) => ctx.withPtyWriteLock(otherTerm, () => {
          events.push({ kind: 'other-prompt' }); return { success: true, submitted: true };
        }, { kind: 'other-prompt' }, input.ptyWriteOwner),
      });
      return other.sendPrompt({ tabId: 'B', ...requested, content: 'independent B' });
    },
    change(what) {
      if (what === 'writer') writerId = 'foreign-S';
      else if (what === 'target') targetCurrent = false;
      else if (what === 'settings') current = { model: 'foreign-model', effort: 'low' };
      else h.change(what);
      h.notifyFrame();
    },
  };
}
module.exports = { fixture, tick, source, names };

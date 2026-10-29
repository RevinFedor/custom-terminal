'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const { createAgentSettingsActivity } = require('./agent-settings-activity');
const { planCodexModelEffortIntentReconcile } = require('./codex-model-effort-intent');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, 'actual Main function: ' + name); return node.getText(ast);
}
function fixture(t) {
  const db = new Database(':memory:'), events = new EventEmitter(), published = [];
  t.after(() => db.close());
  db.exec('CREATE TABLE tabs(project_id TEXT,execution_namespace TEXT,tab_id TEXT,provider_state TEXT)');
  const original = { type: 'anthropic', unrelated: 'keep', codexSettingsIntentModel: 'gpt-6.1-terra',
    codexSettingsIntentEffort: 'max', codexSettingsIntentRevision: 21,
    codexSettingsIntentAppliedRevision: 19, codexSettingsIntentActionSequence: 8,
    codexSettingsIntentStateVersion: 6, codexSettingsIntentControl: 'model', codexSettingsIntentError: null };
  db.prepare('INSERT INTO tabs VALUES(?,?,?,?)').run('P', null, 'T', JSON.stringify(original));
  db.prepare('INSERT INTO tabs VALUES(?,?,?,?)').run('FOREIGN', null, 'T', JSON.stringify({ sentinel: 'foreign' }));
  const states = new Map([['T', original]]), activity = createAgentSettingsActivity();
  const identity = { revision: 21, actionSequence: 8 };
  const term = {}, terminals = new Map([['T', term]]), epochs = new WeakMap([[term, 'I']]);
  const scope = { terminalInstanceId: 'I', lifecycleGeneration: 'G', terminalRunSeq: 1, stopRevision: 0 };
  const initialActivity = activity.begin({ tabId: 'T', target: 'model', toolType: 'codex', cancelTarget: { ...identity, scope } });
  const context = vm.createContext({ providerStates: states, projectManager: { db: { db } },
    agentSettingsActivity: activity, ipcMain: events, resolveAuthoritativeTabProjectId: () => 'P',
    terminals, terminalLifecycleEpochs: epochs, terminalCommandState: new Map([['T', { isRunning: true, runSeq: 1 }]]),
    getTerminalLifecycleGeneration: () => 'G', getTerminalStopRevision: () => 0,
    setProviderState: (tabId, state) => states.set(tabId, state), broadcastProviderState: (_tabId, state) => published.push(state),
    console: { log() {}, warn() {} } });
  vm.runInContext(['captureCodexSettingsCancelScope', 'getCodexModelEffortIntentRecord', 'createCodexModelEffortIntentWriteGuard',
    'cancelCodexModelEffortIntent'].map(declaration).join('\n'), context);
  const request = { tabId: 'T', ...identity, activityId: initialActivity.id, scope };
  return { context, db, states, events, published, activity, initialActivity, request, term,
    guard: () => context.createCodexModelEffortIntentWriteGuard('T', context.getCodexModelEffortIntentRecord('T')),
    cancel: override => context.cancelCodexModelEffortIntent({ ...request, ...override }),
    stored: () => JSON.parse(db.prepare('SELECT provider_state FROM tabs WHERE project_id=? AND tab_id=?').get('P', 'T').provider_state) };
}

test('actual Main cancel persists exact intent and revokes further native picker keys', t => {
  const h = fixture(t), guard = h.guard(), notifications = [];
  guard.onCancel(() => notifications.push('cancelled'));
  assert.equal(guard('slash-command-paste').allowed, true);
  const result = h.cancel();
  assert.equal(result.success, true); assert.equal(result.cancelled, true);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').cancelled, true);
  assert.deepEqual(notifications, ['cancelled']);
  assert.equal(guard('picker-navigation-down-1').allowed, false);
  assert.equal(guard('picker-confirm-model').allowed, false);
  assert.equal(guard('settings-observation-proof').allowed, true, 'already-applied native state remains observable');
  guard.beginCleanup();
  assert.equal(guard('picker-close-1').allowed, true, 'only guarded cleanup may close an owned picker');
  assert.equal(guard('picker-confirm-model').allowed, false, 'cleanup is not permission to apply');
  assert.equal(h.stored().codexSettingsIntentCancelled.revision, 21);
  assert.deepEqual(JSON.parse(h.db.prepare('SELECT provider_state FROM tabs WHERE project_id=?').get('FOREIGN').provider_state), { sentinel: 'foreign' });
  guard.dispose();
});

test('cancel before first input does not permit a draft capture or slash write', t => {
  const h = fixture(t), guard = h.guard(); assert.equal(h.cancel().success, true);
  assert.equal(guard('slash-command-paste').allowed, false);
  guard.beginCleanup(); assert.equal(guard('draft-exact-copy').allowed, false);
  guard.dispose();
});

test('late cancel cannot revoke a replacement intent or another active owner', t => {
  const h = fixture(t), before = JSON.stringify(h.states.get('T'));
  assert.equal(h.cancel({ actionSequence: 7 }).success, false);
  assert.equal(JSON.stringify(h.states.get('T')), before);
  const other = h.activity.begin({ tabId: 'T', target: 'model', toolType: 'codex',
    cancelTarget: { revision: 22, actionSequence: 9 } });
  assert.equal(h.cancel().success, false); assert.equal(JSON.stringify(h.states.get('T')), before);
  h.activity.end(other);
});

test('a stale spinner cannot cancel an intent after the PTY is replaced', t => {
  const h = fixture(t), before = JSON.stringify(h.states.get('T'));
  h.context.terminals.set('T', {});
  assert.equal(h.cancel().error, 'codex_settings_cancel_owner_changed');
  assert.equal(JSON.stringify(h.states.get('T')), before);
});

test('persistence failure never reports durable cancellation yet revokes this in-memory writer', t => {
  const h = fixture(t), guard = h.guard(); guard('slash-command-paste');
  h.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON tabs BEGIN SELECT RAISE(ABORT,'disk'); END;");
  const result = h.cancel();
  assert.equal(result.success, false); assert.equal(result.cancelled, true);
  assert.equal(guard('picker-confirm-model').allowed, false);
  assert.equal(h.stored().codexSettingsIntentCancelled, undefined);
  assert.match(h.states.get('T').codexSettingsIntentError, /cancel.*persist/i);
  guard.dispose();
});

test('cancel changes only its durable intent marker, preserving independently saved provider fields', t => {
  const h = fixture(t);
  const durable = { ...h.stored(), unrelated: 'newer durable value', codexFastIntent: true,
    codexFastIntentRevision: 7, futureProviderField: 'retained' };
  h.db.prepare('UPDATE tabs SET provider_state=? WHERE project_id=? AND tab_id=?')
    .run(JSON.stringify(durable), 'P', 'T');
  assert.equal(h.cancel().success, true);
  const saved = h.stored();
  assert.equal(saved.unrelated, 'newer durable value');
  assert.equal(saved.codexFastIntent, true); assert.equal(saved.codexFastIntentRevision, 7);
  assert.equal(saved.futureProviderField, 'retained');
  assert.deepEqual(saved.codexSettingsIntentCancelled, { revision: 21, actionSequence: 8 });
});

test('a newer durable revision of the same intent cannot be overwritten by cancel', t => {
  const h = fixture(t), durable = { ...h.stored(), codexSettingsIntentStateVersion: 7 };
  h.db.prepare('UPDATE tabs SET provider_state=? WHERE project_id=? AND tab_id=?')
    .run(JSON.stringify(durable), 'P', 'T');
  const result = h.cancel();
  assert.equal(result.success, false); assert.equal(result.cancelled, true);
  assert.equal(h.stored().codexSettingsIntentStateVersion, 7);
  assert.equal(h.stored().codexSettingsIntentCancelled, undefined);
  assert.match(result.error, /cancel-persistence-state-changed/);
});

test('cancel survives reload; an explicit same-pair choice gets a fresh revision without reviving the old guard', t => {
  const h = fixture(t), old = h.guard(); old.onCancel(() => {}); old('slash-command-paste');
  assert.equal(h.cancel().success, true);
  h.states.set('T', h.stored()); // Reload only this private, already persisted fixture.
  const cancelled = h.context.getCodexModelEffortIntentRecord('T');
  assert.equal(cancelled.cancelled, true);
  assert.equal(planCodexModelEffortIntentReconcile({ ...cancelled, writerOwnerId: 'S',
    processRunning: true, tuiReady: true }).reason, 'intent-cancelled');
  Object.assign(h.context, { nextCodexModelEffortIntent: require('./codex-model-effort-intent').nextCodexModelEffortIntent,
    retireCodexScopedModelEffortIntent() {}, codexNativeSettingsIntentTracker: { hasPending: () => false },
    getHeadlessTerminalMirror: () => null, parseCodexVerifiedComposerFooter: () => null });
  h.context.projectManager.db.updateTabProviderState = (_tabId, state) =>
    h.db.prepare('UPDATE tabs SET provider_state=? WHERE project_id=? AND tab_id=?').run(JSON.stringify(state), 'P', 'T');
  vm.runInContext(declaration('persistCodexModelEffortIntent'), h.context);
  const saved = h.context.persistCodexModelEffortIntent('T', 'gpt-6.1-terra', 'max', 'user-selection');
  assert.equal(saved.success, true); assert.equal(saved.revision, 22);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').cancelled, false);
  assert.equal(old('picker-confirm-model').allowed, false, 'old physical operation stays revoked after a new click');
  old.dispose();
});

test('a cancelled desired pair is not scheduled as an application', () => {
  const result = planCodexModelEffortIntentReconcile({ model: 'gpt-6.1-terra', effort: 'max',
    revision: 21, cancelled: true, writerOwnerId: 'S', processRunning: true, tuiReady: true });
  assert.equal(result.action, 'none'); assert.equal(result.reason, 'intent-cancelled');
});

test('actual picker capture wakes on cancel and cannot write another navigation or Enter', async t => {
  const h = fixture(t), guard = h.guard(), writes = [], output = new EventEmitter();
  Object.assign(h.context, { setTimeout, clearTimeout, CODEX_SYNC_MARKER: '\x1b[?2026l',
    cleanCodexTuiFrame: text => text });
  vm.runInContext(['captureCodexFrame', 'readCodexPickerWriteRefusal', 'sendCodexKeyAndCapture']
    .map(declaration).join('\n'), h.context);
  const term = { write: data => writes.push(data), onData(fn) { output.on('data', fn);
    return { dispose: () => output.removeListener('data', fn) }; } };
  guard('slash-command-paste');
  const pending = h.context.sendCodexKeyAndCapture(term, '\x1b[B', 6000, '[test]', null,
    { writeGuard: guard, writePhase: 'picker-navigation-down-1' });
  assert.deepEqual(writes, ['\x1b[B']);
  assert.equal(h.cancel().success, true);
  const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(result.writeAborted, true);
  assert.equal(result.keyWritten, true); assert.equal(output.listenerCount('data'), 0);
  const next = await h.context.sendCodexKeyAndCapture(term, '\r', 6000, '[test]', null,
    { writeGuard: guard, writePhase: 'picker-confirm-model' });
  assert.equal(next.writeAborted, true); assert.deepEqual(writes, ['\x1b[B']);
  guard.dispose();
});

test('cancel also wakes a late picker-frame observer without waiting for its deadline', async t => {
  const h = fixture(t), guard = h.guard(), output = new EventEmitter(); guard('slash-command-paste');
  Object.assign(h.context, { setTimeout, clearTimeout, CODEX_SYNC_MARKER: '\x1b[?2026l', cleanCodexTuiFrame: text => text });
  vm.runInContext(['captureCodexFrame', 'ensureCodexPickerFrame'].map(declaration).join('\n'), h.context);
  const term = { onData(fn) { output.on('data', fn); return { dispose: () => output.removeListener('data', fn) }; } };
  const pending = h.context.ensureCodexPickerFrame(term, { clean: '' }, { tabId: 'T', logPrefix: '[test]',
    parseState: () => ({ items: [] }), writeGuard: guard });
  assert.equal(h.cancel().success, true);
  const result = await pending;
  assert.equal(result.frame.cancelled, true); assert.equal(output.listenerCount('data'), 0); guard.dispose();
});

for (const mode of ['owned-picker', 'manual-takeover', 'screen-unknown', 'already-composer']) {
  test('cancel cleanup uses actual Main screen and write guards: ' + mode, async t => {
    const h = fixture(t), guard = h.guard(), events = new EventEmitter(), writes = [];
    guard('slash-command-paste'); guard.onCancel(() => {});
    let screen = mode === 'already-composer' ? '› Ask Codex to do anything\ngpt-6.1-sol max · /fixture'
      : 'Select Model and Effort\n› 1. GPT-6.1-Sol\n  2. GPT-6.1 Terra\nenter select · esc back';
    const term = { onData(fn) { events.on('data', fn); return { dispose: () => events.removeListener('data', fn) }; },
      write(value) { writes.push(value); if (value === '\x1b') {
        screen = '› Ask Codex to do anything\ngpt-6.1-sol max · /fixture'; events.emit('data', screen);
      } } };
    const wrapped = phase => mode === 'manual-takeover'
      ? { allowed: false, reason: 'codex_input_ownership_changed' } : guard(phase);
    wrapped.onCancel = guard.onCancel; wrapped.isCancelled = guard.isCancelled;
    wrapped.beginCleanup = guard.beginCleanup; wrapped.endCleanup = guard.endCleanup;
    Object.assign(h.context, require('./codex-model-picker'), require('./codex-tui-readiness'),
      { setTimeout, clearTimeout, CODEX_SYNC_MARKER: '\x1b[?2026l', cleanCodexTuiFrame: text => text,
        classifyManualCodexEnterFrame: () => ({ kind: 'ordinary-enter', proven: false }),
        readCodexAuthoritativeScreen: async () => mode === 'screen-unknown'
          ? { success: false } : { success: true, clean: screen, snapshot: {} } });
    vm.runInContext(['captureCodexFrame', 'readCodexPickerWriteRefusal', 'sendCodexKeyAndCapture',
      'latestCodexSynchronizedFrameText', 'currentCodexPickerFrameText', 'codexPickerFrameIsComposer',
      'closeCodexPickerToComposer'].map(declaration).join('\n'), h.context);
    assert.equal(h.cancel().success, true); guard.beginCleanup();
    const result = await h.context.closeCodexPickerToComposer(term, { tabId: 'T', logPrefix: '[test]', writeGuard: wrapped });
    if (mode === 'owned-picker') { assert.equal(result.success, true); assert.deepEqual(writes, ['\x1b']); }
    else if (mode === 'already-composer') { assert.equal(result.success, true); assert.deepEqual(writes, []); }
    else { assert.equal(result.success, false); assert.deepEqual(writes, []); }
    assert.equal(events.listenerCount('data'), 0); guard.endCleanup(); guard.dispose();
  });
}

test('cancel during a written draft stash returns its exact text and image snapshot', async t => {
  const h = fixture(t), guard = h.guard(), events = new EventEmitter(), writes = [];
  const snapshot = { success: true, editorReturnReady: true, terminalIdentityStable: true,
    captureOperationId: 'CAPTURE', text: 'original [Image #1]', capturedText: 'original [Image #1]',
    images: 1, imagePaths: [{ id: 1, assetId: 'fixture-image', path: '/fixture/image.png' }] };
  Object.assign(h.context, require('./codex-draft-preservation'), { setTimeout, clearTimeout,
    CODEX_SYNC_MARKER: '\x1b[?2026l', cleanCodexTuiFrame: text => text });
  vm.runInContext(['captureCodexFrame', 'readCodexPickerWriteRefusal', 'sendCodexKeyAndCapture',
    'stashCodexDraftForPicker'].map(declaration).join('\n'), h.context);
  const term = { onData(fn) { events.on('data', fn); return { dispose: () => events.removeListener('data', fn) }; },
    write(value) { writes.push(value); assert.equal(h.cancel().success, true); } };
  guard('draft-exact-copy');
  const result = await h.context.stashCodexDraftForPicker(term, { tabId: 'T', logPrefix: '[test]', writeGuard: guard,
    captureDraftSnapshot: async () => snapshot });
  assert.equal(result.success, false); assert.equal(result.draftTransfer.text, snapshot.text);
  assert.equal(result.draftTransfer.imagePaths[0].assetId, 'fixture-image');
  assert.deepEqual(writes, ['\x03']); assert.equal(events.listenerCount('data'), 0);
  guard.dispose();
});

test('actual Main settings request cancels during config preparation without a timer or PTY write', async t => {
  const h = fixture(t), guard = h.guard(), writes = [];
  h.activity.end(h.initialActivity);
  h.term.write = value => writes.push(value);
  Object.assign(h.context, {
    resolveActiveCodexConfigForTab: () => new Promise(() => {}),
    AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown' }, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext([declaration('beginAgentSettingsActivity'), declaration('executeCodexSelectModelEffortRequest')].join('\n'), h.context);
  const work = h.context.executeCodexSelectModelEffortRequest(null, {
    tabId: 'T', model: 'gpt-6.1-terra', effort: 'max', settingsWriteGuard: guard,
  });
  assert.equal(h.activity.read('T').busy, true);
  assert.equal(h.cancel(h.activity.read('T').cancelTarget).success, true);
  const result = await work;
  assert.equal(result.cancelled, true); assert.equal(result.success, false);
  assert.equal(h.activity.read('T').busy, false); assert.deepEqual(writes, []);
});

test('the actual scheduler does not replay a cancelled revision on an already queued readiness wake', async t => {
  const h = fixture(t); let calls = 0;
  Object.assign(h.context, { setImmediate, codexModelEffortIntentReconcileInflight: new Map(),
    codexModelEffortIntentReconcileRequested: new Set(), codexReserveResumeGuards: new WeakMap(),
    terminalCommandState: new Map([['T', { isRunning: true, runSeq: 1 }]]),
    retireCodexScopedModelEffortIntent() {}, getTerminalLifecycleGeneration: () => 'G',
    getCodexWriterProofSnapshot: () => ({ sessionId: 'S' }), getCodexProvisionalSettingsSnapshot: () => null,
    codexHasLivePtySubmitEvidence: () => true, isCodexTuiEffectivelyReady: () => true,
    planCodexModelEffortIntentReconcile,
    codexModelEffortIntentApplicationProven: require('./codex-model-effort-intent').codexModelEffortIntentApplicationProven,
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } },
    executeCodexSelectModelEffortRequest: async (_sender, request) => {
      calls++; request.settingsWriteGuard('slash-command-paste');
      return new Promise(resolve => request.settingsWriteGuard.onCancel(() => {
        request.settingsWriteGuard.dispose(); resolve({ success: false, cancelled: true, error: 'codex_settings_intent_cancelled' });
      }));
    },
  });
  vm.runInContext(['updateCodexSettingsIntentError', 'scheduleCodexModelEffortIntentReconcile']
    .map(declaration).join('\n'), h.context);
  const work = h.context.scheduleCodexModelEffortIntentReconcile('T', 'user-selection');
  h.context.scheduleCodexModelEffortIntentReconcile('T', 'tui-ready');
  assert.equal(h.cancel().success, true);
  const result = await work; assert.equal(result.cancelled, true, JSON.stringify(result)); assert.equal(result.intentPending, false);
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(h.context.getCodexModelEffortIntentRecord('T').cancelled, true);
});

test('a same-revision readiness echo cannot replay an already-started failed /model operation', async t => {
  const h = fixture(t); let calls = 0, release;
  Object.assign(h.context, { setImmediate, codexModelEffortIntentReconcileInflight: new Map(),
    codexModelEffortIntentReconcileRequested: new Set(), codexReserveResumeGuards: new WeakMap(),
    retireCodexScopedModelEffortIntent() {}, getCodexWriterProofSnapshot: () => ({ sessionId: 'S' }),
    getCodexProvisionalSettingsSnapshot: () => null, codexHasLivePtySubmitEvidence: () => true,
    isCodexTuiEffectivelyReady: () => true, planCodexModelEffortIntentReconcile,
    codexModelEffortIntentApplicationProven: () => false, updateCodexSettingsIntentError() {},
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } },
    executeCodexSelectModelEffortRequest: async (_sender, request) => {
      calls++; request.settingsWriteGuard('slash-command-paste');
      if (calls === 1) return new Promise(resolve => { release = resolve; });
      return { success: false, error: 'controlled-timeout' };
    },
  });
  vm.runInContext(declaration('scheduleCodexModelEffortIntentReconcile'), h.context);
  const work = h.context.scheduleCodexModelEffortIntentReconcile('T', 'user-selection');
  h.context.scheduleCodexModelEffortIntentReconcile('T', 'tui-ready');
  release({ success: false, error: 'controlled-timeout' }); await work;
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'the readiness echo is not a new user choice or authority for another /model');
});

for (const kind of ['newer-choice-after-write', 'ready-before-write']) {
  test('the scheduler preserves the legitimate ' + kind + ' wake', async t => {
    const h = fixture(t); let calls = 0, release;
    Object.assign(h.context, { setImmediate, codexModelEffortIntentReconcileInflight: new Map(),
      codexModelEffortIntentReconcileRequested: new Set(), codexReserveResumeGuards: new WeakMap(),
      retireCodexScopedModelEffortIntent() {}, getCodexWriterProofSnapshot: () => ({ sessionId: 'S' }),
      getCodexProvisionalSettingsSnapshot: () => null, codexHasLivePtySubmitEvidence: () => true,
      isCodexTuiEffectivelyReady: () => true, planCodexModelEffortIntentReconcile,
      codexModelEffortIntentApplicationProven: () => false, updateCodexSettingsIntentError() {},
      mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } },
      executeCodexSelectModelEffortRequest: async (_sender, request) => {
        calls++;
        if (kind === 'newer-choice-after-write') request.settingsWriteGuard('slash-command-paste');
        if (calls === 1) return new Promise(resolve => { release = resolve; });
        return { success: false, error: 'controlled-no-input' };
      },
    });
    vm.runInContext(declaration('scheduleCodexModelEffortIntentReconcile'), h.context);
    const work = h.context.scheduleCodexModelEffortIntentReconcile('T', 'user-selection');
    if (kind === 'newer-choice-after-write') h.states.set('T', { ...h.states.get('T'),
      codexSettingsIntentModel: 'gpt-6-astra', codexSettingsIntentRevision: 22, codexSettingsIntentActionSequence: 9 });
    h.context.scheduleCodexModelEffortIntentReconcile('T', kind === 'ready-before-write' ? 'tui-ready' : 'user-selection');
    release({ success: false, error: 'controlled-not-ready' }); await work;
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'a real newer choice or readiness gained before input is not discarded');
  });
}

test('actual model spinner becomes red on hover and its click reaches exact Main cancellation', async t => {
  const h = fixture(t), guard = h.guard(); guard('slash-command-paste'); guard.onCancel(() => {});
  const writes = [], output = new EventEmitter();
  Object.assign(h.context, { setTimeout, clearTimeout, CODEX_SYNC_MARKER: '\x1b[?2026l', cleanCodexTuiFrame: text => text });
  vm.runInContext(['captureCodexFrame', 'readCodexPickerWriteRefusal', 'sendCodexKeyAndCapture']
    .map(declaration).join('\n'), h.context);
  const term = { write: data => writes.push(data), onData(fn) { output.on('data', fn);
    return { dispose: () => output.removeListener('data', fn) }; } };
  const pending = h.context.sendCodexKeyAndCapture(term, '\x1b[B', 6000, '[test]', null,
    { writeGuard: guard, writePhase: 'picker-navigation-down-1' });
  const React = require('react'), bar = fs.readFileSync(require.resolve('../renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const tree = ts.createSourceFile('bar.tsx', bar, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variables = new Map(); let button;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['canCancelCodexSetting', 'requestCodexSettingsCancellation', 'forceResetBusy'].includes(node.name?.text)) {
      variables.set(node.name.text, node.parent.parent.getText(tree));
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'button'
      && node.openingElement.attributes.properties.some(attr => ts.isJsxAttribute(attr)
        && attr.name.getText(tree) === 'data-agent-setting-trigger' && attr.initializer?.text === 'model')) button = node;
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(button); assert.equal(variables.size, 3);
  const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const ui = vm.createContext({ React, tabId: 'T', isCodex: true, isLocalBusy: false, localBusyReason: null,
    busyTarget: 'model', settingsActivity: h.activity.read('T'), codexSettingsSaveRef: { current: null },
    controlBarBusyTarget: () => 'model', setBusyCancelHover: value => { ui.busyCancelHover = value; },
    busyCancelHover: false, triggerRefs: { current: {} }, triggerProps: () => ({}), triggerStyle: {},
    modelSpinning: true, modelBlocked: true, codexModelMenuDisabled: true, modelActiveId: 'gpt-6.1-terra',
    modelLabel: 'GPT-6.1 Terra', pinnedPopup: null, claudeModelProofNeedsAttention: false,
    ControlBusySpinner: () => null, adoptProviderState() {}, console: { warn() {} },
    useUIStore: { getState: () => ({ showToast: message => assert.fail(message) }) },
    ipcRenderer: { invoke: async (channel, request) => { assert.equal(channel, 'codex:cancel-model-effort-intent');
      return h.context.cancelCodexModelEffortIntent(request); } },
  });
  const declarations = ['canCancelCodexSetting', 'requestCodexSettingsCancellation', 'forceResetBusy']
    .map(name => variables.get(name)).join('\n');
  vm.runInContext(compile(declarations + '\nglobalThis.canCancel = canCancelCodexSetting;'
    + '\nglobalThis.button = () => (' + button.getText(tree) + ');'), ui);
  ui.modelCanCancel = ui.canCancel('model');
  assert.equal(ui.modelCanCancel, true);
  let element = ui.button(); assert.equal(element.props.disabled, false);
  element.props.onMouseEnter(); element = ui.button();
  assert.equal(element.props.style.backgroundColor, 'rgba(220,38,38,0.14)');
  assert.equal(React.Children.toArray(element.props.children).find(child => child.type === ui.ControlBusySpinner).props.hovered, true);
  element.props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(writes, ['\x1b[B']); assert.equal(output.listenerCount('data'), 0);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').cancelled, true);
  assert.equal(guard('picker-confirm-model').allowed, false);
  assert.equal(h.stored().codexSettingsIntentCancelled.revision, 21);
  guard.dispose();
});

test('click while the original settings-save IPC is pending cancels that exact saved action', async t => {
  const h = fixture(t), bar = fs.readFileSync(require.resolve('../renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const tree = ts.createSourceFile('bar.tsx', bar, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), declarations = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['canCancelCodexSetting', 'requestCodexSettingsCancellation',
      'forceResetBusy', 'applyCodexModelAndEffort'].includes(node.name?.text)) declarations.set(node.name.text, node.parent.parent.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.equal(declarations.size, 4);
  let resolveSave, adopted;
  const ui = vm.createContext({ tabId: 'T', isCodex: true, isLocalBusy: false, localBusyReason: 'codex-model:terra/max',
    busyTarget: 'model', settingsActivity: { busy: false }, codexSettingsSaveRef: { current: null },
    claudeSettingActionsRef: { current: { tabId: 'T', seq: 9, pending: 1 } },
    claudeSettingActionIsCurrent: seq => seq === 9,
    controlBarBusyTarget: () => 'model', setBusyCancelHover() {}, focusTerminal() {},
    setLocalBusy: value => { ui.isLocalBusy = value; }, recoverAgentDraftTransferToHistory: async () => {},
    adoptProviderState: value => { adopted = value; }, console: { warn() {}, log() {} },
    useUIStore: { getState: () => ({ showToast: message => assert.fail(message) }) },
    ipcRenderer: { invoke(channel, request) {
      if (channel === 'codex:set-model-effort-intent') return new Promise(resolve => { resolveSave = resolve; });
      assert.equal(channel, 'codex:cancel-model-effort-intent');
      return Promise.resolve(h.context.cancelCodexModelEffortIntent(request));
    } },
  });
  const code = ['canCancelCodexSetting', 'requestCodexSettingsCancellation', 'forceResetBusy', 'applyCodexModelAndEffort']
    .map(name => declarations.get(name)).join('\n')
    + '\nglobalThis.apply = applyCodexModelAndEffort; globalThis.clickCancel = forceResetBusy;';
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText, ui);
  const pending = ui.apply('gpt-6.1-terra', 'max', 'model');
  assert.equal(ui.isLocalBusy, true); ui.clickCancel();
  resolveSave({ success: true, queued: true, intentRevision: 21, providerState: h.states.get('T'),
    cancelTarget: h.activity.read('T').cancelTarget });
  const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(ui.isLocalBusy, false);
  assert.equal(adopted.codexSettingsIntentCancelled.revision, 21);
  assert.equal(h.context.getCodexModelEffortIntentRecord('T').cancelled, true);
});

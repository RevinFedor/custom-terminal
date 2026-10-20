'use strict';

// Actual Main intent/publisher/PTY serializer/admission and launch boundary.
// The CLI composer, native slash response, database and renderer IPC are explicit
// controlled leaves: these are not physical Codex or installed-app checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const contract = require('./codex-runtime-contract');
const fast = require('./codex-fast-intent');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');
const { planCodexModelEffortIntentReconcile } = require('./codex-model-effort-intent');
const main = fs.readFileSync(process.env.CODEX_FAST_MAIN_SOURCE || require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
const declaration = name => { const n = fn(name); assert.ok(n, name); return n.getText(ast); };
const quiet = { log() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const names = ['withPtyWriteLock', 'getCurrentCodexServiceTierProofIdentity',
  'resolveCodexServiceTierResultIdentity', 'clearCodexServiceTierProof',
  'reconcileCodexServiceTierProofIdentity', 'publishCodexServiceTierProof',
  'getCodexFastIntentRecord', 'persistNextCodexFastIntent', 'persistCodexFastIntentValue',
  'scheduleCodexFastIntentReconcile', 'executeCodexLiveSlashCommandRequest', 'waitForCodexInputPreparation'];
// Preimages execute their existing code unchanged; absent new helpers are not
// setup failures. The behavioral assertions below distinguish that old code.
for (const name of ['ensureCodexFastLaunchIntent', 'readCodexFastIntentWriteAdmission']) {
  if (fn(name)) names.push(name);
}

function fixture({ desired = false, revision = 1, tier = 'priority', running = true, ready = true } = {}) {
  const writes = [], notifications = [], saved = [], logs = [];
  const state = { owner: 'W1', lifecycle: 'G1', run: 1, input: 1, stop: 0,
    nativeTier: tier, running, ready, hasDraft: false, beforeProbe: null, afterPaste: null, afterEnter: null,
    modelIntent: null };
  const term = { write: value => writes.push(value) };
  const providerStates = new Map([['T', { type: 'anthropic', unrelated: 'KEEP',
    ...(typeof desired === 'boolean' ? { codexFastIntent: desired, codexFastIntentRevision: revision } : {}) }]]);
  const commands = new Map([['T', { isRunning: running, runSeq: state.run }]]);
  const terms = new Map([['T', term]]), meta = new Map(), events = new EventEmitter();
  const identity = () => ({ ownerId: state.owner, terminalToken: terms.get('T'),
    terminalLifecycleGeneration: state.lifecycle, terminalRunSeq: commands.get('T').runSeq,
    generationMode: 'terminal-run', generationId: state.lifecycle });
  const paint = value => {
    state.nativeTier = value;
    meta.set('T', { serviceTierProof: contract.createCodexServiceTierProof({
      ...identity(), serviceTier: value, proofAt: Date.now(), source: 'verified-composer-footer' }) });
  };
  const ctx = vm.createContext({ ...contract, ...fast, console: quiet, Date, setImmediate, queueMicrotask,
    observeAgentInput, planCodexModelEffortIntentReconcile, codexReserveResumeGuards: new WeakMap(),
    terminals: terms, terminalCommandState: commands, codexTuiReadyMeta: meta,
    codexTuiReadyTabs: new Set(['T']), providerStates, ipcMain: events,
    getCodexWriterProofSnapshot: () => ({ sessionId: state.owner }),
    getCodexProvisionalSettingsSnapshot: () => null,
    getTerminalLifecycleGeneration: () => state.lifecycle,
    getTerminalInputRevision: () => state.input, getTerminalStopRevision: () => state.stop,
    codexHasLivePtySubmitEvidence: () => state.running,
    isCodexTuiEffectivelyReady: () => state.ready,
    hasCodexPromptOrTurnInFlight: () => false,
    codexFastIntentReconcileInflight: new Map(), codexFastIntentReconcileRequested: new Set(),
    codexModelEffortIntentReconcileInflight: new Map(),
    codexSettingsMutationQueue: createCodexSettingsMutationQueue(),
    codexPickerQueue: new Map(), aiStoppingTabs: new Map(),
    pasteInflight: new WeakMap(), ptyActiveWriteOperation: new WeakMap(),
    ptyLastQueuedWriteOperation: new WeakMap(), ptyWriteOwners: new WeakMap(),
    setProviderState: (id, value) => providerStates.set(id, value),
    projectManager: { db: {
      updateTabProviderState: (id, value) => saved.push({ id, value: structuredClone(value) }),
      db: { prepare: sql => {
        assert.equal(sql, 'SELECT provider_state FROM tabs WHERE tab_id = ? LIMIT 1');
        return { get: id => {
          const last = saved.filter(row => row.id === id).at(-1);
          return last ? { provider_state: JSON.stringify(last.value) } : { provider_state: null };
        } };
      } },
    } },
    broadcastProviderState: (id, value) => notifications.push({ event: 'provider-state', id, value }),
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false,
      send: (event, payload) => notifications.push({ event, payload }) } },
    syncPendingCodexServiceTierProof() {}, noteProjectCardSignalsChanged() {},
    getCodexModelEffortIntentRecord: () => state.modelIntent,
    createMainAgentInputObservation: (_id, _tool, timeoutMs) => {
      const before = { input: state.input, stop: state.stop, run: commands.get('T').runSeq,
        lifecycle: state.lifecycle, terminal: terms.get('T') };
      return createAgentInputObservation({ timeoutMs,
        isCurrent: () => before.input === state.input && before.stop === state.stop
          && before.run === commands.get('T').runSeq && before.lifecycle === state.lifecycle
          && before.terminal === terms.get('T'),
        subscribe: wake => {
          const onReady = () => wake(); events.on('agent:readiness-changed-internal', onReady);
          return () => events.removeListener('agent:readiness-changed-internal', onReady);
        },
      });
    },
    captureCodexSendStartupFrameWait: () => null,
    codexSlashCommandAllowsTurnBusy: ({ command }) => command === '/fast',
    isOwnedDesktopHistorySendSource: () => false,
    requestTerminalCodexDraftState: async () => {
      if (state.beforeProbe) await state.beforeProbe();
      return { success: true, hasDraft: state.hasDraft, source: 'controlled-composer' };
    },
    createCodexPickerDraftCapture: () => () => {},
    sendCodexLiveSlashCommand: async (_term, request) => {
      const reject = check => ({ success: false, error: check.reason, submitted: false,
        pasteWritten: writes.length > 0, enterWritten: false });
      const paste = request.writeGuard('slash-command-paste');
      if (!paste.allowed) return reject(paste);
      if (request.turnBusy && request.hasDraft) return { success: false, error: 'busy_draft_unsafe', submitted: false };
      term.write('/fast');
      if (state.afterPaste) await state.afterPaste();
      const enter = request.writeGuard('slash-command-enter');
      if (!enter.allowed) return { ...reject(enter), pasteWritten: true, slashRollback: { cleared: true } };
      term.write('\r');
      const next = state.nativeTier === 'priority' ? 'default' : 'priority';
      state.nativeTier = next;
      if (state.afterEnter) await state.afterEnter(request, next);
      return { success: true, submitted: true, pasteWritten: true, enterWritten: true,
        serviceTier: next, serviceTierSource: 'tui-service-tier-feedback' };
    },
  });
  vm.runInContext(names.map(declaration).join('\n'), ctx);
  // Capture logs without changing product control flow.
  ctx.console = Object.fromEntries(['log', 'warn', 'error'].map(kind => [kind, (...args) => logs.push(args.join(' '))]));
  paint(tier);
  return { ctx, state, term, terms, commands, providerStates, writes, saved, notifications, logs, paint,
    reconcile: () => ctx.scheduleCodexFastIntentReconcile('T', 'actual-test'),
    click() { const result = ctx.persistNextCodexFastIntent('T'); ctx.scheduleCodexFastIntentReconcile('T', 'user-toggle'); return result; },
    async settle() { for (let i = 0; i < 8; i++) await tick(); },
  };
}

function launchBoundary(h, { command = 'codex', globalTier = 'priority', profile = null, onAdmission = null } = {}) {
  let boundary;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'withPtyWriteLock'
      && node.getText(ast).includes('returnChoiceCurrent')) boundary = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(fn('runCodexCommandFromPayloadInner'));
  assert.ok(boundary, 'actual managed launch boundary');
  const payload = { launchId: 'L' }, lines = [];
  Object.assign(h.ctx, { tabId: 'T', term: h.term, sessionId: 'SOURCE', launchId: 'L', launchRunSeq: 1,
    normalizedCommand: command, termCwd: '/fixture/path with spaces', profile,
    developerInstructions: '', providerProxyBaseUrl: null, codexAuthProfileRoute: null,
    payload: {}, ownsMcpStartupRecoveryHandoff: false, startedAt: 0,
    effectiveModel: 'gpt-6.1-sol', effectiveEffort: 'max', sourceSettingsProof: {}, reserveReturn: null,
    assertCurrent() {},
    codexLastRunCommandPayload: new Map([['T', payload]]), codexServiceTierLaunchCandidates: new Map(),
    codexReserveResumeGuards: new WeakMap(),
    proveIdleShellForAgentLaunch: async () => { if (onAdmission) await onAdmission(); return { allowed: true }; },
    rebaseCodexLaunchObservationAtWrite() {}, disarmCodexProviderSemanticSource() {},
    writeAgentLaunchCommandToIdleShell: (_term, request) => lines.push(request.command),
  });
  vm.runInContext(['shellQuote', 'tomlString', 'buildCodexCommand'].map(declaration).join('\n')
    + '\nvar launchBoundary = ' + boundary.getText(ast), h.ctx);
  return { payload, lines, async run() {
    const result = await h.ctx.launchBoundary();
    const explicit = lines[0]?.match(/service_tier="(fast|priority|default)"/)?.[1];
    return { result, tier: explicit === 'fast' ? 'priority' : explicit || globalTier };
  } };
}

for (const command of ['codex', 'codex-c', 'codex-f']) {
  for (const desired of [undefined, false, true]) {
    test('actual ' + command + ' overrides foreign global Fast; saved=' + desired, async () => {
      const h = fixture({ desired: typeof desired === 'boolean' ? desired : null });
      const expected = desired === true ? 'priority' : 'default';
      const launch = launchBoundary(h, { command, globalTier: expected === 'priority' ? 'default' : 'priority', profile: 'managed' });
      const result = await launch.run();
      assert.equal(result.result.written, true);
      assert.equal(result.tier, expected, 'the launch must not inherit another tab/global tier');
      assert.equal(h.providerStates.get('T').codexFastIntent, desired === true);
      assert.equal(h.providerStates.get('T').unrelated, 'KEEP');
      assert.equal(launch.lines.length, 1);
      assert.match(launch.lines[0], /--profile 'managed'/);
      assert.equal(h.ctx.codexTuiReadyMeta.get('T').serviceTierProof.serviceTier, 'priority', 'arguments are not observed/runtime proof');
    });
  }
}

test('a Fast click during asynchronous launch preparation wins at the actual shell write', async () => {
  const h = fixture({ desired: false, running: false, ready: false });
  const launch = launchBoundary(h, { globalTier: 'default', onAdmission: () => { h.click(); } });
  assert.equal((await launch.run()).tier, 'priority');
  assert.equal(h.providerStates.get('T').codexFastIntentRevision, 2);
  assert.equal(h.writes.length, 0, 'no slash is written into the starting shell');
});

for (const desired of [true, false]) test('a persisted ' + desired + ' choice wins after missing startup RAM hydration', async () => {
  const h = fixture({ desired: null, running: false, ready: false });
  const stored = { type: 'anthropic', codexFastIntent: desired, codexFastIntentRevision: 9, storedMetadata: 'KEEP' };
  h.ctx.projectManager.db.db.prepare = () => ({ get: () => ({ provider_state: JSON.stringify(stored) }) });
  h.ctx.projectManager.db.updateTabProviderState = () => assert.fail('a known persisted revision must not be rewritten as a default');
  const launch = launchBoundary(h, { globalTier: desired ? 'default' : 'priority' });
  assert.equal((await launch.run()).tier, desired ? 'priority' : 'default');
  assert.equal(h.providerStates.get('T').codexFastIntentRevision, 9);
  assert.equal(h.providerStates.get('T').storedMetadata, 'KEEP');
  assert.equal(h.providerStates.get('T').unrelated, 'KEEP');
});

test('malformed persisted state is unknown, not a healthy missing choice that may be replaced with off', async () => {
  for (const provider_state of ['{', '[]', 'null', '{"codexFastIntent":"true"}']) {
    const h = fixture({ desired: null, running: false, ready: false });
    h.ctx.projectManager.db.db.prepare = () => ({ get: () => ({ provider_state }) });
    const launch = launchBoundary(h);
    await assert.rejects(launch.run(), /codex_fast_intent_source_unavailable/);
    assert.equal(launch.lines.length, 0); assert.equal(h.saved.length, 0);
    assert.equal(h.providerStates.get('T').codexFastIntent, undefined);
  }
});

test('queued Fast rechecks last desired state after an earlier Send owns the actual PTY', async () => {
  const h = fixture(), head = deferred(), entered = deferred();
  const send = h.ctx.withPtyWriteLock(h.term, async () => { entered.resolve(); await head.promise; });
  await entered.promise;
  const reconcile = h.reconcile();
  h.click(); // false -> true, already matches the still-active priority tier.
  assert.equal(h.providerStates.get('T').codexFastIntent, true, 'choice commits without waiting for the writer');
  assert.equal(h.writes.length, 0);
  head.resolve(); await send; await reconcile; await h.settle();
  assert.deepEqual(h.writes, [], 'a stale toggle cannot run and then be corrected with a second toggle');
  assert.equal(h.state.nativeTier, 'priority');
});

test('fresh proof arriving during composer await cancels a now-redundant toggle', async () => {
  const h = fixture(); let once = true;
  h.state.beforeProbe = () => { if (once) { once = false; h.paint('default'); } };
  await h.reconcile(); await h.settle();
  assert.deepEqual(h.writes, []);
  assert.equal(h.state.nativeTier, 'default');
});

test('a newer choice between paste and Enter refuses the old Enter, retaining the latest intent', async () => {
  const h = fixture(); let once = true;
  h.state.afterPaste = () => { if (once) { once = false; h.click(); } };
  await h.reconcile(); await h.settle();
  assert.equal(h.writes.filter(value => value === '\r').length, 0);
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.state.nativeTier, 'priority');
});

test('a choice after Enter survives late native feedback and the final native tier matches it', async () => {
  const h = fixture(); let once = true;
  h.state.afterEnter = request => { if (once) {
    once = false; h.click();
    assert.equal(request.writeGuard('draft-restore-1').allowed, true,
      'a newer Fast choice must not block owned draft restoration after Enter');
  } };
  await h.reconcile(); await h.settle();
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.providerStates.get('T').codexFastIntentRevision, 2);
  assert.equal(h.state.nativeTier, 'priority');
  assert.equal(h.writes.filter(value => value === '\r').length, 2, 'one already-entered old choice, then one latest-state correction');
});

for (const changed of ['input', 'stop', 'run', 'lifecycle', 'terminal', 'unknown-draft', 'owner']) {
  test('actual Fast keeps the ' + changed + ' guard across the queued composer probe', async () => {
    const h = fixture();
    h.state.beforeProbe = () => {
      if (changed === 'input') h.state.input++;
      if (changed === 'stop') h.state.stop++;
      if (changed === 'run') h.commands.get('T').runSeq++;
      if (changed === 'lifecycle') h.state.lifecycle = 'G2';
      if (changed === 'terminal') h.terms.set('T', { write() { assert.fail('foreign terminal'); } });
      if (changed === 'unknown-draft') h.state.hasDraft = null;
      if (changed === 'owner') h.state.owner = 'W2';
    };
    const result = await h.reconcile();
    assert.equal(result.queued, true);
    assert.doesNotMatch(String(result.error), /not defined|not a function/);
    assert.deepEqual(h.writes, []);
    assert.equal(h.providerStates.get('T').codexFastIntent, false);
  });
}

test('a late Fast ACK does not become proof or intent of a replacement writer', async () => {
  const h = fixture();
  h.state.afterEnter = () => { h.state.owner = 'W2'; h.state.lifecycle = 'G2'; h.commands.get('T').runSeq++; };
  const result = await h.reconcile();
  assert.equal(result.serviceTierProofSuperseded, true);
  assert.equal(h.providerStates.get('T').codexFastIntent, false);
  assert.notEqual(h.ctx.codexTuiReadyMeta.get('T')?.serviceTierProof?.ownerId, 'W2');
});

test('Fast intent and persistence are per-tab, never inherited from the global bucket', async () => {
  const h = fixture({ desired: null, running: false, ready: false });
  h.providerStates.set('global', { codexFastIntent: true, codexFastIntentRevision: 20 });
  h.providerStates.set('B', { codexFastIntent: true, codexFastIntentRevision: 7 });
  const launch = launchBoundary(h);
  assert.equal((await launch.run()).tier, 'default');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].id, 'T');
  assert.equal(h.providerStates.get('global').codexFastIntentRevision, 20);
  assert.equal(h.providerStates.get('B').codexFastIntentRevision, 7);
});

test('manual exact native Fast feedback outside the app transaction remains a new per-tab choice', () => {
  const h = fixture({ desired: false });
  h.ctx.publishCodexServiceTierProof('T', 'priority', 'tui-service-tier-feedback');
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.providerStates.get('T').codexFastIntentRevision, 2);
});

test('actual startup/Send/queued model/Fast interleave without holding the PTY or losing the last choice', async () => {
  const h = fixture({ desired: null, tier: 'default', running: false, ready: false });
  const sequence = [], globalHead = deferred(), sendHead = deferred(), sendEntered = deferred();
  await launchBoundary(h, { globalTier: 'priority' }).run();
  h.state.running = true; h.state.ready = true; h.commands.get('T').isRunning = true;
  h.state.modelIntent = { model: 'gpt-6.1-sol', effort: 'high', revision: 1, actionSequence: 1,
    appliedRevision: 0, appliedOwnerId: null };
  const queue = h.ctx.codexSettingsMutationQueue;
  const blocker = queue.run(() => globalHead.promise);
  const model = queue.run(() => h.ctx.withPtyWriteLock(h.term, () => {
    sequence.push('model');
    h.state.modelIntent = { ...h.state.modelIntent, appliedRevision: 1, appliedOwnerId: 'W1' };
  }));
  h.ctx.codexModelEffortIntentReconcileInflight.set('T', model);
  h.ctx.historyMutationInput = { notify() {} };
  h.ctx.scheduleCodexModelEffortIntentReconcile = () => null;
  const readyHandler = ast.statements.find(n => ts.isExpressionStatement(n)
    && n.getText(ast).startsWith("ipcMain.on('agent:readiness-changed-internal'")
    && n.getText(ast).includes('input-ready:'));
  assert.ok(readyHandler);
  vm.runInContext(readyHandler.getText(ast), h.ctx);
  model.then(() => {
    h.ctx.codexModelEffortIntentReconcileInflight.delete('T');
    h.ctx.ipcMain.emit('agent:readiness-changed-internal', null,
      { tabId: 'T', toolType: 'codex', source: 'settings-reconcile-settled' });
  });
  h.click(); // Saved immediately while model waits in the existing global queue.
  await tick(); await tick();
  const send = h.ctx.withPtyWriteLock(h.term, async () => {
    sequence.push('send'); sendEntered.resolve(); await sendHead.promise;
  });
  await sendEntered.promise;
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.writes.length, 0, 'the Fast waiter did not retain the PTY while waiting for model preparation');
  sendHead.resolve(); await send;
  globalHead.resolve(); await blocker; await model; await h.settle();
  assert.equal(h.state.nativeTier, 'priority');
  assert.deepEqual(sequence, ['send', 'model']);
  assert.equal(h.writes.filter(value => value === '/fast').length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  assert.equal(queue.pending, 0);
  assert.equal(h.ctx.codexModelEffortIntentReconcileInflight.size, 0);
  assert.equal(h.ctx.codexFastIntentReconcileInflight.size, 0);
});

test('failed durable Fast save cannot leave a new RAM intent that a later launch mistakes for committed', async () => {
  const h = fixture({ desired: null, running: false, ready: false });
  h.ctx.projectManager.db.updateTabProviderState = () => { throw Error('controlled-disk-failure'); };
  const launch = launchBoundary(h);
  await assert.rejects(launch.run(), /controlled-disk-failure/);
  assert.equal(h.providerStates.get('T').codexFastIntent, undefined);
  assert.equal(launch.lines.length, 0);
  assert.equal(h.notifications.length, 0);
});

test('actual SQLite point writer keeps false and refuses a swallowed failure without fake app intent', () => {
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec('CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,provider_state TEXT); INSERT INTO tabs VALUES (\'T\',NULL);');
    const manager = Object.create(require('./database').prototype); manager.db = sqlite;
    const h = fixture({ desired: null, running: false, ready: false }); h.ctx.projectManager.db = manager;
    h.ctx.persistCodexFastIntentValue('T', false, 'managed-launch');
    assert.equal(JSON.parse(sqlite.prepare('SELECT provider_state FROM tabs WHERE tab_id=?').get('T').provider_state).codexFastIntent, false);
    h.ctx.persistNextCodexFastIntent('T');
    assert.equal(JSON.parse(sqlite.prepare('SELECT provider_state FROM tabs WHERE tab_id=?').get('T').provider_state).codexFastIntent, true);
    const before = h.providerStates.get('T');
    sqlite.exec("CREATE TRIGGER reject_fast BEFORE UPDATE ON tabs BEGIN SELECT RAISE(ABORT,'controlled Fast write failure'); END;");
    assert.throws(() => h.ctx.persistNextCodexFastIntent('T'), /codex_fast_intent_persistence_unconfirmed/);
    assert.equal(h.providerStates.get('T'), before, 'a swallowed disk failure is not a committed newer app choice');
  } finally { sqlite.close(); }
});

test('already-applied native Fast remains observed and is not undone after a persistence failure', async () => {
  const h = fixture({ desired: false });
  h.ctx.projectManager.db.updateTabProviderState = () => {}; // Actual legacy writer may swallow the failure.
  const proof = h.ctx.publishCodexServiceTierProof('T', 'priority', 'tui-service-tier-feedback');
  await h.settle();
  assert.equal(proof.serviceTier, 'priority');
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.providerStates.get('T').codexFastIntentPersistenceError, 'codex_fast_intent_persistence_unconfirmed');
  assert.deepEqual(h.writes, []);
});

test('actual Fast button saves a choice while model/Send presentation is busy, rather than cancelling the spinner', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const bar = fs.readFileSync(process.env.CODEX_FAST_CONTROL_SOURCE
    || path.join(__dirname, '../renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const marker = bar.indexOf('data-agent-setting-trigger="fast"');
  const start = bar.lastIndexOf('<button', marker), end = bar.indexOf('</button>', marker) + '</button>'.length;
  const clickStart = bar.indexOf('  const sendCodexFast = async');
  const clickEnd = bar.indexOf('  const pickProvider =', clickStart);
  const h = fixture({ running: false, ready: false }); let resets = 0;
  const ui = vm.createContext({ React, isCodex: true, tabId: 'T', codexFastDisabled: false,
    settingsWriteBusy: true, fastSpinning: true, codexFastStateLabel: 'Fast OFF', codexFastTitle: 'Fast',
    codexFastModeState: { known: false, intentKnown: true, active: false, pending: true },
    triggerStyle: {}, forceResetBusy: () => { resets++; }, setBusyCancelHover() {},
    ControlBusySpinner: () => null, busyCancelHover: false,
    focusTerminal() {}, console: quiet, adoptProviderState() {}, showToast: value => assert.fail(value),
    ipcRenderer: { invoke: async channel => {
      assert.equal(channel, 'codex:toggle-fast-intent');
      const saved = h.click(); return { success: true, queued: true, ...saved };
    } },
  });
  const compile = source => ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  vm.runInContext(compile(bar.slice(clickStart, clickEnd) + '\nglobalThis.render = () => (' + bar.slice(start, end) + ');'), ui);
  const element = ui.render();
  assert.equal(element.props.disabled, false, 'saving Fast intent is independent of physical model mutation');
  assert.doesNotMatch(renderToStaticMarkup(element), /disabled=""/);
  await element.props.onClick();
  assert.equal(resets, 0, 'a Fast click is not cancellation of unrelated work');
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.writes.length, 0);
});

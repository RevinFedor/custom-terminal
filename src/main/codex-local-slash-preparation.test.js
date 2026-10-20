'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');
const source = process.env.CODEX_LOCAL_SLASH_BASELINE
  ? require('node:child_process').execFileSync('git', ['show', process.env.CODEX_LOCAL_SLASH_BASELINE + ':src/main/main.js'],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  : fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events = new EventEmitter(), writes = [];
  const reservations = [];
  const term = { write: bytes => writes.push(bytes) };
  const state = { runSeq: 1, isRunning: true };
  let input = 1, stopped = false, ready = false, lifecycle = 'G';
  let intent = { model: 'gpt-6-sol', effort: 'max', revision: 5, actionSequence: 2,
    appliedRevision: 4, appliedOwnerId: 'S' };
  const queue = createCodexSettingsMutationQueue();
  const receipt = { original: '/model' };
  queue.rememberUnsubmittedInput(term, receipt);
  const context = vm.createContext({
    ...require('./agent-send-preparation'), agentSendReceiptStore: null,
    codexLastRunCommandPayload: new Map(),
    agentSendCancellations: { isCancelled: () => false },
    ...require('./codex-runtime-contract'), ...require('./codex-model-effort-intent'),
    console: { log() {}, warn() {}, error() {} }, Date, observeAgentInput,
    codexSettingsMutationQueue: queue, codexModelEffortIntentReconcileInflight: new Map(),
    codexReserveResumeGuards: new WeakMap(), codexPickerQueue: new Map(),
    ptyWriteOwners: new WeakMap(), aiStoppingTabs: new Map(),
    pasteInflight: new WeakMap(), ptyActiveWriteOperation: new WeakMap(), ptyLastQueuedWriteOperation: new WeakMap(),
    terminals: new Map([['T', term]]), terminalProjects: new Map([['T', '/fixture']]),
    terminalCommandState: new Map([['T', state]]),
    getTerminalInputRevision: () => input, getTerminalLifecycleGeneration: () => lifecycle,
    getTerminalStopRevision: () => stopped ? 1 : 0,
    findTabIdForTerm: () => 'T',
    captureAgentInputIdentity: () => ({ terminalToken: term, terminalRunSeq: state.runSeq,
      terminalLifecycleGeneration: lifecycle, terminalStopRevision: stopped ? 1 : 0 }),
    assertKnownEmptySend() {}, isLocalSlashCommandPrompt: text => text.startsWith('/'),
    conversationOwners: { noteInput() {} },
    bumpTerminalInputRevision: () => { reservations.push(++input); return input; },
    reserveClaudeExactEmptyEvidence: () => null, getHeadlessTerminalMirror: () => null,
    finishSafePasteAfterWrite: async (_term, _text, _options, _operation, result) => result,
    resolveSafePasteFailureAfterWrite: error => { throw error; },
    settleCodexOwnedModelInput: async () => ({ success: false, error: 'codex_owned_model_input_pending' }),
    _safePasteAndSubmitInner: async (_term, text, options) => {
      writes.push({ text, images: options.presentationSnapshot.imagePaths });
      return { success: true, submitted: true, pasteWritten: true, enterWritten: true };
    },
    getCodexModelEffortIntentRecord: () => intent,
    getCodexWriterProofSnapshot: () => ({ sessionId: 'S' }), getCodexProvisionalSettingsSnapshot: () => null,
    isCodexTuiEffectivelyReady: () => ready,
    codexHasLivePtySubmitEvidence: () => true, hasCodexPromptOrTurnInFlight: () => false,
    isOwnedDesktopHistorySendSource: () => true,
    requestTerminalCodexDraftState: async () => ({ success: true, hasDraft: false }),
    getHeadlessCodexDraftState: () => ({ success: true, hasDraft: false }),
    createCodexPickerDraftCapture: () => ({}), getCurrentCodexServiceTierProofIdentity: () => null,
    captureCodexManualCompactBoundary: () => ({ tabId: 'T', sessionId: 'S' }),
    readCodexManualInputOwner: () => ({}),
    compactOperations: { armPending: r => ({ ...r, operationId: 'C' }) }, cancelCodexManualCompactPending() {},
    sendCodexLiveSlashCommand: async (_term, request) => {
      const proof = request.writeGuard('paste');
      assert.equal(proof.allowed, true);
      writes.push(request.command, 'Enter');
      return { success: true, submitted: true, compactStartConfirmed: true };
    },
    createMainAgentInputObservation() {
      const initial = { input, lifecycle, runSeq: state.runSeq };
      return createAgentInputObservation({ timeoutMs: 120,
        isCurrent: () => !stopped && context.terminals.get('T') === term
          && initial.input === input && initial.lifecycle === lifecycle && initial.runSeq === state.runSeq,
        subscribe: wake => { events.on('change', wake); return () => events.off('change', wake); },
      });
    },
  });
  vm.runInContext(require('./fixtures/codex-draft-request-observation.cjs').startupFrameDeclarations(), context);
  for (const name of ['withPtyWriteLock', 'waitForCodexInputPreparation', 'waitForCodexLocalSlashPreparation',
    'executeCodexLiveSlashCommandRequest', 'safePasteAndSubmit', 'agentSendExecutionFailure']) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (node) vm.runInContext(node.getText(ast), context);
  }
  const wake = () => events.emit('change');
  return { context, term, writes, queue, events, wake, reservations,
    sendImage: () => context.safePasteAndSubmit(term, 'original prompt [Image #1]', {
      source: 'codex-history-panel', handoffId: 'IMAGE', presentationSnapshot: {
        text: 'original prompt [Image #1]', imagePaths: [{ id: 1, path: '/fixture/original.png' }],
      },
    }),
    send: (options = {}) => context.executeCodexLiveSlashCommandRequest({ tabId: 'T', command: '/compact', handoffId: 'H', source: 'history-panel', ...options }),
    async finishSettings() {
      // This must acquire the real serializer while the slash is waiting.
      return context.withPtyWriteLock(term, async () => {
        queue.releaseUnsubmittedInput(term, receipt);
        ready = true; intent = { ...intent, appliedRevision: 5 }; wake();
      });
    },
    change(kind) {
      if (kind === 'input') input++;
      if (kind === 'stop') { stopped = true; context.aiStoppingTabs.set('T', { toolType: 'codex' }); }
      if (kind === 'run') state.runSeq++;
      if (kind === 'lifecycle') lifecycle = 'G2';
      if (kind === 'terminal') context.terminals.set('T', {});
      if (kind === 'intent') intent = { ...intent, revision: 6 };
      if (kind === 'intent-action') intent = { ...intent, actionSequence: 3 };
      wake();
    },
    clearOnly() { queue.releaseUnsubmittedInput(term, receipt); ready = true; wake(); },
  };
}

test('actual /compact joins delayed model preparation outside the PTY lock and submits once', async () => {
  const h = fixture();
  const result = h.send();
  await tick();
  assert.deepEqual(h.writes, []);
  await h.finishSettings();
  assert.equal((await result).success, true);
  assert.deepEqual(h.writes, ['/compact', 'Enter']);
  assert.equal(h.events.listenerCount('change'), 0);
});

test('actual normal Send with image waits outside the writer queue without reserving input, then pastes once', async () => {
  const h = fixture(); const result = h.sendImage(); await tick();
  assert.deepEqual(h.writes, []); assert.deepEqual(h.reservations, []);
  h.clearOnly(); await tick();
  assert.deepEqual(h.writes, []); assert.deepEqual(h.reservations, []);
  await h.finishSettings();
  assert.equal((await result).submitted, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].text, 'original prompt [Image #1]');
  assert.equal(h.writes[0].images[0].path, '/fixture/original.png');
  assert.deepEqual(h.reservations, [2]);
});

for (const kind of ['input', 'stop', 'run', 'lifecycle', 'terminal', 'intent', 'intent-action']) {
  test('normal image Send cancels before reservation and paste after ' + kind, async () => {
    const h = fixture(); const result = h.sendImage(); await tick(); h.change(kind);
    assert.equal((await result).success, false);
    assert.deepEqual(h.writes, []); assert.deepEqual(h.reservations, []);
  });
}

test('normal image Send deadline retains the service receipt and original input', async () => {
  const h = fixture(); const result = await h.sendImage();
  assert.equal(result.submitted, false);
  assert.ok(h.queue.getUnsubmittedInput(h.term));
  assert.deepEqual(h.writes, []); assert.deepEqual(h.reservations, []);
});

for (const type of ['sendImage', 'send']) {
  test(type + ' retains the original settings choice between observation completion and writer reacquisition', async () => {
    const h = fixture(); const observe = h.context.waitForCodexInputPreparation;
    h.context.waitForCodexInputPreparation = async (...args) => {
      const ready = await observe(...args);
      if (ready.success) h.change('intent');
      return ready;
    };
    const result = h[type](); await tick(); await h.finishSettings();
    assert.equal((await result).error, 'codex_settings_intent_changed');
    assert.deepEqual(h.writes, []); assert.deepEqual(h.reservations, []);
  });
}

test('cleared /model alone does not overtake the same pending settings intent', async () => {
  const h = fixture(); const result = h.send(); await tick();
  h.clearOnly(); await tick();
  assert.deepEqual(h.writes, []);
  await h.finishSettings();
  assert.equal((await result).success, true);
  assert.deepEqual(h.writes, ['/compact', 'Enter']);
});

for (const kind of ['input', 'stop', 'run', 'lifecycle', 'terminal', 'intent', 'intent-action']) {
  test('actual pending /compact never writes after ' + kind + ' changes', async () => {
    const h = fixture(); const result = h.send(); await tick(); h.change(kind);
    assert.equal((await result).success, false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.events.listenerCount('change'), 0);
  });
}

test('expiry leaves the original service receipt and never repeats model/compact', async () => {
  const h = fixture(); const result = await h.send();
  assert.equal(result.success, false);
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'codex_local_command_preparation_pending');
  assert.ok(h.queue.getUnsubmittedInput(h.term));
  assert.deepEqual(h.writes, []);
});

test('warm ready local command keeps its immediate path', async () => {
  const h = fixture(); await h.finishSettings();
  assert.equal((await h.send()).success, true);
  assert.deepEqual(h.writes, ['/compact', 'Enter']);
  assert.equal(h.events.listenerCount('change'), 0);
});

test('actual API compact binds the exact durable attempt before any PTY submission and preserves boundary sequence', async t => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = require('./agent-send-receipt-store').createAgentSendReceiptStore(db);
  const h = fixture(); await h.finishSettings();
  const attempt = store.beginAttempt({ operationKey: 'project:T:H', surface: 'project-api',
    tabId: 'T', handoffId: 'H', provider: 'codex', promptHash: 'unused', promptLength: 8,
    requestFingerprint: 'one-request' });
  h.context.agentSendReceiptStore = store;
  h.context.compactOperations = require('./compact-operation-state').createCompactOperationRegistry();
  h.context.captureCodexManualCompactBoundary = () => ({ tabId: 'T', sessionId: 'S',
    generation: 'G', promptSeq: 7, sourceByteOffset: 128, boundaryEventSequence: 10 });
  const sender = h.context.sendCodexLiveSlashCommand;
  h.context.sendCodexLiveSlashCommand = async (...args) => {
    const record = store.get('project:T:H');
    assert.equal(record.receipt.compactOperationOwner.sendAttemptId, attempt.attemptId);
    assert.equal(record.receipt.compactOperationOwner.causalBoundaryEventSequence, 10);
    assert.equal(record.receipt.compactOperationOwner.generation, 'G');
    return sender(...args);
  };
  const result = await h.send({ sendOperationKey: 'project:T:H', sendAttemptId: attempt.attemptId });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(h.writes, ['/compact', 'Enter']);
});

test('failed exact compact receipt binding refuses before slash bytes without starting another executor', async t => {
  const Database = require('better-sqlite3'), db = new Database(':memory:'); t.after(() => db.close());
  const store = require('./agent-send-receipt-store').createAgentSendReceiptStore(db);
  const attempt = store.beginAttempt({ operationKey: 'project:T:H', surface: 'project-api',
    tabId: 'T', handoffId: 'H', provider: 'codex', promptHash: 'unused', promptLength: 8,
    requestFingerprint: 'one-request' });
  const h = fixture(); await h.finishSettings();
  h.context.agentSendReceiptStore = { get: key => store.get(key),
    bindCompactOperation: () => ({ ok: false, reason: 'stale-attempt' }) };
  const result = await h.send({ sendOperationKey: 'project:T:H', sendAttemptId: attempt.attemptId });
  assert.equal(result.error, 'compact_send_receipt_binding_failed');
  assert.equal(result.submitted, false); assert.equal(result.pasteWritten, false);
  assert.equal(result.enterWritten, false); assert.deepEqual(h.writes, []);
});

test('actual settings work, without a retained insertion yet, finishes before compact admission', async () => {
  const h = fixture(); h.clearOnly();
  h.context.codexModelEffortIntentReconcileInflight.set('T', Promise.resolve());
  const result = h.send(); await tick();
  assert.deepEqual(h.writes, []);
  await h.finishSettings();
  await tick(); assert.deepEqual(h.writes, [], 'applied publication alone cannot bypass active settings work');
  h.context.codexModelEffortIntentReconcileInflight.delete('T'); h.wake();
  assert.equal((await result).success, true);
  assert.deepEqual(h.writes, ['/compact', 'Enter']);
});

test('a different tab settings preparation cannot delay this ready compact', async () => {
  const h = fixture(); await h.finishSettings();
  h.context.codexModelEffortIntentReconcileInflight.set('OTHER', new Promise(() => {}));
  assert.equal((await h.send()).success, true);
  assert.deepEqual(h.writes, ['/compact', 'Enter']);
});

test('fresh unknown draft after the wait cannot reuse the earlier empty proof', async () => {
  const h = fixture(); const result = h.send(); await tick();
  h.context.requestTerminalCodexDraftState = async () => ({ success: false, hasDraft: null });
  h.context.getHeadlessCodexDraftState = () => ({ success: false, hasDraft: null });
  await h.finishSettings();
  assert.equal((await result).success, false);
  assert.deepEqual(h.writes, []);
});

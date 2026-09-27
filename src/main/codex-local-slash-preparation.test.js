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
  const term = { write: bytes => writes.push(bytes) };
  const state = { runSeq: 1, isRunning: true };
  let input = 1, stopped = false, ready = false, lifecycle = 'G';
  let intent = { model: 'gpt-6-sol', effort: 'max', revision: 5, actionSequence: 2,
    appliedRevision: 4, appliedOwnerId: 'S' };
  const queue = createCodexSettingsMutationQueue();
  const receipt = { original: '/model' };
  queue.rememberUnsubmittedInput(term, receipt);
  const context = vm.createContext({
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
    getCodexModelEffortIntentRecord: () => intent,
    getCodexWriterProofSnapshot: () => ({ sessionId: 'S' }), getCodexProvisionalSettingsSnapshot: () => null,
    isCodexTuiEffectivelyReady: () => ready,
    codexHasLivePtySubmitEvidence: () => true, hasCodexPromptOrTurnInFlight: () => false,
    isOwnedDesktopHistorySendSource: () => true,
    requestTerminalCodexDraftState: async () => ({ success: true, hasDraft: false }),
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
  for (const name of ['withPtyWriteLock', 'waitForCodexLocalSlashPreparation', 'executeCodexLiveSlashCommandRequest']) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (node) vm.runInContext(node.getText(ast), context);
  }
  const wake = () => events.emit('change');
  return { context, term, writes, queue, events, wake,
    send: () => context.executeCodexLiveSlashCommandRequest({ tabId: 'T', command: '/compact', handoffId: 'H', source: 'history-panel' }),
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
  await h.finishSettings();
  assert.equal((await result).success, false);
  assert.deepEqual(h.writes, []);
});

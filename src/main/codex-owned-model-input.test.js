'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');
const picker = require('./codex-model-picker');
const { codexNativeDraftTransfer } = require('./codex-draft-preservation');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const names = ['withPtyWriteLock', 'captureCodexOwnedSlashDraftIdentity', 'validateCodexOwnedSlashDraftIdentity',
  'releaseCodexOwnedModelInput', 'validateCodexOwnedModelInputIdentity', 'readCodexOwnedModelInputDecision', 'reconcileCodexOwnedModelInputAtWriteBoundary',
  'settleCodexOwnedModelInput', 'waitForCodexOwnedModelPaste', 'retainCodexOwnedModelInput', 'inspectCodexOwnedSlashDraft',
  'rollbackCodexOwnedSlashDraft', 'sendCodexSlashCommand', 'captureAgentInputAtWriteBoundary', 'selectCodexModelEffort',
  'safePasteAndSubmit', 'getCodexLiveInputControl', 'waitForCodexInputPreparation'];
const tick = () => new Promise(r => setImmediate(r));

function harness({ frameTimedOut = true, synchronousClear = true } = {}) {
  const writes = [], wakes = [];
  let inputRevision = 1, stopRevision = 0, run = 2, lifecycle = 'G:2';
  let proof;
  const mirror = { generation: 'M', writeSeq: 10, synchronizedFrameWaiters: new Set(),
    terminal: { buffer: { active: { baseY: 0, cursorY: 3 } } } };
  const events = new EventEmitter();
  const frame = (text, seq = mirror.writeSeq + 1, hasDraft = !!text) => {
    mirror.writeSeq = seq;
    proof = { success: true, hasDraft, preview: text, source: 'headless-main:cursor:3',
      frameIdentity: { generation: mirror.generation, writeSeq: seq } };
    for (const callback of [...mirror.synchronizedFrameWaiters]) callback();
  };
  frame('', 10);
  const term = { write(data) {
    writes.push(data);
    if (data === '\x01\x0b' && synchronousClear) frame('');
    if (!frameTimedOut && data.includes('\x1b[200~/model')) frame('/model');
  } };
  const ctx = vm.createContext({ ...picker, codexNativeDraftTransfer, observeAgentInput,
    console: { log() {}, warn() {} }, queueMicrotask, setTimeout, clearTimeout,
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { isRunning: true, runSeq: run }]]),
    aiStoppingTabs: new Map(), codexLastRunCommandPayload: new Map([['T', { launchId: 'L' }]]),
    codexSettingsMutationQueue: createCodexSettingsMutationQueue(),
    codexModelEffortIntentReconcileInflight: new Map(), codexReserveResumeGuards: new WeakMap(),
    getCodexModelEffortIntentRecord: () => null, isCodexTuiEffectivelyReady: () => false,
    pasteInflight: new WeakMap(), ptyActiveWriteOperation: new WeakMap(),
    ptyLastQueuedWriteOperation: new WeakMap(), ptyWriteOwners: new WeakMap(),
    getTerminalInputRevision: () => inputRevision, getTerminalStopRevision: () => stopRevision,
    getTerminalLifecycleGeneration: () => lifecycle, getHeadlessTerminalMirror: () => mirror,
    getHeadlessCodexDraftState: () => proof, recordComposerForensicPtyInput() {},
    getCodexWriterProofSnapshot: () => null, getCodexProvisionalSettingsSnapshot: () => null,
    ipcMain: events, scheduleCodexModelEffortIntentReconcile: (...args) => wakes.push(args),
    emitAgentReadinessChanged: (_tabId, event) => events.emit('agent:readiness-changed-internal', null, { tabId: 'T', ...event }),
    hasCodexEstablishedComposerLifecycle: () => true, codexTuiReadyMeta: new Map(), codexTuiReadyTabs: new Set(['T']),
    codexLateMcpProofPending: new Map(), codexRuntimePolicies: null,
    codexInputControlFromCommittedSnapshot: () => null,
    findTabIdForTerm: () => 'T', captureAgentInputIdentity: () => ({}), agentSendExecutionFailure: () => null,
    assertKnownEmptySend() {}, isLocalSlashCommandPrompt: () => false, conversationOwners: { noteInput() {} },
    bumpTerminalInputRevision: () => { inputRevision++; events.emit('agent:input-owner-changed-internal', null, { tabId: 'T' }); return inputRevision; },
    reserveClaudeExactEmptyEvidence: () => null,
    _safePasteAndSubmitInner: () => { throw new Error('pending service input must not reach prompt paste'); },
    finishSafePasteAfterWrite: async (_term, _content, _options, _op, result) => result,
    resolveSafePasteFailureAfterWrite: error => { throw error; },
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~', CODEX_SYNC_MARKER: '\x1b[?2026l',
    readCodexPickerWriteRefusal: () => null,
    captureCodexFrame: async () => ({ timedOut: frameTimedOut, raw: '', clean: '' }),
    createMainAgentInputObservation() {
      const identity = { inputRevision, stopRevision, lifecycle };
      return createAgentInputObservation({ timeoutMs: 20,
        isCurrent: () => identity.inputRevision === inputRevision && identity.stopRevision === stopRevision && identity.lifecycle === lifecycle,
        subscribe(wake) { mirror.synchronizedFrameWaiters.add(wake); return () => mirror.synchronizedFrameWaiters.delete(wake); },
      });
    },
  });
  vm.runInContext(names.map(declaration).join('\n'), ctx);
  return { ctx, term, writes, wakes, mirror, frame,
    get receipt() { return ctx.codexSettingsMutationQueue.getUnsubmittedInput(term); },
    async expire() { return ctx.withPtyWriteLock(term, () => ctx.sendCodexSlashCommand(term, '/model', '[test]', {
      tabId: 'T', readDraftState: async () => proof, writeGuard: () => ({ allowed: true }),
    }), { manualInputYields: true }); },
    change(kind) {
      if (kind === 'input') inputRevision++;
      if (kind === 'stop') { stopRevision++; ctx.aiStoppingTabs.set('T', {}); }
      if (kind === 'terminal') ctx.terminals.set('T', { write: () => assert.fail('foreign write') });
      if (kind === 'run') ctx.terminalCommandState.get('T').runSeq = ++run;
      if (kind === 'lifecycle') lifecycle = 'G:3';
      if (kind === 'mirror') mirror.generation = 'M2';
      if (kind === 'launch') ctx.codexLastRunCommandPayload.set('T', { launchId: 'L2' });
      events.emit('agent:input-owner-changed-internal', null, { tabId: 'T' });
    },
  };
}

test('actual timeout retains its insertion; a late exact frame clears only /model without Enter/Ctrl+C/Ctrl+G', async () => {
  const h = harness();
  const result = await h.expire();
  assert.equal(result.submitted, false);
  assert.ok(h.receipt, 'caller expiry is not abandonment of the written service command');
  assert.equal(h.ctx.getCodexLiveInputControl('T'), 'owned-model-input', 'shared readiness must not present a foreign draft/ready Send');
  assert.equal(h.writes.length, 1);
  h.frame('/model');
  await tick(); await tick();
  assert.deepEqual(h.writes, ['\x01\x0b\x1b[200~/model\x1b[201~', '\x01\x0b']);
  assert.equal(h.receipt, null);
  assert.equal(h.ctx.getCodexLiveInputControl('T'), null);
  assert.equal(h.wakes.length, 1, 'the existing intent owner wakes once, not the failed picker');
  assert.equal(h.mirror.synchronizedFrameWaiters.size, 0);
});

test('newer frame must prove clear; elapsed time and old empty frame do not retire ownership', async () => {
  const h = harness({ synchronousClear: false });
  await h.expire();
  h.frame('/model', 10); await tick();
  assert.equal(h.writes.length, 1, 'baseline/stale text is not an echo');
  h.frame('/model', 11); await tick();
  assert.equal(h.writes.length, 2);
  h.frame('', 11); await tick();
  assert.ok(h.receipt, 'clear is not confirmed by a same-sequence empty sample');
  h.frame('', 12); await tick(); await tick();
  assert.equal(h.receipt, null);
});

test('manual input, Stop, run and terminal replacement revoke old cleanup', async () => {
  for (const kind of ['input', 'stop', 'terminal', 'run', 'lifecycle']) {
    const h = harness(); await h.expire(); h.change(kind); h.frame('/model'); await tick();
    assert.equal(h.writes.length, 1, kind);
    assert.equal(h.receipt, null, kind);
    assert.equal(h.wakes.length, 0, kind);
  }
});

test('lost mirror/launch observation never turns the retained service insertion into a user draft', async () => {
  for (const kind of ['mirror', 'launch']) {
    const h = harness(); await h.expire(); h.change(kind); h.frame('/model'); await tick();
    assert.equal(h.writes.length, 1);
    assert.ok(h.receipt);
    assert.equal(h.ctx.getCodexLiveInputControl('T'), 'owned-model-input');
    const capture = await h.ctx.captureAgentInputAtWriteBoundary('T', 'copy', 'codex', {}, h.term);
    assert.equal(capture.error, 'codex_owned_model_input_pending');
    assert.equal(h.writes.length, 1);
    h.change('input');
    assert.equal(h.receipt, null);
  }
});

test('a queued recovery for an old receipt cannot clear the next identical command', async () => {
  const h = harness(); await h.expire();
  const old = h.receipt;
  h.change('input'); await h.expire();
  const current = h.receipt;
  h.ctx.getHeadlessCodexDraftState = () => ({ success: true, hasDraft: true, preview: '/model', source: 'headless-main:cursor:3',
    frameIdentity: { generation: 'M', writeSeq: 99 } });
  const before = h.writes.length;
  const stale = h.ctx.reconcileCodexOwnedModelInputAtWriteBoundary('T', h.term, old);
  assert.equal(stale.error, 'codex_owned_model_input_changed');
  assert.equal(h.writes.length, before);
  assert.equal(h.receipt, current);
  h.change('input');
});

test('a background/viewport match or an active policy dialog cannot authorize editing keys', async () => {
  for (const blocker of ['viewport', 'wrong-cursor-row', 'policy', 'late-mcp', 'not-ready']) {
    const h = harness(); await h.expire();
    if (blocker === 'policy') h.ctx.codexRuntimePolicies = { read: () => ({ phase: 'waiting-user' }) };
    if (blocker === 'late-mcp') h.ctx.codexLateMcpProofPending.set('T', {});
    if (blocker === 'not-ready') h.ctx.codexTuiReadyTabs.delete('T');
    if (blocker === 'wrong-cursor-row') h.mirror.terminal.buffer.active.baseY = 100;
    if (blocker === 'viewport') h.ctx.getHeadlessCodexDraftState = () => ({ success: true,
      hasDraft: true, preview: '/model', source: 'headless-main:viewport:3',
      frameIdentity: { generation: 'M', writeSeq: 99 } });
    h.frame('/model'); await tick();
    assert.equal(h.writes.length, 1, blocker);
    assert.ok(h.receipt, blocker);
    h.change('input');
  }
});

test('consumed startup payload can hand off only to the exact same proven launch, never a saved SID', async () => {
  for (const exact of [true, false]) {
    const h = harness(); await h.expire();
    h.ctx.codexLastRunCommandPayload.delete('T');
    h.ctx.getCodexWriterProofSnapshot = () => ({ terminalToken: h.term, runSeq: 2,
      lifecycleGeneration: 'G:2', launchId: exact ? 'L' : 'other' });
    h.frame('/model'); await tick(); await tick();
    assert.equal(h.writes.length, exact ? 2 : 1);
    if (exact) assert.equal(h.receipt, null);
    else { assert.ok(h.receipt); h.change('input'); }
  }
});

test('unknown, changed or incomplete draft does not authorize cleanup or another editor capture', async () => {
  const h = harness(); await h.expire();
  h.frame('/model extra', 11); await tick();
  h.frame('', 12, null); await tick();
  const capture = await h.ctx.captureAgentInputAtWriteBoundary('T', 'copy', 'codex', {}, h.term);
  assert.equal(capture.error, 'codex_owned_model_input_pending');
  assert.equal(h.writes.length, 1, 'no Ctrl+G reaches the uncertain service input');
  h.change('input');
});

test('actual Send wrapper cannot erase pending service ownership by reserving a new input revision', async () => {
  const h = harness(); await h.expire();
  const receipt = h.receipt;
  const result = await h.ctx.safePasteAndSubmit(h.term, 'USER PROMPT', { source: 'codex-history-panel' });
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'codex_local_command_preparation_pending');
  assert.equal(h.receipt, receipt);
  assert.equal(h.writes.length, 1);
  h.change('input');
});

test('normal successful slash writes one Enter and does not leave a cleanup receipt', async () => {
  const h = harness({ frameTimedOut: false });
  const result = await h.expire();
  assert.equal(result.success, true);
  assert.equal(h.writes.at(-1), '\r');
  assert.equal(h.receipt, null);
  h.frame('/model'); await tick();
  assert.equal(h.writes.length, 2, 'a submitted slash is never cleared or resent by the old receipt');
});

test('busy unrelated renders cannot acknowledge /model; only its fresh exact composer does', async () => {
  const h = harness();
  const pending = h.expire();
  await tick();
  h.frame('', 11); await tick();
  assert.equal(h.writes.includes('\r'), false);
  h.frame('/model', 12);
  const result = await pending;
  assert.equal(result.success, true);
  assert.deepEqual(h.writes, ['\x01\x0b\x1b[200~/model\x1b[201~', '\r']);
});

test('actual model-picker finally transfers only the captured user draft; no ArrowUp over pending service input', async () => {
  const h = harness();
  const snapshot = { text: 'USER TEXT [Image #1]', captureOperationId: 'C', images: 1,
    imagePaths: [{ id: 1, path: '/fixture/image.png', assetId: 'image' }] };
  h.ctx.stashCodexDraftForPicker = async () => ({ success: true, draftSnapshot: snapshot });
  h.ctx.restoreCodexDraftAfterPicker = () => assert.fail('unsettled /model is not a safe native restoration surface');
  const result = await h.ctx.withPtyWriteLock(h.term, () => h.ctx.selectCodexModelEffort(h.term, {
    tabId: 'T', model: 'gpt-6-sol', effort: 'max', hasDraft: true, readDraftState: async () => ({ success: true, hasDraft: false }),
  }));
  assert.equal(result.success, false);
  assert.equal(result.draftTransfer.text, snapshot.text);
  assert.equal(result.draftTransfer.imagePaths[0].assetId, 'image');
  assert.equal(result.serviceInputPending, true);
  assert.equal(h.writes.length, 1);
  h.change('input');
});

test('all shared write boundaries resolve retained service input before treating it as authoring', () => {
  const capture = declaration('captureAgentInputAtWriteBoundary');
  assert.ok(capture.indexOf('settleCodexOwnedModelInput') < capture.indexOf('resolveAgentInputProcess'));
  const send = declaration('_safePasteAndSubmitInner');
  assert.ok(send.indexOf('settleCodexOwnedModelInput') < send.indexOf('beginCodexPromptInFlight'));
  const picker = declaration('executeCodexSelectModelEffortRequest');
  assert.ok(picker.indexOf('settleCodexOwnedModelInput') < picker.indexOf('requestTerminalCodexDraftState'));
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { actualFunction, createFakeClock, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');
const { createAgentSendCancellationRegistry } = require('./agent-send-cancellation');

const declarations = [
  'getTerminalStopRevision', 'getTerminalInputRevision', 'bumpTerminalInputRevision',
  'captureAgentInputIdentity', 'validateAgentInputIdentity', 'agentInputObservationOwner',
  'createMainAgentInputObservation', 'agentDraftObservationResult', 'decorateAgentDraftProofIdentity',
  'agentSendExecutionFailure', 'agentDraftProofMatchesCaptureIdentity',
  'exactClaudeEmptyEvidenceStillCurrent', 'exactClaudeStartupComposerRead',
  'markAiStopping', 'clearAiStopping', 'disposeHeadlessTerminalMirror',
  'parseClaudeDraftFromVisibleSnapshot', 'readCurrentClaudeDraftState', 'claudeDraftProofIsSettled',
  'requestTerminalClaudeDraftState', 'waitForTerminalClaudeDraftState', 'requestTerminalCodexDraftState',
].map(actualFunction).join('\n');

function harness() {
  const tabId = 'owned-observation-tab';
  const term = { pid: 7, write: () => assert.fail('read-only adapter must not write') };
  const mirror = { generation: 'mirror-A', generationOrdinal: 1, complete: true,
    writeSeq: 31, flushedSeq: 31, synchronizedFrameWaiters: new Set(),
    redrawTrace: { synchronizedOutputOpen: false }, terminal: { dispose() {} } };
  const clock = createFakeClock();
  const ipcMain = new EventEmitter();
  const mirrors = new Map([[tabId, mirror]]);
  let content = '';
  let readCount = 0;
  let flushImpl = async () => ({ success: true });
  const c = vm.createContext({
    ...require('./codex-draft-authority'),
    ...require('./claude-composer-proof'),
    ...require('./claude-trust-folder-state'),
    ...require('./claude-auto-mode-default-prompt'),
    ...require('../shared/agent-input-observation.cjs'),
    console: { log() {}, warn() {}, error() {} },
    Date: { now: clock.now }, setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    crypto: require('node:crypto'), ipcMain, HEADLESS_XTERM_FLUSH_TIMEOUT_MS: 900,
    terminals: new Map([[tabId, term]]), terminalHeadlessMirrors: mirrors,
    terminalCommandState: new Map([[tabId, { runSeq: 1 }]]),
    terminalInputRevisions: new Map([[tabId, 5]]), terminalStopRevisions: new WeakMap(),
    aiStoppingTabs: new Map(), agentSendCancellations: createAgentSendCancellationRegistry(),
    mainWindow: null, codexCapacityRetryRuntime: null, codexManualQueueInterrupts: new Map(),
    terminalHistoryPreviewController: { clear() {} },
    claudeTrustFolderPromptHintTabs: new Set(), claudeAutoModeDefaultPromptHintTabs: new Set(),
    getTerminalLifecycleGeneration: () => 'lifecycle-A',
    getHeadlessTerminalMirror: () => mirrors.get(tabId) || null,
    hasLiveClaudeInTab: () => true,
    resolveAiToolTypeForTab: (_id, type) => type,
    getAiRuntimeSessionId: () => 'session-A',
    revokeCodexActionAuthoritiesForTab() {}, invalidateCodexExitObservers() {}, broadcastAiRuntimeStatus() {},
    emitAgentReadinessChanged: (_id, event) => ipcMain.emit('agent:readiness-changed-internal', null, { tabId, ...event }),
    classifyClaudeMissingPromptCaptureForTab: () => ({ recommended: false, reason: 'fixture-not-needed' }),
    agentSendTestFaultActive: () => false, codexDraftUnknownTestFaultConsumed: false, codexTurnWatchers: new Map(),
    reportTerminalIncident: () => null,
    createAgentInputObservation: options => createAgentInputObservation({ ...options,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }),
    observeAgentInput,
    flushHeadlessTerminalMirror: (...args) => flushImpl(...args),
    getHeadlessVisibleBufferSnapshot: (_id, _reason, options) => {
      assert.equal(options.preferCommitted, false, 'current frame, not retained old empty');
      readCount++;
      const m = mirrors.get(tabId);
      if (!m || !m.complete) return { success: false, source: 'headless-main', error: 'no-complete-mirror' };
      const prompt = content === null ? 'not a composer' : content ? '❯ ' + content : '❯ ';
      return { success: true, source: 'headless-main', mirrorGeneration: m.generation,
        writeSeq: m.writeSeq, flushedSeq: m.flushedSeq,
        synchronizedOutputOpen: m.redrawTrace.synchronizedOutputOpen,
        baseY: 0, cursorY: 2, cursorX: content ? prompt.length : 2,
        lines: [ { row: 0, text: 'answer' }, { row: 1, text: '────────────' },
          { row: 2, text: prompt, wrapped: false, occupiedEndX: prompt.length,
            promptSuffixAllDim: content === '' }, { row: 3, text: '' } ] };
    },
    getHeadlessCodexDraftState: () => {
      readCount++;
      const m = mirrors.get(tabId);
      const frameBlocker = c.getCodexDraftFrameBlocker({
        synchronizedOutputOpen: m?.redrawTrace.synchronizedOutputOpen,
        writeSeq: m?.writeSeq, flushedSeq: m?.flushedSeq });
      return { success: true, hasDraft: frameBlocker || content === null ? null : !!content,
        source: 'headless-main', preview: content || '', frameBlocker,
        frameIdentity: { generation: m?.generation, writeSeq: m?.flushedSeq } };
    },
  });
  vm.runInContext(declarations, c);
  return { c, tabId, term, mirror, mirrors, clock, ipcMain,
    reads: () => readCount,
    content: value => { content = value; },
    flush: value => { flushImpl = value; },
    wake: () => { for (const notify of [...mirror.synchronizedFrameWaiters]) notify(); },
    read(provider, options = {}) {
      return provider === 'claude'
        ? c.waitForTerminalClaudeDraftState(null, tabId, 'fixture', 100,
          { waitOnUnknownOnly: true, waitTimeoutMs: 500, ...options })
        : c.requestTerminalCodexDraftState(null, tabId, 'fixture', 100,
          { waitFor: false, waitOnUnknownOnly: true, waitTimeoutMs: 500, ...options });
    },
    stopAndClear(provider = 'claude') {
      c.markAiStopping(tabId, provider, 'fixture-stop');
      c.clearAiStopping(tabId, 'fixture-stop-settled');
    },
    clean() {
      assert.equal(mirror.synchronizedFrameWaiters.size, 0);
      assert.equal(ipcMain.listenerCount('agent:input-owner-changed-internal'), 0);
      assert.equal(ipcMain.listenerCount('agent:readiness-changed-internal'), 0);
      assert.equal(clock.timers.size, 0);
    },
  };
}

for (const provider of ['claude', 'codex']) {
  test(provider + ': actual main adapter works with no renderer and preserves original proof fields', async () => {
    const h = harness();
    if (provider === 'claude') {
      const initial = h.c.readCurrentClaudeDraftState(h.tabId, 'initial', h.c.captureAgentInputIdentity(h.tabId, h.term));
      assert.equal(initial.hasDraft, false, JSON.stringify(initial));
    }
    const result = await h.read(provider);
    assert.equal(result.hasDraft, false, JSON.stringify(result));
    assert.equal(result.observation.status, 'settled');
    assert.equal(result.inputRevision, 5);
    assert.equal(result.terminalStopRevision, 0);
    assert.equal(result.mirrorWriteSeq, 31);
    assert.equal(h.c.decorateAgentDraftProofIdentity(h.tabId, result), result);
    h.clean();
  });

  test(provider + ': Stop begins and clears while flush is pending; late empty cannot revive read', async () => {
    const h = harness();
    let finishFlush;
    h.flush(() => new Promise(resolve => { finishFlush = resolve; }));
    const read = h.read(provider);
    await drainMicrotasks();
    assert.equal(typeof finishFlush, 'function');
    h.stopAndClear(provider);
    assert.equal(h.c.aiStoppingTabs.size, 0, 'ABA: stopping boolean is already clear');
    const result = await read;
    assert.equal(result.hasDraft, null);
    assert.equal(result.observation.status, 'superseded');
    assert.equal(h.c.getTerminalStopRevision(h.tabId), 1);
    finishFlush({ success: true });
    await drainMicrotasks();
    assert.equal(h.reads(), 0, 'late flush cannot read, publish or renew a stopped operation');
    h.clean();
  });

  test(provider + ': ready event is only a wake; current parsed frame closes the read', async () => {
    const h = harness();
    h.mirror.redrawTrace.synchronizedOutputOpen = true;
    const read = h.read(provider);
    let settled = false;
    read.then(() => { settled = true; });
    await drainMicrotasks(30);
    for (const status of ['active', 'inactive', 'stopping']) {
      h.ipcMain.emit('agent:readiness-changed-internal', null, { tabId: h.tabId, status, inputReady: true });
    }
    await drainMicrotasks(30);
    assert.equal(settled, false);
    h.mirror.redrawTrace.synchronizedOutputOpen = false;
    h.mirror.writeSeq = h.mirror.flushedSeq = 67;
    h.wake();
    const result = await read;
    assert.equal(result.hasDraft, false, JSON.stringify(result));
    assert.equal(result.mirrorWriteSeq, 67);
    assert.equal(h.clock.setCalls.filter(call => call.delayMs === 500).length, 1);
    h.clean();
  });

  test(provider + ': actual input revision and mirror disposal wake the owner, not just its clock', async () => {
    for (const change of ['input', 'dispose']) {
      const h = harness();
      h.content(null);
      const read = h.read(provider);
      await drainMicrotasks(30);
      if (change === 'input') h.c.bumpTerminalInputRevision(h.tabId);
      else h.c.disposeHeadlessTerminalMirror(h.tabId, 'fixture-dispose');
      const result = await read;
      assert.equal(result.hasDraft, null);
      assert.equal(result.observation.status, 'superseded');
      assert.equal(h.clock.now(), 1000);
      h.clean();
    }
  });

  test(provider + ': an exact cancelled attempt ends observation; foreign cancellation is irrelevant', async () => {
    const h = harness();
    h.content(null);
    const read = h.read(provider, { handoffId: 'handoff-A', attemptId: 'attempt-A' });
    let settled = false;
    read.then(() => { settled = true; });
    await drainMicrotasks(30);
    h.c.agentSendCancellations.cancel(h.tabId, 'handoff-A', { attemptId: 'foreign' });
    await drainMicrotasks();
    assert.equal(settled, false);
    h.c.agentSendCancellations.cancel(h.tabId, 'handoff-A', { attemptId: 'attempt-A' });
    const result = await read;
    assert.equal(result.hasDraft, null);
    assert.equal(result.observation.status, 'cancelled');
    h.clean();
  });
}

test('publication cannot stamp an old empty with current input or Stop identity', async () => {
  for (const change of ['input', 'stop']) {
    const h = harness();
    const old = await h.read('claude');
    if (change === 'input') h.c.bumpTerminalInputRevision(h.tabId);
    else h.stopAndClear();
    const published = h.c.decorateAgentDraftProofIdentity(h.tabId, old);
    assert.equal(published.hasDraft, null);
    assert.equal(published.observation.status, 'superseded');
    assert.equal(published.observation.owner.inputRevision, 5, 'keeps old scope for diagnosis, never relabels');
    assert.equal(h.c.agentDraftProofMatchesCaptureIdentity(published,
      h.c.captureAgentInputIdentity(h.tabId, h.term)), false);
  }
});

test('Claude one deadline includes late flushes; a current sync final read preserves exact-capture recommendation', async () => {
  const h = harness();
  h.content(null);
  h.c.classifyClaudeMissingPromptCaptureForTab = () => ({ recommended: true, reason: 'exact-idle-startup-owner' });
  const read = h.read('claude');
  await drainMicrotasks(30);
  h.clock.advance(450);
  h.flush(() => new Promise(() => {}));
  h.wake();
  await drainMicrotasks();
  h.clock.advance(50);
  const result = await read;
  assert.equal(result.hasDraft, null);
  assert.equal(result.observation.status, 'expired');
  assert.equal(result.observation.elapsedMs, 500);
  assert.equal(result.exactCaptureRecommended, true, 'deadline does not disable the existing exact-capture capability');
  assert.equal(result.exactCaptureAdmissionReason, 'exact-idle-startup-owner');
  h.clean();
});

test('execution fence rejects Stop ABA and foreign process, but allows own input reservation/capture', () => {
  const h = harness();
  const identity = h.c.captureAgentInputIdentity(h.tabId, h.term);
  h.c.bumpTerminalInputRevision(h.tabId);
  assert.equal(h.c.agentSendExecutionFailure(h.tabId, h.term, identity), null);
  h.stopAndClear();
  const failure = h.c.agentSendExecutionFailure(h.tabId, h.term, identity,
    { stage: 'before-enter', pasteWritten: true });
  assert.equal(failure.code, 'agent_send_execution_superseded');
  assert.equal(failure.pasteWritten, true);
  assert.equal(failure.submitted, false);
  const afterStop = h.c.captureAgentInputIdentity(h.tabId, h.term);
  h.c.terminals.set(h.tabId, { ...h.term });
  assert.equal(h.c.agentSendExecutionFailure(h.tabId, h.term, afterStop).submitted, false);
});

test('main capture identity treats legacy missing Stop revision as zero only, never a later Stop', () => {
  const h = harness();
  const current = h.c.captureAgentInputIdentity(h.tabId, h.term);
  const legacy = { ...current };
  delete legacy.terminalStopRevision;
  assert.equal(h.c.agentDraftProofMatchesCaptureIdentity(legacy, current), true);
  h.stopAndClear();
  const next = h.c.captureAgentInputIdentity(h.tabId, h.term);
  assert.equal(h.c.agentDraftProofMatchesCaptureIdentity(legacy, next), false);
  assert.equal(h.c.agentDraftProofMatchesCaptureIdentity(current, next), false);
  assert.equal(h.c.agentDraftProofMatchesCaptureIdentity(next, next), true);
});

test('startup exact-empty cannot outlive Stop while awaiting its editor-return lease', async () => {
  const h = harness();
  const captured = { ...h.c.captureAgentInputIdentity(h.tabId, h.term), success: true,
    proofOutcome: 'absent', text: '', images: 0, terminalIdentityStable: true, editorReturnReady: true };
  h.c.captureAgentInput = async () => captured;
  let finishLease;
  h.c.claudePromptStability = {
    wait: () => new Promise(resolve => { finishLease = resolve; }), validate: () => ({ valid: true }),
  };
  const read = h.c.exactClaudeStartupComposerRead(h.tabId, 'launch-A', {}, {});
  await drainMicrotasks();
  h.stopAndClear();
  finishLease({ ready: true, lease: {} });
  const result = await read;
  assert.equal(result.ready, false);
  assert.equal(result.retryAdmission, false);
  assert.equal(h.c.exactClaudeEmptyEvidenceStillCurrent(h.tabId, {
    ...captured, terminalStopRevision: 1 }), true, 'newly captured proof is usable after Stop');
});

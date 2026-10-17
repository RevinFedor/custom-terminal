'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { actualFunction, startupFrameDeclarations, createFakeClock, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');
const { createAgentSendCancellationRegistry } = require('./agent-send-cancellation');

const declarations = [
  'getTerminalStopRevision', 'getTerminalInputRevision', 'bumpTerminalInputRevision',
  'captureAgentLaunchFence',
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
    terminalLifecycleEpochs: new WeakMap([[term, 'fixture-terminal']]),
    terminalLaunchFenceOrders: new WeakMap(), nextTerminalLaunchFenceOrder: 0,
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
    broadcastAgentLaunchFenceRevoked() {},
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
  vm.runInContext(startupFrameDeclarations() + '\n' + declarations, c);
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

function startupFrameHarness() {
  const h = harness();
  h.clock.advance(10000);
  Object.assign(h.c, { ...require('./codex-runtime-contract'), CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000,
    codexLastRunCommandPayload: new Map([[h.tabId, { launchId: 'L', terminalToken: h.term,
      lifecycleGeneration: 'lifecycle-A', runSeq: 1, startedAt: 1 }]]) });
  h.c.terminalCommandState.get(h.tabId).isRunning = true;
  h.mirror.redrawTrace.synchronizedOutputOpen = true;
  h.readStartup = () => h.c.requestTerminalCodexDraftState(null, h.tabId,
    'agent-send-preflight:history-panel', 700, { waitFor: false, waitOnUnknownOnly: true, waitTimeoutMs: 2500 });
  return h;
}

// Exercise the actual final pre-paste call site, not another copy of the
// public/preflight reason string (that missed the cold174 production gap).
function readPhysicalBeforePaste(h) {
  const source = actualFunction('_safePasteAndSubmitInner');
  const start = source.indexOf('const beforeDraft = await requestTerminalCodexDraftState(');
  const end = source.indexOf('const afterDraftProbeInputRevision', start);
  assert.ok(start > 0 && end > start);
  Object.assign(h.c, { broadcastTabId: h.tabId, handoffId: 'H', sendAttemptId: 'A',
    exactSendCancellationRequested: () => false,
    codexStartupFrameWait: h.c.captureCodexSendStartupFrameWait(h.tabId), options: {} });
  return vm.runInContext('(async () => { ' + source.slice(start, end) + ' return beforeDraft; })()', h.c);
}

test('actual final paste guard retains cold launch budget after common preflight already observed empty', async () => {
  const h = startupFrameHarness(); h.mirror.redrawTrace.synchronizedOutputOpen = false;
  assert.equal((await h.readStartup()).hasDraft, false);
  h.clock.advance(100); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  let settled = false; const pending = readPhysicalBeforePaste(h).then(r => { settled = true; return r; });
  await drainMicrotasks(); const reads = h.reads();
  h.clock.advance(5500); await drainMicrotasks();
  assert.equal(settled, false, 'the last guard must not fall back to 2500ms during the SAME startup');
  assert.equal(h.reads(), reads, 'elapsed time cannot poll or manufacture an empty frame');
  h.mirror.redrawTrace.synchronizedOutputOpen = false; h.mirror.writeSeq++; h.mirror.flushedSeq++;
  h.wake(); assert.equal((await pending).hasDraft, false); h.clean();
});

test('actual final paste guard near expiry uses the remaining original deadline, not a fresh 2500ms', async () => {
  const h = startupFrameHarness(); h.clock.advance(48001);
  const pending = readPhysicalBeforePaste(h); await drainMicrotasks();
  assert.deepEqual([...h.clock.timers.values()].map(t => t.dueAt), [60001]);
  h.clock.advance(1000); const result = await pending;
  assert.equal(result.hasDraft, null); assert.equal(result.observation.status, 'expired'); h.clean();
});

for (const change of ['stop', 'input', 'mirror', 'cancel', 'user-draft', 'missing-close']) {
  test('actual final cold paste guard preserves ' + change, async () => {
    const h = startupFrameHarness(); const pending = readPhysicalBeforePaste(h); await drainMicrotasks();
    if (change === 'stop') h.stopAndClear('codex');
    if (change === 'input') h.c.bumpTerminalInputRevision(h.tabId);
    if (change === 'mirror') h.mirrors.set(h.tabId, { ...h.mirror, generation: 'replacement' });
    if (change === 'cancel') h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'A' });
    if (change === 'user-draft') { h.content('real user text'); h.mirror.redrawTrace.synchronizedOutputOpen = false; }
    if (change === 'missing-close') h.clock.advance(50001);
    h.wake(); const result = await pending;
    if (change === 'user-draft') assert.equal(result.hasDraft, true);
    else { assert.equal(result.hasDraft, null); assert.ok(['expired', 'cancelled', 'superseded'].includes(result.observation.status)); }
    h.clean();
  });
}

for (const change of ['expired', 'foreign-terminal', 'foreign-generation', 'foreign-run', 'post-paste']) {
  test('final guard does not borrow a startup budget for ' + change, async () => {
    const h = startupFrameHarness(), launch = h.c.codexLastRunCommandPayload.get(h.tabId);
    if (change === 'expired') h.clock.advance(60001);
    if (change === 'foreign-terminal') launch.terminalToken = {};
    if (change === 'foreign-generation') launch.lifecycleGeneration = 'other';
    if (change === 'foreign-run') launch.runSeq++;
    const pending = change === 'post-paste'
      ? h.c.requestTerminalCodexDraftState(null, h.tabId, 'codex-post-submit', 700,
        { waitFor: false, waitOnUnknownOnly: true, waitTimeoutMs: 2500 })
      : readPhysicalBeforePaste(h);
    await drainMicrotasks(); h.clock.advance(2500); const result = await pending;
    assert.equal(result.observation.budgetMs, 2500); assert.equal(result.hasDraft, null); h.clean();
  });
}

test('cold Send waits for committed first frame under the original Main launch deadline, without polling/input', async () => {
  const h = startupFrameHarness(); let settled = false;
  const pending = h.readStartup().then(value => { settled = true; return value; });
  await drainMicrotasks(); const reads = h.reads();
  h.clock.advance(5500); await drainMicrotasks();
  assert.equal(settled, false, '2500ms probe expiry must not truncate an active startup owner');
  assert.equal(h.reads(), reads, 'elapsed time is not a polling wake');
  h.mirror.redrawTrace.synchronizedOutputOpen = false; h.mirror.writeSeq++; h.mirror.flushedSeq++;
  h.wake(); const result = await pending; assert.equal(result.hasDraft, false); h.clean();
});

test('cold frame opening during the first flush still belongs to the original startup deadline', async () => {
  const h = startupFrameHarness(); let settled = false;
  h.mirror.redrawTrace.synchronizedOutputOpen = false;
  h.flush(async () => {
    h.mirror.redrawTrace.synchronizedOutputOpen = true;
    return { success: true };
  });
  const pending = h.readStartup().then(value => { settled = true; return value; });
  await drainMicrotasks(); h.clock.advance(5500); await drainMicrotasks();
  assert.equal(settled, false, 'a pre-await empty frame cannot choose the shorter observation lifetime');
  h.flush(async () => ({ success: true }));
  h.mirror.redrawTrace.synchronizedOutputOpen = false;
  h.mirror.writeSeq++; h.mirror.flushedSeq++;
  h.wake(); assert.equal((await pending).hasDraft, false); h.clean();
});

test('a cold observation begun near startup expiry cannot extend that original deadline', async () => {
  const h = startupFrameHarness(); h.clock.advance(48001); // now 59001, launch deadline 60001
  const pending = h.readStartup(); await drainMicrotasks();
  assert.deepEqual([...h.clock.timers.values()].map(timer => timer.dueAt), [60001]);
  h.clock.advance(1000); const result = await pending;
  assert.equal(result.observation.status, 'expired');
  assert.equal(result.observation.budgetMs, 1000); assert.equal(result.hasDraft, null); h.clean();
});

test('repeated ready/busy/idle wakes do not renew the cold observation or grant empty input', async () => {
  const h = startupFrameHarness(); const pending = h.readStartup(); await drainMicrotasks();
  for (const status of ['active', 'busy', 'active']) {
    h.clock.advance(3000);
    h.ipcMain.emit('agent:readiness-changed-internal', null, { tabId: h.tabId, status, inputReady: true });
    await drainMicrotasks();
    assert.deepEqual([...h.clock.timers.values()].map(timer => timer.dueAt), [60001]);
  }
  h.clock.advance(40001); const result = await pending;
  assert.equal(result.hasDraft, null); assert.equal(result.observation.status, 'expired'); h.clean();
});

test('a real draft after cold frame commit is returned immediately, never cleared to authorize Send', async () => {
  const h = startupFrameHarness(); const pending = h.readStartup(); await drainMicrotasks();
  h.content('user-owned draft'); h.mirror.redrawTrace.synchronizedOutputOpen = false;
  h.mirror.writeSeq++; h.mirror.flushedSeq++; h.wake();
  const result = await pending;
  assert.equal(result.hasDraft, true); assert.equal(result.preview, 'user-owned draft'); h.clean();
});

test('cancellation of the original cold attempt remains final after a later empty frame', async () => {
  const h = startupFrameHarness();
  const pending = h.c.requestTerminalCodexDraftState(null, h.tabId, 'agent-send-preflight:project-api', 700,
    { waitFor: false, waitOnUnknownOnly: true, waitTimeoutMs: 2500, handoffId: 'H', attemptId: 'A' });
  await drainMicrotasks();
  h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'A' });
  await drainMicrotasks();
  h.mirror.redrawTrace.synchronizedOutputOpen = false; h.wake();
  const result = await pending;
  assert.equal(result.hasDraft, null); assert.equal(result.observation.status, 'cancelled'); h.clean();
});

test('startup frame wait keeps its original deadline and remains unknown if no committed frame arrives', async () => {
  const h = startupFrameHarness(); const pending = h.readStartup(); await drainMicrotasks();
  h.clock.advance(50001); const result = await pending;
  assert.equal(result.hasDraft, null); assert.equal(result.observation.status, 'expired'); h.clean();
});

for (const replacement of ['stop', 'input', 'mirror']) {
  test('startup frame wait never adopts a new ' + replacement + ' owner', async () => {
    const h = startupFrameHarness(); const pending = h.readStartup(); await drainMicrotasks();
    if (replacement === 'stop') h.stopAndClear('codex');
    if (replacement === 'input') h.c.bumpTerminalInputRevision(h.tabId);
    if (replacement === 'mirror') h.mirrors.set(h.tabId, { ...h.mirror, generation: 'OTHER' });
    h.wake(); const result = await pending;
    assert.equal(result.hasDraft, null);
    assert.ok(['cancelled', 'superseded'].includes(result.observation.status)); h.clean();
  });
}

for (const changed of ['expired-launch', 'foreign-terminal', 'foreign-generation', 'foreign-run', 'ordinary-probe']) {
  test('ordinary draft deadline is unchanged for ' + changed, async () => {
    const h = startupFrameHarness(); const launch = h.c.codexLastRunCommandPayload.get(h.tabId);
    if (changed === 'expired-launch') h.clock.advance(60001);
    if (changed === 'foreign-terminal') launch.terminalToken = {};
    if (changed === 'foreign-generation') launch.lifecycleGeneration = 'OTHER';
    if (changed === 'foreign-run') launch.runSeq = 2;
    const pending = changed === 'ordinary-probe' ? h.read('codex', { waitTimeoutMs: 2500 }) : h.readStartup();
    await drainMicrotasks(); h.clock.advance(2500);
    const result = await pending; assert.equal(result.observation.status, 'expired');
    assert.equal(result.observation.budgetMs, 2500); h.clean();
  });
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

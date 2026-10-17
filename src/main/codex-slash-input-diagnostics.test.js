'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { createCodexSlashInputDiagnostic } = require('./codex-slash-input-diagnostics');
const { createAgentInputObservation } = require('./agent-input-observation');
const { createFakeClock } = require('./fixtures/codex-draft-request-observation.cjs');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const actual = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}

function pipeline() {
  let time = 1000;
  const callbacks = [], publications = [];
  const state = { generation: 'M', writeSeq: 10, flushedSeq: 10, complete: true,
    replayJournal: require('./terminal-replay-journal').createTerminalReplayJournal(),
    committedFrameGeneration: 1, pendingResizeWriteSeq: null,
    lastCommittedVisibleSnapshot: { success: true, writeSeq: 10 },
    redrawTrace: require('./terminal-redraw-diagnostics').createTerminalRedrawTrace(),
    synchronizedFrameWaiters: new Set() };
  const context = vm.createContext({ state, tabId: 'T',
    ...require('./terminal-redraw-diagnostics'), ...require('./codex-draft-authority'),
    getHeadlessTerminalMirror: () => state,
    // Parser content and provider are controlled here. The actual production
    // pump/commit/blocker/notify declarations are executed, not copied formulas.
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, writeSeq: state.writeSeq,
      flushedSeq: state.flushedSeq }),
    recordTerminalComposerOutput() {}, readHeadlessCursorMetrics: () => null,
    terminalHistoryPreviewController: { observeFrame() {} },
    claudeLaunchGenerationByTab: new Map(), codexNativeQuestionMirror: { observeFrame() {} },
    logTerminalComposerForensicError() {},
    logHeadlessTerminalMirrorError(_tab, _state, _reason, error) { throw error; },
    console,
  });
  for (const name of ['observeCodexLateMcpProofAfterHeadlessFlush', 'observeClaudeSynchronizedFrameFlushed',
    'observeCodexNativeSettingsIntentFrame', 'observeCommittedTerminalComposerForensics',
    'observeClaudeProviderFatalCommittedFrame', 'observeCodexModelCapacityCommittedFrame',
    'observeCodexQueuedMessageCommittedFrame', 'observeCodexInputControlReadinessFrame',
    'observeCodexSettingsActivityFrame', 'observeCodexStartupGoalCommittedFrame',
    'observeCodexStartupComposerCommittedFrame', 'observeClaudeTrustFolderPromptCommittedFrame',
    'observeClaudeAutoModeDefaultPromptCommittedFrame']) context[name] = () => {};
  vm.runInContext(actual('writeHeadlessTerminalMirror') + '\n' + actual('commitHeadlessVisibleBufferSnapshot'), context);
  const creator = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createHeadlessTerminalMirror');
  const onFlushed = find(creator, n => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'onFlushed');
  const onError = find(creator, n => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'onError');
  state.writePump = require('../shared/xterm-write-pump.cjs').createXtermWritePump(
    (_text, done) => callbacks.push(done), {
      onFlushed: vm.runInContext('(' + onFlushed.initializer.getText(ast) + ')', context),
      onError: vm.runInContext('(' + onError.initializer.getText(ast) + ')', context),
    });
  const raw = find(ast, n => ts.isExpressionStatement(n)
    && n.getText(ast).startsWith('getHeadlessTerminalMirror(tabId)?.codexSlashInputDiagnostic?.record(\'raw-output\''));
  assert.ok(raw, 'actual onData instrumentation');
  const onData = vm.runInContext('(data) => { ' + raw.getText(ast) + ' }', context);
  const diagnostic = createCodexSlashInputDiagnostic({ tabId: 'T', command: '/compact', operationId: 'codex:api:H',
    identity: { terminalRunSeq: 7, mirrorGeneration: 'M', mirrorWriteSeq: 10 }, now: () => time,
    log: value => publications.push(value),
    readState: () => ({ writeSeq: state.writeSeq, flushedSeq: state.flushedSeq,
      synchronizedOutputOpen: state.redrawTrace.synchronizedOutputOpen,
      committedWriteSeq: state.lastCommittedVisibleSnapshot.writeSeq, ...state.writePump.getStatus() }),
  });
  state.codexSlashInputDiagnostic = diagnostic;
  return { state, diagnostic, publications, callbacks, context,
    time: value => { time = value; },
    raw: data => onData(data), mirror: data => context.writeHeadlessTerminalMirror('T', data),
    flush: () => { assert.ok(callbacks.length); callbacks.shift()(); },
  };
}

test('actual raw/pump/commit hooks distinguish no output, parser backlog, open frame and commit', () => {
  const h = pipeline();
  h.diagnostic.record('paste-returned');
  h.time(1100); h.diagnostic.publish('observation-result');
  assert.equal(h.publications.at(-1).stages['raw-output'], undefined);
  h.time(1200); h.raw('PRIVATE OUTPUT');
  let snapshot = h.diagnostic.snapshot();
  assert.equal(snapshot.stages['raw-output'].firstAt, 1200);
  assert.equal(snapshot.stages['mirror-output'], undefined, 'raw arrival and mirror delivery are separate');
  h.time(1300); h.mirror('\x1b[?2026hPRIVATE OUTPUT');
  snapshot = h.diagnostic.snapshot();
  assert.equal(snapshot.state.inFlight, true);
  assert.equal(snapshot.state.writeSeq, 11); assert.equal(snapshot.state.flushedSeq, 10);
  assert.equal(snapshot.stages['pump-flushed'], undefined);
  h.time(1700); h.flush();
  snapshot = h.diagnostic.snapshot();
  assert.equal(snapshot.stages['pump-flushed'].firstAt - snapshot.stages['mirror-output'].firstAt, 400);
  assert.equal(snapshot.state.flushedSeq, 11); assert.equal(snapshot.state.committedWriteSeq, 10);
  assert.equal(snapshot.events.find(e => e.stage === 'frame-blocked').reason, 'synchronized-output-open');
  h.time(1900); h.raw('\x1b[?2026l'); h.mirror('\x1b[?2026l'); h.flush();
  snapshot = h.diagnostic.snapshot();
  assert.equal(snapshot.state.committedWriteSeq, 12);
  assert.equal(snapshot.stages['frame-committed'].firstAt, 1900);
  assert.equal(snapshot.stages['notify-frame'].count, 2);
  assert.equal(snapshot.stages['observer-wake'], undefined, 'notification is not proof an observer received it');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE OUTPUT'), false);
});

test('actual observation subscriptions record only addressed wakes and clean up after Stop', async () => {
  const h = pipeline(), clock = createFakeClock(), ipcMain = new EventEmitter();
  let stopRevision = 0;
  Object.assign(h.context, { ipcMain, terminals: new Map([['T', {}]]), aiStoppingTabs: new Map(),
    captureAgentInputIdentity: () => ({ mirrorToken: h.state }),
    validateAgentInputIdentity: () => true, getTerminalStopRevision: () => stopRevision,
    agentInputObservationOwner: () => ({}),
    createAgentInputObservation: options => createAgentInputObservation({ ...options,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }),
  });
  vm.runInContext(actual('createMainAgentInputObservation'), h.context);
  const observation = h.context.createMainAgentInputObservation('T', 'codex', 2500, { diagnostic: h.diagnostic });
  h.mirror('x'); h.flush();
  ipcMain.emit('agent:readiness-changed-internal', null, { tabId: 'FOREIGN' });
  ipcMain.emit('agent:readiness-changed-internal', null, { tabId: 'T' });
  stopRevision++;
  ipcMain.emit('agent:input-owner-changed-internal', null, { tabId: 'T', reason: 'process-stopping' });
  assert.throws(() => observation.checkpoint(), /owner-changed/);
  observation.dispose();
  const snapshot = h.diagnostic.snapshot();
  assert.deepEqual(snapshot.events.filter(e => e.stage === 'observer-wake').map(e => e.wakeSource),
    ['frame', 'readiness', 'owner']);
  assert.equal(snapshot.stages['observer-subscribed'].count, 1);
  assert.equal(snapshot.stages['observer-unsubscribed'].count, 1);
  assert.equal(h.state.synchronizedFrameWaiters.size, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(ipcMain.eventNames().length, 0);
});

test('bounded scalar collector retains first/last spans, counts omissions and excludes arbitrary payloads', () => {
  const messages = []; let time = 0;
  const trace = createCodexSlashInputDiagnostic({ tabId: 'T', command: '/compact', maxEvents: 4,
    now: () => time++, log: value => messages.push(value),
    readState: () => ({ writeSeq: 123, content: 'SECRET', failed: true, error: 'SECRET' }) });
  for (let n = 0; n < 10000; n++) trace.record('raw-output', { chars: 1, seq: n, text: 'SECRET' });
  trace.record('check', { action: 'wait', reason: 'SECRET', preview: 'SECRET', token: 'SECRET' });
  for (let n = 0; n < 20; n++) trace.publish('observation-result');
  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 4); assert.equal(snapshot.droppedEvents, 9997);
  assert.equal(snapshot.stages['raw-output'].count, 10000);
  assert.equal(snapshot.stages['raw-output'].firstSeq, 0);
  assert.equal(snapshot.stages['raw-output'].lastSeq, 9999);
  assert.equal(snapshot.stages['raw-output'].chars, 10000);
  assert.equal(snapshot.lastDecision.reason, 'other');
  assert.equal(messages.length, 12); assert.equal(snapshot.suppressedPublications, 8);
  assert.equal(messages.at(-1).publicationBudgetExhausted, true);
  assert.equal(JSON.stringify([messages, snapshot]).includes('SECRET'), false);
  assert.ok(JSON.stringify(snapshot).length < 6000);
});

test('blocked reason counts survive eviction and snapshots do not mutate', () => {
  const trace = createCodexSlashInputDiagnostic({ command: '/compact', maxEvents: 4 });
  trace.record('frame-blocked', { reason: 'synchronized-output-open' });
  const before = trace.snapshot();
  for (let i = 0; i < 128; i++) trace.record('frame-blocked', { reason: 'frame-not-flushed' });
  const after = trace.snapshot();
  assert.deepEqual(after.stages['frame-blocked'].reasonCounts,
    { 'synchronized-output-open': 1, 'frame-not-flushed': 128 });
  assert.deepEqual(before.stages['frame-blocked'].reasonCounts, { 'synchronized-output-open': 1 });
  assert.equal(after.droppedEvents, 125);
});

test('missing/broken outbound instrumentation is explicit and never suppresses the original write', () => {
  for (const term of [{}, { get _writeStream() { throw Error('PRIVATE'); } }]) {
    const trace = createCodexSlashInputDiagnostic({ command: '/compact' }); let calls = 0;
    assert.equal(trace.withWrite(term, 'paste', 1, () => { calls++; return 42; }), 42);
    assert.equal(calls, 1);
    assert.equal(trace.snapshot().stages['outbound-unavailable'].count, 1);
    assert.equal(JSON.stringify(trace.snapshot()).includes('PRIVATE'), false);
    assert.throws(() => trace.withWrite(term, 'enter', 1, () => { throw Error('real-write-error'); }), /real-write-error/);
  }
});

test('broken log sink/state reader/clock cannot throw into the writer', () => {
  let brokenClock = false;
  const trace = createCodexSlashInputDiagnostic({ command: '/model',
    now: () => { if (brokenClock) throw new Error('SECRET'); return 10; },
    readState: () => { throw new Error('SECRET'); }, log: () => { throw new Error('SECRET'); } });
  assert.doesNotThrow(() => trace.publish('begin'));
  assert.ok(trace.snapshot().diagnosticErrors >= 2);
  brokenClock = true;
  assert.doesNotThrow(() => trace.record('paste-returned'));
  assert.doesNotThrow(() => trace.publish('observation-result'));
  assert.equal(trace.snapshot(), null);
  assert.equal(createCodexSlashInputDiagnostic({ command: '/compact', now: () => { throw 1; } }), null);
  assert.equal(createCodexSlashInputDiagnostic({ command: '/other PRIVATE BODY' }), null);
});

test('raw diagnostic executes before OSC/readiness work, and normal output emits no per-chunk logs', () => {
  const first = source.indexOf("record('raw-output'");
  assert.ok(first > 0);
  assert.ok(first < source.indexOf('parseOSC133AndEmit(tabId, data, ptyProcess)', first));
  const h = pipeline();
  for (let n = 0; n < 30; n++) { h.raw('x'); h.mirror('x'); h.flush(); }
  assert.equal(h.publications.length, 0);
  assert.equal(h.diagnostic.snapshot().stages['frame-committed'].count, 30);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript'), { Terminal } = require('@xterm/headless'), { SerializeAddon } = require('@xterm/addon-serialize');
const redraw = require('./terminal-redraw-diagnostics'), forensics = require('./terminal-composer-forensics');
const { createTerminalRawWindow, observeTerminalRaw } = require(process.env.RAW_CONTROL_SOURCE || './terminal-raw-window');
const { createTerminalRawWindowWriter } = require('./terminal-raw-window-writer');
const { createTerminalReplayJournal } = require('./terminal-replay-journal');
const { createXtermWritePump } = require('../shared/xterm-write-pump.cjs');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');
const artifacts = require('./terminal-history-preview-diagnostic');
const { createCodexSlashInputDiagnostic } = require('./codex-slash-input-diagnostics');

async function fixture(t, { command = '/model' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-raw-control-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const terminal = new Terminal({ cols: 78, rows: 59, scrollback: 1000, allowProposedApi: true });
  const addon = new SerializeAddon(); terminal.loadAddon(addon); t.after(() => terminal.dispose());
  const writer = createTerminalRawWindowWriter({ directory: path.join(directory, 'raw') }); t.after(() => writer.close());
  let at = 1000; const timers = new Map(); let timerId = 0;
  const raw = createTerminalRawWindow({ persist: writer, now: () => at,
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, deadline: at + ms }); return id; },
    clearTimer: id => timers.delete(id) }); t.after(() => raw.dispose());
  const writes = [], logs = [], readiness = [];
  const pty = { pid: 123, write: value => writes.push(value) };
  const state = { terminal, serializeAddon: addon, rawPhysicalTerminal: pty,
    generation: 'M', generationOrdinal: 1, writeSeq: 0, flushedSeq: 0, complete: true, failed: false,
    redrawTrace: redraw.createTerminalRedrawTrace(), composerForensics: forensics.createTerminalComposerForensics(),
    replayJournal: createTerminalReplayJournal(), committedFrameGeneration: 0, pendingResizeWriteSeq: null };
  const owner = { tabId: 'T', lifecycleGeneration: 'L', mirrorGeneration: 'M', runSeq: 1, stopRevision: 0, inputRevision: 0 };
  const queue = createCodexSettingsMutationQueue();
  const receipt = { command, identity: { tabId: 'T', terminalToken: pty,
    terminalLifecycleGeneration: 'L', terminalRunSeq: 1, terminalStopRevision: 0, mirrorGeneration: 'M', inputRevision: 0 },
  };
  receipt.diagnostic = createCodexSlashInputDiagnostic({ tabId: 'T', command: receipt.command, identity: receipt.identity,
    operationId: 'owned-control-operation', now: () => at, readState: () => ({
      writeSeq: state.writeSeq, flushedSeq: state.flushedSeq, sameTerminal: true, sameMirror: true,
      committedWriteSeq: state.lastCommittedVisibleSnapshot?.writeSeq,
    }) });
  state.codexSlashInputDiagnostic = receipt.diagnostic;
  assert.equal(queue.rememberUnsubmittedInput(pty, receipt), true);
  const ctx = { Buffer, crypto: require('node:crypto'), app: { getPath: () => directory }, queueMicrotask,
    console: { log: x => logs.push(x), warn: x => logs.push(x), error: x => logs.push(x) }, ...redraw, ...forensics, ...artifacts,
    getCodexDraftFrameBlocker: require('./codex-draft-authority').getCodexDraftFrameBlocker,
    observeTerminalIo: require('./terminal-io-progress').observeTerminalIo, observeTerminalRaw,
    terminalRawWindow: raw, codexSettingsMutationQueue: queue,
    terminals: new Map([['T', pty]]), getHeadlessTerminalMirror: () => state,
    readTerminalInputDiagnosticOwner: () => ({ ...owner }), getTerminalLifecycleGeneration: () => owner.lifecycleGeneration,
    normalizeHistoryEntryCopyDiagnostic: () => null, normalizeTerminalHistoryPreviewDiagnosticPreview: () => null,
    terminalHistoryPreviewController: { get: () => null, getDiagnosticState: () => null },
    terminalHistoryPreviewDiagnosticNumber: v => Number.isFinite(v) ? v : null,
    terminalHistoryPreviewDiagnosticCommandState: () => ({ isRunning: true, runSeq: owner.runSeq }),
    requestTerminalIncidentRendererSnapshot: async () => ({ unavailable: true, reason: 'controlled-unmounted-renderer' }),
    boundedDiagnosticText: require('./history-entry-copy-diagnostic').boundedDiagnosticText,
    claudeLaunchGenerationByTab: new Map(), codexNativeQuestionMirror: { observeFrame() {} },
    emitAgentReadinessChanged: (...x) => readiness.push(x),
    scheduleCodexModelEffortIntentReconcile() {}, scheduleCodexFastIntentReconcile() {},
    logTerminalComposerForensicError() {}, logHeadlessTerminalMirrorError(_tab, _state, _reason, error) { throw error; },
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, source: 'headless-main', rows: terminal.rows, cols: terminal.cols,
      writeSeq: state.writeSeq, flushedSeq: state.flushedSeq, mirrorGeneration: state.generation,
      synchronizedOutputOpen: state.redrawTrace.synchronizedOutputOpen,
      lines: Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) || '') }),
  };
  for (const name of ['observeCodexNativeSettingsIntentFrame', 'observeCommittedTerminalComposerForensics',
    'observeClaudeProviderFatalCommittedFrame', 'observeCodexModelCapacityCommittedFrame',
    'observeCodexQueuedMessageCommittedFrame', 'observeCodexInputControlReadinessFrame',
    'observeCodexSettingsActivityFrame', 'observeCodexStartupGoalCommittedFrame',
    'observeCodexStartupComposerCommittedFrame', 'observeClaudeTrustFolderPromptCommittedFrame',
    'observeClaudeAutoModeDefaultPromptCommittedFrame']) ctx[name] = () => {};
  const source = await fs.readFile(process.env.RAW_CONTROL_MAIN_SOURCE || require.resolve('./main'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const declaration = name => { const n = ast.statements.find(x => ts.isFunctionDeclaration(x) && x.name?.text === name);
    assert.ok(n, name); return n.getText(ast); };
  vm.createContext(ctx); vm.runInContext(['writeHeadlessTerminalMirror', 'commitHeadlessVisibleBufferSnapshot',
    'captureTerminalHistoryPreviewDiagnostic', 'releaseCodexOwnedModelInput'].map(declaration).join('\n'), ctx);
  state.writePump = createXtermWritePump((data, done) => terminal.write(data, done), { onFlushed(meta) {
    state.flushedSeq = meta.seq; ctx.commitHeadlessVisibleBufferSnapshot('T', state, meta.seq);
  } });
  const delivered = [];
  const emit = async data => { delivered.push(data); receipt.diagnostic.record('raw-output', { chars: data.length });
    raw.output(pty, data, owner); ctx.writeHeadlessTerminalMirror('T', data);
    assert.equal((await state.writePump.drain()).failed, null); };
  const capture = async (patch = {}) => {
    const result = await ctx.captureTerminalHistoryPreviewDiagnostic({ tabId: 'T', toolType: 'codex',
      incidentReason: 'slash-input-frame-timeout', context: { source: 'owned-short-control-frame',
        traceId: receipt.diagnostic.traceId, command: receipt.command }, ...patch });
    const packet = JSON.parse(await fs.readFile(result.artifactPath, 'utf8'));
    await writer.drain(); return { result, packet, manifest: packet.diagnostic.rawWindow.manifestPath };
  };
  const manifest = async p => { await writer.drain(); return JSON.parse(await fs.readFile(p, 'utf8')); };
  const streamText = async p => { const m = await manifest(p), b = await fs.readFile(path.join(path.dirname(p), m.stream));
    let at = 0, text = ''; while (at < b.length) { const h = b.readUInt32LE(at), n = b.readUInt32LE(at + 4); at += 8 + h;
      text += b.subarray(at, at + n).toString('utf16le'); at += n; } return text; };
  return { raw, writer, pty, state, ctx, receipt, queue, writes, logs, readiness, owner, emit, capture, manifest, streamText, delivered, timers,
    at: n => { at = n; }, expire: () => { for (const { fn } of [...timers.values()]) fn(); } };
}

test('owned short-control retains late OSC and intermediate frames through exact release and final snapshot', async t => {
  const h = await fixture(t); await h.emit('› Ask Codex to do anything\r\nGPT-6-Luna high');
  h.at(3501); const c = await h.capture();
  h.at(60000); await h.emit('\x1b]7501;state=working:app=codex\x1b\\');
  assert.equal((await h.manifest(c.manifest)).state, 'partial', 'a late OSC-only commit is NOT the end of failed control recovery');
  await h.emit('\x1b[?2026h\r\n' + 'history\r\n'.repeat(120));
  await h.emit('\r\n› /model\x1b[?2026l');
  assert.equal((await h.manifest(c.manifest)).state, 'partial', 'even an echoed slash precedes its owned clear');
  await h.emit('\r\n› \x1b[2mAsk Codex to do anything\x1b[0m\r\nGPT-6-Luna high');
  assert.equal(h.ctx.releaseCodexOwnedModelInput(h.pty, h.receipt, 'owned-input-cleared'), true);
  const completion = await h.receipt.rawCompletionCapture;
  assert.ok(completion?.artifactPath, 'final diagnostic uses the existing forensic artifact writer');
  const m = await h.manifest(c.manifest);
  assert.equal(m.state, 'sealed'); assert.equal(m.summary.end.reason, 'owned-control-released');
  assert.equal(m.summary.completion.pending, 0); assert.equal(m.summary.tail.complete, true);
  assert.equal(await h.streamText(c.manifest), h.delivered.join(''));
  const packet = JSON.parse(await fs.readFile(completion.artifactPath, 'utf8'));
  assert.equal(packet.diagnostic.rawWindow.id, c.packet.diagnostic.rawWindow.id);
  assert.equal(packet.diagnostic.incident.context.completionReason, 'owned-input-cleared');
  assert.ok(packet.diagnostic.committedSnapshot.lines.join('\n').includes('Ask Codex to do anything'));
  assert.ok(packet.diagnostic.serializedScreen.text.includes('\x1b['), 'final snapshot preserves ANSI, not only stripped prose');
  assert.equal(h.raw.snapshot().activePins, 0, 'completion capture must not create another raw pin');
  assert.deepEqual(h.writes, [], 'diagnostic capture/release writes no input');
  assert.equal(h.queue.getUnsubmittedInput(h.pty), null);
});

test('owned raw diagnostic retains its original tail deadline with explicit unresolved completion', async t => {
  const h = await fixture(t); await h.emit('baseline'); const c = await h.capture();
  const deadline = [...h.timers.values()][0].deadline;
  h.at(56000); await h.emit('\x1b]7501;state=working:app=codex\x1b\\');
  await h.capture(); assert.equal([...h.timers.values()][0].deadline, deadline, 'alias does not renew time');
  h.at(deadline); h.expire(); const m = await h.manifest(c.manifest);
  assert.equal(m.summary.end.reason, 'tail-deadline'); assert.equal(m.summary.completion.pending, 1);
  assert.equal(h.queue.getUnsubmittedInput(h.pty), h.receipt, 'diagnostic expiry cannot abandon or submit service input');
  assert.equal(h.raw.snapshot().activePins, 0); assert.deepEqual(h.writes, []);
});

test('foreign trace does not bind a control receipt or change legacy committed-frame termination', async t => {
  const h = await fixture(t); await h.emit('baseline');
  const c = await h.capture({ context: { source: 'owned-short-control-frame', traceId: 'foreign-trace' } });
  await h.emit('late'); const m = await h.manifest(c.manifest);
  assert.equal(m.summary.end.reason, 'committed-current-frame'); assert.equal(h.receipt.rawCompletion, undefined);
  assert.equal(h.queue.getUnsubmittedInput(h.pty), h.receipt); assert.deepEqual(h.writes, []);
});

test('an old release cannot close the current receipt and diagnostic failures cannot block owned cleanup', async t => {
  const h = await fixture(t); await h.emit('baseline'); const c = await h.capture();
  assert.equal(h.queue.releaseUnsubmittedInput(h.pty, h.receipt), true);
  const replacement = { command: '/fast' }; h.queue.rememberUnsubmittedInput(h.pty, replacement);
  assert.equal(h.ctx.releaseCodexOwnedModelInput(h.pty, h.receipt, 'owned-input-cleared'), false);
  assert.equal((await h.manifest(c.manifest)).state, 'partial');
  h.queue.releaseUnsubmittedInput(h.pty, replacement); h.queue.rememberUnsubmittedInput(h.pty, h.receipt);
  h.ctx.terminalRawWindow = { settle() { throw Error('controlled-observer-fault'); } };
  assert.equal(h.ctx.releaseCodexOwnedModelInput(h.pty, h.receipt, 'owned-input-cleared'), true);
  assert.equal(h.queue.getUnsubmittedInput(h.pty), null);
  await h.receipt.rawCompletionCapture;
  assert.deepEqual(h.writes, []); assert.equal(h.readiness.length, 1);
});

test('scalar differentiating: durable failure retains exact owned fd/raw/pump trace, independent of rotating console', async t => {
  const h = await fixture(t); await h.emit('baseline');
  h.receipt.diagnostic.record('outbound-fd-callback', { taskId: 7, writeKind: 'paste', writtenBytes: 19, complete: true });
  const c = await h.capture(), trace = c.packet.diagnostic.ownedControlTrace;
  assert.equal(trace?.available, true, 'durable error packet omitted the exact scalar receipt trace');
  assert.equal(trace.boundary, 'failure'); assert.equal(trace.snapshot.traceId, h.receipt.diagnostic.traceId);
  assert.equal(trace.snapshot.outboundTasks[0].stages['outbound-fd-callback'].last.writtenBytes, 19);
  const frozen = JSON.stringify(trace.snapshot);
  h.at(69000); await h.emit('late');
  assert.equal(JSON.stringify(c.packet.diagnostic.ownedControlTrace.snapshot), frozen, 'late data cannot rewrite original failure boundary');
  assert.deepEqual(h.writes, []);
});

test('scalar differentiating: separate completion captures late stages before receipt retirement, without renewing raw TTL', async t => {
  const h = await fixture(t); await h.emit('baseline'); const c = await h.capture();
  const deadline = [...h.timers.values()][0].deadline; h.at(deadline); h.expire();
  h.at(69000); await h.emit('late exact-owner bytes');
  const before = h.receipt.diagnostic.snapshot();
  h.receipt.unsubscribe = () => { h.receipt.diagnostic.record('mirror-disposed', { disposed: true }); };
  h.ctx.releaseCodexOwnedModelInput(h.pty, h.receipt, 'owned-input-cleared');
  const done = await h.receipt.rawCompletionCapture;
  const packet = JSON.parse(await fs.readFile(done.artifactPath, 'utf8'));
  assert.equal(packet.diagnostic.ownedControlTrace?.available, true, 'final packet lost trace after queue/mirror retirement');
  assert.equal(packet.diagnostic.ownedControlTrace.boundary, 'pre-release');
  assert.equal(packet.diagnostic.ownedControlTrace.snapshot.stages['raw-output'].lastAt, 69000);
  assert.equal(packet.diagnostic.ownedControlTrace.snapshot.stages['mirror-disposed'], undefined);
  assert.deepEqual(packet.diagnostic.ownedControlTrace.snapshot, before);
  assert.equal((await h.manifest(c.manifest)).summary.end.reason, 'tail-deadline');
  assert.equal(h.raw.snapshot().activePins, 0); assert.deepEqual(h.writes, []);
});

for (const field of ['inputRevision', 'stopRevision', 'runSeq', 'lifecycleGeneration', 'mirrorGeneration']) {
  test('foreign ' + field + ' cannot attach an old scalar control trace', async t => {
    const h = await fixture(t); await h.emit('baseline');
    if (field === 'mirrorGeneration') h.state.generation = 'FOREIGN';
    else h.owner[field] = typeof h.owner[field] === 'number' ? h.owner[field] + 1 : 'FOREIGN';
    const c = await h.capture(); assert.notEqual(c.packet.diagnostic.ownedControlTrace?.available, true);
    assert.equal(h.queue.getUnsubmittedInput(h.pty), h.receipt); assert.deepEqual(h.writes, []);
  });
}

test('scalar snapshot failure does not suppress raw evidence, cleanup or readiness wake', async t => {
  const h = await fixture(t); await h.emit('baseline');
  h.receipt.diagnostic.snapshot = () => { throw Error('controlled-scalar-fault'); };
  const c = await h.capture(); assert.equal(c.packet.diagnostic.rawWindow.available, true);
  assert.equal(c.packet.diagnostic.ownedControlTrace, undefined);
  assert.equal(h.ctx.releaseCodexOwnedModelInput(h.pty, h.receipt, 'owned-input-cleared'), true);
  await h.receipt.rawCompletionCapture;
  assert.equal(h.queue.getUnsubmittedInput(h.pty), null); assert.deepEqual(h.writes, []);
  assert.equal(h.readiness.length, 1);
});

test('failure scalar boundary is detached before held renderer response and never admits arbitrary text', async t => {
  const h = await fixture(t); await h.emit('baseline');
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  h.ctx.requestTerminalIncidentRendererSnapshot = async () => { entered(); await wait; return { unavailable: true }; };
  h.receipt.diagnostic.record('outbound-fd-callback', { taskId: 7, writeKind: 'paste', writtenBytes: 19, complete: true });
  for (let i = 0; i < 200; i++) h.receipt.diagnostic.record('check', { text: 'MUST_NOT_ENTER_SCALARS', checks: i });
  const pending = h.capture(); await started;
  h.at(9000); h.receipt.diagnostic.record('raw-output', { chars: 4 }); release();
  const c = await pending, trace = c.packet.diagnostic.ownedControlTrace.snapshot;
  assert.equal(trace.stages['raw-output'].lastAt, 1000);
  assert.equal(trace.stages.check.count, 200); assert.ok(trace.droppedEvents > 0);
  assert.ok(trace.events.length <= trace.limits.maxEvents);
  assert.doesNotMatch(JSON.stringify(trace), /MUST_NOT_ENTER_SCALARS/);
  assert.ok(Buffer.byteLength(JSON.stringify(trace)) < 64 * 1024);
});

test('replacement terminal cannot attach the former receipt scalar trace', async t => {
  const h = await fixture(t); await h.emit('baseline');
  h.ctx.terminals.set('T', { pid: 456 });
  const c = await h.capture(); assert.equal(c.packet.diagnostic.ownedControlTrace, undefined);
  assert.equal(h.queue.getUnsubmittedInput(h.pty), h.receipt); assert.deepEqual(h.writes, []);
});

for (const command of ['/fast', '/compact']) test('exact ' + command + ' scalar trace follows its own control, not another command', async t => {
  const h = await fixture(t, { command }); await h.emit('baseline'); const c = await h.capture();
  assert.equal(c.packet.diagnostic.ownedControlTrace.snapshot.command, command);
  assert.equal(c.packet.diagnostic.ownedControlTrace.snapshot.operationId, 'owned-control-operation');
  h.ctx.releaseCodexOwnedModelInput(h.pty, h.receipt, 'owned-input-cleared');
  const done = await h.receipt.rawCompletionCapture, packet = JSON.parse(await fs.readFile(done.artifactPath, 'utf8'));
  assert.equal(packet.diagnostic.ownedControlTrace.snapshot.command, command); assert.deepEqual(h.writes, []);
});

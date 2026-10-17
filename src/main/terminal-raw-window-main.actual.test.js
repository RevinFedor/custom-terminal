'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript'), { Terminal } = require('@xterm/headless'), { SerializeAddon } = require('@xterm/addon-serialize');
const redraw = require('./terminal-redraw-diagnostics'), forensics = require('./terminal-composer-forensics');
const { createTerminalRawWindow, observeTerminalRaw } = require('./terminal-raw-window');
const { createTerminalRawWindowWriter } = require('./terminal-raw-window-writer');
const { createTerminalReplayJournal } = require('./terminal-replay-journal');
const { createXtermWritePump } = require('../shared/xterm-write-pump.cjs');
const { persistTerminalHistoryPreviewDiagnostic, buildTerminalHistoryPreviewDiagnosticReference } = require('./terminal-history-preview-diagnostic');
const { getCodexDraftFrameBlocker } = require('./codex-draft-authority');

test('actual Main detection capture → real xterm long open frame → worker prefix/tail artifact', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-raw-main-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const terminal = new Terminal({ cols: 61, rows: 59, scrollback: 5000, allowProposedApi: true });
  const addon = new SerializeAddon(); terminal.loadAddon(addon); t.after(() => terminal.dispose());
  const writer = createTerminalRawWindowWriter({ directory: path.join(directory, 'raw') }); t.after(() => writer.close());
  let at = 1000; const raw = createTerminalRawWindow({ persist: writer, now: () => at }); t.after(() => raw.dispose());
  const pty = { pid: 123 }, state = { terminal, serializeAddon: addon, rawPhysicalTerminal: pty,
    generation: 'M', generationOrdinal: 1, writeSeq: 0, flushedSeq: 0, complete: true, failed: false,
    redrawTrace: redraw.createTerminalRedrawTrace(), composerForensics: forensics.createTerminalComposerForensics(),
    replayJournal: createTerminalReplayJournal(), committedFrameGeneration: 0, pendingResizeWriteSeq: null };
  const owner = () => ({ tabId: 'T', lifecycleGeneration: 'L', mirrorGeneration: 'M', runSeq: 1, stopRevision: 0 });
  const context = { Buffer, console, crypto: require('node:crypto'), app: { getPath: () => directory },
    ...redraw, ...forensics, getCodexDraftFrameBlocker, observeTerminalRaw,
    observeTerminalIo: require('./terminal-io-progress').observeTerminalIo, terminalRawWindow: raw,
    terminals: new Map([['T', pty]]), getHeadlessTerminalMirror: () => state,
    readTerminalInputDiagnosticOwner: owner, getTerminalLifecycleGeneration: () => 'L',
    normalizeHistoryEntryCopyDiagnostic: () => null, normalizeTerminalHistoryPreviewDiagnosticPreview: () => null,
    terminalHistoryPreviewController: { get: () => null, getDiagnosticState: () => null },
    terminalHistoryPreviewDiagnosticNumber: v => Number.isFinite(v) ? v : null,
    terminalHistoryPreviewDiagnosticCommandState: () => ({ isRunning: true, runSeq: 1 }),
    requestTerminalIncidentRendererSnapshot: async () => ({ unavailable: true, reason: 'renderer-controlled-not-mounted' }),
    persistTerminalHistoryPreviewDiagnostic, buildTerminalHistoryPreviewDiagnosticReference,
    boundedDiagnosticText: require('./history-entry-copy-diagnostic').boundedDiagnosticText,
    claudeLaunchGenerationByTab: new Map(), codexNativeQuestionMirror: { observeFrame() {} },
    logTerminalComposerForensicError() {}, logHeadlessTerminalMirrorError(_tab, _state, _reason, error) { throw error; },
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, source: 'headless-main', rows: terminal.rows, cols: terminal.cols,
      writeSeq: state.writeSeq, flushedSeq: state.flushedSeq, mirrorGeneration: 'M',
      synchronizedOutputOpen: state.redrawTrace.synchronizedOutputOpen,
      lines: Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) || '') }),
  };
  for (const name of ['observeCodexNativeSettingsIntentFrame', 'observeCommittedTerminalComposerForensics',
    'observeClaudeProviderFatalCommittedFrame', 'observeCodexModelCapacityCommittedFrame',
    'observeCodexQueuedMessageCommittedFrame', 'observeCodexInputControlReadinessFrame',
    'observeCodexSettingsActivityFrame', 'observeCodexStartupGoalCommittedFrame',
    'observeCodexStartupComposerCommittedFrame', 'observeClaudeTrustFolderPromptCommittedFrame',
    'observeClaudeAutoModeDefaultPromptCommittedFrame']) context[name] = () => {};
  const source = await fs.readFile(require.resolve('./main'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const declaration = name => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); return node.getText(ast);
  };
  vm.createContext(context);
  vm.runInContext(['writeHeadlessTerminalMirror', 'commitHeadlessVisibleBufferSnapshot',
    'captureTerminalHistoryPreviewDiagnostic'].map(declaration).join('\n'), context);
  state.writePump = createXtermWritePump((data, done) => terminal.write(data, done), { onFlushed(meta) {
    state.flushedSeq = meta.seq; context.commitHeadlessVisibleBufferSnapshot('T', state, meta.seq);
  } });
  const delivered = [];
  const emit = async data => {
    delivered.push(data); raw.output(pty, data, owner()); context.writeHeadlessTerminalMirror('T', data);
    const drained = await state.writePump.drain(); assert.equal(drained.failed, null);
  };
  await emit('baseline\r\n');
  const baselineSeq = state.lastCommittedVisibleSnapshot.writeSeq;
  await emit('\x1b[?2026h' + 'PRE Ж\r\n'.repeat(16000));
  assert.equal(state.flushedSeq, state.writeSeq);
  assert.equal(state.lastCommittedVisibleSnapshot.writeSeq, baselineSeq);
  const capture = await context.captureTerminalHistoryPreviewDiagnostic({ tabId: 'T', toolType: 'codex',
    incidentReason: 'draft-frame-unresolved', sendIdentity: { handoffId: 'H', operationKey: 'O', attemptId: 'A' } });
  const artifact = JSON.parse(await fs.readFile(capture.artifactPath, 'utf8'));
  assert.equal(artifact.diagnostic.rawWindow.available, true);
  const manifestPath = artifact.diagnostic.rawWindow.manifestPath; await writer.drain();
  assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).state, 'partial');
  at = 31000; await emit('LATE ДАННЫЕ\r\n'.repeat(15000) + '\x1b[?2026l'); await writer.drain();
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.state, 'sealed'); assert.equal(manifest.summary.end.reason, 'committed-current-frame');
  assert.equal(manifest.summary.send.attemptId, 'A'); assert.equal(manifest.rawWindowCompleteWithinAdvertisedRange, true);
  const binary = await fs.readFile(path.join(path.dirname(manifestPath), manifest.stream));
  let offset = 0, replay = '';
  while (offset < binary.length) {
    const h = binary.readUInt32LE(offset), b = binary.readUInt32LE(offset + 4); offset += 8 + h;
    replay += binary.subarray(offset, offset + b).toString('utf16le'); offset += b;
  }
  assert.equal(replay, delivered.join(''));
  assert.ok(state.lastCommittedVisibleSnapshot.writeSeq > baselineSeq);
});

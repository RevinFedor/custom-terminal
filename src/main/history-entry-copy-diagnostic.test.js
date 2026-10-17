'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { boundedDiagnosticText, normalizeHistoryEntryCopyDiagnostic, copyHistoryEntryDetails } = require('./history-entry-copy-diagnostic');
const writer = require('./terminal-history-preview-diagnostic');
const forensics = require('./terminal-composer-forensics');
const payload = { copyText: 'Message ID: message-A\nQueue status: delivery-unknown', diagnostic: {
  tabId: 'tab-A', toolType: 'codex', messageId: 'message-A', sessionId: 'session-A',
  handoffId: 'handoff-A', queueStatus: 'delivery-unknown', promptText: '  text\nwith image [Image #1]',
} };

test('ID-copy waits for the artifact, never changing message delivery or using a different tab', async () => {
  const copied = [];
  let finish;
  const pending = copyHistoryEntryDetails(payload, {
    writeText: (text) => copied.push(text),
    captureDiagnostic: (request) => {
      assert.equal(request.tabId, 'tab-A');
      assert.equal(request.historyEntry.handoffId, 'handoff-A');
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  assert.deepEqual(copied, []);
  finish({ artifactPath: '/saved.json', reference: 'artifactPath: /saved.json', snapshotAvailable: true });
  assert.equal((await pending).success, true);
  assert.equal(copied.length, 1);
  assert.ok(copied[0].startsWith(payload.copyText));
  assert.match(copied[0], /artifactPath: \/saved.json/);
  assert.equal(payload.diagnostic.queueStatus, 'delivery-unknown');
});

test('plain ID-copy makes no diagnostic and save failure still copies IDs without a fake path', async () => {
  let captured = 0;
  let copied;
  const captureDiagnostic = async () => { captured++; throw new Error('disk unavailable'); };
  const writeText = (text) => { copied = text; };
  assert.equal((await copyHistoryEntryDetails({ copyText: 'plain' }, { captureDiagnostic, writeText })).success, true);
  assert.equal(copied, 'plain');
  assert.equal(captured, 0);
  const failed = await copyHistoryEntryDetails(payload, { captureDiagnostic, writeText });
  assert.equal(failed.success, false);
  assert.equal(failed.copied, true);
  assert.ok(copied.startsWith(payload.copyText));
  assert.match(copied, /could not be saved: disk unavailable/);
  assert.doesNotMatch(copied, /artifactPath:/);
});

test('missing live terminal is explicit and clipboard failure does not pretend persistence failed', async () => {
  let copied;
  const captureDiagnostic = async () => ({ artifactPath: '/saved.json', reference: 'artifactPath: /saved.json', snapshotAvailable: false });
  const partial = await copyHistoryEntryDetails(payload, { captureDiagnostic, writeText: (text) => { copied = text; } });
  assert.equal(partial.partial, true);
  assert.match(copied, /Terminal snapshot: unavailable/);
  const failed = await copyHistoryEntryDetails(payload, { captureDiagnostic, writeText: () => { throw new Error('clipboard denied'); } });
  assert.equal(failed.copied, false);
  assert.match(failed.error, /Diagnostics saved, but clipboard failed/);
});

test('large diagnostics retain explicit limits and the complete UTF-8 identity', () => {
  const text = 'Привет\n'.repeat(100);
  const value = boundedDiagnosticText(text, 80);
  assert.equal(value.truncated, true);
  assert.equal(value.head.length + value.tail.length, 80);
  assert.equal(value.bytes, Buffer.byteLength(text));
  assert.equal(value.sha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(normalizeHistoryEntryCopyDiagnostic({ ...payload.diagnostic, toolType: 'gemini' }), null);
});

test('actual shared collector saves ANSI, styled frame, raw trace and exact late receipt atomically', async (t) => {
  const logsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'history-send-diag-'));
  t.after(() => fs.promises.rm(logsDir, { recursive: true, force: true }));
  const terminal = new Terminal({ cols: 48, rows: 8, allowProposedApi: true });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  t.after(() => terminal.dispose());
  const raw = '\x1b[2mMessages to be submitted after next tool call\r\n  text with image [Image #1]…\x1b[0m';
  await new Promise((resolve) => terminal.write(raw, resolve));
  const trace = forensics.createTerminalComposerForensics();
  forensics.recordTerminalComposerInput(trace, '\r', { kind: 'programmatic-enter',
    handoffId: 'handoff-A', sendAttemptId: 'attempt-A', mirrorGeneration: 'mirror-A' });
  forensics.recordTerminalComposerOutput(trace, raw, { seq: 7 });
  const frame = { success: true, tabId: 'tab-A', cols: 48, rows: 8,
    lines: [{ row: 1, text: 'text with image [Image #1]…', wrapped: true, allTextDim: true }] };
  const mirror = { generation: 'mirror-A', generationOrdinal: 1, writeSeq: 7, flushedSeq: 7,
    complete: true, committedFrameGeneration: 3, lastCommittedVisibleSnapshot: frame,
    serializeAddon, composerForensics: trace };
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function captureTerminalHistoryPreviewDiagnostic(payload = {})');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start);
  let preferCommitted;
  const capture = vm.runInNewContext(source.slice(start, end) + '\ncaptureTerminalHistoryPreviewDiagnostic', {
    crypto, console: { log() {} }, app: { getPath: () => logsDir },
    getHeadlessTerminalMirror: (tabId) => tabId === 'tab-A' ? mirror : null,
    terminals: new Map([['tab-A', { pid: 42 }]]),
    normalizeTerminalHistoryPreviewDiagnosticPreview: () => null,
    terminalHistoryPreviewController: { get: () => null },
    normalizeHistoryEntryCopyDiagnostic, boundedDiagnosticText,
    terminalHistoryPreviewDiagnosticNumber: (value) => value == null ? null : Number(value),
    terminalHistoryPreviewDiagnosticCommandState: () => ({ isRunning: true }),
    getTerminalLifecycleGeneration: () => 'lifecycle-A',
    getHeadlessVisibleBufferSnapshot: (_tabId, _reason, options) => { preferCommitted = options.preferCommitted; return frame; },
    codexKnownSessions: new Map([['tab-A', 'session-A']]), bridgeKnownSessions: new Map(),
    agentSendReceiptStore: { list: (filter) => {
      assert.equal(filter.tabId, 'tab-A'); assert.equal(filter.handoffId, 'handoff-A');
      return [{ provider: 'codex', handoffId: 'handoff-A', state: 'confirmed', attemptId: 'attempt-A',
        operationKey: 'operation-A', sessionId: 'session-A', receipt: { submitted: true } }];
    } },
    snapshotTerminalComposerForensics: forensics.snapshotTerminalComposerForensics,
    snapshotTerminalComposerForensicWindow: forensics.snapshotTerminalComposerForensicWindow,
    snapshotTerminalRedrawTrace: () => ({ entries: [{ seq: 7, at: 42 }] }),
    persistTerminalHistoryPreviewDiagnostic: writer.persistTerminalHistoryPreviewDiagnostic,
    buildTerminalHistoryPreviewDiagnosticReference: writer.buildTerminalHistoryPreviewDiagnosticReference,
    requestTerminalIncidentRendererSnapshot: async () => ({ success: true,
      capturedAt: 100, frameIdentity: { generation: 'mirror-A', writeSeq: 6 }, serializedScreen: 'renderer-screen' }),
  });
  let copied;
  const result = await copyHistoryEntryDetails(payload, { captureDiagnostic: capture, writeText: (text) => { copied = text; } });
  assert.equal(result.success, true);
  assert.equal(preferCommitted, false, 'live and committed frames must not secretly be the same replay');
  const saved = JSON.parse(await fs.promises.readFile(result.artifactPath, 'utf8'));
  const diagnostic = saved.diagnostic;
  assert.equal(diagnostic.incident.reason, 'manual-unconfirmed-message-copy');
  assert.equal(diagnostic.incident.historyEntry.queueStatus, 'delivery-unknown');
  assert.equal(diagnostic.incident.sendReceipts[0].state, 'confirmed', 'late receipt does not erase the observed problem');
  assert.equal(diagnostic.incident.messageSessionMatched, true);
  assert.equal(diagnostic.liveSnapshot.lines[0].allTextDim, true);
  assert.match(diagnostic.serializedScreen.text, /\x1b\[/);
  assert.equal(diagnostic.composerTrace.pendingOutput.chunks[0].data, raw);
  assert.equal(diagnostic.composerTrace.window.anchorFound, true);
  assert.equal(diagnostic.composerTrace.window.sendAttemptId, 'attempt-A');
  assert.match(copied, /Terminal send diagnostic/);
  const auto = await capture({ tabId: 'tab-A', toolType: 'codex',
    incidentReason: 'send-delivery-unconfirmed', historyEntry: payload.diagnostic });
  const autoSaved = JSON.parse(await fs.promises.readFile(auto.artifactPath, 'utf8')).diagnostic;
  assert.equal(autoSaved.incident.reason, 'send-delivery-unconfirmed');
  assert.equal(autoSaved.rendererSnapshot.serializedScreen, 'renderer-screen');
  assert.match(autoSaved.serializedScreen.text, /\x1b\[/);
  assert.match(copied, /messageId: message-A/);
  assert.match(copied, /handoffId: handoff-A/);
  assert.equal((await fs.promises.stat(result.artifactPath)).mode & 0o777, 0o600);
});

test('native menu and all history row forms preserve explicit tab ownership', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const history = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
  const begin = main.indexOf("ipcMain.on('show-history-entry-context-menu'");
  const end = main.indexOf("ipcMain.on('show-terminal-history-preview-context-menu'", begin);
  const menu = main.slice(begin, end);
  assert.match(menu, /copyHistoryEntryDetails\(payload/);
  assert.match(menu, /captureDiagnostic: captureTerminalHistoryPreviewDiagnostic/);
  assert.match(menu, /history-entry:diagnostic-copy-result/);
  assert.equal((history.match(/openHistoryEntryContextMenu\(event, presentedEntry, toolType, tabId,/g) || []).length, 3);
  assert.match(history, /diagnostic: historyEntryCopyDiagnostic\(entry, tabId, toolType\)/);
  assert.match(history, /removeListener\('history-entry:diagnostic-copy-result'/);
});

test('actual native-menu callback starts capture only on Copy and replies after persistence', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const begin = source.indexOf("ipcMain.on('show-history-entry-context-menu'");
  const end = source.indexOf("ipcMain.on('show-terminal-history-preview-context-menu'", begin);
  let openMenu;
  let template;
  let captured = 0;
  let persisted;
  let copied;
  const replies = [];
  const sender = { isDestroyed: () => false, send: (...args) => replies.push(args) };
  vm.runInNewContext(source.slice(begin, end), {
    ipcMain: { on: (name, handler) => { assert.equal(name, 'show-history-entry-context-menu'); openMenu = handler; } },
    Menu: { buildFromTemplate: (items) => { template = items; return { popup: (options) => assert.equal(options.window, sender) }; } },
    BrowserWindow: { fromWebContents: (value) => value },
    clipboard: { writeText: (text) => { copied = text; } },
    copyHistoryEntryDetails,
    writeTerminalMessageDetails: require('./terminal-message-clipboard').writeTerminalMessageDetails,
    captureTerminalHistoryPreviewDiagnostic: (request) => {
      captured++;
      assert.equal(request.tabId, 'tab-A');
      return new Promise((resolve) => { persisted = resolve; });
    },
  });
  openMenu({ sender }, payload);
  assert.equal(template[0].label, 'Copy ID and details');
  assert.equal(captured, 0, 'opening/right-clicking alone does not write logs');
  const click = template[0].click();
  assert.equal(captured, 1);
  assert.equal(copied, undefined);
  assert.equal(replies.length, 0);
  persisted({ artifactPath: '/exact.json', reference: 'artifactPath: /exact.json', snapshotAvailable: true });
  await click;
  assert.match(copied, /artifactPath: \/exact.json/);
  assert.equal(replies[0][0], 'history-entry:diagnostic-copy-result');
  assert.equal(replies[0][1].tabId, 'tab-A');
  assert.equal(replies[0][1].messageId, 'message-A');
  assert.equal(replies[0][1].success, true);
});

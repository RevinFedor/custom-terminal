import assert from 'node:assert/strict';
import test from 'node:test';
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const { Terminal: HeadlessTerminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

test('serialized terminal hydration restores non-visual prompt boundary lines', async () => {
  (globalThis as any).window = globalThis;
  const { terminalRegistry } = await import('./terminalRegistry.ts');
  const tabId = 'terminal-hydration-marker-test';
  const source = new HeadlessTerminal({
    cols: 20,
    rows: 3,
    scrollback: 100,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  source.loadAddon(serializeAddon);
  const sourceBoundaries: Array<{ seq: number; line: number }> = [];
  source.parser.registerOscHandler(7777, (payload) => {
    const match = /^prompt:(\d+)$/.exec(payload);
    const marker = match ? source.registerMarker(0) : null;
    if (match && marker) sourceBoundaries.push({ seq: Number(match[1]), line: marker.line });
    return true;
  });

  await new Promise<void>((resolve) => {
    source.write(
      [
        'line-0\r\nline-1\r\nline-2\r\n',
        '\x1b]7777;prompt:2\x07',
        'line-3\r\nline-4\r\nline-5\r\nline-6\r\n',
        '\x1b]7777;prompt:3\x07',
        'line-7\r\nline-8\r\nline-9\r\n',
      ].join(''),
      resolve,
    );
  });
  const serialized = serializeAddon.serialize();
  assert.equal(serialized.includes('7777'), false);

  const terminal = new HeadlessTerminal({
    cols: 20,
    rows: 3,
    scrollback: 100,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => terminal.write(serialized, resolve));

  const restored = terminalRegistry.restorePromptBoundaries(
    tabId,
    terminal as any,
    sourceBoundaries,
  );

  assert.equal(restored, 2);
  assert.deepEqual(
    terminalRegistry.getPromptBoundaryLines(tabId),
    sourceBoundaries.map((boundary) => boundary.line),
  );

  terminalRegistry.unregister(tabId);
  source.dispose();
  terminal.dispose();
});

test('an OSC boundary in the live tail is registered while snapshot writes are queued', async () => {
  (globalThis as any).window = globalThis;
  const { terminalRegistry } = await import('./terminalRegistry.ts');
  const tabId = 'terminal-hydration-live-tail-marker-test';
  const terminal = new HeadlessTerminal({
    cols: 40,
    rows: 4,
    scrollback: 100,
    allowProposedApi: true,
  });
  terminal.parser.registerOscHandler(7777, (payload) => {
    const match = /^prompt:(\d+)$/.exec(payload);
    if (match) {
      terminalRegistry.registerPromptBoundaryForTerminal(
        tabId,
        terminal as any,
        Number(match[1]),
      );
    }
    return true;
  });

  const snapshotWrite = new Promise<void>((resolve) => {
    terminal.write('snapshot-0\r\nsnapshot-1\r\n', resolve);
  });
  const tailWrite = new Promise<void>((resolve) => {
    terminal.write('tail\r\n\x1b]7777;prompt:9\x07prompt', resolve);
  });
  await Promise.all([snapshotWrite, tailWrite]);

  assert.equal(terminalRegistry.getPromptBoundaryCount(tabId), 1);
  assert.deepEqual(terminalRegistry.getPromptBoundaryLines(tabId), [3]);

  terminalRegistry.unregister(tabId);
  terminal.dispose();
});

test('draft diagnostics bind visible rows to the renderer write generation', async () => {
  (globalThis as any).window = globalThis;
  const { terminalRegistry } = await import('./terminalRegistry.ts');
  const tabId = 'terminal-draft-diagnostic-boundary-test';
  const terminal = new HeadlessTerminal({
    cols: 40,
    rows: 4,
    scrollback: 100,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => {
    terminal.write('old-row\r\n\u276f visible-tail', resolve);
  });
  terminalRegistry.register(tabId, terminal as any);
  terminalRegistry.markRendererWriteFlushed(tabId, terminal as any, {
    writeSeq: 73,
    generation: 'generation-73',
    generationOrdinal: 9,
  });

  const snapshot = terminalRegistry.getDraftDiagnosticSnapshot(tabId, {
    cursorRow: terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
  });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.rendererWriteSeq, 73);
  assert.equal(snapshot.rendererGeneration, 'generation-73');
  assert.equal(snapshot.rendererGenerationOrdinal, 9);
  assert.ok(snapshot.rendererInstanceId);
  terminalRegistry.markRendererWriteReceived(tabId, terminal as any, { writeSeq: 75, generation: 'generation-73' });
  const incident = terminalRegistry.getIncidentSnapshot(tabId);
  assert.equal(incident.frameIdentity?.writeSeq, 73);
  assert.equal(incident.received?.writeSeq, 75);
  assert.ok(incident.serializedScreen?.includes('visible-tail'));
  assert.equal(
    snapshot.lines?.some((line) => line.text.includes('\u276f visible-tail')),
    true,
  );

  terminalRegistry.unregister(tabId);
  terminal.dispose();
});

test('draft probe carries the exact flushed frame through picker-to-composer replacement', async () => {
  const { terminalRegistry } = await import('./terminalRegistry.ts');
  const { mergeCodexDraftAuthority } = await import('../../main/codex-draft-authority.js');
  const tabId = 'codex-stale-menu-draft-replay';
  const terminal = new HeadlessTerminal({ cols: 100, rows: 12, allowProposedApi: true });
  terminalRegistry.register(tabId, terminal as any);
  try {
    await new Promise<void>(resolve => terminal.write('› 5. More reasoning…   Max and Ultra consume usage limits', resolve));
    terminalRegistry.markRendererWriteFlushed(tabId, terminal as any, { generation: 'pty-a', writeSeq: 41 });
    const oldMenu = terminalRegistry.getCodexDraftState(tabId);
    assert.equal(oldMenu.hasDraft, true, 'this old drawing is deliberately kept as the regression input');
    assert.deepEqual(oldMenu.frameIdentity, { generation: 'pty-a', writeSeq: 41 });
    const main = { success: true, hasDraft: false, source: 'headless-main:cursor:dim-hint',
      frameIdentity: { generation: 'pty-a', writeSeq: 42 } };
    assert.equal(mergeCodexDraftAuthority(main, { success: true, ...oldMenu }, { mergeRendererPositive: true }).hasDraft, false);

    await new Promise<void>(resolve => terminal.write('\x1b[2J\x1b[H› \x1b[2mAsk Codex to do anything\x1b[0m', resolve));
    terminalRegistry.markRendererWriteFlushed(tabId, terminal as any, { generation: 'pty-a', writeSeq: 42 });
    assert.equal(terminalRegistry.getCodexDraftState(tabId).hasDraft, false);

    await new Promise<void>(resolve => terminal.write('\x1b[2J\x1b[H› 5. More reasoning…   Max and Ultra consume usage limits', resolve));
    terminalRegistry.markRendererWriteFlushed(tabId, terminal as any, { generation: 'pty-a', writeSeq: 43 });
    const realDraft = terminalRegistry.getCodexDraftState(tabId);
    assert.equal(mergeCodexDraftAuthority(main, { success: true, ...realDraft }, { mergeRendererPositive: true }).hasDraft, true,
      'the identical words typed in the new composer are protected, not filtered by content');
  } finally {
    terminalRegistry.unregister(tabId);
    terminal.dispose();
  }
});

test('late flush from a replaced renderer cannot label the current terminal with its frame identity', async () => {
  const { terminalRegistry } = await import('./terminalRegistry.ts');
  const tabId = 'codex-draft-replaced-renderer';
  const previous = new HeadlessTerminal({ cols: 80, rows: 8, allowProposedApi: true });
  const current = new HeadlessTerminal({ cols: 80, rows: 8, allowProposedApi: true });
  try {
    terminalRegistry.register(tabId, previous as any);
    terminalRegistry.register(tabId, current as any);
    await new Promise<void>(resolve => current.write('› real draft', resolve));
    terminalRegistry.markRendererWriteFlushed(tabId, previous as any, { generation: 'old-pty', writeSeq: 100 });
    const state = terminalRegistry.getCodexDraftState(tabId);
    assert.equal(state.hasDraft, true);
    assert.deepEqual(state.frameIdentity, { generation: null, writeSeq: null });
  } finally { terminalRegistry.unregister(tabId); previous.dispose(); current.dispose(); }
});

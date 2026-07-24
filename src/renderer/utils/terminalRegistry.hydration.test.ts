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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyInput,
  createTerminalRedrawTrace,
  recordTerminalFlush,
  recordTerminalInput,
  recordTerminalOutput,
  recordTerminalResize,
  snapshotTerminalRedrawTrace,
} = require('./terminal-redraw-diagnostics');

test('redraw trace records cursor visibility, erase and movement without storing printable output', () => {
  const trace = createTerminalRedrawTrace();
  const entry = recordTerminalOutput(
    trace,
    '\x1b[?25lsecret answer\x1b[2K\x1b[4;2H\x1b[?25h',
    { seq: 7, at: 100 },
  );

  assert.equal(trace.cursorVisible, true);
  assert.equal(trace.cursorVisibilitySeq, 7);
  assert.equal(Object.hasOwn(entry, 'printable'), false);
  assert.deepEqual(entry.controls.map((item) => item.kind), [
    'cursor-hide',
    'erase-line',
    'cursor-move',
    'cursor-show',
  ]);
});

test('redraw trace recognizes a cursor control split across PTY chunks', () => {
  const trace = createTerminalRedrawTrace();
  recordTerminalOutput(trace, '\x1b[?2', { seq: 1 });
  recordTerminalOutput(trace, '5l', { seq: 2 });
  assert.equal(trace.cursorVisible, false);
  assert.equal(trace.cursorVisibilitySeq, 2);
});

test('redraw trace exposes the exact DEC 2026 frame boundary, including split controls', () => {
  const trace = createTerminalRedrawTrace();
  recordTerminalOutput(trace, '\x1b[?20', { seq: 1 });
  recordTerminalOutput(trace, '26hframe', { seq: 2 });
  let snapshot = snapshotTerminalRedrawTrace(trace);
  assert.equal(snapshot.synchronizedOutputOpen, true);
  assert.equal(snapshot.synchronizedOutputSeq, 2);
  assert.equal(snapshot.synchronizedOutputGeneration, 1);

  recordTerminalOutput(trace, '\x1b[?2026l', { seq: 3 });
  snapshot = snapshotTerminalRedrawTrace(trace);
  assert.equal(snapshot.synchronizedOutputOpen, false);
  assert.equal(snapshot.synchronizedOutputSeq, 3);
  assert.equal(snapshot.synchronizedOutputGeneration, 2);
  assert.deepEqual(
    snapshot.entries.flatMap((entry) => entry.controls || []).map((item) => item.kind),
    ['synchronized-output-begin', 'synchronized-output-end'],
  );
});

test('redraw trace keeps bounded context plus input, resize and flush boundaries', () => {
  const trace = createTerminalRedrawTrace(8);
  recordTerminalInput(trace, '\x1b[O', { at: 10, revision: 3, origin: 'renderer' });
  recordTerminalResize(trace, 82, 18, { at: 11 });
  for (let seq = 1; seq <= 10; seq += 1) {
    recordTerminalOutput(trace, 'x\n', { seq });
  }
  recordTerminalFlush(trace, { seq: 10, chars: 10, items: 10, after: { cursorX: 2 } });
  const snapshot = snapshotTerminalRedrawTrace(trace, 20);

  assert.equal(classifyInput('\x1b[I'), 'focus-in');
  assert.equal(snapshot.lastInput.kind, 'focus-out');
  assert.deepEqual(snapshot.lastResize, { at: 11, cols: 82, rows: 18 });
  assert.equal(snapshot.entries.length, 8);
  assert.equal(snapshot.entries.at(-1).kind, 'output');
  assert.equal(snapshot.lastFlush.seq, 10);
});

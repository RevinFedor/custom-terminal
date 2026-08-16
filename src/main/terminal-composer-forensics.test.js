'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalComposerForensics,
  observeTerminalComposerFrame,
  recordTerminalComposerInput,
  recordTerminalComposerOutput,
  snapshotTerminalComposerForensicWindow,
  snapshotTerminalComposerForensics,
} = require('./terminal-composer-forensics');

function frame(text, reason = 'current-composer-text') {
  return {
    provider: 'claude',
    proofOutcome: text ? 'found' : 'absent',
    proofReason: reason,
    promptRow: 21,
    cursorRow: 21,
    cursorX: text.length + 2,
    screenText: text,
    lines: [{ row: 21, text: `❯ ${text}`, wrapped: false }],
  };
}

test('stores raw PTY only with a composer transition', () => {
  const trace = createTerminalComposerForensics({ createdAt: 1, maxAgeMs: 60_000 });
  recordTerminalComposerOutput(trace, '\x1b[2K❯ old', { seq: 1, at: 10 });
  const initial = observeTerminalComposerFrame(trace, frame('old'), {
    at: 11,
    writeSeq: 1,
    flushedSeq: 1,
    committedFrameGeneration: 1,
  });
  assert.equal(initial.kind, 'initial');
  assert.equal(initial.pty.chunks[0].data, '\x1b[2K❯ old');

  recordTerminalComposerOutput(trace, '\x1b[?25h', { seq: 2, at: 12 });
  const unchanged = observeTerminalComposerFrame(trace, frame('old'), {
    at: 13,
    writeSeq: 2,
    flushedSeq: 2,
    committedFrameGeneration: 2,
  });
  assert.equal(unchanged, null);
  assert.equal(snapshotTerminalComposerForensics(trace, { capturedAt: 14 }).pendingOutput, null);
  assert.equal(trace.transitions.length, 1);
});

test('keeps a post-Enter frame even when composer cells did not change', () => {
  const trace = createTerminalComposerForensics({ createdAt: 1, maxAgeMs: 60_000 });
  observeTerminalComposerFrame(trace, frame('stale'), {
    at: 10,
    writeSeq: 1,
    flushedSeq: 1,
  });
  const input = recordTerminalComposerInput(trace, '\r', {
    at: 11,
    phase: 'pty-write-attempt',
    source: 'manual-terminal-enter',
    checkpoint: true,
  });
  recordTerminalComposerOutput(trace, '\x1b[1G\x1b[?2026l', { seq: 2, at: 12 });
  const checkpoint = observeTerminalComposerFrame(trace, frame('stale'), {
    at: 13,
    writeSeq: 2,
    flushedSeq: 2,
  });
  assert.equal(checkpoint.kind, 'post-input');
  assert.deepEqual(checkpoint.checkpointInputIds, [input.id]);
  assert.equal(checkpoint.pty.chunks[0].data, '\x1b[1G\x1b[?2026l');
});

test('bounds retained PTY bytes while preserving the newest suffix', () => {
  const trace = createTerminalComposerForensics({
    createdAt: 1,
    maxAgeMs: 60_000,
    maxPendingOutputChars: 4096,
  });
  recordTerminalComposerOutput(trace, 'a'.repeat(3000), { seq: 1, at: 10 });
  recordTerminalComposerOutput(trace, 'b'.repeat(3000), { seq: 2, at: 11 });
  const event = observeTerminalComposerFrame(trace, frame('value'), {
    at: 12,
    writeSeq: 2,
    flushedSeq: 2,
  });
  assert.equal(event.pty.truncated, true);
  assert.equal(event.pty.charsSeen, 6000);
  assert.equal(event.pty.charsStored, 4096);
  assert.equal(event.pty.chunks.at(-1).data, 'b'.repeat(3000));
  assert.equal(event.pty.chunks[0].prefixTruncated, true);
});

test('snapshot is bounded, immutable, and includes an uncommitted incident tail', () => {
  const trace = createTerminalComposerForensics({
    createdAt: 1,
    maxAgeMs: 60_000,
    maxInputs: 8,
    maxTransitions: 8,
  });
  for (let index = 0; index < 12; index += 1) {
    recordTerminalComposerInput(trace, String(index), {
      at: 100 + index,
      checkpoint: false,
    });
  }
  recordTerminalComposerOutput(trace, '\x1b[2Kpending', { seq: 9, at: 120 });
  const snapshot = snapshotTerminalComposerForensics(trace, {
    capturedAt: 121,
    incident: { reason: 'contradiction' },
  });
  assert.equal(snapshot.inputs.length, 8);
  assert.equal(snapshot.incident.reason, 'contradiction');
  assert.equal(snapshot.pendingOutput.chunks[0].data, '\x1b[2Kpending');
  snapshot.inputs[0].kind = 'mutated';
  assert.notEqual(trace.inputs[0].kind, 'mutated');
});

test('coalesces a character-by-character draft while preserving its first and latest frames', () => {
  const trace = createTerminalComposerForensics({ createdAt: 1, maxAgeMs: 60_000 });
  observeTerminalComposerFrame(trace, frame(''), { at: 10, writeSeq: 1, flushedSeq: 1 });
  for (let index = 1; index <= 500; index += 1) {
    recordTerminalComposerOutput(trace, `draw-${index}`, { seq: index + 1, at: 10 + index });
    observeTerminalComposerFrame(trace, frame('x'.repeat(index)), {
      at: 10 + index,
      writeSeq: index + 1,
      flushedSeq: index + 1,
    });
  }
  assert.equal(trace.transitions.length, 3);
  const coalesced = trace.transitions.at(-1);
  assert.equal(coalesced.kind, 'transition-coalesced');
  assert.equal(coalesced.firstObservation.screenText, 'xx');
  assert.equal(coalesced.observation.screenText.length, 500);
  assert.equal(coalesced.coalescedUpdates, 499);
});

test('extracts one exact post-Enter window without crossing terminal generations', () => {
  const trace = createTerminalComposerForensics({ createdAt: 1, maxAgeMs: 60_000 });
  observeTerminalComposerFrame(trace, frame('old generation'), {
    at: 10,
    writeSeq: 1,
    terminalRunSeq: 1,
    lifecycleGeneration: 'life-1',
    mirrorGeneration: 'mirror-1',
  });
  recordTerminalComposerInput(trace, 'prompt text', {
    at: 20,
    kind: 'programmatic-paste',
    sendAttemptId: 'attempt-a',
    terminalRunSeq: 2,
    lifecycleGeneration: 'life-2',
    mirrorGeneration: 'mirror-2',
    checkpoint: false,
  });
  observeTerminalComposerFrame(trace, frame('prompt text'), {
    at: 21,
    writeSeq: 2,
    terminalRunSeq: 2,
    lifecycleGeneration: 'life-2',
    mirrorGeneration: 'mirror-2',
  });
  const enter = recordTerminalComposerInput(trace, '\r', {
    at: 22,
    kind: 'programmatic-enter',
    sendAttemptId: 'attempt-a',
    terminalRunSeq: 2,
    lifecycleGeneration: 'life-2',
    mirrorGeneration: 'mirror-2',
    checkpoint: true,
  });
  recordTerminalComposerOutput(trace, 'post-enter redraw', { seq: 3, at: 23 });
  observeTerminalComposerFrame(trace, frame('prompt text'), {
    at: 24,
    writeSeq: 3,
    terminalRunSeq: 2,
    lifecycleGeneration: 'life-2',
    mirrorGeneration: 'mirror-2',
  });

  const snapshot = snapshotTerminalComposerForensicWindow(trace, {
    capturedAt: 25,
    inputId: enter.id,
  });

  assert.equal(snapshot.window.anchorFound, true);
  assert.equal(snapshot.window.anchorInputId, enter.id);
  assert.deepEqual(snapshot.inputs.map((entry) => entry.kind), [
    'programmatic-paste',
    'programmatic-enter',
  ]);
  assert.ok(snapshot.transitions.length >= 2);
  assert.ok(snapshot.transitions.every((entry) => entry.frame.terminalRunSeq === 2));
  assert.equal(snapshot.transitions.at(-1).pty.chunks[0].data, 'post-enter redraw');
});

test('anchors concurrent attempt identities independently', () => {
  const trace = createTerminalComposerForensics({ createdAt: 1, maxAgeMs: 60_000 });
  const first = recordTerminalComposerInput(trace, '\r', {
    at: 10,
    kind: 'programmatic-enter',
    sendAttemptId: 'attempt-a',
    terminalRunSeq: 1,
    mirrorGeneration: 'mirror-1',
    checkpoint: true,
  });
  observeTerminalComposerFrame(trace, frame('first'), {
    at: 11,
    terminalRunSeq: 1,
    mirrorGeneration: 'mirror-1',
  });
  const second = recordTerminalComposerInput(trace, '\r', {
    at: 20,
    kind: 'programmatic-enter',
    sendAttemptId: 'attempt-b',
    terminalRunSeq: 1,
    mirrorGeneration: 'mirror-1',
    checkpoint: true,
  });
  observeTerminalComposerFrame(trace, frame('second'), {
    at: 21,
    terminalRunSeq: 1,
    mirrorGeneration: 'mirror-1',
  });

  const firstWindow = snapshotTerminalComposerForensicWindow(trace, {
    capturedAt: 22,
    inputId: first.id,
  });
  const secondWindow = snapshotTerminalComposerForensicWindow(trace, {
    capturedAt: 22,
    inputId: second.id,
  });

  assert.equal(firstWindow.window.anchorInputId, first.id);
  assert.equal(secondWindow.window.anchorInputId, second.id);
  assert.equal(firstWindow.inputs[0].sendAttemptId, 'attempt-a');
  assert.equal(secondWindow.inputs.at(-1).sendAttemptId, 'attempt-b');
});

test('returns a bounded diagnostic tail when the exact Enter checkpoint expired', () => {
  const trace = createTerminalComposerForensics({ createdAt: 1, maxAgeMs: 60_000 });
  for (let index = 0; index < 20; index += 1) {
    recordTerminalComposerInput(trace, String(index), {
      at: 10 + index,
      kind: 'control',
      checkpoint: false,
    });
  }
  const snapshot = snapshotTerminalComposerForensicWindow(trace, {
    capturedAt: 40,
    inputId: 999,
    fallbackInputs: 3,
  });
  assert.equal(snapshot.window.anchorFound, false);
  assert.equal(snapshot.window.reason, 'exact-enter-checkpoint-not-found');
  assert.equal(snapshot.inputs.length, 3);
});

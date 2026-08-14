'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalComposerForensics,
  observeTerminalComposerFrame,
  recordTerminalComposerInput,
  recordTerminalComposerOutput,
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

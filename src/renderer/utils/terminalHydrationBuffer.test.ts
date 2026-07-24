import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendTerminalHydrationChunk,
  beginTerminalHydration,
  createTerminalHydrationActivity,
  createTerminalHydrationBuffer,
  decideTerminalHydrationGeneration,
  drainTerminalHydrationBuffer,
  getTerminalHydrationTailMaxSeq,
  hasNewerTerminalHydrationGeneration,
  isTerminalHydrationActive,
  shouldPreferSavedTerminalCheckpoint,
} from './terminalHydrationBuffer.ts';

test('nested generation retry keeps hydration active until every frame exits', () => {
  const activity = createTerminalHydrationActivity();
  const endOuter = beginTerminalHydration(activity);
  const endRetry = beginTerminalHydration(activity);

  endOuter();
  assert.equal(isTerminalHydrationActive(activity), true);
  endRetry();
  assert.equal(isTerminalHydrationActive(activity), false);
});

test('renderer hydration replays only PTY chunks newer than the main snapshot', () => {
  const buffer = createTerminalHydrationBuffer();
  appendTerminalHydrationChunk(buffer, 'old-a', 10, 'generation-a', 1);
  appendTerminalHydrationChunk(buffer, 'old-b', 11, 'generation-a', 1);
  appendTerminalHydrationChunk(buffer, 'new-a', 12, 'generation-a', 1);
  appendTerminalHydrationChunk(buffer, 'new-b', 13, 'generation-a', 1);

  assert.equal(getTerminalHydrationTailMaxSeq(buffer, 11, 'generation-a'), 13);
  assert.equal(drainTerminalHydrationBuffer(buffer, 11, 'generation-a'), 'new-anew-b');
  assert.equal(buffer.chars, 0);
  assert.deepEqual(buffer.chunks, []);
});

test('unsequenced chunks are retained because the snapshot cannot prove coverage', () => {
  const buffer = createTerminalHydrationBuffer();
  appendTerminalHydrationChunk(buffer, 'legacy', null, null, null);
  appendTerminalHydrationChunk(buffer, 'covered', 4, 'generation-a', 1);
  appendTerminalHydrationChunk(buffer, 'tail', 5, 'generation-a', 1);

  assert.equal(drainTerminalHydrationBuffer(buffer, 4, 'generation-a'), 'legacytail');
});

test('memory cap drops complete old frames and never slices the newest frame', () => {
  const buffer = createTerminalHydrationBuffer();
  appendTerminalHydrationChunk(buffer, 'a'.repeat(6), 1, 'generation-a', 1, 10, 5);
  appendTerminalHydrationChunk(buffer, 'b'.repeat(6), 2, 'generation-a', 1, 10, 5);

  assert.equal(buffer.chunks.length, 1);
  assert.equal(buffer.chunks[0]?.data, 'b'.repeat(6));
  assert.equal(drainTerminalHydrationBuffer(buffer), 'b'.repeat(6));
});

test('live PTY tail can remain untrimmed while the main snapshot is replaying', () => {
  const buffer = createTerminalHydrationBuffer();
  appendTerminalHydrationChunk(
    buffer,
    'a'.repeat(60_000),
    21,
    'generation-a',
    1,
    Number.POSITIVE_INFINITY,
  );
  appendTerminalHydrationChunk(
    buffer,
    'b'.repeat(60_000),
    22,
    'generation-a',
    1,
    Number.POSITIVE_INFINITY,
  );

  assert.equal(buffer.chars, 120_000);
  assert.equal(drainTerminalHydrationBuffer(buffer, 20, 'generation-a').length, 120_000);
});

test('a richer renderer checkpoint is reused only when it matches the main generation', () => {
  const saved = {
    serialized: 'x'.repeat(50),
    headlessWriteSeq: 40,
    headlessGeneration: 'generation-a',
    headlessGenerationOrdinal: 1,
    cols: 80,
    rows: 24,
  };
  const sameMain = {
    serialized: 'x'.repeat(10),
    headlessWriteSeq: 40,
    headlessGeneration: 'generation-a',
    headlessGenerationOrdinal: 1,
    cols: 80,
    rows: 24,
  };
  const newerMain = {
    serialized: 'x'.repeat(10),
    headlessWriteSeq: 41,
    headlessGeneration: 'generation-a',
    headlessGenerationOrdinal: 1,
    cols: 80,
    rows: 24,
  };
  const resetMain = {
    serialized: 'x'.repeat(10),
    headlessWriteSeq: 40,
    headlessGeneration: 'generation-b',
    headlessGenerationOrdinal: 2,
    cols: 80,
    rows: 24,
  };
  const resizedMain = {
    ...sameMain,
    cols: 100,
  };

  assert.equal(shouldPreferSavedTerminalCheckpoint(saved, sameMain), true);
  assert.equal(shouldPreferSavedTerminalCheckpoint(saved, newerMain), false);
  assert.equal(shouldPreferSavedTerminalCheckpoint(saved, resetMain), false);
  assert.equal(shouldPreferSavedTerminalCheckpoint(saved, resizedMain), false);
});

test('a newer mirror generation is detected and old-generation tail is discarded', () => {
  const buffer = createTerminalHydrationBuffer();
  appendTerminalHydrationChunk(buffer, 'old-generation', 41, 'generation-a', 1);
  appendTerminalHydrationChunk(buffer, 'new-generation', 1, 'generation-b', 2);

  assert.equal(hasNewerTerminalHydrationGeneration(buffer, 1), true);
  assert.equal(
    decideTerminalHydrationGeneration(buffer, 1, true),
    'retry-authoritative-snapshot',
  );
  assert.equal(
    decideTerminalHydrationGeneration(buffer, 1, false),
    'preserve-and-retry-later',
  );
  assert.equal(
    drainTerminalHydrationBuffer(buffer, 0, 'generation-b'),
    'new-generation',
  );
});

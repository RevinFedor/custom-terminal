import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createXtermWritePump,
  digestTerminalVisibleText,
  waitForXtermPresentationAfterDrain,
} from './xtermWritePump.ts';

test('renderer pump keeps one write in flight and preserves byte order', async () => {
  const writes: Array<{ data: string; done: () => void }> = [];
  const pump = createXtermWritePump((data, done) => {
    writes.push({ data, done });
  });

  pump.push('a', { generation: 'one', generationOrdinal: 1, writeSeq: 1 });
  pump.push('b', { generation: 'one', generationOrdinal: 1, writeSeq: 2 });
  pump.push('c', { generation: 'one', generationOrdinal: 1, writeSeq: 3 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].data, 'a');
  writes[0].done();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].data, 'bc');
  writes[1].done();
  await pump.drain();
});

test('renderer pump never joins a local marker across PTY generations', () => {
  const writes: Array<{ data: string; done: () => void }> = [];
  const pump = createXtermWritePump((data, done) => {
    writes.push({ data, done });
  });

  pump.push('old', { generation: 'old', generationOrdinal: 1, writeSeq: 10 });
  pump.push('[Process completed]');
  pump.push('new', { generation: 'new', generationOrdinal: 2, writeSeq: 1 });

  writes[0].done();
  assert.equal(writes[1].data, '[Process completed]');
  writes[1].done();
  assert.equal(writes[2].data, 'new');
});

test('surface presentation proof waits for queue drain and a later paint frame', async () => {
  const status = {
    disposed: false,
    failed: null,
    inFlight: false,
    inFlightChars: 0,
    inFlightItems: 0,
    queuedBatches: 0,
    queuedChars: 0,
    queuedItems: 0,
    latestMeta: { generation: 'one', writeSeq: 3 },
  };
  let resolveDrain!: (value: typeof status) => void;
  const drain = new Promise<typeof status>((resolve) => {
    resolveDrain = resolve;
  });
  let frame: FrameRequestCallback | null = null;
  let current = true;
  const proofPromise = waitForXtermPresentationAfterDrain({
    drain: () => drain,
    requestFrame: (callback) => {
      frame = callback;
      return 1;
    },
    isCurrent: () => current,
  });

  resolveDrain(status);
  await Promise.resolve();
  assert.equal(typeof frame, 'function');
  let settled = false;
  void proofPromise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  frame!(0);
  assert.equal((await proofPromise).presented, true);
  current = false;
});

test('surface presentation proof rejects a stale owner and visible digest is stable', async () => {
  const status = {
    disposed: false,
    failed: null,
    inFlight: false,
    inFlightChars: 0,
    inFlightItems: 0,
    queuedBatches: 0,
    queuedChars: 0,
    queuedItems: 0,
    latestMeta: null,
  };
  const proof = await waitForXtermPresentationAfterDrain({
    drain: async () => status,
    requestFrame: () => 1,
    isCurrent: () => false,
  });
  assert.equal(proof.presented, false);
  assert.equal(proof.reason, 'stale-before-paint');
  assert.equal(digestTerminalVisibleText('line one\nline two'), '6917dbef');
  assert.equal(digestTerminalVisibleText('line one\nline two'), '6917dbef');
});

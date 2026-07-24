'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createXtermWritePump } = require('./xterm-write-pump.cjs');

test('keeps one physical write in flight and coalesces the untouched tail', async () => {
  const writes = [];
  const callbacks = [];
  const flushed = [];
  const pump = createXtermWritePump((data, callback) => {
    writes.push(data);
    callbacks.push(callback);
  }, {
    onFlushed: (meta, stats) => flushed.push({ meta, stats }),
  });

  pump.push('a', { seq: 1, generation: 'g', generationOrdinal: 1 });
  pump.push('b', { seq: 2, generation: 'g', generationOrdinal: 1 });
  pump.push('c', { seq: 3, generation: 'g', generationOrdinal: 1 });

  assert.deepEqual(writes, ['a']);
  assert.equal(pump.getStatus().queuedBatches, 1);
  assert.equal(pump.getStatus().queuedChars, 2);

  callbacks.shift()();
  assert.deepEqual(writes, ['a', 'bc']);
  callbacks.shift()();
  await pump.drain();

  assert.deepEqual(flushed.map((item) => item.meta.seq), [1, 3]);
  assert.deepEqual(flushed.map((item) => item.stats.items), [1, 2]);
  assert.equal(pump.getStatus().inFlight, false);
});

test('never merges different terminal generations', async () => {
  const writes = [];
  const callbacks = [];
  const pump = createXtermWritePump((data, callback) => {
    writes.push(data);
    callbacks.push(callback);
  });

  pump.push('old-1', { seq: 1, generation: 'old', generationOrdinal: 1 });
  pump.push('old-2', { seq: 2, generation: 'old', generationOrdinal: 1 });
  pump.push('new-1', { seq: 1, generation: 'new', generationOrdinal: 2 });
  pump.push('new-2', { seq: 2, generation: 'new', generationOrdinal: 2 });

  callbacks.shift()();
  callbacks.shift()();
  callbacks.shift()();
  await pump.drain();

  assert.deepEqual(writes, ['old-1', 'old-2', 'new-1new-2']);
});

test('drain follows data queued before the current callback completes', async () => {
  const callbacks = [];
  const writes = [];
  const pump = createXtermWritePump((data, callback) => {
    writes.push(data);
    callbacks.push(callback);
  });

  pump.push('first', { seq: 1 });
  const drained = pump.drain();
  pump.push('second', { seq: 2 });

  let settled = false;
  drained.then(() => { settled = true; });
  callbacks.shift()();
  await Promise.resolve();
  assert.equal(settled, false);
  callbacks.shift()();
  await drained;
  assert.deepEqual(writes, ['first', 'second']);
});

test('write failure is terminal and releases drain waiters', async () => {
  const errors = [];
  const pump = createXtermWritePump(() => {
    throw new Error('boom');
  }, {
    onError: (error) => errors.push(error.message),
  });

  assert.equal(pump.push('x', { seq: 1 }), true);
  await pump.drain();
  assert.deepEqual(errors, ['boom']);
  assert.equal(pump.push('later', { seq: 2 }), false);
  assert.equal(pump.getStatus().failed, 'boom');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistoryViewportPaintProbe,
  type HistoryViewportPaintOwner,
} from './historyViewportPaintProbe.ts';

const createFrameHarness = () => {
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    requestFrame(callback: FrameRequestCallback) {
      const handle = nextHandle;
      nextHandle += 1;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle: number) {
      frames.delete(handle);
    },
    flushOne() {
      const next = frames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!next) return false;
      const [handle, callback] = next;
      frames.delete(handle);
      callback(0);
      return true;
    },
    get pending() {
      return frames.size;
    },
  };
};

const owner = (key: string, generation: number): HistoryViewportPaintOwner => ({
  key,
  generation,
});

test('unmount before the first mounted row cancels the recurring paint probe', () => {
  const frames = createFrameHarness();
  const probe = createHistoryViewportPaintProbe(frames);
  let published = 0;
  const ownerA = owner('A', 1);

  probe.start(ownerA, () => false, () => { published += 1; });
  assert.equal(frames.flushOne(), true);
  assert.equal(frames.pending, 1);

  probe.cancel(ownerA);

  assert.equal(frames.pending, 0);
  assert.equal(frames.flushOne(), false);
  assert.equal(probe.isActive(ownerA), false);
  assert.equal(published, 0);
});

test('A to B before the first mounted row invalidates A and only publishes B', () => {
  const frames = createFrameHarness();
  const probe = createHistoryViewportPaintProbe(frames);
  const ownerA = owner('A', 1);
  const ownerB = owner('B', 2);
  const published: string[] = [];
  let ownerBMounted = false;

  probe.start(ownerA, () => false, () => published.push('A'));
  assert.equal(frames.flushOne(), true);
  assert.equal(frames.pending, 1);

  probe.start(ownerB, () => ownerBMounted, () => published.push('B'));
  assert.equal(probe.isActive(ownerA), false);
  assert.equal(probe.isActive(ownerB), true);
  assert.equal(frames.pending, 1);

  ownerBMounted = true;
  assert.equal(frames.flushOne(), true);
  assert.equal(published.length, 0);
  assert.equal(frames.pending, 1);
  assert.equal(frames.flushOne(), true);

  assert.deepEqual(published, ['B']);
  assert.equal(probe.isActive(ownerB), false);
  assert.equal(frames.pending, 0);
});

test('a transient previous-owner row must survive the paint boundary before publish', () => {
  const frames = createFrameHarness();
  const probe = createHistoryViewportPaintProbe(frames);
  const ownerB = owner('B', 2);
  let mountedForOwner = true;
  let published = 0;

  probe.start(ownerB, () => mountedForOwner, () => { published += 1; });

  // The first frame sees a row, but it disappears while React replaces the
  // previous virtualized owner. The post-paint frame must not publish ready.
  assert.equal(frames.flushOne(), true);
  mountedForOwner = false;
  assert.equal(frames.flushOne(), true);
  assert.equal(published, 0);
  assert.equal(probe.isActive(ownerB), true);
  assert.equal(frames.pending, 1);

  // A real B row mounts and remains present for a complete paint boundary.
  mountedForOwner = true;
  assert.equal(frames.flushOne(), true);
  assert.equal(frames.flushOne(), true);
  assert.equal(published, 1);
  assert.equal(probe.isActive(ownerB), false);
  assert.equal(frames.pending, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Execute the complete production controller. Only DOM/coordinator and the
// text-anchor measurement boundary are doubles; the writer/control flow below
// is read from the actual shipped module, including its continuation callbacks.
const source = readFileSync(new URL('./historyResizeController.mjs', import.meta.url), 'utf8');
function rig({ guard = true, ready = true, tail = false, omitGuard = false } = {}) {
  const anchor = { kind: tail ? 'tail' : 'entry', key: 'entry:a', uuid: 'a' };
  let prepare, convergence, measured = 0, position = 100, writes = 0, presented = true;
  const frames = [], jumps = [], finished = [];
  const stage = { getBoundingClientRect: () => ({ width: 800 }), contains: () => true };
  const scroller = { clientHeight: 500, scrollHeight: 3000 };
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => position, set: value => { writes++; position = value; },
  });
  const view = {
    addEventListener() {}, removeEventListener() {},
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  const root = { querySelector: () => stage, ownerDocument: { defaultView: view },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  const create = new Function('captureHistoryResizeAnchor', 'measureHistoryResizeAnchor', 'registerHistoryResizeSurface',
    source.replace(/^import[^\n]+\n/, '').replace('export function createHistoryResizeController', 'function createHistoryResizeController')
      + '\nreturn createHistoryResizeController;')(
    () => anchor,
    () => { measured++; return { drift: 20, proof: 'text' }; },
    (_root, callback) => { prepare = callback; return () => {}; },
  );
  let jumpResult = true;
  const options = { root, getScroller: () => scroller, getOwner: () => 'owner:v1',
    isPresented: () => presented, getFollowBottom: () => tail,
    isContentReady: () => ready,
    converge: opts => { convergence = opts; },
    jumpToKey: (...args) => { jumps.push(args); return jumpResult; },
    onPrepare() {}, onPhase() {}, onFinish: outcome => finished.push(outcome),
    requestFrame: callback => { frames.push(callback); return frames.length; }, cancelFrame() {},
  };
  if (!omitGuard) options.canWritePosition = () => guard;
  const controller = create(options);
  const participant = prepare(); participant.activate(); participant.finish(true);
  return { controller, anchor, scroller, jumps, finished, get convergence() { return convergence; },
    setGuard: value => { guard = value; }, setReady: value => { ready = value; },
    setJump: value => { jumpResult = value; }, setPresented: value => { presented = value; },
    stats: () => ({ measured, writes, position }) };
}

test('actual resize controller holds stale/pending composition before drift and before direct mounted-row write', () => {
  const r = rig({ guard: false });
  assert.equal(r.convergence.measureDrift(), null);
  assert.equal(r.convergence.jump(), true, 'pending preserves the current controller continuation');
  assert.deepEqual(r.stats(), { measured: 0, writes: 0, position: 100 });
  assert.equal(r.jumps.length, 0);
  r.setGuard(Promise.resolve(true));
  assert.equal(r.convergence.measureDrift(), null);
  assert.equal(r.convergence.jump(), true, 'a promise is not synchronous position authority');
  assert.equal(r.stats().writes, 0);
  r.setGuard(true);
  assert.equal(r.convergence.measureDrift(), 20);
  assert.equal(r.convergence.jump(), true);
  assert.equal(r.stats().writes, 1);
  assert.equal(r.stats().position, 120, 'same resize resumes after its cut is current');
  r.controller.dispose();
});

test('an unadmitted mounted text anchor delegates to the real async address callback without old DOM writes', async () => {
  const r = rig({ ready: false });
  let resolve; const pending = new Promise(done => { resolve = done; }); r.setJump(pending);
  assert.equal(r.convergence.measureDrift(), null);
  const result = r.convergence.jump();
  assert.equal(result, pending, 'controller returns the actual continuation for convergence to await');
  assert.deepEqual(r.jumps, [['entry:a', 'a']]);
  assert.deepEqual(r.stats(), { measured: 0, writes: 0, position: 100 });
  resolve(true); assert.equal(await result, true);
  r.setReady(true);
  assert.equal(r.convergence.jump(), true);
  assert.equal(r.stats().writes, 1);
  r.controller.dispose();
});

test('legacy direct measurement and the tail callback arguments remain unchanged', async () => {
  const legacy = rig({ omitGuard: true });
  assert.equal(legacy.convergence.measureDrift(), 20);
  assert.equal(legacy.convergence.jump(), true);
  assert.equal(legacy.stats().writes, 1); assert.equal(legacy.jumps.length, 0);
  legacy.controller.dispose();
  const tail = rig({ omitGuard: true, tail: true, ready: false });
  tail.setJump(Promise.resolve(true));
  assert.equal(await tail.convergence.jump(), true);
  assert.deepEqual(tail.jumps, [[null, null, true]]);
  assert.equal(tail.stats().writes, 0);
  tail.setPresented(false);
  assert.equal(tail.convergence.cancelled(), 'hidden');
  tail.controller.dispose(); assert.equal(tail.convergence.cancelled(), 'superseded');
});

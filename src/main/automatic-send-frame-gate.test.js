'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutomaticSendFrameGate } = require('./automatic-send-frame-gate');

function fixture() {
  let mirror = { complete: true, generation: 'G', writeSeq: 176, flushedSeq: 176,
    redrawTrace: { synchronizedOutputOpen: true }, synchronizedFrameWaiters: new Set() };
  let wakes = 0;
  const gate = createAutomaticSendFrameGate({ getMirror: () => mirror });
  return { gate, get mirror() { return mirror; }, replace: value => { mirror = value; },
    read: () => gate.read('T', () => wakes++), wakes: () => wakes,
    flush: () => { for (const fn of [...mirror.synchronizedFrameWaiters]) fn(); } };
}
test('open resumed-history frame parks before an attempt; arbitrarily many flushes cannot authorize input', () => {
  const f = fixture();
  assert.equal(f.read().reason, 'synchronized-output-open');
  for (let n = 0; n < 200; n++) { f.read(); f.flush(); }
  assert.equal(f.mirror.synchronizedFrameWaiters.size, 1); assert.equal(f.wakes(), 0);
  f.mirror.redrawTrace.synchronizedOutputOpen = false;
  f.mirror.writeSeq++; f.flush();
  assert.equal(f.wakes(), 0, 'end marker received but not flushed is not a complete frame');
  f.mirror.flushedSeq = f.mirror.writeSeq; f.flush();
  assert.equal(f.wakes(), 1); assert.equal(f.mirror.synchronizedFrameWaiters.size, 0);
  f.flush(); assert.equal(f.wakes(), 1); assert.equal(f.read().ready, true);
});
test('resize requires a later flushed frame, not a timer or an old closed snapshot', () => {
  const f = fixture(); f.mirror.redrawTrace.synchronizedOutputOpen = false;
  f.mirror.pendingResizeWriteSeq = 176;
  assert.equal(f.read().reason, 'post-resize-frame-not-observed'); f.flush(); assert.equal(f.wakes(), 0);
  f.mirror.writeSeq = f.mirror.flushedSeq = 177; f.flush(); assert.equal(f.wakes(), 1);
});
test('replacement/failure/disposal only wake revalidation and release the old observer', () => {
  for (const kind of ['replacement', 'failure', 'disposal']) {
    const f = fixture(); f.read(); const old = f.mirror;
    if (kind === 'replacement') f.replace(null);
    else if (kind === 'failure') old.failed = true;
    else old.disposed = true;
    for (const fn of [...old.synchronizedFrameWaiters]) fn();
    assert.equal(f.wakes(), 1); assert.equal(old.synchronizedFrameWaiters.size, 0);
    assert.equal(f.read().ready, false);
  }
});
test('clear/dispose never send a wake or keep a hidden polling job', () => {
  const f = fixture(); f.read(); f.gate.clear('T'); f.flush(); assert.equal(f.wakes(), 0);
  f.read(); f.gate.dispose(); assert.equal(f.mirror.synchronizedFrameWaiters.size, 0);
});

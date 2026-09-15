import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryWheelDiagnostics } from './historyWheelDiagnostics.mjs';

function fixture(extra = {}) {
  let clock = 0, nextId = 0;
  let scope = { tab: 'tab-4196', owner: 'reader-a', generation: 1, visit: 30, presented: true };
  const logs = [], tasks = new Map(), frames = new Map();
  const diag = createHistoryWheelDiagnostics({
    context: () => scope, now: () => clock, timeOrigin: 1000000,
    log: line => logs.push(JSON.parse(line.replace(/^WHEEL_PIPELINE /, ''))),
    defer: fn => { const id = ++nextId; tasks.set(id, fn); return id; },
    cancelDeferred: id => tasks.delete(id),
    frame: fn => { const id = ++nextId; frames.set(id, fn); return id; },
    cancelFrame: id => frames.delete(id), ...extra,
  });
  const drain = map => { const batch = [...map.values()]; map.clear(); batch.forEach(fn => fn()); };
  return { diag, logs, tasks, frames,
    at: value => { clock = value; },
    scope: patch => { scope = { ...scope, ...patch }; },
    flush: () => drain(tasks), raf: () => drain(frames),
  };
}
function wheel(timeStamp = 0, deltaY = -4) {
  return { type: 'wheel', isTrusted: true, timeStamp, deltaY, deltaMode: 0,
    cancelable: true, defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
  };
}

test('separates delivery, each handler, post-handler wait and observed scroll; output is deferred', () => {
  const f = fixture(), event = wheel();
  const tool = f.diag.wrap('tool', () => { f.at(83); return 12; });
  const intent = f.diag.wrap('intent', () => { f.at(85); return 13; });
  f.at(81.7); assert.equal(tool(event), 12);
  f.at(84); assert.equal(intent(event), 13);
  assert.equal(f.logs.length, 0, 'no console/IPC from either handler');
  assert.equal(f.tasks.size, 1, 'one coalesced output task');
  f.at(335); f.raf();
  f.at(405); f.diag.observeScroll(66005.5, 400);
  f.at(430); f.raf(); f.flush();
  const by = phase => f.logs.find(item => item.phase === phase);
  assert.equal(by('tool').delayToEnterMs, 81.7);
  assert.equal(by('tool').handlerMs, 1.3);
  assert.equal(by('intent').handlerMs, 1);
  assert.equal(by('raf-after-handlers').scrollObserved, false);
  assert.equal(by('scroll-observed').fromEventMs, 405);
  assert.equal(by('scroll-observed').afterIntentMs, 320);
  assert.equal(by('scroll-observed').scrollHandlerEnterAbs, 1000400);
  assert.equal(by('scroll-observed').beforeObservationMs, 5);
  assert.equal(by('raf-after-scroll').firstScrollAbs, 1000405);
  assert.equal(by('tool').logLagMs, 347);
  assert.equal(new Set(f.logs.map(item => item.id)).size, 1);
  assert.ok(f.logs.every(item => !item.phase.includes('paint')), 'rAF is not pixel proof');
});

test('long handler is distinct from slow delivery and original exception/this/arguments survive', () => {
  const f = fixture(), event = wheel(10), receiver = { n: 0 }, failure = new Error('original');
  const handler = f.diag.wrap('tool', function (received, amount) {
    assert.equal(received, event); this.n += amount; f.at(220); throw failure;
  });
  f.at(20); assert.throws(() => handler.call(receiver, event, 3), err => err === failure);
  f.flush();
  assert.equal(receiver.n, 3);
  assert.equal(f.logs[0].handlerMs, 200);
  assert.equal(f.logs[0].delayToEnterMs, 10);
  assert.equal(f.logs[0].threw, true);
});

test('inner consumption and edge chaining are labelled without diagnostics changing the event', () => {
  for (const branch of ['none', 'inner', 'edge']) {
    const f = fixture(), event = wheel();
    f.diag.wrap('tool', e => {
      if (branch === 'none') return;
      f.diag.toolBranch(e, branch); e.preventDefault();
      if (branch === 'inner') e.stopPropagation();
    })(event);
    f.at(10); f.diag.observeScroll(100); f.flush();
    const record = f.logs.find(item => item.phase === 'tool');
    assert.equal(record.branch, branch);
    assert.equal(record.defaultPrevented, branch !== 'none');
    assert.equal(record.propagationStopped, branch === 'inner');
    assert.equal(f.logs.some(item => item.phase === 'scroll-observed'), branch !== 'inner');
  }
});

test('does not read target/DOM/geometry and ignores hidden, synthetic, touch and horizontal-only events', () => {
  const f = fixture(); let calls = 0;
  const run = f.diag.wrap('tool', () => calls++);
  const event = wheel();
  for (const field of ['target', 'currentTarget', 'scrollTop', 'clientHeight', 'getBoundingClientRect']) {
    Object.defineProperty(event, field, { get() { assert.fail('extra DOM read: ' + field); } });
  }
  run(event);
  for (const input of [{ ...wheel(), isTrusted: false }, { ...wheel(), type: 'touchmove' }, wheel(2, 0)]) run(input);
  f.scope({ presented: false }); run(wheel(3)); f.flush();
  assert.equal(calls, 5); assert.equal(f.logs.length, 1);
});

test('first packet remains observable if another burst arrives before delayed native scroll', () => {
  const f = fixture(), run = f.diag.wrap('tool', () => {});
  run(wheel()); f.at(365); run(wheel(300, -92.8));
  f.at(405); f.diag.observeScroll(66005.5); f.flush();
  const observed = f.logs.filter(item => item.phase === 'scroll-observed');
  assert.equal(observed.length, 2);
  assert.equal(observed[0].fromEventMs, 405);
  assert.equal(observed[1].fromEventMs, 105);
  assert.deepEqual(observed.map(item => item.burst), [1, 2]);
});

test('sampling is bounded without suppressing a single real handler call', () => {
  const f = fixture(); let calls = 0;
  const tool = f.diag.wrap('tool', () => calls++), intent = f.diag.wrap('intent', () => calls++);
  for (let i = 0; i < 2000; i++) {
    f.at(i); const event = wheel(i); tool(event); intent(event);
  }
  assert.equal(calls, 4000); assert.equal(f.frames.size, 1); assert.equal(f.tasks.size, 1);
  f.flush(); assert.equal(f.logs.length, 6);
  assert.equal(new Set(f.logs.map(item => item.id)).size, 3);
  f.at(3000); tool(wheel(3000)); f.flush();
  assert.equal(f.logs.at(-1).packet, 1);
});

test('bounded pending samples, frames and deferred queue remain explicit when browser tasks cannot run', () => {
  const f = fixture(), run = f.diag.wrap('tool', () => {});
  for (let i = 0; i < 100; i++) { f.at(i * 300); run(wheel(i * 300)); }
  assert.ok(f.frames.size <= 8); assert.equal(f.tasks.size, 1);
  f.flush(); assert.ok(f.logs.length <= 48); assert.ok(f.logs.some(item => item.droppedLines > 0));
  f.logs.length = 0; f.diag.observeScroll(3); f.flush();
  assert.equal(f.logs.filter(item => item.phase === 'scroll-observed').length, 12);
});

test('hide/show, generation and owner changes cannot attach old wheel to new surface movement', () => {
  for (const change of [{ presented: false }, { visit: 31 }, { generation: 2 }, { owner: 'reader-b' }]) {
    const f = fixture(); f.diag.wrap('tool', () => {})(wheel());
    f.scope(change); f.at(500); f.diag.observeScroll(90); f.raf(); f.flush();
    assert.ok(!f.logs.some(item => item.phase === 'scroll-observed'));
    assert.ok(f.logs.some(item => item.reason === 'presentation-changed'));
  }
});

test('a replacement scroller cancels frames and does not consume subsequent user input', () => {
  const f = fixture(), run = f.diag.wrap('tool', () => 'ok');
  run(wheel()); f.diag.reset(); assert.equal(f.frames.size, 0);
  f.diag.observeScroll(77); f.at(1); assert.equal(run(wheel(1)), 'ok'); f.flush();
  assert.equal(f.logs.filter(item => item.phase === 'tool').length, 2);
  assert.equal(f.logs.at(-1).packet, 1);
  assert.ok(!f.logs.some(item => item.phase === 'scroll-observed'));
});

test('dispose releases scheduled frames and flushes the collected evidence outside cleanup', () => {
  const f = fixture(); f.diag.wrap('tool', () => {})(wheel()); f.diag.dispose();
  assert.equal(f.frames.size, 0); assert.equal(f.logs.length, 0); assert.equal(f.tasks.size, 1);
  f.flush(); assert.ok(f.logs.some(item => item.reason === 'disposed'));
  assert.equal(f.tasks.size, 0);
});

test('observer failures cannot replace handler result, skip the call or escape from queued work', () => {
  for (const extra of [
    { context() { throw new Error('observer'); } },
    { defer() { throw new Error('observer'); } },
    { frame() { throw new Error('observer'); } },
    { log() { throw new Error('observer'); } },
  ]) {
    const f = fixture(extra); let count = 0;
    assert.equal(f.diag.wrap('tool', () => { count++; return 42; })(wheel()), 42);
    assert.equal(count, 1); assert.doesNotThrow(() => f.flush());
  }
});

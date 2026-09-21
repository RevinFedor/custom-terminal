'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');

const unknown = reason => ({ proofOutcome: 'unknown', hasDraft: null, proofReason: reason || 'not-settled' });
const absent = { proofOutcome: 'absent', hasDraft: false };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function waitUntil(predicate, message) {
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message || 'condition did not become true');
}

function fakeClock(start = 0) {
  let time = start;
  let nextId = 0;
  const timers = new Map();
  const cleared = [];
  const setCalls = [];
  return {
    now: () => time,
    timers,
    cleared,
    setCalls,
    setTimer(callback, delayMs) {
      const id = ++nextId;
      const due = time + Math.max(0, Number(delayMs) || 0);
      timers.set(id, { callback, due });
      setCalls.push({ id, delayMs, due });
      return id;
    },
    clearTimer(id) {
      cleared.push(id);
      timers.delete(id);
    },
    advance(ms) {
      time += ms;
      const dueTimers = [...timers.entries()]
        .filter(([, timer]) => timer.due <= time)
        .sort((a, b) => a[1].due - b[1].due);
      for (const [id, timer] of dueTimers) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function makeObservation({ clock = fakeClock(), timeoutMs = 100, isCurrent = () => true,
  subscribe = () => () => {}, cleanupFailure = null } = {}) {
  const observation = createAgentInputObservation({
    timeoutMs,
    isCurrent,
    subscribe: wake => {
      const cleanup = subscribe(wake);
      return () => {
        cleanup?.();
        if (cleanupFailure) throw cleanupFailure;
      };
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { observation, clock };
}

test('arms subscription before first read and catches a wake delivered during that read', async () => {
  const order = [];
  let wake;
  let probes = 0;
  const { observation } = makeObservation({
    subscribe: callback => { order.push('subscribe'); wake = callback; return () => {}; },
  });
  const resultPromise = observeAgentInput({
    observation,
    probe: () => {
      order.push('probe-' + (++probes));
      if (probes === 1) {
        // The event arrives after the loop snapshots its revision but before
        // the first unknown result resolves. The subsequent wait must not lose it.
        wake();
        return unknown('first-frame-open');
      }
      return { proofOutcome: 'found', hasDraft: true };
    },
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  });
  const result = await resultPromise;
  assert.deepEqual(order, ['subscribe', 'probe-1', 'probe-2']);
  assert.equal(result.value.proofOutcome, 'found');
  assert.equal(result.checks, 2);
});

test('stable unknown waits for a real event without polling; the event itself is not proof', async () => {
  const clock = fakeClock();
  let wake;
  let probes = 0;
  let settled = false;
  const { observation } = makeObservation({
    clock,
    subscribe: callback => { wake = callback; return () => {}; },
  });
  const resultPromise = observeAgentInput({
    observation,
    probe: () => {
      probes += 1;
      return probes < 3 ? unknown('frame-unsettled') : absent;
    },
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  }).then(result => { settled = true; return result; });

  await waitUntil(() => probes === 1, 'initial read should happen once');
  clock.advance(40);
  await flushMicrotasks();
  assert.equal(probes, 1, 'time passing must not poll an unknown owner');
  assert.equal(settled, false);

  wake();
  await waitUntil(() => probes === 2, 'wake should trigger one new read');
  await flushMicrotasks();
  assert.equal(settled, false, 'wake alone must not settle an unknown observation');
  assert.equal(probes, 2);

  wake();
  const result = await resultPromise;
  assert.equal(result.value, absent);
  assert.equal(result.checks, 3);
  assert.equal(probes, 3);
});

test('owner, input-revision, and Stop ABA revocation all beat a late settled probe', async t => {
  const cases = [
    ['terminal owner changed', live => { live.terminal = 'replacement-terminal'; }],
    ['mirror owner changed', live => { live.mirrorGeneration += 1; }],
    ['input changed then screen restored', live => {
      live.inputRevision += 1;
      live.screen = 'temporarily changed';
      live.screen = 'original-screen';
    }],
    ['Stop began and cleared (ABA)', live => {
      live.stopRevision += 1;
      live.stopping = true;
      live.stopRevision += 1;
      live.stopping = false;
    }],
  ];

  for (const [name, revoke] of cases) {
    await t.test(name, async () => {
      const captured = {
        terminal: 'terminal-a', mirrorGeneration: 4, inputRevision: 17,
        stopRevision: 2, stopping: false, screen: 'original-screen',
      };
      const live = { ...captured };
      let wake;
      let finalReads = 0;
      const pending = deferred();
      const { observation } = makeObservation({
        isCurrent: () => live.terminal === captured.terminal
          && live.mirrorGeneration === captured.mirrorGeneration
          && live.inputRevision === captured.inputRevision
          && live.stopRevision === captured.stopRevision
          && live.stopping === captured.stopping,
        subscribe: callback => { wake = callback; return () => {}; },
      });
      const resultPromise = observeAgentInput({
        observation,
        probe: () => pending.promise,
        finalProbe: () => { finalReads += 1; return absent; },
        isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
        shouldWait: value => value?.proofOutcome === 'unknown',
      });

      await flushMicrotasks();
      revoke(live);
      wake();
      const result = await resultPromise;
      assert.equal(result.reason, 'owner-changed');
      assert.equal(result.value, null);
      assert.equal(finalReads, 0);
      pending.resolve(absent);
      await flushMicrotasks();
      assert.equal(result.value, null, 'the late old read cannot replace revocation');
    });
  }
});

test('post-await owner validation rejects a settled payload even when no wake event arrived', async () => {
  const captured = { terminal: 'terminal-a', inputRevision: 8, stopRevision: 3 };
  const live = { ...captured };
  const pending = deferred();
  let finalReads = 0;
  const { observation } = makeObservation({
    isCurrent: () => live.terminal === captured.terminal
      && live.inputRevision === captured.inputRevision
      && live.stopRevision === captured.stopRevision,
  });
  const resultPromise = observeAgentInput({
    observation,
    probe: () => pending.promise,
    finalProbe: () => { finalReads += 1; return absent; },
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  });

  await flushMicrotasks();
  live.inputRevision += 1;
  pending.resolve(absent);
  const result = await resultPromise;
  assert.equal(result.reason, 'owner-changed');
  assert.equal(result.value, null);
  assert.equal(finalReads, 0);
});

test('one deadline spans the initial read, event wait, and later reads; only sync final read may settle', async () => {
  const clock = fakeClock();
  let wake;
  let probes = 0;
  let finalReads = 0;
  const pendingSecondProbe = deferred();
  const { observation } = makeObservation({
    clock,
    timeoutMs: 100,
    subscribe: callback => { wake = callback; return () => {}; },
  });
  const resultPromise = observeAgentInput({
    observation,
    probe: () => {
      probes += 1;
      return probes === 1 ? unknown('initial') : pendingSecondProbe.promise;
    },
    finalProbe: () => { finalReads += 1; return absent; },
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  });

  await waitUntil(() => probes === 1);
  clock.advance(60);
  wake();
  await waitUntil(() => probes === 2);
  assert.equal(clock.setCalls.length, 1, 'the observation owns one fixed timer');
  assert.equal(clock.setCalls[0].due, 100);
  clock.advance(40);
  const result = await resultPromise;
  assert.equal(result.value, absent, 'a same-owner synchronous final frame can settle the deadline');
  assert.equal(result.observation.status, 'settled');
  assert.equal(result.observation.elapsedMs, 100);
  assert.equal(probes, 2);
  assert.equal(finalReads, 1);
  assert.equal(clock.cleared.length, 1);

  pendingSecondProbe.resolve({ proofOutcome: 'found', hasDraft: true });
  await flushMicrotasks();
  assert.equal(result.value, absent, 'late async output is ignored after the deadline final read');
});

test('deadline final read stays unknown unless a synchronous current frame settles it', async t => {
  await t.test('unknown final frame remains expired', async () => {
    const clock = fakeClock();
    const { observation } = makeObservation({ clock, timeoutMs: 25 });
    const resultPromise = observeAgentInput({
      observation,
      probe: () => unknown('frame-open'),
      finalProbe: () => unknown('still-open'),
      isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
      shouldWait: value => value?.proofOutcome === 'unknown',
    });
    await flushMicrotasks();
    clock.advance(25);
    const result = await resultPromise;
    assert.equal(result.value, null);
    assert.equal(result.reason, 'deadline');
    assert.equal(result.observation.status, 'expired');
  });

  await t.test('asynchronous final frame is rejected', async () => {
  const clock = fakeClock();
  const pending = deferred();
  const { observation } = makeObservation({ clock, timeoutMs: 25 });
  const resultPromise = observeAgentInput({
    observation,
    probe: () => unknown('frame-open'),
    finalProbe: () => pending.promise.then(() => absent),
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  });
  await flushMicrotasks();
  clock.advance(25);
  const result = await resultPromise;
  assert.equal(result.value, null);
  assert.equal(result.reason, 'read-failed');
  pending.resolve();
  await flushMicrotasks();
  assert.equal(result.value, null);
  });
});

test('owner revocation wins over an expired deadline and forbids the final read', async () => {
  const clock = fakeClock();
  let current = true;
  let finalReads = 0;
  const pending = deferred();
  const { observation } = makeObservation({
    clock,
    timeoutMs: 10,
    isCurrent: () => current,
  });
  const resultPromise = observeAgentInput({
    observation,
    probe: () => pending.promise,
    finalProbe: () => { finalReads += 1; return absent; },
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  });
  await flushMicrotasks();
  clock.advance(10); // deadline signal wins the Promise.race first
  current = false; // then the owner revokes before the continuation/final read
  const result = await resultPromise;
  assert.equal(result.reason, 'owner-changed');
  assert.equal(result.observation.status, 'superseded');
  assert.equal(finalReads, 0);
  pending.resolve(absent);
});

test('cleanup runs once and cleanup failure does not rewrite a settled read', async () => {
  const clock = fakeClock();
  let cleanupCalls = 0;
  const { observation } = makeObservation({
    clock,
    subscribe: () => () => { cleanupCalls += 1; },
    cleanupFailure: new Error('test cleanup error'),
  });
  const result = await observeAgentInput({
    observation,
    probe: () => absent,
    isSettled: value => value?.proofOutcome === 'found' || value?.proofOutcome === 'absent',
    shouldWait: value => value?.proofOutcome === 'unknown',
  });
  observation.dispose();
  assert.equal(result.value, absent);
  assert.equal(result.observation.status, 'settled');
  assert.equal(cleanupCalls, 1);
  assert.equal(clock.cleared.length, 1);
});

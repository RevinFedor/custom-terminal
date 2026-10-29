import assert from 'node:assert/strict';
import test from 'node:test';

import { createDormantSurfaceAdmissionQueue } from './dormantSurfaceAdmission.mjs';

const scheduler = () => {
  const queue = [];
  return {
    schedule(callback) {
      const entry = { callback, cancelled: false };
      queue.push(entry);
      return () => { entry.cancelled = true; };
    },
    flushOne() {
      const entry = queue.shift();
      if (entry && !entry.cancelled) entry.callback();
    },
    size: () => queue.filter((entry) => !entry.cancelled).length,
  };
};

test('N hidden jobs are completion-serial, not frame-start serial', () => {
  const idle = scheduler();
  const starts = [];
  const leases = new Map();
  const admission = createDormantSurfaceAdmissionQueue({
    schedule: idle.schedule,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  for (const key of ['a', 'b', 'c']) {
    admission.enqueue(key, (lease) => {
      starts.push(key);
      leases.set(key, lease);
    });
  }

  assert.equal(idle.size(), 1, 'one idle boundary admits the head only');
  idle.flushOne();
  assert.deepEqual(starts, ['a']);
  assert.equal(idle.size(), 0, 'no frame-paced fan-out while a is in flight');
  assert.equal(leases.get('a').complete('history+timeline-settled'), true);
  assert.equal(idle.size(), 1, 'completion schedules exactly one new idle boundary');
  assert.deepEqual(starts, ['a']);
  idle.flushOne();
  assert.deepEqual(starts, ['a', 'b']);
});

test('foreground promotion removes a queued hidden job without waiting', () => {
  const idle = scheduler();
  const starts = [];
  const admission = createDormantSurfaceAdmissionQueue({
    schedule: idle.schedule,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  admission.enqueue('hidden-a', () => starts.push('hidden-a'));
  admission.enqueue('visible-b', () => starts.push('visible-b'));
  assert.equal(admission.promote('visible-b'), 'queued');
  // The caller wakes visible-b synchronously; admission starts only hidden-a.
  idle.flushOne();
  assert.deepEqual(starts, ['hidden-a']);
  assert.deepEqual(admission.pendingKeys(), []);
});

test('unmount/failure releases and stale lease cannot release the next job', () => {
  const idle = scheduler();
  const leases = [];
  const admission = createDormantSurfaceAdmissionQueue({
    schedule: idle.schedule,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  admission.enqueue('a', (lease) => leases.push(lease));
  admission.enqueue('b', (lease) => leases.push(lease));
  idle.flushOne();
  assert.equal(admission.cancel('a', 'unmount'), true);
  idle.flushOne();
  assert.equal(admission.activeKey(), 'b');
  assert.equal(leases[0].complete('stale-success'), false);
  assert.equal(admission.activeKey(), 'b');
  assert.equal(leases[1].complete('load-failed'), true);
  assert.equal(admission.activeKey(), null);
});

test('timeout reports unfinished work without admitting another hidden job', () => {
  const idle = scheduler();
  let timeoutCallback = null;
  const starts = [];
  const leases = [];
  const events = [];
  const admission = createDormantSurfaceAdmissionQueue({
    schedule: idle.schedule,
    setTimer: (callback) => { timeoutCallback = callback; return 7; },
    clearTimer: () => {},
    onTransition: event => events.push(event),
  });
  admission.enqueue('a', lease => { starts.push('a'); leases.push(lease); });
  admission.enqueue('b', lease => { starts.push('b'); leases.push(lease); });
  idle.flushOne();
  timeoutCallback();
  idle.flushOne();
  assert.deepEqual(starts, ['a']);
  assert.equal(admission.activeKey(), 'a');
  assert.equal(events.filter(event => event.phase === 'overdue').length, 1);
  assert.equal(leases[0].reportOverdue('component-timeout'), false, 'deadline is reported once');
  assert.equal(leases[0].complete('late-source-settled'), true);
  idle.flushOne();
  assert.deepEqual(starts, ['a', 'b']);
  assert.equal(leases[0].complete('stale-settled'), false);
  assert.equal(leases[0].reportOverdue('stale-timeout'), false);
  assert.equal(admission.activeKey(), 'b');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enqueueAgentSendScenario,
  pendingAgentSendScenarioCount,
} from './agentSendSequencer.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('distinct sends to one tab run FIFO and keep their own results', async () => {
  const gate = deferred();
  const events = [];
  const first = enqueueAgentSendScenario({
    tabId: 'tab-fifo',
    handoffId: 'handoff-a',
    run: async () => {
      events.push('a:start');
      await gate.promise;
      events.push('a:end');
      return 'result-a';
    },
  });
  const second = enqueueAgentSendScenario({
    tabId: 'tab-fifo',
    handoffId: 'handoff-b',
    run: async () => {
      events.push('b:start');
      return 'result-b';
    },
  });

  await nextTurn();
  assert.deepEqual(events, ['a:start']);
  assert.equal(pendingAgentSendScenarioCount('tab-fifo'), 2);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['result-a', 'result-b']);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
  assert.equal(pendingAgentSendScenarioCount('tab-fifo'), 0);
});

test('an exact handoff retry joins only its own in-flight send', async () => {
  const gate = deferred();
  let calls = 0;
  const first = enqueueAgentSendScenario({
    tabId: 'tab-idempotent',
    handoffId: 'same-handoff',
    run: async () => {
      calls += 1;
      await gate.promise;
      return 'one-result';
    },
  });
  const duplicate = enqueueAgentSendScenario({
    tabId: 'tab-idempotent',
    handoffId: 'same-handoff',
    run: async () => {
      calls += 1;
      return 'wrong-result';
    },
  });
  assert.equal(first, duplicate);
  gate.resolve();
  assert.equal(await duplicate, 'one-result');
  assert.equal(calls, 1);
});

test('a failed send does not block the next queued intent', async () => {
  const events = [];
  const first = enqueueAgentSendScenario({
    tabId: 'tab-recovery',
    handoffId: 'fail',
    run: async () => {
      events.push('fail');
      throw new Error('expected failure');
    },
  });
  const second = enqueueAgentSendScenario({
    tabId: 'tab-recovery',
    handoffId: 'next',
    run: async () => {
      events.push('next');
      return 'recovered';
    },
  });
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'recovered');
  assert.deepEqual(events, ['fail', 'next']);
});

test('different tabs remain parallel', async () => {
  const gateA = deferred();
  const gateB = deferred();
  const started = [];
  const first = enqueueAgentSendScenario({
    tabId: 'tab-parallel-a',
    run: async () => {
      started.push('a');
      await gateA.promise;
    },
  });
  const second = enqueueAgentSendScenario({
    tabId: 'tab-parallel-b',
    run: async () => {
      started.push('b');
      await gateB.promise;
    },
  });
  await nextTurn();
  assert.deepEqual(started.sort(), ['a', 'b']);
  gateA.resolve();
  gateB.resolve();
  await Promise.all([first, second]);
});

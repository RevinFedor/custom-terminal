import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginCoordinatedAgentSend,
  getCoordinatedAgentAction,
  requestCoordinatedStopAfterSend,
  resetCoordinatedAgentActionsForTests,
  settleCoordinatedAgentSend,
  subscribeCoordinatedAgentActions,
} from './agentActionCoordinator.mjs';

test.beforeEach(() => {
  resetCoordinatedAgentActionsForTests();
});

test('queued Stop survives a view switch and runs exactly once after Send settles', async () => {
  const events = [];
  subscribeCoordinatedAgentActions((event) => events.push(event.reason));
  const send = beginCoordinatedAgentSend('tab-a', 100);
  assert.equal(send.started, true);

  const queued = requestCoordinatedStopAfterSend('tab-a', 140);
  const duplicate = requestCoordinatedStopAfterSend('tab-a', 150);
  assert.equal(queued.queued, true);
  assert.equal(queued.deduped, false);
  assert.equal(duplicate.deduped, true);

  // Looking at another tab does not consume or reset tab-a's scenario state.
  assert.equal(getCoordinatedAgentAction('tab-b'), null);
  assert.equal(getCoordinatedAgentAction('tab-a')?.stopRequestedAt, 140);

  let stopCalls = 0;
  const settled = await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: send.token,
    runQueuedStop: async () => {
      stopCalls += 1;
      return { success: true };
    },
  });
  assert.equal(settled.stopped, true);
  assert.equal(stopCalls, 1);
  assert.equal(getCoordinatedAgentAction('tab-a'), null);
  assert.deepEqual(events, [
    'send-started',
    'stop-queued',
    'queued-stop-started',
    'queued-stop-complete',
  ]);
});

test('settling a Send without Stop never invokes the Stop runner', async () => {
  const send = beginCoordinatedAgentSend('tab-a', 100);
  let stopCalls = 0;
  const settled = await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: send.token,
    runQueuedStop: async () => {
      stopCalls += 1;
      return { success: true };
    },
  });
  assert.equal(settled.reason, 'send-settled');
  assert.equal(stopCalls, 0);
  assert.equal(getCoordinatedAgentAction('tab-a'), null);
});

test('a stale Send token cannot consume a newer per-tab action', async () => {
  const first = beginCoordinatedAgentSend('tab-a', 100);
  await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: first.token,
    runQueuedStop: async () => ({ success: true }),
  });
  const second = beginCoordinatedAgentSend('tab-a', 200);
  const stale = await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: first.token,
    runQueuedStop: async () => ({ success: true }),
  });
  assert.equal(stale.settled, false);
  assert.equal(getCoordinatedAgentAction('tab-a')?.token, second.token);
});

test('an unknown queued Stop result is a failure, not a proven stop', async () => {
  const send = beginCoordinatedAgentSend('tab-a', 100);
  requestCoordinatedStopAfterSend('tab-a', 120);
  const settled = await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: send.token,
    runQueuedStop: async () => undefined,
  });
  assert.equal(settled.stopped, false);
  assert.equal(settled.reason, 'queued-stop-failed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginCoordinatedAgentSend,
  bindCoordinatedAgentSendHandoff,
  cancelCoordinatedAgentSendFollowers,
  createCoordinatedAgentSendCancellationWait,
  getCoordinatedAgentAction,
  isCoordinatedAgentSendCancellationRequested,
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

test('queued Stop wakes the exact in-flight readiness wait before submit', async () => {
  const first = beginCoordinatedAgentSend('tab-a', 100);
  const wait = createCoordinatedAgentSendCancellationWait('tab-a', first.token);
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-a', first.token), false);

  requestCoordinatedStopAfterSend('tab-a', 125);
  const cancelled = await wait.promise;
  assert.equal(cancelled.token, first.token);
  assert.equal(cancelled.stopRequestedAt, 125);
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-a', first.token), true);
});

test('binds one exact handoff so Stop can cancel the matching main-side write', () => {
  const send = beginCoordinatedAgentSend('tab-a', 100);
  const bound = bindCoordinatedAgentSendHandoff('tab-a', send.token, 'handoff-a');
  assert.equal(bound.bound, true);
  assert.equal(getCoordinatedAgentAction('tab-a')?.handoffId, 'handoff-a');
  assert.equal(bindCoordinatedAgentSendHandoff('tab-a', send.token, 'handoff-b').bound, false);
});

test('Stop for a newer action cannot cancel a stale readiness waiter', async () => {
  const first = beginCoordinatedAgentSend('tab-a', 100);
  await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: first.token,
    runQueuedStop: async () => ({ success: true }),
  });
  const staleWait = createCoordinatedAgentSendCancellationWait('tab-a', first.token);
  const second = beginCoordinatedAgentSend('tab-a', 200);
  requestCoordinatedStopAfterSend('tab-a', 225);

  const outcome = await Promise.race([
    staleWait.promise.then(() => 'stale-cancelled'),
    Promise.resolve('not-cancelled'),
  ]);
  staleWait.cancel();
  assert.equal(outcome, 'not-cancelled');
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-a', first.token), false);
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-a', second.token), true);
});

test('distinct accepted sends keep FIFO coordinator ownership across settlement', async () => {
  const first = beginCoordinatedAgentSend('tab-a', 100, { recordWithoutReply: true });
  const second = beginCoordinatedAgentSend('tab-a', 101);
  assert.equal(first.started, true);
  assert.equal(second.started, true);
  assert.equal(second.queued, true);
  assert.equal(getCoordinatedAgentAction('tab-a')?.token, first.token);
  assert.equal(getCoordinatedAgentAction('tab-a')?.queuedSendCount, 1);
  assert.equal(getCoordinatedAgentAction('tab-a')?.recordWithoutReply, true);
  assert.equal(bindCoordinatedAgentSendHandoff('tab-a', first.token, 'handoff-a').bound, true);
  assert.equal(bindCoordinatedAgentSendHandoff('tab-a', second.token, 'handoff-b').bound, true);

  await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: first.token,
    runQueuedStop: async () => ({ success: true }),
  });
  assert.equal(getCoordinatedAgentAction('tab-a')?.token, second.token);
  assert.equal(getCoordinatedAgentAction('tab-a')?.handoffId, 'handoff-b');
  assert.equal(getCoordinatedAgentAction('tab-a')?.queuedSendCount, 0);

  await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: second.token,
    runQueuedStop: async () => ({ success: true }),
  });
  assert.equal(getCoordinatedAgentAction('tab-a'), null);
});

test('Stop marks queued follower intents so none can submit after the head is cancelled', async () => {
  const first = beginCoordinatedAgentSend('tab-a', 100);
  const second = beginCoordinatedAgentSend('tab-a', 101);
  requestCoordinatedStopAfterSend('tab-a', 125);
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-a', first.token), true);
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-a', second.token), true);

  await settleCoordinatedAgentSend({
    tabId: 'tab-a',
    token: first.token,
    runQueuedStop: async () => ({ success: true }),
  });
  const followerWait = createCoordinatedAgentSendCancellationWait('tab-a', second.token);
  const cancelled = await followerWait.promise;
  assert.equal(cancelled.token, second.token);
  assert.equal(cancelled.stopRequestedAt, 125);
});

test('a failed history-record head cancels followers without requesting a process Stop', async () => {
  const first = beginCoordinatedAgentSend('tab-record', 100, { recordWithoutReply: true });
  const second = beginCoordinatedAgentSend('tab-record', 101);
  const third = beginCoordinatedAgentSend('tab-record', 102);
  bindCoordinatedAgentSendHandoff('tab-record', second.token, 'handoff-b');
  bindCoordinatedAgentSendHandoff('tab-record', third.token, 'handoff-c');
  const cascade = cancelCoordinatedAgentSendFollowers('tab-record', first.token, 'record-failed', 130);
  assert.equal(cascade.cancelled, 2);
  assert.deepEqual(cascade.handoffIds, ['handoff-b', 'handoff-c']);

  await settleCoordinatedAgentSend({
    tabId: 'tab-record',
    token: first.token,
    runQueuedStop: async () => { throw new Error('must not stop'); },
  });
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-record', second.token), true);
  const follower = createCoordinatedAgentSendCancellationWait('tab-record', second.token);
  const followerCancellation = await follower.promise;
  assert.equal(followerCancellation.cancelReason, 'record-failed');
  assert.equal(followerCancellation.cascadeRestoreBatched, true);
  assert.equal(getCoordinatedAgentAction('tab-record').stopRequestedAt, null);
  assert.equal(isCoordinatedAgentSendCancellationRequested('tab-record', third.token), true);
});

test('a follower bound after head failure keeps self-restore ownership', async () => {
  const first = beginCoordinatedAgentSend('tab-late-bind', 100, { recordWithoutReply: true });
  const follower = beginCoordinatedAgentSend('tab-late-bind', 101);
  const cascade = cancelCoordinatedAgentSendFollowers(
    'tab-late-bind',
    first.token,
    'record-failed',
    120,
  );
  assert.equal(cascade.cancelled, 1);
  assert.deepEqual(cascade.handoffIds, []);

  const bound = bindCoordinatedAgentSendHandoff(
    'tab-late-bind',
    follower.token,
    'handoff-late',
  );
  assert.equal(bound.bound, true);
  const cancellationWait = createCoordinatedAgentSendCancellationWait(
    'tab-late-bind',
    follower.token,
  );
  const cancellation = await cancellationWait.promise;
  assert.equal(cancellation.cascadeRestoreByToken, first.token);
  assert.equal(cancellation.cascadeRestoreBatched, false);
});

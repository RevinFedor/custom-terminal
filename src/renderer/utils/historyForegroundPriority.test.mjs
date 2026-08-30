import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryForegroundPriority } from './historyForegroundPriority.mjs';

test('foreground gesture lease extends from the latest physical packet', () => {
  let now = 100;
  const priority = createHistoryForegroundPriority({
    now: () => now,
    hasPendingInput: () => false,
  });
  priority.mark('tab-a', 500);
  assert.equal(priority.remainingMs(), 500);
  now = 420;
  priority.mark('tab-a', 500);
  assert.equal(priority.remainingMs(), 500);
  now = 921;
  assert.equal(priority.active(), false);
});

test('background slot waits through quiet edge and browser background lane', async () => {
  let now = 0;
  let backgroundYields = 0;
  const priority = createHistoryForegroundPriority({
    now: () => now,
    delay: async (ms) => { now += ms; },
    backgroundYield: async () => { backgroundYields += 1; },
    hasPendingInput: () => false,
  });
  priority.mark('tab-a', 75);
  const result = await priority.waitForBackgroundSlot();
  assert.equal(result.reason, 'idle');
  assert.ok(result.waitedMs >= 75);
  assert.equal(backgroundYields, 1);
});

test('queued input and foreground promotion both fail safe', async () => {
  let now = 0;
  let pendingChecks = 0;
  let promoted = false;
  const priority = createHistoryForegroundPriority({
    now: () => now,
    delay: async (ms) => {
      now += ms;
      promoted = true;
    },
    backgroundYield: async () => {},
    hasPendingInput: () => pendingChecks++ === 0,
  });
  const result = await priority.waitForBackgroundSlot({
    shouldBypass: () => promoted,
  });
  assert.equal(result.reason, 'bypass');
  assert.ok(result.waitedMs >= 16);
});

test('first foreground packet interrupts only the currently registered hidden commit', () => {
  let interrupted = 0;
  const priority = createHistoryForegroundPriority({
    now: () => 10,
    hasPendingInput: () => false,
  });
  const clear = priority.registerInterruptibleBackgroundWork('hidden-a', () => {
    interrupted += 1;
  });
  priority.mark('reader', 500);
  priority.mark('reader', 500);
  clear();
  assert.equal(interrupted, 1);
});

test('continuous renderer interaction owns priority until its exact release', async () => {
  let now = 0;
  let releaseInteraction = false;
  const priority = createHistoryForegroundPriority({
    now: () => now,
    delay: async (ms) => {
      now += ms;
      if (now >= 64 && !releaseInteraction) {
        releaseInteraction = true;
        priority.endInteraction('workflow-drag');
      }
    },
    backgroundYield: async () => {},
    hasPendingInput: () => false,
  });
  priority.beginInteraction('workflow-drag');
  assert.equal(priority.active(), true);
  assert.equal(priority.interactionCount(), 1);
  const result = await priority.waitForBackgroundSlot();
  assert.equal(result.reason, 'idle');
  assert.ok(result.waitedMs >= 64);
  assert.equal(priority.active(), false);
});

test('stale interaction release cannot clear another active owner', () => {
  const priority = createHistoryForegroundPriority({
    now: () => 0,
    hasPendingInput: () => false,
  });
  priority.beginInteraction('sidebar-drag:a');
  priority.beginInteraction('workflow-drag:b');
  assert.equal(priority.endInteraction('sidebar-drag:a'), true);
  assert.equal(priority.active(), true);
  assert.equal(priority.interactionCount(), 1);
  priority.endInteraction('workflow-drag:b');
  assert.equal(priority.active(), false);
});

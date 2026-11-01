'use strict';

// The collector cannot delete anything younger than its 30-day `minAgeMs`, so a
// queue save carries no urgency. These controls pin the coalescing that keeps
// the two inventory reads off the interactive path, and the fresh re-read that
// prevents an hour-old snapshot from deciding what may be deleted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function extractScheduler() {
  const intervalMatch = source.match(
    /const PROMPT_QUEUE_ASSET_GC_INTERVAL_MS = ([^;]+);/,
  );
  assert.ok(intervalMatch, 'the GC interval constant must stay declared in main.js');
  const start = source.indexOf('function schedulePromptQueueAssetGc(');
  assert.ok(start > 0, 'scheduler must stay in main.js');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'deps',
    `const PROMPT_QUEUE_ASSET_GC_INTERVAL_MS = ${intervalMatch[1]};
     let promptQueueAssetGcTimer = null;
     let promptQueueAssetGcLastRunMs = deps.lastRunMs;
     const { clearTimeout, setTimeout, Date, projectManager } = deps;
     const garbageCollectPromptQueueAssets = deps.collect;
     ${body}
     return { schedulePromptQueueAssetGc, interval: PROMPT_QUEUE_ASSET_GC_INTERVAL_MS };`,
  );
  return factory;
}

function harness({ lastRunMs, committedQueue = null }) {
  const scheduled = [];
  const collected = [];
  const factory = extractScheduler();
  const api = factory({
    lastRunMs,
    collect: (state, reason) => { collected.push({ state, reason }); },
    clearTimeout: () => {},
    setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    Date: { now: () => 10_000_000 },
    projectManager: { db: { getAppState: () => committedQueue } },
  });
  return { api, scheduled, collected };
}

test('a queue save does not put the inventory reads on the interactive path', () => {
  const { api, scheduled } = harness({ lastRunMs: 10_000_000 });
  api.schedulePromptQueueAssetGc('{}', 'queue-save');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, api.interval,
    'a save right after a sweep must wait a full interval, not 1s');
  assert.ok(api.interval >= 60 * 60 * 1000,
    'the interval must stay far below the 30-day collection threshold in cost, not above it in urgency');
});

test('a long-idle app still sweeps promptly instead of being delayed further', () => {
  const { api, scheduled } = harness({ lastRunMs: 0 });
  api.schedulePromptQueueAssetGc('{}', 'queue-save');
  assert.equal(scheduled[0].delay, 1000,
    'an overdue sweep keeps the original 1s debounce');
});

test('the sweep reads the committed queue instead of the hour-old snapshot', () => {
  const committedQueue = '{"tab-1":{"items":[]}}';
  const { api, scheduled, collected } = harness({ lastRunMs: 0, committedQueue });
  api.schedulePromptQueueAssetGc('{"stale":true}', 'queue-save');
  scheduled[0].fn();
  assert.equal(collected.length, 1);
  assert.equal(collected[0].state, committedQueue,
    'a stale inventory must never decide what can be deleted');
  assert.equal(collected[0].reason, 'queue-save');
});

test('an unreadable committed queue falls back to the caller snapshot, never to empty', () => {
  const { api, scheduled, collected } = harness({ lastRunMs: 0, committedQueue: null });
  api.schedulePromptQueueAssetGc('{"tab-1":{"items":[]}}', 'queue-save');
  scheduled[0].fn();
  assert.equal(collected[0].state, '{"tab-1":{"items":[]}}',
    'a missing app-state read must not become an empty reference set');
});

'use strict';

// Exercises the REAL cold-read admission from history-read-control.js.
//
// Why it changed: the lane protects the reader process from holding several
// full record graphs at once (a V8 heap OOM there is fatal and uncatchable),
// but it used to admit exactly one read at a time regardless of size. On
// 31.10 that charged the protection to everyone — a tab with 51 records
// waited 233s behind a large parse while the same read took 2s in a quiet
// moment, and measured admission waits reached 11.7s. Concurrency is now
// bounded by the summed SIZE of admitted reads.
//
// These tests pin both directions: cheap reads must stop queueing behind an
// expensive one, and the memory protection must still hold — including for
// callers whose size is unknown, which stay as strict as before.
//
// Run: node --test src/main/history-read-admission-weight.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadAdmission, DEFAULT_ADMISSION_CAPACITY,
  createReadControl, isHistoryReadCancelled } = require('./history-read-control');

// Cancellation travels through the control's AbortSignal, the same way a
// navigated-away History read is revoked in production.
function cancellableControl() {
  const controller = new AbortController();
  return { control: createReadControl({ signal: controller.signal }), cancel: () => controller.abort() };
}

const MB = 1024 * 1024;

test('default capacity leaves room for several ordinary sources', () => {
  assert.equal(DEFAULT_ADMISSION_CAPACITY, 64 * MB);
});

test('a small read is admitted while a large one is still parsing', async () => {
  const lane = createReadAdmission({ capacity: 64 * MB });
  const releaseBig = await lane.acquire(null, { weight: 60 * MB });
  // The exact scar: 51 records behind a large journal.
  const small = lane.acquire(null, { weight: 32 * 1024 });
  const releaseSmall = await small;
  assert.equal(lane.activeCount, 2, 'both reads run at once');
  releaseSmall(); releaseBig();
  assert.equal(lane.activeCount, 0);
  assert.equal(lane.usedBytes, 0, 'the budget is returned exactly');
});

test('memory protection holds: two large reads never overlap', async () => {
  const lane = createReadAdmission({ capacity: 64 * MB });
  const releaseFirst = await lane.acquire(null, { weight: 50 * MB });
  let secondAdmitted = false;
  const second = lane.acquire(null, { weight: 50 * MB }).then(release => {
    secondAdmitted = true; return release;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondAdmitted, false, 'the second large read waits');
  assert.equal(lane.waiting, 1);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAdmitted, true, 'it is admitted once the budget frees up');
  releaseSecond();
});

test('unknown size is charged the whole lane, exactly as before', async () => {
  // Every caller that cannot state a size must keep the old serialized
  // behaviour; guessing something cheaper would silently remove the guard.
  const lane = createReadAdmission({ capacity: 64 * MB });
  const releaseFirst = await lane.acquire(null, {});
  assert.equal(lane.usedBytes, 64 * MB, 'an unknown read occupies the lane');
  let admitted = false;
  const second = lane.acquire(null, { weight: 1024 }).then(r => { admitted = true; return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false, 'even a tiny read waits behind unknown work');
  releaseFirst();
  (await second)();
});

test('a source larger than the whole budget still runs, alone', async () => {
  const lane = createReadAdmission({ capacity: 8 * MB });
  const release = await lane.acquire(null, { weight: 900 * MB });
  assert.equal(lane.activeCount, 1, 'an oversized read is never deadlocked');
  let admitted = false;
  const other = lane.acquire(null, { weight: 1024 }).then(r => { admitted = true; return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false, 'but it does not share the lane');
  release();
  (await other)();
});

test('a cheap read passes a queued expensive one — the whole point of the fix', async () => {
  // In the 31.10 burst 42 tabs asked at once, so strict head-of-line order
  // would still have parked the 51-record tab behind whichever large parse
  // arrived first. A read that fits in the remaining budget goes now.
  const lane = createReadAdmission({ capacity: 64 * MB });
  const releaseFirst = await lane.acquire(null, { weight: 60 * MB });
  const order = [];
  const big = lane.acquire(null, { weight: 60 * MB }).then(r => { order.push('big'); return r; });
  const small = lane.acquire(null, { weight: 1024 }).then(r => { order.push('small'); return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['small'], 'the cheap read does not wait for the large one');
  assert.equal(lane.activeCount, 2);
  releaseFirst();
  const releaseBig = await big;
  (await small)();
  releaseBig();
});

test('the head is not starved: after 8 skips the lane waits for it', async () => {
  // The opposite unfairness: a steady stream of cheap reads must not keep a
  // large one queued forever.
  const lane = createReadAdmission({ capacity: 64 * MB });
  const releaseFirst = await lane.acquire(null, { weight: 60 * MB });
  let bigAdmitted = false;
  const big = lane.acquire(null, { weight: 60 * MB }).then(r => { bigAdmitted = true; return r; });
  const releases = [];
  for (let i = 0; i < 8; i++) releases.push(await lane.acquire(null, { weight: 1024 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bigAdmitted, false, 'the head is still queued');

  let lateAdmitted = false;
  const late = lane.acquire(null, { weight: 1024 }).then(r => { lateAdmitted = true; return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateAdmitted, false, 'once the head has been passed 8 times, nobody overtakes it');

  releaseFirst();
  for (const release of releases) release();
  const releaseBig = await big;
  assert.equal(bigAdmitted, true, 'the head finally runs');
  releaseBig();
  (await late)();
});

test('small reads fill the lane up to the budget and no further', async () => {
  const lane = createReadAdmission({ capacity: 10 * MB });
  const releases = [];
  for (let i = 0; i < 5; i++) releases.push(await lane.acquire(null, { weight: 2 * MB }));
  assert.equal(lane.activeCount, 5);
  assert.equal(lane.usedBytes, 10 * MB);
  let sixth = false;
  const extra = lane.acquire(null, { weight: 2 * MB }).then(r => { sixth = true; return r; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sixth, false, 'the budget is a real ceiling');
  releases.pop()();
  (await extra)();
  for (const release of releases) release();
});

test('releasing twice does not corrupt the budget', async () => {
  const lane = createReadAdmission({ capacity: 10 * MB });
  const release = await lane.acquire(null, { weight: 4 * MB });
  release(); release();
  assert.equal(lane.usedBytes, 0);
  assert.equal(lane.activeCount, 0);
});

test('a cancelled waiter frees the queue it was heading', async () => {
  // A revoked head used to be impossible (one slot); with a queue it must not
  // park everyone behind a read nobody is waiting for any more.
  const lane = createReadAdmission({ capacity: 64 * MB });
  const releaseFirst = await lane.acquire(null, { weight: 60 * MB });
  const cancelled = cancellableControl();
  const head = lane.acquire(cancelled.control, { weight: 60 * MB });
  let followerAdmitted = false;
  const follower = lane.acquire(null, { weight: 60 * MB }).then(r => { followerAdmitted = true; return r; });
  await new Promise(resolve => setImmediate(resolve));

  cancelled.cancel();
  await assert.rejects(head, error => isHistoryReadCancelled(error));
  releaseFirst();
  const releaseFollower = await follower;
  assert.equal(followerAdmitted, true, 'the follower is not stranded behind a cancelled head');
  releaseFollower();
});

test('cancelling an ADMITTED read still returns its budget', async () => {
  const lane = createReadAdmission({ capacity: 10 * MB });
  const { control, cancel } = cancellableControl();
  const release = await lane.acquire(control, { weight: 8 * MB });
  cancel();
  release();
  assert.equal(lane.usedBytes, 0, 'the lane does not leak the revoked read');
  const next = await lane.acquire(null, { weight: 8 * MB });
  next();
});

test('a read cancelled before admission never occupies the lane', async () => {
  const lane = createReadAdmission({ capacity: 10 * MB });
  const { control, cancel } = cancellableControl();
  cancel();
  // Pre-existing contract, unchanged by the weight work: `acquire` asserts the
  // control synchronously, so an already-revoked caller throws on the call
  // itself rather than returning a rejected promise. Either way an awaiting
  // caller sees a cancellation; the wrapper just lets the test accept both.
  await assert.rejects(async () => lane.acquire(control, { weight: 1024 }),
    error => isHistoryReadCancelled(error));
  assert.equal(lane.activeCount, 0);
  assert.equal(lane.usedBytes, 0);
});

test('worker source: the cold lane passes a weight and reports it', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, 'history-read-worker.js'), 'utf8');
  assert.match(source, /coldLane\.acquire\(control, \{ weight \}\)/,
    'the cold lane must be acquired with the source size');
  assert.match(source, /function coldWeightForContext/,
    'the size resolver must exist');
  assert.match(source, /weightBytes: weight, laneUsedBytes: coldLane\.usedBytes/,
    'the queue diagnostic must record what the decision was based on');
  // An unknown size must fall through to 0, which the lane charges in full.
  assert.match(source, /return 0;\n\}/, 'unknown size resolves to 0, not a guess');
});

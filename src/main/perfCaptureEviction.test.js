// A full capture quota must spend its four slots on the WORST freezes of the
// day, not on the first four that happened to occur.
//
// Measured failure this fixes (01.11, production boot mvxdojep): the four
// slots were consumed by 06:11, one minute after launch. Every later request
// was refused — 765 of them — including a 1861ms renderer freeze the user
// actually reported at 16:35. The refusals themselves were logged, so the
// problem looked like "diagnostics ran and found nothing".
//
// The dangerous direction is the opposite one: eviction must never become a
// way to exceed four held captures, churn the set on near-equal events, or
// drop a receipt without taking its slot. Most assertions below guard that.
//
// Run: node --test src/main/perfCaptureEviction.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { captureDecision, createArtifactStore } = require('./perf-flight-recorder');

const held = (now, severities, group = 'responsiveness') => severities.map((severityMs, index) => ({
  at: now - 3600000 + index * 1000,
  name: 'incident-' + (now - 3600000 + index * 1000) + '-1.capture.json',
  group,
  severityMs,
}));

test('a decisively worse freeze takes the slot of the mildest held one', () => {
  const now = Date.now();
  const decision = captureDecision(held(now, [300, 900, 1200, 1500]), now, 'ui-click', { durationMs: 1861 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'evicted-milder-capture');
  assert.equal(decision.evictedSeverityMs, 300, 'the mildest must be the one evicted');
  assert.match(decision.evicts, /\.capture\.json$/);
  assert.equal(decision.severityMs, 1861);
});

test('a marginally worse freeze does NOT churn the set', () => {
  // Trading an explained 900ms freeze for an explained 1000ms one costs a
  // capture and buys nothing.
  const now = Date.now();
  const decision = captureDecision(held(now, [900, 1000, 1200, 1500]), now, 'ui-click', { durationMs: 1000 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'rolling-quota-exhausted');
  assert.equal(decision.heldMildestMs, 900, 'the refusal still explains what is held');
  assert.equal(decision.severityMs, 1000);
});

test('both thresholds are required, not either', () => {
  const now = Date.now();
  // Twice as long, but only +100ms worse: below the absolute floor.
  assert.equal(captureDecision(held(now, [100, 900, 1200, 1500]), now, 'ui-click',
    { durationMs: 200 }).allowed, false, 'a tiny absolute gain must not evict');
  // +1200ms worse, but not twice as long: below the ratio.
  assert.equal(captureDecision(held(now, [2000, 2100, 2200, 2300]), now, 'ui-click',
    { durationMs: 3200 }).allowed, false, 'a sub-2x gain must not evict');
  // Both satisfied.
  assert.equal(captureDecision(held(now, [2000, 2100, 2200, 2300]), now, 'ui-click',
    { durationMs: 4100 }).allowed, true);
});

test('eviction never raises the number of held captures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-evict-count-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const at = now - 3600000 + i * 600000;
    const name = 'incident-' + at + '-1.capture.json';
    store.write(name, { group: 'responsiveness', severityMs: 200 + i * 100 });
    fs.utimesSync(store.file(name), new Date(at), new Date(at));
  }
  const before = store.entries().filter(e => e.name.endsWith('.capture.json')).length;
  assert.equal(before, 4);
  const decision = store.reserveCaptureDetails('incident-' + now + '-9', now, 'ui-click', { durationMs: 1861 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'evicted-milder-capture');
  const after = store.entries().filter(e => e.name.endsWith('.capture.json'));
  assert.equal(after.length, 4, 'the quota must stay at four held captures');
  assert.ok(!after.some(e => e.name === decision.evicts), 'the evicted receipt is gone');
  assert.ok(after.some(e => e.name === 'incident-' + now + '-9.capture.json'), 'the new receipt is held');
});

test('the stored receipt carries the severity that justified it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-evict-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  const id = 'incident-' + now + '-1';
  store.reserveCaptureDetails(id, now, 'ui-click', { durationMs: 1861.4 });
  const receipt = JSON.parse(store.read(id + '.capture.json'));
  assert.equal(receipt.severityMs, 1861, 'severity is recorded so a later event can compare against it');
  assert.equal(receipt.group, 'responsiveness');
});

test('receipts without severity are never evicted', t => {
  // Receipts written before this change, and kinds that carry no duration,
  // must not be treated as severity 0 and discarded first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-evict-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const at = now - 3600000 + i * 600000;
    const name = 'incident-' + at + '-1.capture.json';
    store.write(name, { group: 'responsiveness' }); // legacy: no severityMs
    fs.utimesSync(store.file(name), new Date(at), new Date(at));
  }
  const decision = store.reserveCaptureDetails('incident-' + now + '-2', now, 'ui-click', { durationMs: 5000 });
  assert.equal(decision.allowed, false, 'legacy receipts hold their slots');
  assert.equal(decision.reason, 'rolling-quota-exhausted');
  assert.equal(store.entries().filter(e => e.name.endsWith('.capture.json')).length, 4);
});

test('an event with no duration cannot evict', () => {
  const now = Date.now();
  const decision = captureDecision(held(now, [300, 900, 1200, 1500]), now, 'ui-click', {});
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'rolling-quota-exhausted');
});

test('eviction stays inside its own group', () => {
  // Background CPU captures must not take the responsiveness slots the user's
  // clicks depend on, and vice versa.
  const now = Date.now();
  const background = held(now, [300, 400, 500, 600], 'background');
  const decision = captureDecision(background, now, 'ui-click', { durationMs: 5000 });
  assert.equal(decision.allowed, false, 'a UI freeze does not evict background receipts');
  assert.equal(decision.reason, 'rolling-quota-exhausted');
});

test('a manual request still bypasses the quota without evicting anything', () => {
  const now = Date.now();
  const decision = captureDecision(held(now, [300, 900, 1200, 1500]), now, 'manual', { durationMs: 10 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'reserved');
  assert.equal(decision.evicts, undefined, 'manual has its own group and takes no automatic slot');
});

test('a failed eviction refuses rather than taking a slot for free', t => {
  // If the receipt cannot be removed, granting the capture would leave five
  // held. The decision must degrade to the old refusal instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-evict-fail-'));
  t.after(() => { try { fs.chmodSync(dir, 0o700); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const at = now - 3600000 + i * 600000;
    const name = 'incident-' + at + '-1.capture.json';
    store.write(name, { group: 'responsiveness', severityMs: 200 + i * 100 });
    fs.utimesSync(store.file(name), new Date(at), new Date(at));
  }
  fs.chmodSync(dir, 0o500); // directory not writable: unlink must fail
  const decision = store.reserveCaptureDetails('incident-' + now + '-9', now, 'ui-click', { durationMs: 1861 });
  fs.chmodSync(dir, 0o700);
  assert.equal(decision.allowed, false, 'an un-evictable slot must not be granted');
  assert.equal(decision.reason, 'rolling-quota-exhausted');
  assert.equal(store.entries().filter(e => e.name.endsWith('.capture.json')).length, 4,
    'nothing was removed and nothing was added');
});

test('eviction does not bypass the earlier gates', () => {
  const now = Date.now();
  // Background CPU with no Electron hotspot is refused before quota logic.
  const decision = captureDecision(held(now, [100, 200, 300, 400], 'background'), now, 'sustained-cpu',
    { durationMs: 9000, appCpu: 10, appChildCpu: 3, systemBusy: 98 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'system-pressure-no-electron-hotspot');
});

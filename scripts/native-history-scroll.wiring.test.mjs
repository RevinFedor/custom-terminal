import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./native-history-scroll.m', import.meta.url), 'utf8');

test('native History scroll fails closed on exact layer-0 PID and restores cursor', () => {
  assert.match(source, /CGPreflightPostEventAccess\(\)/);
  assert.match(source, /kCGWindowLayer/);
  assert.match(source, /layer\.integerValue != 0/);
  assert.match(source, /observedPID != expectedPID/);
  assert.match(source, /exitCode = 4/);
  assert.match(source, /@finally \{[\s\S]*warpAndMove\(original\)/);
  const guard = source.indexOf('observedPID != expectedPID');
  const post = source.indexOf('CGEventPost(kCGHIDEventTap, event)');
  assert.ok(guard >= 0 && post > guard, 'no wheel packet may precede PID proof');
});

test('native History scroll preserves fractional pixel packets and reports rollback', () => {
  assert.match(source, /kCGScrollEventUnitPixel/);
  assert.match(source, /kCGScrollWheelEventIsContinuous/);
  assert.match(source, /kCGScrollWheelEventPointDeltaAxis1, delta/);
  assert.match(source, /kCGScrollWheelEventFixedPtDeltaAxis1, delta \* 65536\.0/);
  assert.match(source, /packets=%lu total=%.1f/);
  assert.match(source, /restored=1/);
});

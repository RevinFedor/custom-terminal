import test from 'node:test';
import assert from 'node:assert';
import {
  createHistoryTailSpacer,
  historyContentDistanceFromBottom,
} from './historyTailSpacer.mjs';

test('arm keeps the larger reserve; burn shrinks by travelled distance only', () => {
  const spacer = createHistoryTailSpacer({});
  spacer.arm(400, 'collapse');
  assert.equal(spacer.get(), 400);
  spacer.arm(150, 'collapse'); // second smaller collapse does not shrink
  assert.equal(spacer.get(), 400);
  assert.equal(spacer.burn(120), 120);
  assert.equal(spacer.get(), 280);
  assert.equal(spacer.burn(1000), 280); // burns to zero, never negative
  assert.equal(spacer.get(), 0);
  assert.equal(spacer.burn(50), 0);
});

test('reset zeroes and reports; mustBeZero flags and self-heals', () => {
  const lines = [];
  const spacer = createHistoryTailSpacer({ diag: (line) => lines.push(line) });
  spacer.arm(200);
  assert.equal(spacer.reset('owner-change'), true);
  assert.equal(spacer.get(), 0);
  assert.equal(spacer.reset('owner-change'), false);
  spacer.arm(90);
  assert.equal(spacer.mustBeZero('restore-start'), false);
  assert.equal(spacer.get(), 0); // violation self-heals to keep restore honest
  assert.equal(spacer.mustBeZero('restore-start'), true);
  assert.ok(lines.some((line) => line.includes('violation context=restore-start')));
});

test('content distance subtracts the reserve', () => {
  const scroller = { scrollHeight: 1000, scrollTop: 700, clientHeight: 200 };
  assert.equal(historyContentDistanceFromBottom(scroller, 0), 100);
  assert.equal(historyContentDistanceFromBottom(scroller, 100), 0);
  // Reserve present + user at padded bottom → content distance can go
  // negative; callers clamp via their own thresholds.
  assert.equal(historyContentDistanceFromBottom(scroller, 150), -50);
});

test('onChange publishes every transition with its reason', () => {
  const events = [];
  const spacer = createHistoryTailSpacer({ onChange: (px, reason) => events.push([px, reason]) });
  spacer.arm(100, 'collapse');
  spacer.burn(40);
  spacer.reset('new-rows');
  assert.deepEqual(events, [[100, 'collapse'], [60, 'burn'], [0, 'new-rows']]);
});

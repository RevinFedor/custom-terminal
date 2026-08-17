import test from 'node:test';
import assert from 'node:assert';
import {
  createHistoryTailSpacer,
  historyContentDistanceFromBottom,
  historyTailReserveDeficitAfterShrink,
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

test('streaming growth burns only the refilled height, not the whole reserve', () => {
  // 16.08 live: collapsing near the bottom armed ~400px; then the LAST block
  // kept streaming and each durable refresh hard-zeroed the reserve — the
  // visual gap vanished and the frame jumped. The reconciliation contract:
  // reserve follows the clamp deficit downward, exactly.
  const spacer = createHistoryTailSpacer({});
  spacer.arm(400, 'collapse-hold');
  // Layout-effect reconciliation math (mirrors HistoryPanel): content grew by
  // 150px → deficit shrinks from 400 to 250 → burn the difference.
  const scroller = { scrollHeight: 1000 + spacer.get(), scrollTop: 800, clientHeight: 450 };
  const contentBottom = scroller.scrollHeight - spacer.get();
  const deficit = Math.round(scroller.scrollTop + scroller.clientHeight - contentBottom);
  assert.equal(deficit, 250);
  spacer.burn(spacer.get() - deficit);
  assert.equal(spacer.get(), 250, 'reserve shrinks by the grown height only');
  // Growth that refills everything → deficit <= 2 → full reset.
  spacer.reset('content-refilled');
  assert.equal(spacer.get(), 0);
});

test('preview shrink deficit uses the pre-change reading position after browser clamp', () => {
  // The reader was at 800. Removing a 150px preview clamps the live scrollTop
  // to 650 before React sees the new DOM. Only the captured pre-change value
  // proves how much blank reserve is required to keep the frame stationary.
  const clampedScroller = { scrollHeight: 1100, scrollTop: 650, clientHeight: 450 };
  assert.equal(
    historyTailReserveDeficitAfterShrink(clampedScroller, 800),
    150,
  );
  assert.equal(
    historyTailReserveDeficitAfterShrink(clampedScroller, clampedScroller.scrollTop),
    0,
    'the already-clamped live position cannot reconstruct the removed height',
  );

  const spacer = createHistoryTailSpacer({});
  spacer.arm(150, 'terminal-preview-shrink-hold');
  const withReserve = {
    scrollHeight: clampedScroller.scrollHeight + spacer.get(),
    scrollTop: clampedScroller.scrollTop,
    clientHeight: clampedScroller.clientHeight,
  };
  const contentBottom = withReserve.scrollHeight - spacer.get();
  const heldDeficit = 800 + withReserve.clientHeight - contentBottom;
  assert.equal(
    heldDeficit,
    spacer.get(),
    'reconciliation must use the held pre-change position until live scrollTop is restored',
  );
});

test('preview resize needs no reserve while real content still absorbs the shrink', () => {
  const scroller = { scrollHeight: 1600, scrollTop: 800, clientHeight: 450 };
  assert.equal(historyTailReserveDeficitAfterShrink(scroller, 800), 0);
});

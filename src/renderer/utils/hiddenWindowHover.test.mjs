import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenWindowHoverContains } from './hiddenWindowHover.mjs';
const popup = { left: 520, right: 940, top: 94, bottom: 290 };
const button = { left: 900, right: 940, top: 50, bottom: 90 };
const header = { left: 100, right: 980, top: 50, bottom: 210 };
test('leftward travel keeps the popup only within its own trigger row', () => {
  const inside = (x, y) => hiddenWindowHoverContains({ popup, button, header, x, y });
  assert.equal(inside(120, 70), true);
  assert.equal(inside(200, 93), true, 'short bridge below the trigger row');
  assert.equal(inside(600, 180), true, 'the popup itself');
  assert.equal(inside(50, 70), false, 'neighbour window');
  assert.equal(inside(970, 70), false, 'no new zone to the right of the icon');
  assert.equal(inside(200, 150), false, 'not the entire multiline header');
  assert.equal(inside(200, 30), false);
});
test('standalone trigger and popup above the trigger retain ordinary hover geometry', () => {
  assert.equal(hiddenWindowHoverContains({ popup, button, header: null, x: 120, y: 70 }), false);
  assert.equal(hiddenWindowHoverContains({ popup: { ...popup, top: 10, bottom: 48 }, button, header,
    x: 120, y: 49 }), true);
});

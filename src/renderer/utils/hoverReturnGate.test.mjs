import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoverReturnGate } from './hoverReturnGate.mjs';

test('a clicked disappearing child grants one return trip, never a pin', () => {
  const gate = createHoverReturnGate(), child = { isConnected: true }, point = { clientX: 10, clientY: 10 };
  gate.capture(child);
  assert.equal(gate.holds(point, false), false);
  child.isConnected = false;
  assert.equal(gate.holds(point, false), true);
  gate.settle(child);
  assert.equal(gate.holds(point, false), true);
  assert.equal(gate.holds(point, true), false);
  assert.equal(gate.holds(point, false), false);
});

test('a click which kept its popup open cannot arm a later Escape', () => {
  const gate = createHoverReturnGate(), child = { isConnected: true };
  gate.capture(child); gate.settle(child); child.isConnected = false;
  assert.equal(gate.holds({}, false), false);
});

test('blur/close/return before the commit cannot re-arm a stale child', () => {
  for (const clear of [gate => gate.reset(), gate => gate.holds(null, false), gate => gate.holds({}, true)]) {
    const gate = createHoverReturnGate(), child = { isConnected: true };
    gate.capture(child); clear(gate); child.isConnected = false; gate.settle(child);
    assert.equal(gate.holds({}, false), false);
  }
});

test('an older click settlement cannot discard a newer selection', () => {
  const gate = createHoverReturnGate(), first = { isConnected: true }, second = { isConnected: false };
  gate.capture(first); gate.capture(second); gate.settle(first); gate.settle(second);
  assert.equal(gate.holds({}, false), true);
});

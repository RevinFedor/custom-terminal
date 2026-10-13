import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoverReturnGate, hasOwnedClickPopup, queueOwnsPopup, markQueueChildDismiss,
  isOwnedQueueChildDismiss } from './hoverReturnGate.mjs';

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

test('explicit keyboard save grants a return trip that clears on reentry or window blur', () => {
  const gate = createHoverReturnGate();
  gate.retain(); assert.equal(gate.holds({}, false), true);
  assert.equal(gate.holds({}, true), false); assert.equal(gate.holds({}, false), false);
  gate.retain(); gate.holds(null, false); assert.equal(gate.holds({}, false), false);
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

test('click-open hold belongs only to the current root and its registered inline queues', () => {
  const popups = [];
  const root = {
    dataset: { promptQueueHoverOwner: 'own' },
    querySelectorAll: () => [{ dataset: { promptQueueHoverOwner: 'inline' } }],
    ownerDocument: { querySelectorAll: selector => {
      assert.equal(selector, '[data-run-after-click-open="true"]');
      return popups.filter(element => element.dataset.runAfterClickOpen === 'true');
    } },
  };
  popups.push({ dataset: { runAfterHoverOwner: 'foreign', runAfterClickOpen: 'true' } });
  assert.equal(hasOwnedClickPopup(root), false);
  popups.push({ dataset: { runAfterHoverOwner: 'own' } });
  assert.equal(hasOwnedClickPopup(root), false, 'a hover-open child does not freeze its parent');
  popups.push({ dataset: { runAfterHoverOwner: 'own', runAfterClickOpen: 'true' } });
  assert.equal(hasOwnedClickPopup(root), true);
  popups.push({ dataset: { runAfterHoverOwner: 'inline', runAfterClickOpen: 'true' } });
  popups.splice(2, 1);
  assert.equal(hasOwnedClickPopup(root), true, 'another owned click-open child still holds the global root');
  popups.pop();
  assert.equal(hasOwnedClickPopup(root), false, 'removing the last owned child releases the root');
  assert.equal(queueOwnsPopup(root, 'foreign'), false);
  assert.equal(hasOwnedClickPopup(null), false);
});

test('one native dismissal gesture is owned, not an instruction to close another popup stack', () => {
  const root = { dataset: { promptQueueHoverOwner: 'own' }, querySelectorAll: () => [] };
  const event = {};
  markQueueChildDismiss(event, 'own');
  assert.equal(isOwnedQueueChildDismiss(root, event), true);
  assert.equal(isOwnedQueueChildDismiss(root, {}), false);
  assert.equal(isOwnedQueueChildDismiss({ dataset: { promptQueueHoverOwner: 'other' }, querySelectorAll: () => [] }, event), false);
});

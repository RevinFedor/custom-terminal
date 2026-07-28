'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryPresenceTestGate } = require('./history-presence-test-gate');

function createGate() {
  let clock = 100;
  let id = 0;
  const events = [];
  const gate = createHistoryPresenceTestGate({
    enabled: true,
    now: () => ++clock,
    makeArmId: () => `arm-${++id}`,
    onEvent: (kind, detail) => events.push({ kind, detail }),
  });
  return { gate, events };
}

test('disabled gate cannot arm and never blocks product requests', async () => {
  const gate = createHistoryPresenceTestGate({ enabled: false });
  assert.deepEqual(gate.arm({ tabId: 'tab-a' }), { success: false, error: 'disabled' });
  assert.deepEqual(await gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'tab-a:claude:project',
    generation: 1,
  }), { held: false, reason: 'disabled' });
});

test('only a History request with exact owner identity consumes an arm', async () => {
  const { gate, events } = createGate();
  const armed = gate.arm({ tabId: 'tab-a' });
  assert.equal(armed.success, true);

  assert.deepEqual(await gate.waitIfArmed({ tabId: 'tab-a' }), {
    held: false,
    reason: 'not-armed',
  });
  assert.deepEqual(await gate.waitIfArmed({
    tabId: 'tab-b',
    consumer: 'history-panel',
    ownerKey: 'tab-b:claude:project',
    generation: 1,
  }), { held: false, reason: 'not-armed' });

  const held = gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'tab-a:claude:project',
    generation: 7,
  });
  assert.equal(gate.snapshot()[0].state, 'held');
  assert.equal(gate.snapshot()[0].generation, 7);
  assert.equal(events.at(-1).kind, 'hold');

  assert.equal(gate.release({ armId: armed.arm.armId }).success, true);
  assert.deepEqual(await held, {
    held: true,
    armId: armed.arm.armId,
    state: 'released',
    ownerKey: 'tab-a:claude:project',
    generation: 7,
  });
  assert.equal(events.at(-1).kind, 'release');
});

test('optional owner and generation constraints reject a different request', async () => {
  const { gate } = createGate();
  const armed = gate.arm({
    tabId: 'tab-a',
    ownerKey: 'tab-a:claude:project',
    generation: 4,
  });
  assert.deepEqual(await gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'tab-a:claude:other-project',
    generation: 4,
  }), { held: false, reason: 'not-armed' });
  assert.deepEqual(await gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'tab-a:claude:project',
    generation: 5,
  }), { held: false, reason: 'not-armed' });

  const held = gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'tab-a:claude:project',
    generation: 4,
  });
  assert.equal(gate.release({ armId: armed.arm.armId }).success, true);
  assert.equal((await held).state, 'released');
});

test('two held owners can be released in reverse order without cross-release', async () => {
  const { gate } = createGate();
  const a = gate.arm({ tabId: 'tab-a' }).arm;
  const b = gate.arm({ tabId: 'tab-b' }).arm;
  const waitA = gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'owner-a',
    generation: 11,
  });
  const waitB = gate.waitIfArmed({
    tabId: 'tab-b',
    consumer: 'history-panel',
    ownerKey: 'owner-b',
    generation: 12,
  });

  assert.equal(gate.release({ armId: b.armId, reason: 'reverse-first' }).success, true);
  assert.equal((await waitB).armId, b.armId);
  assert.equal(gate.snapshot().find((row) => row.armId === a.armId).state, 'held');
  assert.equal(gate.release({ armId: a.armId, reason: 'reverse-second' }).success, true);
  assert.equal((await waitA).armId, a.armId);
});

test('clear releases held requests and cancels arms that were not consumed', async () => {
  const { gate, events } = createGate();
  const heldArm = gate.arm({ tabId: 'tab-a' }).arm;
  const untouchedArm = gate.arm({ tabId: 'tab-b' }).arm;
  const held = gate.waitIfArmed({
    tabId: 'tab-a',
    consumer: 'history-panel',
    ownerKey: 'owner-a',
    generation: 1,
  });
  const cleared = gate.clear('rollback');
  assert.equal(cleared.released, 1);
  assert.equal((await held).state, 'cancelled');
  assert.equal(gate.snapshot().find((row) => row.armId === heldArm.armId).releaseReason, 'rollback');
  assert.equal(gate.snapshot().find((row) => row.armId === untouchedArm.armId).state, 'cancelled');
  assert.equal(events.at(-1).kind, 'cancelled');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  axisOwnedLayoutDelta,
  expansionCallback,
  resolvePointerExternalTarget,
  semanticVerticalSlotUnchanged,
} from './useOutlineDnd.js';

test('accepted semantic slot identity ignores a different raw pointer boundary', () => {
  const drag = {
    boundary: 2,
    pointerBoundary: 4,
    slot: { parentId: null, index: 1 },
  };
  const projected = {
    boundary: 2,
    slot: { parentId: null, index: 1 },
  };

  assert.equal(semanticVerticalSlotUnchanged(projected, drag), true);
  assert.equal(semanticVerticalSlotUnchanged({ ...projected, boundary: 3 }, drag), false);
  assert.equal(semanticVerticalSlotUnchanged({ ...projected, slot: { parentId: 'nested', index: 1 } }, drag), false);
});

test('layout animation applies movement only on the axis that changed semantics', () => {
  const measured = { x: 18, y: 42 };

  assert.deepEqual(axisOwnedLayoutDelta('horizontal', measured), { x: 18, y: 0 });
  assert.deepEqual(axisOwnedLayoutDelta('vertical', measured), { x: 0, y: 42 });
  assert.deepEqual(axisOwnedLayoutDelta(null, measured), { x: 0, y: 0 });
});

test('one expansion reason selects one callback even when both aliases exist', () => {
  const calls = [];
  const callbacks = {
    onToggle: () => calls.push('toggle'),
    onExpansionRequest: () => calls.push('request'),
  };

  expansionCallback(callbacks, 'pointer-toggle')();
  expansionCallback(callbacks, 'navigation')();
  assert.deepEqual(calls, ['toggle', 'request']);
});

test('Cmd navigation may hand the same gesture to an explicit host target', () => {
  const seen = [];
  const target = resolvePointerExternalTarget({
    drag: {
      sourceId: 'tab-a',
      sourceIds: ['tab-a'],
      sourceNode: { id: 'tab-a' },
      startX: 12,
      startY: 18,
      pointerX: 240,
      pointerY: 160,
      navigationMode: true,
    },
    event: { clientX: 260, clientY: 170, metaKey: false },
    previewOutline: [{ id: 'tab-a' }],
    resolveExternalTarget: (payload) => {
      seen.push(payload);
      return payload.metaKey ? { id: 'pane:1', zone: 'pane-strip' } : null;
    },
  });

  assert.deepEqual(target, { id: 'pane:1', zone: 'pane-strip' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].metaKey, true);
  assert.equal(seen[0].navigationMode, true);
  assert.equal(seen[0].clientX, 260);
  assert.equal(seen[0].sourceNode.id, 'tab-a');
});

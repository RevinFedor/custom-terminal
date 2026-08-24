import assert from 'node:assert/strict';
import test from 'node:test';

const picker = await import('./workspaceWindowSwapPicker.mjs');

test('pinned swap picker previews workflows without changing source identity', () => {
  picker.endWorkspaceWindowSwapPicker();
  assert.equal(picker.beginWorkspaceWindowSwapPicker({ sourceSpaceId: 'main', sourcePaneIndex: 2 }), true);
  assert.deepEqual(picker.getWorkspaceWindowSwapPickerSnapshot(), {
    active: true,
    revision: picker.getWorkspaceWindowSwapPickerSnapshot().revision,
    sourceSpaceId: 'main',
    sourcePaneIndex: 2,
    targetSpaceId: 'main',
  });
  assert.equal(picker.selectWorkspaceWindowSwapTarget('uav'), true);
  const selected = picker.getWorkspaceWindowSwapPickerSnapshot();
  assert.equal(selected.sourceSpaceId, 'main');
  assert.equal(selected.sourcePaneIndex, 2);
  assert.equal(selected.targetSpaceId, 'uav');
  assert.equal(picker.endWorkspaceWindowSwapPicker(), true);
  assert.equal(picker.getWorkspaceWindowSwapPickerSnapshot().active, false);
});

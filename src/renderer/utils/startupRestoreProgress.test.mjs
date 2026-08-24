import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeStartupRestore,
  getStartupRestoreProgress,
  resetStartupRestoreProgressForTests,
  setStartupRestoreProgress,
  subscribeStartupRestoreProgress,
} from './startupRestoreProgress.mjs';

test('startup restore exposes one ordered blocking state through completion', async () => {
  resetStartupRestoreProgressForTests();
  const seen = [];
  const unsubscribe = subscribeStartupRestoreProgress((state) => {
    seen.push({ phase: state.phase, blocking: state.blocking, current: state.current });
  });
  setStartupRestoreProgress({ phase: 'tabs', current: 3, total: 10 });
  setStartupRestoreProgress({ phase: 'layout', current: 1, total: 1 });
  setStartupRestoreProgress({ phase: 'agents', current: 1, total: 2 });
  completeStartupRestore({ delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  unsubscribe();

  assert.deepEqual(seen.map((row) => row.phase), [
    'projects', 'tabs', 'layout', 'agents', 'complete', 'idle',
  ]);
  assert.equal(getStartupRestoreProgress().blocking, false);
});

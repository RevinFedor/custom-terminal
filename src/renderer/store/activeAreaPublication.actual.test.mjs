import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createStore } from 'zustand/vanilla';

test('actual active-area setter wakes subscribers only for a real focus-area change', () => {
  const source = readFileSync(new URL('./useUIStore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  setActiveArea: (area) =>');
  const end = source.indexOf('\n}));', start);
  assert.ok(start >= 0 && end > start);
  const action = source.slice(start, end).trim().replace(/^setActiveArea: /, '');
  const store = createStore(() => ({ activeArea: 'workspace' }));
  const setActiveArea = vm.runInNewContext('(' + action + ')', { get: store.getState, set: store.setState });
  let wakes = 0;
  const stop = store.subscribe(() => wakes++);
  try {
    const original = store.getState();
    setActiveArea('workspace'); setActiveArea('workspace');
    assert.strictEqual(store.getState(), original);
    assert.equal(wakes, 0);
    setActiveArea('sidebar');
    assert.equal(store.getState().activeArea, 'sidebar');
    assert.equal(wakes, 1);
    setActiveArea('sidebar');
    assert.equal(wakes, 1);
    setActiveArea('workspace');
    assert.equal(store.getState().activeArea, 'workspace');
    assert.equal(wakes, 2);
  } finally { stop(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineViewportSource } from './timelineViewport.mjs';

test('ordinary mounted markers do not scan a broad History viewport per row', () => {
  const entries = Array.from({ length: 2000 }, (_, i) => ({ uuid: 'row-' + i }));
  let visible = Array.from({ length: 1000 }, (_, i) => 'assistant-' + i);
  const source = createTimelineViewportSource({ entries, read: () => visible, subscribe: () => () => {} });
  const originalHas = Set.prototype.has;
  let probes = 0;
  Set.prototype.has = function (value) { probes++; return originalHas.call(this, value); };
  const cleanups = [];
  try {
    for (let i = 0; i < entries.length; i++) {
      const binding = source.bind(i);
      assert.equal(binding.getSnapshot(), false);
      cleanups.push(binding.subscribe(() => {}));
    }
    assert.ok(probes <= entries.length * 3, `singleton membership probes ${probes}`);
    visible = ['row-8', ...visible];
    assert.equal(source.bind(8).getSnapshot(), true);
    assert.equal(source.bind(9).getSnapshot(), false);
  } finally {
    Set.prototype.has = originalHas;
    for (const cleanup of cleanups) cleanup();
  }
});

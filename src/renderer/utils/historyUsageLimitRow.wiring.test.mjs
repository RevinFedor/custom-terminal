import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('usage limit uses the exact interruption SVG and raspberry service row', () => {
  const componentStart = source.indexOf('const HistoryInterruptedRow =');
  const componentEnd = source.indexOf('const HistoryGoalRow =', componentStart);
  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  const component = source.slice(componentStart, componentEnd);
  assert.match(component, /SlidersHorizontal/);
  assert.match(component, /hp-history-interrupted/);
  assert.match(component, /hp-history-interrupted-ic/);

  const route = source.slice(source.indexOf('// Single history entry renderer'), source.indexOf("if (entry.role === 'user')"));
  assert.match(route, /entry\.role === 'usage-limit'[\s\S]*?<HistoryInterruptedRow entry=\{entry\}/);
});

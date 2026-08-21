import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'PaneTabStrip.tsx'), 'utf8');

test('reveal читает committed rect и settle идёт passive-effect без layout-state feedback', () => {
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /desiredOverflowKeyRef\.current = key;\s*setOverflow\(\{ left, right \}\)/);
  assert.match(source, /useLayoutEffect\(\(\) => \{ measure\(\); \}/);
  assert.doesNotMatch(source, /useLayoutEffect\(measure,/);
  assert.match(source, /useEffect\(\(\) => \{[\s\S]{0,700}pendingRevealRef\.current[\s\S]{0,700}\}, \[overflow, revealChip, wrap\]\)/);
  assert.match(source, /revealSettlePassRef\.current > 4/);
  assert.match(source, /new ResizeObserver\(\(\) => \{\s*measure\(\);\s*\}\)/);
  assert.doesNotMatch(source, /ResizeObserver[\s\S]{0,180}revealChip/);
  assert.doesNotMatch(source, /useLayoutEffect\([^\n]*overflow|\[measure,[^\]]*overflow/);
  assert.doesNotMatch(source, /desiredOverflowRef|committedOverflowRef/);
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /marginPx/);
  assert.doesNotMatch(source, /viewportWidth:[^\n]*endInsetPx|clientWidth[^\n]*endInsetPx/);
  assert.doesNotMatch(source, /\[kindOfTab, overflow, wrap\]/);
});

test('wrap-mode не запускает reveal и не возвращает overflow badges', () => {
  assert.match(source, /if \(!el \|\| !targetTabId \|\| wrap\) return/);
  assert.match(source, /if \(wrap\) \{[\s\S]*left: \[\], right: \[\][\s\S]*return/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const timelinePath = fileURLToPath(new URL('../components/Workspace/Timeline.tsx', import.meta.url));
const source = fs.readFileSync(timelinePath, 'utf8');

test('single-entry menu splits Select and Copy without duplicating range state', () => {
  const splitStart = source.indexOf('data-testid="timeline-range-selection-split"');
  const splitEnd = source.indexOf('<div className="border-t border-white/10 my-1" />', splitStart);
  const split = source.slice(splitStart, splitEnd);

  assert.ok(splitStart >= 0 && splitEnd > splitStart, 'split control is present');
  assert.match(split, /data-testid="timeline-range-selection-start"/);
  assert.match(split, /style=\{\{ flex: '4 1 0%'/);
  assert.match(split, /startRangeSelection\(contextMenu\.entry\)/);
  assert.match(split, />\s*Выбрать\s*<\/button>/);
  assert.match(split, /style=\{\{ flex: '1 1 0%'/);
  assert.match(split, /handleCopySingleEntry\(contextMenu\.entry\)/);
  assert.match(split, /<Copy size=\{12\} \/>/);
});

test('an active range consumes the second click before Timeline navigation', () => {
  const selectionBranchStart = source.indexOf('if (selectionStartIdRef.current) {');
  const navigationStart = source.indexOf('const index = entries.findIndex', selectionBranchStart);
  const selectionBranch = source.slice(selectionBranchStart, navigationStart);

  assert.ok(selectionBranchStart >= 0, 'existing range-selection state machine is present');
  assert.ok(navigationStart > selectionBranchStart, 'navigation follows the selection branch');
  assert.match(selectionBranch, /e\?\.preventDefault\(\);/);
  assert.match(selectionBranch, /e\?\.stopPropagation\(\);/);
  assert.match(selectionBranch, /setRangeActionMenu\(\{/);
  assert.match(selectionBranch, /return;/);
  assert.match(source, /if \(readOnly && !selectionStartIdRef\.current\)/,
    'read-only navigation yields to an already active range selection');
});

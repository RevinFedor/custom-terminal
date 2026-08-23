import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('every group toggle carries one correlated geometry trace', () => {
  assert.match(source, /traceHistoryGroupToggleGeometry\(groupKey, 'expand', reason\)/);
  assert.match(source, /traceHistoryGroupToggleGeometry\(groupKey, 'collapse', 'header'\)/);
  assert.match(source, /traceHistoryGroupToggleGeometry\(groupKey, 'collapse', source\)/);
});

test('the trace observes commit and settle without becoming a scroll writer', () => {
  const start = source.indexOf('const traceHistoryGroupToggleGeometry =');
  const end = source.indexOf('// Group toggles obey', start);
  assert.ok(start >= 0 && end > start, 'geometry tracer must exist');
  const trace = source.slice(start, end);
  for (const phase of ['before', 'frame1', 'frame2', 'settled']) {
    assert.match(trace, new RegExp(`sample\\('${phase}'\\)`));
  }
  assert.match(trace, /token=/);
  assert.match(trace, /memberStubs=/);
  assert.match(trace, /restore=/);
  assert.match(trace, /hydration=/);
  assert.doesNotMatch(trace, /\.scrollTop\s*=/, 'observability must not steer the viewport');
  assert.doesNotMatch(trace, /setExpandedGroupKeys/, 'observability must not mutate group state');
});

test('expanded-group anchor corrects delayed machine scroll before ordinary scroll handling', () => {
  const start = source.indexOf('const stabilizePendingHistoryGroupExpand =');
  const end = source.indexOf('// Expansion is intentionally a TWO-COMMIT transaction', start);
  assert.ok(start >= 0 && end > start, 'group anchor transaction must exist');
  const transaction = source.slice(start, end);
  assert.match(transaction, /subscribePositionChange:/);
  assert.match(transaction, /addEventListener\('scroll', listener, \{ capture: true, passive: true \}\)/);
  assert.match(transaction, /removeEventListener\('scroll', listener, true\)/);
  assert.match(transaction, /source=' \+ correctionSource/);
});

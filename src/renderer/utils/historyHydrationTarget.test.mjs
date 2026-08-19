import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHistoryHydrationTargetStub } from './historyHydrationTarget.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const panelSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('hydration follows target uuid, never the compressed display index', () => {
  const entries = Array.from({ length: 620 }, (_, index) => ({
    uuid: `entry-${index}`,
    rowStub: false,
  }));
  // Production 19.08 16:18:53 UTC: Timeline display index 555 addressed a
  // different raw row after grouping. That unrelated row was a stub, while
  // the actual clicked target was already real.
  entries[555].rowStub = true;
  entries[601].uuid = 'clicked-target';
  assert.equal(entries[555].rowStub, true, 'old index-based answer was a false positive');
  assert.equal(isHistoryHydrationTargetStub(entries, 'clicked-target'), false);

  // The inverse must also hold: a genuinely stubbed target cannot be missed
  // merely because its display index happens to point at a real raw row.
  entries[555].rowStub = false;
  entries[601].rowStub = true;
  assert.equal(isHistoryHydrationTargetStub(entries, 'clicked-target'), true);
});

test('Timeline jump and search both use uuid hydration identity', () => {
  const jumpStart = panelSource.indexOf('const targetIsStub =');
  const jumpEnd = panelSource.indexOf('if (targetIsStub)', jumpStart);
  assert.ok(jumpStart >= 0 && jumpEnd > jumpStart, 'Timeline jump stub check must exist');
  const jumpCheck = panelSource.slice(jumpStart, jumpEnd);
  assert.match(
    jumpCheck,
    /isHistoryHydrationTargetStub\(entriesRef\.current, targetUuid\)/,
  );
  assert.doesNotMatch(jumpCheck, /entriesRef\.current\[currentIdx\]/);

  const searchStart = panelSource.indexOf('// rowStub check runs by uuid');
  const searchEnd = panelSource.indexOf('\n  }, [', searchStart);
  assert.ok(searchStart >= 0 && searchEnd > searchStart, 'search hydration check must exist');
  assert.match(
    panelSource.slice(searchStart, searchEnd),
    /isHistoryHydrationTargetStub\(\s*presentationEntriesRef\.current,\s*match\.entryUuid,?\s*\)/,
  );
});

test('missing or malformed inputs fail closed without asking for hydration', () => {
  assert.equal(isHistoryHydrationTargetStub(null, 'x'), false);
  assert.equal(isHistoryHydrationTargetStub([], ''), false);
  assert.equal(isHistoryHydrationTargetStub([{ uuid: 'x' }], 'missing'), false);
});

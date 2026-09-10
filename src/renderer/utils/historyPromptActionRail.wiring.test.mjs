import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const history = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);
const rewrite = fs.readFileSync(
  new URL('./historyRewriteRewind.ts', import.meta.url),
  'utf8',
);

test('saved-history rewind is the primary violet action and native rewind lives behind right click', () => {
  const start = history.indexOf('data-history-rewind-action-stack');
  const end = history.indexOf('</MessageActionRail>', start);
  assert.ok(start >= 0 && end > start, 'prompt action rail must exist');
  const rail = history.slice(start, end);

  const rewriteAt = rail.indexOf('data-testid="history-rewind-jsonl"');
  const deleteAt = rail.indexOf('data-testid="history-delete-iteration"');
  assert.ok(rewriteAt >= 0 && deleteAt > rewriteAt, 'JSONL rewind must sit above delete');
  assert.match(rail, /tone="accent"[\s\S]*?data-testid="history-rewind-jsonl"/);
  assert.match(rail, /data-testid="history-rewind-jsonl"[\s\S]*?<RotateCcw size=\{11\}/);
  assert.match(rail, /data-testid="history-rewind-jsonl"[\s\S]*?onContextMenu=\{openNativeRewindPopover\}/);
  assert.doesNotMatch(rail, /Scissors/);

  assert.match(history, /promptActionPopover\?\.kind === 'native-rewind'[\s\S]*?data-testid="history-rewind-native-popover"[\s\S]*?tone="warning"[\s\S]*?<RotateCcw size=\{11\}/);
  assert.match(history, /const openNativeRewindPopover[\s\S]*?if \(!allowRewind\) return/,
    'right click must still reveal the disabled native action and its reason');
  assert.match(history, /const requestRewind[\s\S]*?if \(!canRewind\) return/,
    'the native action itself must keep the runtime guard');
});

test('delete iteration is a confirmed destructive action with an outside and Escape exit', () => {
  assert.match(history, /data-testid="history-delete-iteration"[\s\S]*?<Trash2 size=\{11\}/);
  assert.match(history, /data-testid="history-delete-iteration-confirm"[\s\S]*?Удалить запрос и ответ\?/);
  assert.match(history, /data-testid="history-delete-iteration-confirm-submit"[\s\S]*?onClick=\{confirmDeleteIteration\}/);
  assert.match(history, /data-history-prompt-action-popover-backdrop[\s\S]*?onClose\(\)/);
  assert.match(history, /event\.key === 'Escape'\) onClose\(\)/);
  assert.match(history, /createPortal\([\s\S]*?document\.body/);
});

test('one-iteration delete proves the current row and reuses the guarded range transaction without restoring the prompt', () => {
  assert.match(rewrite, /executeHistoryDeleteIterationScenario[\s\S]*?executeHistoryRewriteRewindScenario\(\{/);
  assert.match(rewrite, /executeHistoryDeleteIterationScenario[\s\S]*?rangeMode: 'single'/);
  assert.match(rewrite, /executeHistoryDeleteIterationScenario[\s\S]*?restoreDraft: false/);
  assert.match(rewrite, /rangeMode === 'single'[\s\S]*?selected\.uuid/);
  assert.match(history, /executeHistoryDeleteIterationScenario\(\{[\s\S]*?uuid: entry\.uuid/);
  assert.match(history, /Итерация удалена: запрос и ответ убраны из сохранённой истории/);
});

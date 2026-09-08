import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('History renders lineage load failure as recovery instead of a valid empty transcript', () => {
  assert.match(source, /const \[historyLoadError, setHistoryLoadError\]/);
  assert.match(
    source,
    /setHistoryLoadError\(String\(result\?\.lineageReason \|\| result\?\.error/,
  );
  const errorBranch = source.indexOf('data-history-empty-state="load-error"');
  const emptyBranch = source.indexOf('data-history-empty-state="empty-transcript"');
  assert.notEqual(errorBranch, -1);
  assert.notEqual(emptyBranch, -1);
  assert.ok(errorBranch < emptyBranch, 'recovery error must win before generic empty state');
  assert.match(source, /Ничего не удалено; приложение не будет выдавать неполную ветку за пустой чат/);
});

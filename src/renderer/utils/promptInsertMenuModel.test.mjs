import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendHistoryDraftInsertion,
  buildProjectScriptRows,
  isCurrentPickerGeneration,
  joinPromptInsertionText,
  resolveHistoryScriptCwd,
} from './promptInsertMenuModel.mjs';

test('buildProjectScriptRows returns inert command text without Enter', () => {
  const rows = buildProjectScriptRows(
    JSON.stringify({ scripts: { dev: 'vite', _private: 'noop', test: 'vitest' } }),
    ['deploy.sh', '.hidden.sh', 'deploy.sh', 'notes.txt'],
  );

  assert.deepEqual(rows, [
    { id: 'npm:dev', label: 'npm run dev', text: 'npm run dev' },
    { id: 'npm:test', label: 'npm run test', text: 'npm run test' },
    { id: 'sh:deploy.sh', label: './deploy.sh', text: './deploy.sh' },
  ]);
  assert.equal(rows.some((row) => row.text.includes('\r')), false);
});

test('joinPromptInsertionText keeps prompt and file order with readable gaps', () => {
  assert.equal(
    joinPromptInsertionText('Review this', ['first file', '', 'second file']),
    'Review this\n\nfirst file\n\nsecond file',
  );
});

test('malformed package json does not hide shell scripts', () => {
  assert.deepEqual(buildProjectScriptRows('{bad', ['deploy.sh']), [
    { id: 'sh:deploy.sh', label: './deploy.sh', text: './deploy.sh' },
  ]);
});

test('history fallback inserts exact text without clearing the existing draft', () => {
  assert.equal(
    appendHistoryDraftInsertion('before\n', 'npm run dev'),
    'before\nnpm run dev',
  );
});

test('scripts prefer live PTY cwd and fall back to the captured History cwd', () => {
  assert.equal(resolveHistoryScriptCwd('/tmp/live ', '/tmp/captured'), '/tmp/live ');
  assert.equal(resolveHistoryScriptCwd('', '/tmp/captured '), '/tmp/captured ');
  assert.equal(resolveHistoryScriptCwd(null, undefined), '');
});

test('async picker completion only owns the generation it started in', () => {
  assert.equal(isCurrentPickerGeneration(3, 3), true);
  assert.equal(isCurrentPickerGeneration(3, 4), false);
  assert.equal(isCurrentPickerGeneration(0, 0), false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historyActionPresentationMeta } = require('./history-action-grammar.cjs');

test('file edit targets are exact paths, not display summaries or unresolved Python values', () => {
  const native = historyActionPresentationMeta({ toolName: 'Write', args: { file_path: '/project/work/status.md' } });
  assert.equal(native.fileEditTarget, '/project/work/status.md');
  const shell = historyActionPresentationMeta({ toolName: 'Bash', args: { command: 'cat >> work/status.md' } });
  assert.equal(shell.fileEditTarget, 'work/status.md');
  for (const call of [{ toolName: 'Patch', args: { summary: 'Patch not applied' } },
    { toolName: 'Edit', args: { summary: 'Example' } },
    { toolName: 'Read', args: { file_path: '/project/work/status.md' } },
    { toolName: 'Bash', args: { command: 'python -c "open(runtime_path, \'w\').write(\'new\')"' } }]) {
    assert.equal(historyActionPresentationMeta(call).fileEditTarget, undefined);
  }
});

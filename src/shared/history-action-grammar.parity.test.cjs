'use strict';

/**
 * Parity lock between the CJS (main) and ESM (renderer/Vite) twins of the
 * history action grammar. The two files exist because main requires CJS at
 * runtime while Vite serves source ESM to the browser; this test is the
 * mechanism that makes "edit both or fail" enforceable.
 */

const test = require('node:test');
const assert = require('node:assert');
const cjs = require('./history-action-grammar.cjs');

test('CJS and ESM grammar twins agree on every classification', async () => {
  const esm = await import('./history-action-grammar.mjs');

  const commands = [
    'grep -rn x src', 'cd /tmp && rg foo', 'P=1 node run.js', 'git diff',
    'sed -n 1,5p f', '# c\nnl -ba f', '/usr/bin/git status', 'docker ps',
    'echo hi && wc -l f', 'for i in 1 2; do cat $i; done', '', 'ls -la | head',
  ];
  for (const command of commands) {
    assert.equal(
      cjs.effectiveBashWord(command),
      esm.effectiveBashWord(command),
      'effectiveBashWord parity for: ' + command,
    );
  }

  const calls = [
    { toolName: 'Bash', args: { command: 'rg -n x' } },
    { toolName: 'Bash', args: { command: 'git push' } },
    { toolName: 'Read' },
    { toolName: 'Edit' },
    { toolName: 'MultiEdit' },
    { toolName: 'mcp__electron__electron_evaluate' },
    { toolName: 'mcp__sc-desktop-tg-search__telegram_fetch' },
    { toolName: 'MCP', mcpServer: 'electron', mcpMethod: 'click' },
    { toolName: 'TaskCreate' },
    { toolName: 'Agent' },
    { toolName: 'WebSearch' },
    { toolName: 'TotallyUnknown' },
  ];
  for (const call of calls) {
    assert.deepEqual(
      cjs.classifyHistoryAction(call),
      esm.classifyHistoryAction(call),
      'classifyHistoryAction parity for: ' + JSON.stringify(call),
    );
  }

  const headlineCalls = [
    { toolName: 'Bash', args: { command: "sed -n '500,560p' src/a/b.tsx" }, family: 'read', bashWord: 'sed' },
    { toolName: 'Bash', args: { command: 'git diff -- src/a/b.tsx' }, family: 'git', bashWord: 'git', bashDetail: 'diff' },
    { toolName: 'Bash', args: { command: 'npm run build' }, family: 'run', bashWord: 'npm' },
    { toolName: 'Bash', args: { command: 'rg -n "useMemo" src/renderer' }, family: 'search', bashWord: 'rg' },
    { toolName: 'Read', args: { file_path: '/a/b.tsx', offset: 40, limit: 60 } },
    { toolName: 'MultiEdit', args: { file_path: '/a/b.md' } },
    { toolName: 'Grep', args: { pattern: 'foo', path: 'src' } },
    { toolName: 'MCP', family: 'mcp', mcpServer: 'terminal', mcpMethod: 'complete_task' },
    { toolName: 'WebSearch', args: { query: 'anthropic' } },
  ];
  for (const call of headlineCalls) {
    assert.deepEqual(
      cjs.historyActionHeadline(call),
      esm.historyActionHeadline(call),
      'historyActionHeadline parity for: ' + JSON.stringify(call),
    );
  }

  assert.deepEqual([...cjs.BASH_READ_WORDS].sort(), [...esm.BASH_READ_WORDS].sort());
  assert.deepEqual([...cjs.BASH_SEARCH_WORDS].sort(), [...esm.BASH_SEARCH_WORDS].sort());
  assert.deepEqual(cjs.FAMILY_LABELS, esm.FAMILY_LABELS);
  assert.equal(cjs.HISTORY_CAPTION_MAX_CHARS, esm.HISTORY_CAPTION_MAX_CHARS);
});

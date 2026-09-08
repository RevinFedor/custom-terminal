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
    "sed -n '1,60p' src/main/claude-compact-queue-projection.js | grep -i queue",
    "B=/baseline; cd $B; sed -n '3418,3432p' src/renderer/App.tsx; grep -i busy src/main.js",
    "sed -n '56523,56600p' src/main/main.js; grep --ignore-case history src/other.js",
    "sed -i.bak 's/old/new/' src/main.js", "sed --in-place=.bak 's/old/new/' src/main.js",
    "sed -ne '-i' src/main.js", "sed -n -- '-i' src/main.js",
    "sed -n 1p src/read.js; sed -i.bak 's/a/b/' src/main.js",
  ];
  for (const command of commands) {
    assert.equal(
      cjs.effectiveBashWord(command),
      esm.effectiveBashWord(command),
      'effectiveBashWord parity for: ' + command,
    );
  }

  const calls = [
    ...commands.map(command => ({ toolName: 'Bash', args: { command } })),
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
    ...commands.map(command => {
      const call = { toolName: 'Bash', args: { command } };
      return { ...call, ...cjs.classifyHistoryAction(call) };
    }),
    { toolName: 'Bash', args: { command: "sed -n '500,560p' src/a/b.tsx" }, family: 'read', bashWord: 'sed' },
    { toolName: 'Bash', args: { command: 'git diff -- src/a/b.tsx' }, family: 'git', bashWord: 'git', bashDetail: 'diff' },
    { toolName: 'Bash', args: { command: 'npm run build' }, family: 'run', bashWord: 'npm' },
    { toolName: 'Bash', args: { command: 'rg -n "useMemo" src/renderer' }, family: 'search', bashWord: 'rg' },
    { toolName: 'Read', args: { file_path: '/a/b.tsx', offset: 40, limit: 60 } },
    { toolName: 'MultiEdit', args: { file_path: '/a/b.md' } },
    { toolName: 'Grep', args: { pattern: 'foo', path: 'src' } },
    { toolName: 'MCP', family: 'mcp', mcpServer: 'terminal', mcpMethod: 'complete_task' },
    { toolName: 'WebSearch', args: { query: 'anthropic' } },
    // Corpus-audit shapes (scripts/history-headline-audit.mjs) — the exact
    // command forms that broke in production; parity must hold on them too.
    { toolName: 'Bash', args: { command: 'P=~/L/x.log; echo "b"; awk \'$1 >= "12"\' $P | head -20' }, family: 'read', bashWord: 'awk' },
    { toolName: 'Bash', args: { command: 'stat -f m "$HOME/Library/Logs/nt/production.log"' }, family: 'read', bashWord: 'stat' },
    { toolName: 'Bash', args: { command: 'grep -rn "grammar.cjs" src/renderer/ | grep -v test' }, family: 'search', bashWord: 'grep' },
    { toolName: 'Bash', args: { command: 'DB="$HOME/App Support/noted-dev.db"; sqlite3 "$DB" ".tables"' }, family: 'run', bashWord: 'sqlite3' },
    { toolName: 'Bash', args: { command: '(NOTED_WEB_PORT=7979 npx electron-vite dev > /tmp/d.log 2>&1 &) ; sleep 15' }, family: 'run', bashWord: 'npx' },
    { toolName: 'Bash', args: { command: 'F=/tmp/x.jsonl\nnode -e "1" "$F"' }, family: 'run', bashWord: 'node' },
    { toolName: 'Bash', args: { command: "jq '{a:.b | c}' /tmp/probe.json" }, family: 'read', bashWord: 'jq' },
  ];
  for (const call of headlineCalls) {
    assert.deepEqual(
      cjs.historyActionHeadline(call),
      esm.historyActionHeadline(call),
      'historyActionHeadline parity for: ' + JSON.stringify(call),
    );
  }

  const presentationCalls = [
    { toolName: 'Read', args: { file_path: 'docs/knowledge/fact.md', offset: 10, limit: 20 }, family: 'read' },
    { toolName: 'Edit', args: { file_path: '/repo/src/main.js' }, family: 'edit' },
    { toolName: 'Bash', args: { command: 'grep -A 8 "needle" src/main/main.js' }, family: 'search', bashWord: 'grep' },
    { toolName: 'MCP', args: {}, family: 'mcp', mcpServer: 'terminal', mcpMethod: 'list_tabs' },
    { toolName: 'mcp__knowledge__docs_search', args: { query: 'history grouping' } },
  ];
  for (const call of presentationCalls) {
    assert.deepEqual(
      cjs.historyActionPresentationMeta(call),
      esm.historyActionPresentationMeta(call),
      'historyActionPresentationMeta parity for: ' + JSON.stringify(call),
    );
  }

  assert.deepEqual([...cjs.BASH_READ_WORDS].sort(), [...esm.BASH_READ_WORDS].sort());
  assert.deepEqual([...cjs.BASH_SEARCH_WORDS].sort(), [...esm.BASH_SEARCH_WORDS].sort());
  assert.deepEqual(cjs.FAMILY_LABELS, esm.FAMILY_LABELS);
  assert.equal(cjs.HISTORY_CAPTION_MAX_CHARS, esm.HISTORY_CAPTION_MAX_CHARS);
});

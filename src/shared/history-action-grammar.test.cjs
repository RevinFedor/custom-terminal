'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyHistoryAction,
  effectiveBashWord,
  historyActionHeadline,
  historyActionPresentationMeta,
  parseMcpToolName,
} = require('./history-action-grammar.cjs');

test('effectiveBashWord walks past cd, env assignments and echo', () => {
  assert.equal(effectiveBashWord('grep -rn "x" src/'), 'grep');
  assert.equal(effectiveBashWord('cd /tmp && rg -n foo'), 'rg');
  assert.equal(effectiveBashWord('P=~/Library/Logs node run.js'), 'node');
  assert.equal(effectiveBashWord('echo "=== a ===" && sed -n 1,5p f.txt'), 'sed');
  assert.equal(effectiveBashWord('# comment\nnl -ba file | sed -n 1p'), 'nl');
  assert.equal(effectiveBashWord('/usr/bin/git status'), 'git');
  assert.equal(effectiveBashWord(''), '');
});

test('bash family split: read / search / git / run', () => {
  assert.equal(classifyHistoryAction({ toolName: 'Bash', args: { command: 'sed -n 1,10p a' } }).family, 'read');
  assert.equal(classifyHistoryAction({ toolName: 'Bash', args: { command: 'rg -n foo src' } }).family, 'search');
  assert.equal(classifyHistoryAction({ toolName: 'Bash', args: { command: 'git diff --stat' } }).family, 'git');
  assert.equal(classifyHistoryAction({ toolName: 'Bash', args: { command: 'node scripts/x.js' } }).family, 'run');
  const classified = classifyHistoryAction({ toolName: 'Bash', args: { command: 'wc -l *.ts' } });
  assert.equal(classified.family, 'read');
  assert.equal(classified.bashWord, 'wc');
});

test('mcp transport names parse into server and method', () => {
  assert.deepEqual(
    parseMcpToolName('mcp__electron__electron_evaluate'),
    { server: 'electron', method: 'evaluate' },
  );
  assert.deepEqual(
    parseMcpToolName('mcp__terminal__delegate_to_session'),
    { server: 'terminal', method: 'delegate_to_session' },
  );
  assert.deepEqual(
    parseMcpToolName('mcp__sc-desktop-tg-search__telegram_fetch'),
    { server: 'sc-desktop-tg-search', method: 'telegram_fetch' },
  );
  assert.equal(parseMcpToolName('Bash'), null);
  const classified = classifyHistoryAction({ toolName: 'mcp__knowledge__docs_search' });
  assert.equal(classified.family, 'mcp');
  assert.equal(classified.mcpServer, 'knowledge');
  assert.equal(classified.mcpMethod, 'docs_search');
});

test('explicit mcp identity outranks name parsing', () => {
  const classified = classifyHistoryAction({
    toolName: 'MCP',
    mcpServer: 'electron',
    mcpMethod: 'evaluate',
  });
  assert.deepEqual(classified, { family: 'mcp', mcpServer: 'electron', mcpMethod: 'evaluate' });
});

test('edit family unifies Edit/Write/MultiEdit; plan and task map', () => {
  for (const name of ['Edit', 'Write', 'MultiEdit']) {
    assert.equal(classifyHistoryAction({ toolName: name }).family, 'edit');
  }
  assert.equal(classifyHistoryAction({ toolName: 'TaskCreate' }).family, 'plan');
  assert.equal(classifyHistoryAction({ toolName: 'Plan' }).family, 'plan');
  assert.equal(classifyHistoryAction({ toolName: 'Agent' }).family, 'task');
  assert.equal(classifyHistoryAction({ toolName: 'WebSearch' }).family, 'web');
  assert.equal(classifyHistoryAction({ toolName: 'SomethingNew' }).family, 'other');
});

// ── Headline grammar: WHAT was touched, never HOW it was invoked ───────────

test('read headline carries the file and the line window, not the sed command', () => {
  const headline = historyActionHeadline({
    toolName: 'Bash',
    args: { command: "sed -n '500,560p' src/components/presentation-video/VideoPresentationStoryboard.tsx" },
    family: 'read',
    bashWord: 'sed',
  });
  assert.deepEqual(headline, {
    verb: 'Read',
    subject: 'src/components/presentation-video/VideoPresentationStoryboard.tsx',
    detail: '500–560',
  });
});

test('head/tail windows read as first/last N', () => {
  assert.equal(
    historyActionHeadline({ toolName: 'Bash', args: { command: 'head -n 40 a/b.ts' }, family: 'read', bashWord: 'head' }).detail,
    'first 40',
  );
  assert.equal(
    historyActionHeadline({ toolName: 'Bash', args: { command: 'tail -50 logs/dev.log' }, family: 'read', bashWord: 'tail' }).detail,
    'last 50',
  );
});

test('git headline is subcommand + target file name', () => {
  assert.deepEqual(
    historyActionHeadline({
      toolName: 'Bash',
      args: { command: 'git diff -- src/components/presentation-video/VideoPresentationStoryboard.tsx' },
      family: 'git',
      bashWord: 'git',
      bashDetail: 'diff',
    }),
    { verb: 'Git', subject: 'diff · VideoPresentationStoryboard.tsx', detail: '' },
  );
  assert.deepEqual(
    historyActionHeadline({
      toolName: 'Bash', args: { command: 'git status' }, family: 'git', bashWord: 'git', bashDetail: 'status',
    }),
    { verb: 'Git', subject: 'status', detail: '' },
  );
});

test('git headline re-derives status when an old row has no bashDetail stamp', () => {
  assert.deepEqual(
    historyActionHeadline({
      toolName: 'Bash',
      args: { command: "git status --short | sed -n '1,260p' | rg webodm" },
      family: 'git',
      bashWord: 'git',
    }),
    { verb: 'Git', subject: 'status', detail: '' },
  );
});

test('search headline is pattern + scope; ls-like tools name the directory', () => {
  assert.deepEqual(
    historyActionHeadline({
      toolName: 'Bash', args: { command: 'rg -n "useMemo" src/renderer' }, family: 'search', bashWord: 'rg',
    }),
    { verb: 'Search', subject: 'useMemo', detail: 'src/renderer' },
  );
  assert.equal(
    historyActionHeadline({
      toolName: 'Bash', args: { command: 'ls -la packages/claude-blocks/src' }, family: 'search', bashWord: 'ls',
    }).subject,
    'packages/claude-blocks/src',
  );
});

test('an option VALUE never poses as the search pattern', () => {
  // `-A 8` is one option: dropping only the token that starts with `-` left
  // the context SIZE first in line, so the row read «Search 8 · main.js».
  // Corpus: 47 such rows, and — worse than ugly — two different searches of
  // one file rendered as the SAME row, which is what "why is search
  // duplicated for the same file" was actually about.
  const head = (command, word = 'grep') => historyActionHeadline({
    toolName: 'Bash', args: { command }, family: 'search', bashWord: word,
  });
  assert.deepEqual(
    head('grep -n -A 8 "realPattern" src/main/main.js'),
    { verb: 'Search', subject: 'realPattern', detail: 'src/main/main.js' },
  );
  // Short bundle, value glued on, long form with `=`.
  assert.equal(head('grep -A12 "glued" file.txt').subject, 'glued');
  assert.equal(head('rg --glob "*.ts" "needle" src/', 'rg').subject, 'needle');
  assert.equal(head('rg -n -m 20 "capped" report.txt', 'rg').subject, 'capped');
  // `-e`/`--regexp` STATE the pattern — position no longer decides.
  assert.equal(head('grep -e "explicit" src/main/main.js').subject, 'explicit');
  assert.equal(head('rg --regexp="stated" src/', 'rg').subject, 'stated');
  // A flag that takes no value must not eat the pattern.
  assert.equal(head('grep -rn --include=*.js "pattern" src/').subject, 'pattern');
  // Searching for a literal number is still legal — the guard is positional,
  // not "numbers can't be patterns".
  assert.equal(head('grep -n "900296" session.jsonl').subject, '900296');
});

test('a run headline is program + subcommand words ONLY — no flags, paths or ellipsis', () => {
  const subject = (command) =>
    historyActionHeadline({ toolName: 'Bash', args: { command }, family: 'run' }).subject;
  assert.equal(subject('npm run build'), 'npm run build');
  assert.equal(subject('docker compose up -d'), 'docker compose up');
  assert.equal(subject('mkdir -p /Users/fedor/Desktop/vs-code/agrotech/webodm/docs/tmp'), 'mkdir');
  assert.equal(subject('sips --cropToHeightWidth 340 680 shot.png'), 'sips');
  assert.equal(subject('python3 -c "import x"'), 'python3');
  assert.equal(subject("printf '%s\\n' a; rg --files docs | sort"), 'printf');
  for (const cmd of ['mkdir -p /a/b', 'sips -g pixelWidth x.png', 'python3 -c "import x"']) {
    assert.ok(!subject(cmd).includes('…'), 'no ellipsis: ' + subject(cmd));
    assert.ok(!subject(cmd).includes('/'), 'no paths: ' + subject(cmd));
    assert.ok(!subject(cmd).includes('-'), 'no flags: ' + subject(cmd));
  }
});

test('every file-mutating tool speaks one verb: Edit', () => {
  for (const name of ['Edit', 'Write', 'MultiEdit', 'Update']) {
    const headline = historyActionHeadline({ toolName: name, args: { file_path: '/a/b.md' } });
    assert.equal(headline.verb, 'Edit', name + ' must say Edit');
    assert.equal(headline.subject, '/a/b.md');
  }
});

test('native Read carries its offset window; MCP says server + method', () => {
  assert.deepEqual(
    historyActionHeadline({ toolName: 'Read', args: { file_path: '/a/b.tsx', offset: 40, limit: 60 } }),
    { verb: 'Read', subject: '/a/b.tsx', detail: '40–100' },
  );
  assert.deepEqual(
    historyActionHeadline({ toolName: 'MCP', family: 'mcp', mcpServer: 'terminal', mcpMethod: 'complete_task' }),
    { verb: 'terminal', subject: 'complete_task', detail: '' },
  );
});

test('pipelines keep the FIRST segment subject (the file), not the filter', () => {
  const headline = historyActionHeadline({
    toolName: 'Bash',
    args: { command: "sed -n '1,45p' src/a/Big.tsx | grep -n useState" },
    family: 'read',
    bashWord: 'sed',
  });
  assert.equal(headline.subject, 'src/a/Big.tsx');
  assert.equal(headline.detail, '1–45');
});

test('a pipe INSIDE quotes is data, not a stage boundary', () => {
  // A jq program is one quoted string full of pipes. Splitting on the first
  // one cut the command before its path, so the header had no subject at all
  // and the card printed the whole raw command in grey instead of the file.
  const headline = historyActionHeadline({
    toolName: 'Bash',
    args: { command: "jq '.trace | keys, {n:(.events|length)}' '/Users/x/Logs/app/probe.json'" },
    family: 'read',
    bashWord: 'jq',
  });
  assert.equal(headline.subject, '/Users/x/Logs/app/probe.json');
});

test('a real pipeline still ends at the first unquoted pipe', () => {
  const headline = historyActionHeadline({
    toolName: 'Bash',
    args: { command: "jq -r '.a | .b' /tmp/one.json | tail -n 20 /tmp/two.json" },
    family: 'read',
    bashWord: 'jq',
  });
  assert.equal(headline.subject, '/tmp/one.json', 'the second stage must not steal the subject');
});

test('a patch that never applied never claims to be an edit', () => {
  const headline = historyActionHeadline({
    toolName: 'Patch',
    args: { summary: 'Patch not applied' },
    family: 'edit',
  });
  assert.equal(headline.verb, 'Patch');
  assert.equal(headline.subject, 'Patch not applied');
});

test('the subject comes from the stage that OWNS the word, with $VAR resolved', () => {
  // The five-wall screenshot (16.08): `P=~/…/production.log; echo "…";
  // awk '…' $P | grep … | head`. Stage one is an assignment, the file is a
  // variable reference — the old extractor read stage one, found nothing,
  // and the card printed the whole raw pipeline in dim grey.
  const headline = historyActionHeadline({
    toolName: 'Bash',
    args: { command: 'P=~/Library/Logs/noted-terminal/production.log; echo "=== x ==="; awk \'$1 >= "12:31"\' $P | grep -E "LongTask" | head -20' },
    family: 'read',
    bashWord: 'awk',
  });
  assert.equal(headline.subject, '~/Library/Logs/noted-terminal/production.log');
});

test('presentation identity ignores read ranges and marks documentation scope', () => {
  const first = historyActionPresentationMeta({
    toolName: 'Read',
    args: { file_path: 'docs/knowledge/fact-history.md', offset: 20, limit: 30 },
    family: 'read',
  });
  const second = historyActionPresentationMeta({
    toolName: 'Read',
    args: { file_path: 'docs/knowledge/fact-history.md', offset: 200, limit: 10 },
    family: 'read',
  });
  assert.equal(first.targetKey, second.targetKey, 'line windows are body detail, not target identity');
  assert.equal(first.targetLabel, 'fact-history.md');
  assert.equal(first.docsKind, 'search');
  assert.equal(first.aggregateKey, 'read:docs');
});

test('searches aggregate by scope while preserving their distinct patterns', () => {
  const a = historyActionPresentationMeta({
    toolName: 'Bash',
    args: { command: 'grep -A 8 "firstPattern" src/main/main.js' },
    family: 'search',
    bashWord: 'grep',
  });
  const b = historyActionPresentationMeta({
    toolName: 'Bash',
    args: { command: 'grep -A 8 "secondPattern" src/main/main.js' },
    family: 'search',
    bashWord: 'grep',
  });
  assert.equal(a.targetKey, 'src/main/main.js');
  assert.equal(a.targetKey, b.targetKey);
  assert.notEqual(a.operationLabel, b.operationLabel, 'the original queries remain available inside expansion');
});

test('MCP aggregates per server; real docs_search inherits the docs-search colour channel', () => {
  const terminal = historyActionPresentationMeta({
    toolName: 'MCP', family: 'mcp', mcpServer: 'terminal', mcpMethod: 'list_tabs', args: {},
  });
  const docs = historyActionPresentationMeta({
    toolName: 'mcp__knowledge__docs_search', args: { query: 'history grouping' },
  });
  assert.equal(terminal.aggregateKey, 'mcp:terminal:regular');
  assert.equal(terminal.targetLabel, 'list tabs');
  assert.equal(docs.aggregateKey, 'mcp:knowledge:docs');
  assert.equal(docs.docsKind, 'search');
});

test('documentation edits use the edit colour channel', () => {
  const meta = historyActionPresentationMeta({
    toolName: 'Edit', args: { file_path: '/repo/docs/knowledge/fix.md' }, family: 'edit',
  });
  assert.equal(meta.docsKind, 'edit');
  assert.equal(meta.aggregateKey, 'edit:docs');
  assert.equal(meta.targetLabel, 'fix.md');
});

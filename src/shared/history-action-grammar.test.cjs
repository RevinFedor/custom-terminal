'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyHistoryAction,
  effectiveBashWord,
  historyActionHeadline,
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

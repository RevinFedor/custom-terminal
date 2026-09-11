'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'actual main function exists: ' + name);
  return node.getText(ast);
}
const build = vm.runInNewContext([
  declaration('shellQuote'), declaration('tomlString'), declaration('buildCodexCommand'),
  'buildCodexCommand',
].join('\n'));

for (const [command, verb] of [['codex', null], ['codex-c', 'resume'], ['codex-f', 'fork']]) {
  test('managed ' + command + ' disables only whimsy before the launch subcommand', () => {
    const line = build({ command, sessionId: 'session-exact', cwd: '/tmp/project with spaces' });
    assert.match(line, /^command codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox /);
    assert.equal(line.match(/-c 'tui\.whimsy=false'/g)?.length, 1);
    assert.doesNotMatch(line, /tui\.animations/);
    assert.ok(line.includes("-C '/tmp/project with spaces'"));
    if (verb) {
      assert.ok(line.endsWith(verb + " 'session-exact'"));
      assert.ok(line.indexOf('tui.whimsy=false') < line.indexOf(verb + ' '));
    } else {
      assert.doesNotMatch(line, /\b(?:resume|fork)\b/);
    }
  });
}

test('presentation override preserves profile, proxy, exact model and effort', () => {
  const line = build({ command: 'codex-c', sessionId: 'source-exact',
    profile: 'noted-profile', model: 'gpt-6-astra', effort: 'max',
    providerProxyBaseUrl: 'http://127.0.0.1:4001/codex/t/tab-exact' });
  for (const expected of ["--profile 'noted-profile'", "--model 'gpt-6-astra'",
    "-c 'model_reasoning_effort=\"max\"'",
    "-c 'openai_base_url=\"http://127.0.0.1:4001/codex/t/tab-exact\"'",
    "-c 'tui.whimsy=false'", "resume 'source-exact'"]) assert.ok(line.includes(expected), expected);
});

test('presentation flag does not consume or modify developer text, including braille', () => {
  const instruction = 'Keep A⠁Z and the word tui.whimsy=true unchanged.';
  const line = build({ command: 'codex', developerInstructions: instruction });
  assert.ok(line.includes("-c 'developer_instructions=" + JSON.stringify(instruction) + "'"));
  assert.equal(line.match(/-c 'tui\.whimsy=false'/g)?.length, 1);
});

test('the shared launch writer uses the actual command builder for every managed launch', () => {
  const runner = declaration('runCodexCommandFromPayloadInner');
  assert.match(runner, /const cmdLine = buildCodexCommand\(\{/);
  assert.match(runner, /writeAgentLaunchCommandToIdleShell\(term, \{[\s\S]{0,160}command: cmdLine,/);
  assert.doesNotMatch(runner, /spawn\([^\n]*codex/);
});

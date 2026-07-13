const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');

function buildTimeline(...payloads) {
  const records = [
    {
      __line: 1,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'update docs' },
    },
    ...payloads.map((payload, index) => ({
      __line: index + 2,
      type: 'response_item',
      payload,
    })),
  ];
  return _api.buildCodexTimeline(records, 'docs-test-session')[0];
}

function execPayload(source) {
  return { type: 'custom_tool_call', name: 'exec', input: source };
}

test('keeps direct Codex apply_patch and docs_search attributes', () => {
  const entry = buildTimeline(
    {
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: docs/knowledge/direct.md\n@@\n-old\n+new\n*** End Patch',
    },
    {
      type: 'function_call',
      name: 'mcp__knowledge__docs_search',
      arguments: JSON.stringify({ query: 'direct docs lookup' }),
    },
  );

  assert.deepEqual(entry.docsEdited, ['knowledge/direct.md']);
  assert.deepEqual(entry.docsSearchQueries, ['direct docs lookup']);
});

test('collects nested apply_patch and docs_search calls from Codex exec', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: docs/knowledge/nested.md',
    '@@',
    '-old',
    '+new',
    '+const patch = "this declaration is patch content, not JavaScript source";',
    '*** Update File: src/main/not-docs.js',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const source = [
    `const patch = ${JSON.stringify(patch)};`,
    'const [edit, docs] = await Promise.all([',
    '  tools.apply_patch(patch),',
    '  tools.mcp__knowledge__docs_search({ query: "nested docs lookup" }),',
    ']);',
    'text(JSON.stringify({ edit, docs }));',
  ].join('\n');

  const entry = buildTimeline(execPayload(source));

  assert.deepEqual(entry.docsEdited, ['knowledge/nested.md']);
  assert.deepEqual(entry.docsSearchQueries, ['nested docs lookup']);
});

test('does not infer docs activity from exec strings, discovery, or shell commands', () => {
  const source = [
    'const names = ALL_TOOLS.filter((tool) => /apply_patch|docs_search/.test(tool.name));',
    'const examples = [',
    '  "tools.apply_patch(fakePatch)",',
    '  "tools.mcp__knowledge__docs_search({ query: \\\"fake\\\" })",',
    '];',
    'const result = await tools.exec_command({',
    '  cmd: "rg -n \\\"apply_patch|docs_search|docs/knowledge\\\" src docs",',
    '});',
    'text(JSON.stringify({ names, examples, result }));',
  ].join('\n');

  const entry = buildTimeline(execPayload(source));

  assert.equal(entry.docsEdited, undefined);
  assert.equal(entry.docsSearchQueries, undefined);
});

test('ignores a patch literal when exec never calls tools.apply_patch', () => {
  const source = [
    `const example = ${JSON.stringify('*** Begin Patch\n*** Update File: docs/knowledge/example.md\n*** End Patch')};`,
    'text(example);',
  ].join('\n');

  const entry = buildTimeline(execPayload(source));

  assert.equal(entry.docsEdited, undefined);
});

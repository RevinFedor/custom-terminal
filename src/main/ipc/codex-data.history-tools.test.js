const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');

function historyFor(...payloads) {
  const records = [
    {
      __line: 1,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'inspect tools' },
    },
    ...payloads.map((payload, index) => ({
      __line: index + 2,
      type: 'response_item',
      payload,
    })),
  ];
  return _api.buildCodexFullHistory(records, 'history-tools-session');
}

function execCall(callId, source) {
  return { type: 'custom_tool_call', name: 'exec', call_id: callId, input: source };
}

function output(callId, value, isError = false) {
  return { type: 'custom_tool_call_output', call_id: callId, output: value, is_error: isError };
}

function rawActions(history) {
  return history.flatMap((entry) => entry.actions || []).map((action) => action.rawTool);
}

test('renders nested exec_command as a Bash card instead of EXEC source', () => {
  const source = [
    'const result = await tools.exec_command({',
    '  cmd: "rg -n \\\"needle\\\" src",',
    '  workdir: "/tmp/project",',
    '});',
    'text(result.output);',
  ].join('\n');
  const history = historyFor(
    execCall('exec-1', source),
    output('exec-1', [
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: 'src/file.js:4:needle\n' },
    ]),
  );

  const actions = rawActions(history);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].toolName, 'Bash');
  assert.equal(actions[0].args.command, 'rg -n "needle" src');
  assert.equal(actions[0].result, 'src/file.js:4:needle\n');
});

test('maps parallel image and MCP calls, then folds wait result into those cards', () => {
  const source = [
    'const [imageResult, docsResult] = await Promise.all([',
    '  tools.view_image({ path: "/tmp/screen.png", detail: "original" }),',
    '  tools.mcp__knowledge__docs_search({ projectPath: "/tmp/project", query: "history tools" }),',
    ']);',
    'image(imageResult.image_url);',
    'text(JSON.stringify(docsResult));',
  ].join('\n');
  const history = historyFor(
    execCall('exec-2', source),
    output('exec-2', 'Script running with cell ID 42\nWall time 10.0 seconds\nOutput:\n'),
    { type: 'function_call', name: 'wait', call_id: 'wait-2', arguments: JSON.stringify({ cell_id: '42' }) },
    output('wait-2', [
      { type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' },
      { type: 'input_image', image_url: 'data:image/png;base64,do-not-render' },
      { type: 'input_text', text: JSON.stringify({ content: [{ type: 'text', text: '{"found":2}' }] }) },
    ]),
  );

  const actions = rawActions(history);
  assert.deepEqual(actions.map((action) => action.toolName), ['Read', 'MCP']);
  assert.equal(actions[0].args.file_path, '/tmp/screen.png');
  assert.equal(actions[0].result, '[Image output]');
  assert.match(actions[1].args.summary, /^knowledge · docs_search — history tools$/);
  assert.equal(actions[1].result, '{"found":2}');
  assert.equal(JSON.stringify(history).includes('do-not-render'), false);
});

test('turns apply_patch into per-file edit cards even when patch text contains a fake declaration', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: src/main.js',
    '@@',
    '-const before = true;',
    '+const before = false;',
    '+const sample = "const patch = fake";',
    '*** Add File: src/new.js',
    '+export const ready = true;',
    '*** End Patch',
  ].join('\n');
  const source = [
    `const patch = ${JSON.stringify(patchText)};`,
    'const result = await tools.apply_patch(patch);',
    'text(result);',
  ].join('\n');
  const history = historyFor(execCall('exec-3', source), output('exec-3', '{}'));

  const actions = rawActions(history);
  assert.deepEqual(actions.map((action) => action.toolName), ['Edit', 'Write']);
  assert.deepEqual(actions[0].args, {
    file_path: 'src/main.js',
    old_string: 'const before = true;',
    new_string: 'const before = false;\nconst sample = "const patch = fake";',
  });
  assert.equal(actions[1].args.file_path, 'src/new.js');
  assert.equal(actions[1].args.content, 'export const ready = true;');
});

test('does not promote quoted tool examples to real History actions', () => {
  const source = [
    'const example = "tools.exec_command({ cmd: \\\"rm -rf /\\\" })";',
    '// tools.apply_patch(fakePatch);',
    'text(example);',
  ].join('\n');
  const history = historyFor(execCall('exec-4', source), output('exec-4', 'example only'));

  const actions = rawActions(history);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].toolName, 'Orchestration');
  assert.equal(actions.some((action) => action.toolName === 'Bash' || action.toolName === 'Edit'), false);
});

test('keeps direct legacy calls but gives them semantic History labels', () => {
  const history = historyFor(
    { type: 'function_call', name: 'exec_command', call_id: 'bash-1', arguments: JSON.stringify({ cmd: 'pwd' }) },
    output('bash-1', 'ok'),
    { type: 'function_call', namespace: 'mcp__knowledge', name: 'docs_search', call_id: 'mcp-1', arguments: JSON.stringify({ query: 'timeline' }) },
    output('mcp-1', 'found'),
  );

  const actions = rawActions(history);
  assert.deepEqual(actions.map((action) => action.toolName), ['Bash', 'MCP']);
  assert.equal(actions[0].args.command, 'pwd');
  assert.equal(actions[1].args.summary, 'knowledge · docs_search — timeline');
});

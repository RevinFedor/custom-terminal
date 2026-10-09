'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _api } = require('./ipc/codex-data');
const { historyActionHeadline } = require('../shared/history-action-grammar.cjs');

const target = '/workspace/docs/working-context.md';
const command = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('" + target
  + "')\ns=p.read_text()\np.write_text(s.replace('working', 'checked') + '\\n')\nPY";
const source = 'text(await tools.exec_command({cmd:String.raw`' + command
  + '`,workdir:"/workspace",max_output_tokens:1000}));';

function actionsFor(input, output) {
  return _api.codexHistoryActionsForCall({ toolName: 'exec', callId: 'raw-command',
    args: { input }, cwd: '/workspace' }, output, false).actions.map(action => action.rawTool);
}

test('String.raw Python write retains exact command and renders through the existing Edit grammar', () => {
  const [action] = actionsFor(source);
  assert.equal(action.args.command, command);
  assert.equal(action.args.workdir, '/workspace');
  assert.equal(action.family, 'edit');
  assert.equal(action.result, undefined, 'call-only must not claim success');
  const headline = historyActionHeadline(action);
  assert.equal(headline.verb, 'Edit');
  assert.ok(headline.subject.endsWith('working-context.md'));
});

test('String.raw preserves backslashes and escaped interpolation exactly', () => {
  const raw = 'printf "\\n\\t\\u0041"; echo \\${HOME}';
  const [action] = actionsFor('text(await tools.exec_command({cmd:String.raw`' + raw + '`}));');
  assert.equal(action.args.command, raw);
  assert.equal(action.family, 'run');
});

test('live and durable History preserve operation identity, timestamp and Edit semantics', () => {
  const timestamp = '2026-10-09T03:18:57.959Z';
  const records = [
    { __line: 1, type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'update context' } },
    { __line: 2, __byteOffset: 150, type: 'response_item', timestamp,
      payload: { type: 'custom_tool_call', call_id: 'raw-command', name: 'exec', input: source } },
    { __line: 3, type: 'response_item', timestamp: '2026-10-09T03:18:58.101Z',
      payload: { type: 'custom_tool_call_output', call_id: 'raw-command', output: '{"exit_code":0}' } },
  ];
  const rows = _api.buildCodexFullHistory(records, 'raw-template-session');
  const action = rows.flatMap(row => row.actions || []).find(action => action.rawTool)?.rawTool;
  assert.equal(action.args.command, command);
  assert.equal(action.family, 'edit');
  assert.equal(action.toolUseId, 'raw-command:canonical:0');
  assert.equal(action.recordTime.timestamp, timestamp);
  assert.equal(action.recordTime.scope, 'container');
  assert.equal(action.result, '{"exit_code":0}');
});

test('unknown interpolation, custom tags and invalid JS do not invent a command', () => {
  for (const input of [
    'text(await tools.exec_command({cmd:String.raw`python3 ${unknown}`}));',
    'text(await tools.exec_command({cmd:customTag`python3 -c write_file()`}));',
    'text(await tools.exec_command({cmd:String.raw`broken `syntax`}));',
  ]) assert.notEqual(actionsFor(input)[0].family, 'edit');
});

test('shadowed or modified String.raw is not treated as the intrinsic', () => {
  for (const prefix of [
    'const String = {raw: value => "something else"};\n',
    'String.raw = value => "something else";\n',
    'Object.defineProperty(String, "raw", {value: other});\n',
    'const alias = String; alias.raw = other;\n',
    'globalThis.String = other;\n',
    '"".constructor.raw = other;\n',
    'mutateGlobals();\n',
  ]) assert.equal(actionsFor(prefix + source)[0].args.command, 'Exec Command');
});

test('conditional, unawaited and shadowed tool calls do not create raw-command ownership candidates', () => {
  for (const input of [
    'if (condition) { ' + source + ' }',
    source.replace('await tools.', 'tools.'),
    'const tools = other;\n' + source,
  ]) assert.equal(actionsFor(input)[0].args.command, 'Exec Command');
});

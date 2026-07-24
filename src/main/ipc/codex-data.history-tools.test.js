const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');

function historyFor(...items) {
  const records = [
    {
      __line: 1,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'inspect tools' },
    },
    ...items.map((item, index) => item?.recordType
      ? {
          __line: index + 2,
          type: item.recordType,
          payload: item.payload,
        }
      : {
          __line: index + 2,
          type: 'response_item',
          payload: item,
        }),
  ];
  return _api.buildCodexFullHistory(records, 'history-tools-session');
}

function historyRecord(recordType, payload) {
  return { recordType, payload };
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

test('keeps a tool card uuid stable when its output arrives', () => {
  const pending = historyFor(execCall('exec-stable', 'text("pending")'));
  const completed = historyFor(
    execCall('exec-stable', 'text("pending")'),
    output('exec-stable', 'done'),
  );
  const pendingCard = pending.find((entry) => entry.actions?.length);
  const completedCard = completed.find((entry) => entry.actions?.length);

  assert.ok(pendingCard);
  assert.ok(completedCard);
  assert.equal(completedCard.uuid, pendingCard.uuid);
  assert.equal(completedCard.actions[0].rawTool.result, 'done');
});

test('uses canonical patch_apply_end diff content and original line numbers', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: /tmp/session-transcript-service.revision.test.js',
    '@@',
    "test('Codex history returns unchanged before loading or projecting records', async (t) => {",
    '@@',
    '  assert.equal(loadCalls, 2);',
    '  assert.equal(projectionCalls, 2);',
    '});',
    '+',
    "+test('a transcript change received during an active read gets one trailing read', async () => {",
    '+});',
    '*** End Patch',
  ].join('\n');
  const turnId = 'turn-direct-patch';
  const history = historyFor(
    {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'patch-direct',
      input: patchText,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
    historyRecord('event_msg', {
      type: 'patch_apply_end',
      call_id: 'patch-direct',
      turn_id: turnId,
      success: true,
      changes: {
        '/tmp/session-transcript-service.revision.test.js': {
          type: 'update',
          unified_diff: [
            '@@ -84 +84,4 @@',
            ' });',
            '+',
            "+test('a transcript change received during an active read gets one trailing read', async () => {",
            '+});',
          ].join('\n'),
          move_path: null,
        },
      },
    }),
    output('patch-direct', 'Success'),
  );

  const actions = rawActions(history);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].toolName, 'Edit');
  assert.equal(actions[0].args.old_string, '});');
  assert.equal(
    actions[0].args.new_string,
    "});\n\ntest('a transcript change received during an active read gets one trailing read', async () => {\n});",
  );
  assert.equal(actions[0].args.new_string.includes('assert.equal(loadCalls'), false);
  assert.deepEqual(actions[0].diffHunks, [{
    oldStart: 84,
    newStart: 84,
    entries: [
      { tag: 'eq', line: '});' },
      { tag: 'add', line: '' },
      { tag: 'add', line: "test('a transcript change received during an active read gets one trailing read', async () => {" },
      { tag: 'add', line: '});' },
    ],
  }]);
});

test('associates a nested exec patch event by interval, turn and exact touched path', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: src/main.js',
    '@@',
    '-const before = true;',
    '+const before = false;',
    '*** End Patch',
  ].join('\n');
  const source = [
    `const patch = ${JSON.stringify(patchText)};`,
    'const result = await tools.apply_patch(patch);',
    'text(result);',
  ].join('\n');
  const turnId = 'turn-nested-patch';
  const records = [
    {
      __line: 1,
      type: 'session_meta',
      payload: { cwd: '/tmp/project' },
    },
    {
      __line: 2,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'edit' },
    },
    {
      __line: 3,
      type: 'response_item',
      payload: {
        ...execCall('outer-exec', source),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      __line: 4,
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'exec-generated-inner-id',
        turn_id: turnId,
        success: true,
        changes: {
          '/tmp/project/src/main.js': {
            type: 'update',
            unified_diff: '@@ -30 +30 @@\n-const before = true;\n+const before = false;',
            move_path: null,
          },
        },
      },
    },
    {
      __line: 5,
      type: 'response_item',
      payload: output('outer-exec', '{}'),
    },
  ];
  const history = _api.buildCodexFullHistory(records, 'history-tools-session');

  const actions = rawActions(history);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].toolName, 'Edit');
  assert.equal(actions[0].args.file_path, '/tmp/project/src/main.js');
  assert.deepEqual(actions[0].diffHunks, [{
    oldStart: 30,
    newStart: 30,
    entries: [
      { tag: 'del', line: 'const before = true;' },
      { tag: 'add', line: 'const before = false;' },
    ],
  }]);
});

test('preserves separate old/new starts for every canonical multi-hunk update', () => {
  const parsed = _api.parseCodexPatchApplyChanges({
    type: 'patch_apply_end',
    success: true,
    changes: {
      '/tmp/view.swift': {
        type: 'update',
        unified_diff: [
          '@@ -609,2 +609,5 @@',
          ' line-a',
          '+insert-a',
          '+insert-b',
          '+insert-c',
          ' line-b',
          '@@ -613,5 +616,2 @@',
          ' keep-a',
          '-remove-a',
          '-remove-b',
          '-remove-c',
          ' keep-b',
        ].join('\n'),
        move_path: null,
      },
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].toolName, 'MultiEdit');
  assert.deepEqual(
    parsed[0].diffHunks.map(({ oldStart, newStart }) => ({ oldStart, newStart })),
    [
      { oldStart: 609, newStart: 609 },
      { oldStart: 613, newStart: 616 },
    ],
  );
});

test('malformed result metadata falls back without inventing diff line numbers', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: /tmp/file.js',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const history = historyFor(
    {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'patch-malformed',
      input: patchText,
    },
    historyRecord('event_msg', {
      type: 'patch_apply_end',
      call_id: 'patch-malformed',
      success: true,
      changes: {
        '/tmp/file.js': {
          type: 'update',
          // Header claims two old rows, but only one is present.
          unified_diff: '@@ -10,2 +10 @@\n-old\n+new',
        },
      },
    }),
    output('patch-malformed', 'Success'),
  );

  const actions = rawActions(history);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].toolName, 'Edit');
  assert.equal(actions[0].args.old_string, 'old');
  assert.equal(actions[0].diffHunks, undefined);
});

test('patch metadata enriches a pending card without changing its UUID', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: /tmp/file.js',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const call = {
    type: 'custom_tool_call',
    name: 'apply_patch',
    call_id: 'patch-live',
    input: patchText,
  };
  const pending = historyFor(call);
  const enriched = historyFor(
    call,
    historyRecord('event_msg', {
      type: 'patch_apply_end',
      call_id: 'patch-live',
      success: true,
      changes: {
        '/tmp/file.js': {
          type: 'update',
          unified_diff: '@@ -22 +22 @@\n-old\n+new',
        },
      },
    }),
  );

  const pendingCard = pending.find((entry) => entry.actions?.length);
  const enrichedCard = enriched.find((entry) => entry.actions?.length);
  assert.equal(enrichedCard.uuid, pendingCard.uuid);
  assert.equal(pendingCard.actions[0].rawTool.diffHunks, undefined);
  assert.equal(enrichedCard.actions[0].rawTool.diffHunks[0].oldStart, 22);
});

test('nested patch association fails closed when two pending exec calls touch the same path', () => {
  const patchText = [
    '*** Begin Patch',
    '*** Update File: src/same.js',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const source = [
    `const patch = ${JSON.stringify(patchText)};`,
    'const result = await tools.apply_patch(patch);',
    'text(result);',
  ].join('\n');
  const turnId = 'turn-ambiguous';
  const records = [
    { __line: 1, type: 'session_meta', payload: { cwd: '/tmp/project' } },
    { __line: 2, type: 'event_msg', payload: { type: 'user_message', message: 'edit twice' } },
    {
      __line: 3,
      type: 'response_item',
      payload: {
        ...execCall('outer-a', source),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      __line: 4,
      type: 'response_item',
      payload: {
        ...execCall('outer-b', source),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      __line: 5,
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'exec-generated-inner-id',
        turn_id: turnId,
        success: true,
        changes: {
          '/tmp/project/src/same.js': {
            type: 'update',
            unified_diff: '@@ -70 +70 @@\n-old\n+new',
          },
        },
      },
    },
    { __line: 6, type: 'response_item', payload: output('outer-a', '{}') },
    { __line: 7, type: 'response_item', payload: output('outer-b', '{}') },
  ];

  const actions = rawActions(_api.buildCodexFullHistory(records, 'history-tools-session'));
  assert.equal(actions.length, 2);
  assert.equal(actions.every((action) => action.diffHunks === undefined), true);
});

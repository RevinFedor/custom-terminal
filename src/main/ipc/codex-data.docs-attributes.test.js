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

  assert.deepEqual(entry.docsEdited, ['docs/knowledge/direct.md']);
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

  assert.deepEqual(entry.docsEdited, ['docs/knowledge/nested.md']);
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

test('retains non-doc edit targets for linked working-file markers without inventing docs edits', () => {
  const file = '/private/linked-work/recovery.md';
  const patch = '*** Begin Patch\n*** Update File: ' + file + '\n@@\n-old\n+new\n*** End Patch';
  for (const payload of [{ type: 'custom_tool_call', name: 'apply_patch', input: patch },
    execPayload('await tools.apply_patch(' + JSON.stringify(patch) + ');')]) {
    const entry = buildTimeline(payload);
    assert.deepEqual(entry.fileEdits, [file]);
    assert.equal(entry.docsEdited, undefined);
  }
  const read = buildTimeline(execPayload('await tools.exec_command({cmd:"cat /private/linked-work/recovery.md"});'));
  assert.equal(read.fileEdits, undefined);
});

test('linked-file edit targets survive Timeline checkpoints and stay on their original iteration', () => {
  const projector = _api.createCodexTimelineProjector('linked-file-checkpoint');
  projector.feed({ __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'Edit the working file' } });
  projector.feed({ __line: 2, type: 'response_item', payload: execPayload(
    'await tools.exec_command({cmd:"cat >> work/status.md <<EOF\\nnew\\nEOF",workdir:"/fixture-project"});',
  ) });
  const resumed = _api.createCodexTimelineProjector('linked-file-checkpoint', projector.exportState());
  resumed.feed({ __line: 3, type: 'event_msg', payload: { type: 'user_message', message: 'Only read now' } });
  resumed.feed({ __line: 4, type: 'response_item', payload: execPayload(
    'await tools.exec_command({cmd:"cat work/status.md",workdir:"/fixture-project"});',
  ) });
  const entries = resumed.finalize();
  assert.deepEqual(entries[0].fileEdits, ['/fixture-project/work/status.md']);
  assert.equal(entries[0].docsEdited, undefined);
  assert.equal(entries[1].fileEdits, undefined);
});

test('linked-file markers use the existing shell edit grammar, not a docs-only command whitelist', () => {
  for (const cmd of ['printf new > work/status.md', 'touch work/status.md', 'rm work/status.md']) {
    const args = { cmd, workdir: '/fixture-project' };
    for (const payload of [{ type: 'function_call', name: 'exec_command', arguments: JSON.stringify(args) },
      execPayload('await tools.exec_command(' + JSON.stringify(args) + ');')]) {
      assert.deepEqual(buildTimeline(payload).fileEdits, ['/fixture-project/work/status.md'], cmd);
    }
  }
});

test('computed patch markers use the actual apply result and original call owner across checkpoints', () => {
  const projector = _api.createCodexTimelineProjector('computed-linked-file');
  projector.feed({ __line: 0, type: 'session_meta', payload: { cwd: '/fixture-project' } });
  projector.feed({ __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'Edit working file' } });
  const input = 'const files = ["work/status.md"]; const patch = "*** Begin Patch\\n" + files.map(file => "*** Delete File: " + file + "\\n").join("") + "*** End Patch"; await tools.apply_patch(patch);';
  projector.feed({ __line: 2, type: 'response_item', payload: { ...execPayload(input), call_id: 'patch-call' } });
  assert.equal(projector.finalize()[0].fileEdits, undefined, 'computed source is not a path proof');
  const resumed = _api.createCodexTimelineProjector('computed-linked-file', structuredClone(projector.exportState()));
  resumed.feed({ __line: 3, type: 'event_msg', payload: { type: 'user_message', message: 'Another user' } });
  resumed.feed({ __line: 4, type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch-call',
    success: true, changes: { 'work/status.md': { type: 'delete' } } } });
  const entries = resumed.finalize();
  assert.deepEqual(entries[0].fileEdits, ['/fixture-project/work/status.md']);
  assert.equal(entries[1].fileEdits, undefined);
  resumed.feed({ __line: 5, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch-call', output: 'done' } });
  assert.equal(resumed.exportState().pendingFileEditCalls.size, 0);
});

test('failed or ambiguous computed patch results cannot mark an attached file', () => {
  for (const ambiguous of [false, true]) {
    const projector = _api.createCodexTimelineProjector('computed-linked-negative');
    projector.feed({ __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'Edit working file' } });
    const input = 'const patch = files.map(file => file).join(""); await tools.apply_patch(patch);';
    for (const call_id of ambiguous ? ['A', 'B'] : ['A']) {
      projector.feed({ type: 'response_item', payload: { ...execPayload(input), call_id } });
    }
    projector.feed({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'unmatched',
      success: ambiguous, changes: { '/fixture-project/work/status.md': { type: 'delete' } } } });
    assert.equal(projector.finalize()[0].fileEdits, undefined);
  }
});

test('builds one-turn Codex evidence from exact call id and provider settings records', () => {
  const records = [
    {
      __line: 1,
      timestamp: '2026-08-30T12:16:12.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'update docs' },
    },
    {
      __line: 2,
      timestamp: '2026-08-30T12:16:13.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' },
    },
    {
      __line: 3,
      timestamp: '2026-08-30T12:16:14.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        namespace: 'mcp__knowledge',
        name: 'docs_search',
        call_id: 'docs-call-1',
        arguments: JSON.stringify({ query: 'exact knowledge lookup' }),
      },
    },
    {
      __line: 4,
      timestamp: '2026-08-30T12:16:15.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'docs-call-1',
        output: JSON.stringify({ found: 1, files: ['docs/knowledge/fact-codex.md'] }),
      },
    },
    {
      __line: 5,
      timestamp: '2026-08-30T12:16:16.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna', effort: 'high' },
    },
  ];

  const evidence = _api.buildCodexTurnEvidence(records, 'evidence-session', { providerTurnIndex: 0 });

  assert.equal(evidence.found, true);
  assert.equal(evidence.settings.status, 'changed_during_turn');
  assert.equal(evidence.settings.model, null);
  assert.equal(evidence.settings.effort, null);
  assert.equal(evidence.settings.modelAtTurnStart, 'gpt-5.6-sol');
  assert.equal(evidence.settings.effortAtTurnStart, 'ultra');
  assert.equal(evidence.settings.modelAtTurnEnd, 'gpt-5.6-luna');
  assert.deepEqual(evidence.settings.modelSource, {
    source: 'turn_context',
    timestamp: '2026-08-30T12:16:13.000Z',
    sourceLine: 2,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  assert.equal(evidence.settings.changesDuringTurn[0]?.model, 'gpt-5.6-luna');
  assert.equal(evidence.operations.length, 1);
  assert.deepEqual(evidence.operations[0], {
    operationId: 'docs-call-1:canonical:0',
    callId: 'docs-call-1',
    toolName: 'MCP',
    mcpServer: 'knowledge',
    mcpMethod: 'docs_search',
    input: {
      summary: 'knowledge · docs_search — exact knowledge lookup',
      query: 'exact knowledge lookup',
    },
    result: '{"found":1,"files":["docs/knowledge/fact-codex.md"]}',
    resultPresent: true,
    isError: false,
    callTimestamp: '2026-08-30T12:16:14.000Z',
    callSourceLine: 3,
    callScope: 'provider_call',
    resultTimestamp: '2026-08-30T12:16:15.000Z',
    resultSourceLine: 4,
  });
});

test('keeps an unmatched Codex call as missing instead of claiming success', () => {
  const evidence = _api.buildCodexTurnEvidence([
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'inspect' } },
    {
      __line: 2,
      type: 'response_item',
      payload: {
        type: 'function_call', namespace: 'mcp__knowledge', name: 'docs_search',
        call_id: 'pending-docs', arguments: JSON.stringify({ query: 'pending query' }),
      },
    },
  ], 'evidence-pending-session', { providerTurnIndex: 0 });

  assert.equal(evidence.operations.length, 1);
  assert.equal(evidence.operations[0]?.resultPresent, false);
  assert.equal(evidence.operations[0]?.isError, false);
});

test('keeps a matched provider error distinct from a successful empty result', () => {
  const evidence = _api.buildCodexTurnEvidence([
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'inspect' } },
    {
      __line: 2,
      type: 'response_item',
      payload: {
        type: 'function_call', namespace: 'mcp__knowledge', name: 'docs_search',
        call_id: 'failed-docs', arguments: JSON.stringify({ query: 'broken query' }),
      },
    },
    {
      __line: 3,
      type: 'response_item',
      payload: {
        type: 'function_call_output', call_id: 'failed-docs', output: 'model transport failed', is_error: true,
      },
    },
  ], 'evidence-error-session', { providerTurnIndex: 0 });

  assert.equal(evidence.operations[0]?.resultPresent, true);
  assert.equal(evidence.operations[0]?.isError, true);
  assert.equal(evidence.operations[0]?.result, 'model transport failed');
});

test('does not fall back from an absent exact user UUID to another turn index', () => {
  const evidence = _api.buildCodexTurnEvidence([
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
    { __line: 2, type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
  ], 'evidence-identity-session', {
    userUuid: 'codex-user-evidence-identity-session-missing',
    providerTurnIndex: 0,
  });

  assert.equal(evidence.found, false);
  assert.equal(evidence.reason, 'exact_user_uuid_not_found_in_provider_projection');
  assert.deepEqual(evidence.operations, []);
});

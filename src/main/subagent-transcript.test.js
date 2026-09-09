const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createSubagentStepProjectionState,
  readAgentSteps,
  claudeRecordToSteps,
  codexRecordToSteps,
  findCodexAgentFile,
  findCodexSubagentNewTaskBoundary,
} = require('./subagent-transcript');

// A subagent writes its work into its OWN transcript and returns only a final
// answer to the parent, so these parsers are the only way the detail pane can
// show what the agent is doing. Shapes below are copied from real files:
// ~/.claude/projects/<dir>/<session>/subagents/agent-*.jsonl and
// ~/.codex/sessions/**/rollout-*.jsonl with thread_source: subagent.

// ── Claude records ─────────────────────────────────────────────────────────

test('claude assistant record yields tool / message / thinking steps', () => {
  const steps = claudeRecordToSteps({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'Мне нужно прочитать package.json' },
        { type: 'text', text: 'Читаю файл' },
        { type: 'tool_use', name: 'Bash', input: { command: 'cat package.json' } },
      ],
    },
  });
  assert.deepEqual(steps.map((step) => step.kind), ['thinking', 'message', 'tool']);
  assert.equal(steps[2].tool, 'Bash');
  assert.equal(steps[2].text, 'cat package.json');
});

test('claude tool label falls back through the input shapes', () => {
  const byPath = claudeRecordToSteps({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.txt' } }] },
  });
  assert.equal(byPath[0].text, '/tmp/a.txt');

  const byPattern = claudeRecordToSteps({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }] },
  });
  assert.equal(byPattern[0].text, 'TODO');

  // Unknown input shape must still produce a step — the tool name alone is
  // useful, and dropping it would leave visible gaps in the timeline.
  const bare = claudeRecordToSteps({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'x' } }] },
  });
  assert.equal(bare.length, 1);
  assert.equal(bare[0].tool, 'WebFetch');
});

test('claude keeps the full child prompt while tool results update their call', () => {
  const state = createSubagentStepProjectionState();
  const prompt = 'задача\n<pasted_content>' + 'x'.repeat(900) + '</pasted_content>';
  const user = claudeRecordToSteps({ type: 'user', uuid: 'u1', message: { content: prompt } }, state);
  assert.equal(user[0].text, prompt);

  const call = claudeRecordToSteps({
    type: 'assistant',
    uuid: 'a1',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a' } }] },
  }, state);
  const result = claudeRecordToSteps({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }] },
  }, state);
  assert.equal(result[0].id, call[0].id);
  assert.equal(result[0].result, 'file body');
});

// ── Codex records ──────────────────────────────────────────────────────────

test('codex reasoning / tool / message map to steps', () => {
  const reasoning = codexRecordToSteps({
    payload: { type: 'reasoning', summary: [{ text: 'Проверяю структуру проекта' }] },
  });
  assert.equal(reasoning[0].kind, 'thinking');
  assert.match(reasoning[0].text, /структуру/);

  const tool = codexRecordToSteps({
    payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"ls"})' },
  });
  assert.equal(tool[0].kind, 'tool');
  assert.equal(tool[0].tool, 'Script');
  assert.match(tool[0].text, /exec_command/);

  const legacyState = createSubagentStepProjectionState();
  const liveFinal = codexRecordToSteps({
    payload: { type: 'agent_message', message: 'ГОТОВО', phase: 'final_answer' },
  }, legacyState);
  assert.deepEqual(liveFinal, [], 'telemetry waits for a durable carrier/final boundary');
  const final = codexRecordToSteps({ payload: { type: 'task_complete' } }, legacyState);
  assert.equal(final[0].kind, 'message');
  assert.equal(final[0].final, true);
});

test('codex empty reasoning is dropped, not rendered as a blank line', () => {
  // Real corpus: `summary: []` appears constantly (784 reasoning records on one
  // explorer agent); rendering each as an empty row would bury the real steps.
  assert.deepEqual(codexRecordToSteps({ payload: { type: 'reasoning', summary: [] } }), []);
  assert.deepEqual(codexRecordToSteps({ payload: { type: 'agent_message', message: '  ' } }), []);
});

test('codex bookkeeping records are ignored', () => {
  for (const type of ['token_count', 'turn_context', 'world_state', 'session_meta']) {
    assert.deepEqual(codexRecordToSteps({ payload: { type } }), [], type);
  }
});

test('codex nested exec uses the parent canonical decoder and pairs its result', () => {
  const { _api } = require('./ipc/codex-data');
  const state = createSubagentStepProjectionState();
  const call = codexRecordToSteps({
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_nested',
      input: 'const r = await tools.exec_command({cmd:"git status",workdir:"/tmp"}); text(r.output);',
    },
  }, state, _api.codexHistoryActionsForCall);
  assert.equal(call[0].tool, 'Bash');
  assert.equal(call[0].args.command, 'git status');
  const result = codexRecordToSteps({
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call_nested',
      output: 'clean',
    },
  }, state, _api.codexHistoryActionsForCall);
  assert.equal(result[0].id, call[0].id);
  assert.equal(result[0].result, 'clean');
});

test('codex canonical direct edit stays pending until its real output record', () => {
  const { _api } = require('./ipc/codex-data');
  const state = createSubagentStepProjectionState({ codexSessionId: 'session-edit' });
  const args = {
    file_path: '/tmp/visual-history.md',
    old_string: 'before',
    new_string: 'after',
  };
  const call = codexRecordToSteps({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'Edit',
      call_id: 'call-edit',
      arguments: JSON.stringify(args),
    },
  }, state, _api.codexHistoryActionsForCall);
  assert.equal(call.length, 1);
  assert.equal(call[0].tool, 'Edit');
  assert.equal(call[0].result, undefined, 'the call is not an empty successful result');

  const result = codexRecordToSteps({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-edit',
      output: '',
    },
  }, state, _api.codexHistoryActionsForCall);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, call[0].id);
  assert.equal(result[0].result, '', 'an explicit empty output still completes the call');
});

// ── incremental reading ────────────────────────────────────────────────────

const withTempFile = (contents, run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-subagent-'));
  const file = path.join(dir, 'agent-test.jsonl');
  fs.writeFileSync(file, contents);
  try { return run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const withTempFileAsync = async (contents, run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-subagent-'));
  const file = path.join(dir, 'agent-test.jsonl');
  fs.writeFileSync(file, contents);
  try { return await run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const codexLine = (record) => JSON.stringify(record) + '\n';

test('codex v2 child starts at exact NEW_TASK and renders only durable assistant carriers', () => {
  const sessionId = '01a01b21-6fd4-7f21-976b-8bc179b337fa';
  const agentPath = '/root/typed_contract_design';
  const records = [
    {
      type: 'session_meta',
      payload: {
        id: sessionId,
        thread_source: 'subagent',
        multi_agent_version: 'v2',
        agent_path: agentPath,
      },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', id: 'msg_parent', content: [{ type: 'input_text', text: 'старый prompt родителя' }] },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: 'старый prompt родителя' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'msg_parent_answer', content: [{ type: 'output_text', text: 'старый ответ родителя' }] },
    },
    {
      type: 'response_item',
      payload: {
        type: 'agent_message',
        id: 'amsg_task',
        author: '/root',
        recipient: agentPath,
        content: [
          { type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${agentPath}\nSender: /root\nPayload:\n` },
          { type: 'encrypted_content', encrypted_content: 'gAAAA-task' },
        ],
      },
    },
    // Fork snapshots may carry ancestor metadata after the child's own root
    // metadata. It must not replace this reader's owner or boundary.
    { type: 'session_meta', payload: { id: 'parent-session', thread_source: 'user' } },
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', id: 'msg_provider_context',
        content: [{
          type: 'input_text',
          text: '<recommended_plugins>...</recommended_plugins>\n# AGENTS.md instructions for /repo\n<INSTRUCTIONS>...</INSTRUCTIONS>\n<environment_context>...</environment_context>',
        }],
      },
    },
    { type: 'event_msg', timestamp: '2026-08-19T17:46:20.000Z', payload: { type: 'agent_message', message: 'Проверяю контракт', phase: 'commentary' } },
    {
      type: 'response_item',
      timestamp: '2026-08-19T17:46:20.002Z',
      payload: { type: 'message', role: 'assistant', id: 'msg_commentary', phase: 'commentary', content: [{ type: 'output_text', text: 'Проверяю контракт' }] },
    },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_read', name: 'exec', input: 'const r = await tools.exec_command({cmd:"rg contract"}); text(r.output);' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_read', output: 'hit' } },
    { type: 'event_msg', timestamp: '2026-08-19T17:49:20.000Z', payload: { type: 'agent_message', message: 'Готово', phase: 'final_answer' } },
    {
      type: 'response_item',
      timestamp: '2026-08-19T17:49:20.002Z',
      payload: { type: 'message', role: 'assistant', id: 'msg_final', phase: 'final_answer', content: [{ type: 'output_text', text: 'Готово' }] },
    },
  ];
  withTempFile(records.map(codexLine).join(''), (file) => {
    const { _api } = require('./ipc/codex-data');
    const result = readAgentSteps({
      toolType: 'codex',
      filePath: file,
      sessionId,
      offset: 0,
      projectionState: createSubagentStepProjectionState({ codexSessionId: sessionId }),
      codexDecodeCall: _api.codexHistoryActionsForCall,
    });
    const messages = result.steps.filter((step) => step.kind === 'message');
    assert.deepEqual(messages.map((step) => step.text), ['Проверяю контракт', 'Готово']);
    assert.equal(messages[0].id, `codex-assistant-${sessionId}-8`);
    assert.equal(messages[0].sessionId, sessionId);
    assert.equal(messages[0].timestamp, '2026-08-19T17:46:20.002Z');
    assert.equal(messages[1].final, true);
    assert.equal(result.steps.some((step) => /старый/.test(step.text)), false);
    const instruction = result.steps.find((step) => step.kind === 'instruction');
    assert.equal(instruction.instructionFileName, 'AGENTS.md');
    assert.equal(instruction.instructionScope, 'repo');
    assert.equal(result.steps.some((step) => /recommended_plugins/.test(step.text)), false);
    const toolUpdates = result.steps.filter((step) => step.id === 'call_read:canonical:0');
    assert.equal(toolUpdates.length, 2);
    assert.equal(toolUpdates[1].result, 'hit');
  });
});

test('codex child keeps one canonical user carrier after its NEW_TASK boundary', () => {
  const sessionId = 'child-session';
  const agentPath = '/root/reviewer';
  const records = [
    { type: 'session_meta', payload: { id: sessionId, thread_source: 'subagent', multi_agent_version: 'v2', agent_path: agentPath } },
    {
      type: 'response_item',
      payload: {
        type: 'agent_message', author: '/root', recipient: agentPath,
        content: [{ type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${agentPath}\nSender: /root\nPayload:\n` }],
      },
    },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'msg_u', content: [{ type: 'input_text', text: 'уточнение' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'уточнение' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_a', content: [{ type: 'output_text', text: 'принято' }] } },
  ];
  withTempFile(records.map(codexLine).join(''), (file) => {
    const result = readAgentSteps({
      toolType: 'codex', filePath: file, sessionId, offset: 0,
      projectionState: createSubagentStepProjectionState({ codexSessionId: sessionId }),
    });
    assert.deepEqual(
      result.steps.filter((step) => step.kind === 'message').map((step) => [step.role, step.text]),
      [['user', 'уточнение'], ['assistant', 'принято']],
    );
  });
});

test('codex v1 child without a v2 NEW_TASK envelope keeps its own first prompt', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'legacy-child', thread_source: 'subagent', multi_agent_version: 'v1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'проверь файл' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg_a', content: [{ type: 'output_text', text: 'проверяю' }] } },
  ];
  withTempFile(records.map(codexLine).join(''), (file) => {
    const result = readAgentSteps({ toolType: 'codex', filePath: file, sessionId: 'legacy-child', offset: 0 });
    assert.deepEqual(
      result.steps.filter((step) => step.kind === 'message').map((step) => step.text),
      ['проверь файл', 'проверяю'],
    );
  });
});

test('codex NEW_TASK boundary scan skips a large inherited record with bounded streaming', async () => {
  const sessionId = 'child-streamed';
  const agentPath = '/root/streamed';
  const inherited = codexLine({ type: 'response_item', payload: { type: 'noop', padding: 'x'.repeat(5 * 1024 * 1024) } });
  const staleBootstrap = codexLine({
    type: 'response_item',
    payload: {
      type: 'message', role: 'user', id: 'msg_old_bootstrap',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for /old\n<INSTRUCTIONS>old</INSTRUCTIONS>' }],
    },
  });
  const bootstrap = codexLine({
    type: 'response_item',
    timestamp: '2026-08-19T17:46:13.000Z',
    payload: {
      type: 'message', role: 'user', id: 'msg_bootstrap',
      content: [{ type: 'input_text', text: '<recommended_plugins>...</recommended_plugins>\n# AGENTS.md instructions for /repo\n<INSTRUCTIONS>outer <instructions>inner</instructions> body</INSTRUCTIONS>\n<environment_context>...</environment_context>' }],
    },
  });
  const boundary = codexLine({
    type: 'response_item',
    payload: {
      type: 'agent_message', author: '/root', recipient: agentPath,
      content: [{ type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${agentPath}\nSender: /root\nPayload:\n` }],
    },
  });
  const meta = codexLine({
    type: 'session_meta',
    payload: { id: sessionId, thread_source: 'subagent', multi_agent_version: 'v2', agent_path: agentPath },
  });
  await withTempFileAsync(meta + staleBootstrap + inherited + bootstrap + boundary, async (file) => {
    const result = await findCodexSubagentNewTaskBoundary({ filePath: file, expectedSessionId: sessionId });
    assert.equal(result.found, true);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.agentPath, agentPath);
    assert.equal(result.offset, Buffer.byteLength(meta + staleBootstrap + inherited + bootstrap + boundary));
    assert.equal(result.bootstrapInstruction.instructionFileName, 'AGENTS.md');
    assert.equal(result.bootstrapInstruction.instructionScope, 'repo');
    assert.match(result.bootstrapInstruction.text, /inner<\/instructions> body<\/INSTRUCTIONS>$/);
  });
});

test('incremental child reader never materialises more than one bounded chunk', () => {
  const largeIgnoredLine = codexLine({ type: 'response_item', payload: { type: 'noop', padding: 'x'.repeat(5 * 1024 * 1024) } });
  const visibleLine = codexLine({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', id: 'msg_after_large', content: [{ type: 'output_text', text: 'после большой строки' }] },
  });
  withTempFile(largeIgnoredLine + visibleLine, (file) => {
    const state = createSubagentStepProjectionState({ codexSessionId: 'chunked' });
    const first = readAgentSteps({ toolType: 'codex', filePath: file, sessionId: 'chunked', offset: 0, projectionState: state });
    assert.equal(first.pending, true);
    assert.equal(first.offset, 4 * 1024 * 1024);
    assert.equal(first.steps.length, 0);
    const second = readAgentSteps({ toolType: 'codex', filePath: file, sessionId: 'chunked', offset: first.offset, projectionState: state });
    assert.equal(second.steps.some((step) => step.text === 'после большой строки'), true);
    assert.equal(second.pending, false);
  });
});

const claudeLine = (text) => JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
}) + '\n';

test('reading resumes from the byte offset instead of re-parsing', () => {
  withTempFile(claudeLine('первый') + claudeLine('второй'), (file) => {
    const first = readAgentSteps({ toolType: 'claude', filePath: file, offset: 0 });
    assert.equal(first.steps.length, 2);

    // Nothing appended yet → no repeats. Re-emitting old steps would duplicate
    // the whole timeline on every tick.
    const second = readAgentSteps({ toolType: 'claude', filePath: file, offset: first.offset });
    assert.equal(second.steps.length, 0);

    fs.appendFileSync(file, claudeLine('третий'));
    const third = readAgentSteps({ toolType: 'claude', filePath: file, offset: second.offset });
    assert.equal(third.steps.length, 1);
    assert.equal(third.steps[0].text, 'третий');
  });
});

test('a half-written trailing line is left for the next tick', () => {
  // The agent appends while we read; consuming a partial JSON line would drop
  // that record permanently.
  withTempFile(claudeLine('целая') + '{"type":"assistant","mess', (file) => {
    const result = readAgentSteps({ toolType: 'claude', filePath: file, offset: 0 });
    assert.equal(result.steps.length, 1);
    assert.ok(result.offset < result.size, 'offset stops before the partial line');

    fs.writeFileSync(file, claudeLine('целая') + claudeLine('дописанная'));
    const next = readAgentSteps({ toolType: 'claude', filePath: file, offset: result.offset });
    assert.equal(next.steps.length, 1);
    assert.equal(next.steps[0].text, 'дописанная');
  });
});

test('a stale offset past the file size restarts from the beginning', () => {
  withTempFile(claudeLine('первый'), (file) => {
    const result = readAgentSteps({ toolType: 'claude', filePath: file, offset: 999_999 });
    assert.equal(result.success, true);
    assert.equal(result.steps.length, 1, 'truncated/replaced file re-reads instead of emitting garbage');
  });
});

test('missing transcript is reported, not thrown', () => {
  const result = readAgentSteps({ toolType: 'claude', filePath: '/nonexistent/agent.jsonl', offset: 0 });
  assert.equal(result.success, false);
  assert.deepEqual(result.steps, []);
});

test('codex lookup without an id returns nothing instead of scanning', () => {
  assert.equal(findCodexAgentFile({ agentSessionId: '' }), null);
  assert.equal(findCodexAgentFile({}), null);
});

// ── completion by the agent's own transcript ───────────────────────────────

const { isAgentFinishedByOwnTranscript, readAgentCompletionProof } = require('./subagent-transcript');

test('codex completion is recognised from the agent transcript tail', () => {
  // The parent is not a reliable witness: `wait_agent` is routinely called with
  // no target and its "Wait completed" output names nobody, so a finished agent
  // can leave zero terminal trace there. Live production tab: 12 of 36 spawns
  // had no terminal event, 11 were plainly finished in their own file.
  withTempFile(
    JSON.stringify({ payload: { type: 'reasoning', summary: [] } }) + '\n'
    + JSON.stringify({ payload: { type: 'agent_message', message: 'ГОТОВО', phase: 'final_answer' } }) + '\n',
    (file) => {
      assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'codex', filePath: file }), true);
    },
  );
  withTempFile(
    JSON.stringify({ payload: { type: 'task_complete', turn_id: 'x' } }) + '\n',
    (file) => {
      assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'codex', filePath: file }), true);
    },
  );
});

test('a still-working codex agent is not declared finished', () => {
  withTempFile(
    JSON.stringify({ payload: { type: 'custom_tool_call', name: 'exec', input: 'sleep 120' } }) + '\n',
    (file) => {
      assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'codex', filePath: file }), false);
    },
  );
});

test('completion proof returns the provider timestamp for frozen duration', () => {
  withTempFile(
    JSON.stringify({
      timestamp: '2026-08-18T20:12:42.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }) + '\n',
    (file) => {
      const proof = readAgentCompletionProof({ toolType: 'codex', filePath: file });
      assert.equal(proof.finished, true);
      assert.equal(proof.completedAt, Date.parse('2026-08-18T20:12:42.000Z'));
    },
  );
});

test('claude completion needs an ended assistant turn', () => {
  withTempFile(
    JSON.stringify({ type: 'assistant', message: { content: [], stop_reason: 'end_turn' } }) + '\n',
    (file) => {
      assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'claude', filePath: file }), true);
    },
  );
  withTempFile(claudeLine('ещё пишу'), (file) => {
    assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'claude', filePath: file }), false);
  });
});

test('an unreadable transcript never fabricates a terminal state', () => {
  // Absence of proof is not proof of completion — a missing file must keep the
  // agent live rather than silently closing a running card.
  assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'codex', filePath: '/nope/agent.jsonl' }), false);
  assert.equal(isAgentFinishedByOwnTranscript({ toolType: 'codex', filePath: '' }), false);
});

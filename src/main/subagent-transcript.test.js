const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readAgentSteps,
  claudeRecordToSteps,
  codexRecordToSteps,
  findCodexAgentFile,
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

test('claude user records contribute no steps', () => {
  // The first user record is the task itself (used for identity matching),
  // and tool_result records are echoes — neither is a step of the agent's work.
  assert.deepEqual(claudeRecordToSteps({ type: 'user', message: { content: 'задача' } }), []);
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
  assert.equal(tool[0].tool, 'exec');
  assert.match(tool[0].text, /exec_command/);

  const final = codexRecordToSteps({
    payload: { type: 'agent_message', message: 'ГОТОВО', phase: 'final_answer' },
  });
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

// ── incremental reading ────────────────────────────────────────────────────

const withTempFile = (contents, run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-subagent-'));
  const file = path.join(dir, 'agent-test.jsonl');
  fs.writeFileSync(file, contents);
  try { return run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

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

const { isAgentFinishedByOwnTranscript } = require('./subagent-transcript');

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

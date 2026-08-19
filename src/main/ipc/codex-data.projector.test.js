'use strict';

// The resumable projector must be indistinguishable from the one-shot pass:
// for ANY split point, feeding a prefix, finalizing (a live read happened),
// then feeding the rest must produce the same presentation as one fresh pass
// over the whole array. This is the property the whole windowed-history plan
// stands on — checkpoints are just persisted split points.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./codex-data');
const {
  buildCodexFullHistory,
  buildCodexVisibleRecordWrappers,
  createCodexHistoryProjector,
  createCodexTimelineProjector,
  projectCodexFullHistoryFromFile,
  invalidateCodexHistoryProjectors,
} = _api;

const recordsToJsonl = (records) => records
  .map(({ __line, __byteOffset, ...record }) => JSON.stringify(record))
  .join('\n') + '\n';

async function makeSessionFile(t, name, records) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-projector-file-'));
  t.after(async () => {
    invalidateCodexHistoryProjectors();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, `rollout-2026-08-07T10-00-00-${name}.jsonl`);
  await fs.promises.writeFile(filePath, recordsToJsonl(records));
  return { dir, filePath };
}

let lineCounter = 0;
let byteCounter = 0;
const rec = (type, payload, extra = {}) => {
  const line = lineCounter++;
  const byteOffset = byteCounter;
  byteCounter += 100 + line;
  return {
    type,
    payload,
    timestamp: '2026-08-07T10:00:' + String(line % 60).padStart(2, '0') + '.000Z',
    __line: line,
    __byteOffset: byteOffset,
    ...extra,
  };
};

/**
 * A fixture touching every stateful mechanism of the pass: session meta cwd,
 * model/effort dedupe, thinking accumulation, calls+outputs, background exec
 * cells (wait), apply_patch canonical events, subagent v1+v2 lifecycle,
 * compact companion pairing, token counts, rollback, in-flight tail.
 */
function buildFixtureRecords() {
  lineCounter = 0;
  byteCounter = 0;
  const records = [];
  records.push(rec('session_meta', { id: 's-proj', cwd: '/tmp/proj' }));
  records.push(rec('turn_context', { model: 'gpt-5.6', effort: 'high' }));
  // Duplicate turn_context — must render nothing new.
  records.push(rec('turn_context', { model: 'gpt-5.6', effort: 'high' }));
  records.push(rec('event_msg', { type: 'user_message', message: 'первый промпт' }));
  records.push(rec('response_item', { type: 'reasoning', summary: [{ text: 'думаю о задаче' }] }));
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-bash', name: 'exec_command',
    arguments: JSON.stringify({ command: 'ls -la' }),
  }));
  records.push(rec('response_item', {
    type: 'function_call_output', call_id: 'call-bash',
    output: 'total 8\nfile.txt',
  }));
  records.push(rec('response_item', {
    type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'вот список файлов' }],
  }));
  // Background exec cell: call announces a cell id, wait completes it later.
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-bg', name: 'exec_command',
    arguments: JSON.stringify({ command: 'npm run build' }),
  }));
  records.push(rec('response_item', {
    type: 'function_call_output', call_id: 'call-bg',
    output: 'Script running with cell ID 42',
  }));
  records.push(rec('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 } } }));
  // Compaction: top-level snapshot + telemetry companion (must render ONCE).
  records.push(rec('compacted', { message: 'Compact snapshot body' }));
  records.push(rec('event_msg', { type: 'compact_completed', message: 'companion telemetry' }));
  records.push(rec('event_msg', { type: 'user_message', message: 'второй промпт' }));
  // Subagent v1: spawn → output binds id → wait completes it.
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-spawn', name: 'spawn_agent',
    namespace: 'multi_agent_v1',
    arguments: JSON.stringify({ message: 'исследуй репозиторий' }),
  }));
  records.push(rec('response_item', {
    type: 'function_call_output', call_id: 'call-spawn',
    output: JSON.stringify({ agent_id: 'agent-1', nickname: 'Faraday' }),
  }));
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-wait', name: 'wait_agent',
    namespace: 'multi_agent_v1', arguments: JSON.stringify({}),
  }));
  records.push(rec('response_item', {
    type: 'function_call_output', call_id: 'call-wait',
    output: JSON.stringify({ status: { 'agent-1': { completed: 'нашёл три файла' } } }),
  }));
  // Background wait completes the cell from earlier.
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-wait-cell', name: 'wait',
    arguments: JSON.stringify({ cell_id: '42' }),
  }));
  records.push(rec('response_item', {
    type: 'function_call_output', call_id: 'call-wait-cell',
    output: 'build finished OK',
  }));
  records.push(rec('response_item', {
    type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'сборка завершена' }],
  }));
  // Rollback of the last turn.
  records.push(rec('event_msg', { type: 'user_message', message: 'отменяемый промпт' }));
  records.push(rec('response_item', {
    type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'ответ который откатят' }],
  }));
  records.push(rec('event_msg', { type: 'thread_rolled_back', num_turns: 1 }));
  records.push(rec('event_msg', { type: 'user_message', message: 'третий промпт' }));
  // Standalone compact event with no top-level twin — must render (the
  // companion counter is 0 here: the last `compacted` was already paired and
  // the window closed at the user turns above).
  records.push(rec('event_msg', { type: 'compact_boundary', message: 'standalone compact' }));
  // Heavy output — crosses the 16KB dehydration threshold, so refreshes
  // interleaved with dehydration exercise the shared-rawTool mutation path.
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-heavy', name: 'exec_command',
    arguments: JSON.stringify({ command: 'cat big.log' }),
  }));
  records.push(rec('response_item', {
    type: 'function_call_output', call_id: 'call-heavy',
    output: 'x'.repeat(20 * 1024),
  }));
  // Reasoning directly before an in-flight call: the finalize tail must show
  // it WITHOUT consuming it, so a later feed still owns it.
  records.push(rec('response_item', {
    type: 'reasoning', summary: [{ text: 'думаю над долгой командой' }],
  }));
  records.push(rec('response_item', {
    type: 'function_call', call_id: 'call-open', name: 'exec_command',
    arguments: JSON.stringify({ command: 'sleep 999' }),
  }));
  return records;
}

const strip = (entries) => JSON.parse(JSON.stringify(entries));

test('projector fed in one pass equals the one-shot builder', () => {
  const records = buildFixtureRecords();
  const oneShot = buildCodexFullHistory(records, 's-proj');
  const projector = createCodexHistoryProjector('s-proj');
  for (const record of records) projector.feed(record);
  assert.deepEqual(strip(projector.finalize()), strip(oneShot));
  // Sanity: the fixture actually exercises the interesting rows.
  const roles = oneShot.map((entry) => entry.role);
  assert.ok(roles.includes('compact'), 'fixture renders a compact row');
  assert.ok(roles.includes('slash'), 'fixture renders model/effort rows');
  assert.equal(oneShot.filter((entry) => entry.role === 'compact').length, 2,
    'paired companion suppressed, standalone compact rendered');
  assert.match(
    oneShot.find((entry) => entry.role === 'compact')?.sourceIdentity || '',
    /^codex-compact-source-s-proj-\d+$/,
    'top-level compact keeps the exact rollout position for live handoff',
  );
  const taskCards = oneShot.flatMap((entry) => entry.actions || [])
    .filter((action) => action.tool === 'Task');
  assert.equal(taskCards.length, 1);
  assert.equal(taskCards[0].subagentStatus, 'completed');
  assert.equal(taskCards[0].result, 'нашёл три файла');
});

test('every split point with a mid-stream finalize converges to the one-shot result', () => {
  const records = buildFixtureRecords();
  const expected = strip(buildCodexFullHistory(records, 's-proj'));
  for (let split = 0; split <= records.length; split += 1) {
    const projector = createCodexHistoryProjector('s-proj');
    for (let index = 0; index < split; index += 1) projector.feed(records[index]);
    // A live read happened at the split point — must not corrupt state.
    projector.finalize();
    for (let index = split; index < records.length; index += 1) projector.feed(records[index]);
    assert.deepEqual(
      strip(projector.finalize()),
      expected,
      'diverged at split=' + split,
    );
  }
});

test('double finalize with no feeds in between is idempotent', () => {
  const records = buildFixtureRecords();
  const projector = createCodexHistoryProjector('s-proj');
  for (const record of records) projector.feed(record);
  const first = strip(projector.finalize());
  const second = strip(projector.finalize());
  assert.deepEqual(second, first);
});

test('an old call with no output stays at its physical call position, not after later answers', () => {
  lineCounter = 0;
  byteCounter = 0;
  const records = [
    rec('event_msg', { type: 'user_message', message: 'first prompt' }),
    rec('response_item', {
      type: 'function_call', call_id: 'orphan-search', name: 'exec_command',
      arguments: JSON.stringify({ command: 'rg old.log' }),
    }),
    rec('response_item', {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'later final answer' }],
    }),
  ];
  const history = buildCodexFullHistory(records, 's-orphan');
  assert.deepEqual(
    history.map((entry) => entry.role === 'assistant' && entry.actions?.length
      ? 'pending-call'
      : entry.content),
    ['first prompt', 'pending-call', 'later final answer'],
  );
  assert.match(history[1].sourceIdentity, /-source-s-orphan-\d+$/);
});

test('a genuinely current in-flight call still renders at the tail', () => {
  lineCounter = 0;
  byteCounter = 0;
  const records = [
    rec('event_msg', { type: 'user_message', message: 'prompt' }),
    rec('response_item', {
      type: 'message', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'checking' }],
    }),
    rec('response_item', {
      type: 'function_call', call_id: 'current-search', name: 'exec_command',
      arguments: JSON.stringify({ command: 'rg current.log' }),
    }),
  ];
  const history = buildCodexFullHistory(records, 's-current');
  assert.equal(history.at(-1).actions?.[0]?.rawTool?.toolName, 'Bash');
  assert.deepEqual(history.slice(0, 2).map((entry) => entry.content), ['prompt', 'checking']);
});

test('response_item-only user turn is visible in both History and Timeline', () => {
  const records = [
    {
      __line: 0,
      __byteOffset: 0,
      timestamp: '2026-08-17T10:24:26.604Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-response-only' },
    },
    {
      __line: 1,
      __byteOffset: 200,
      timestamp: '2026-08-17T10:24:26.671Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,image' },
          { type: 'input_text', text: 'response-only prompt' },
        ],
      },
    },
    {
      __line: 2,
      __byteOffset: 500,
      timestamp: '2026-08-17T10:25:21.890Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-response-only', last_agent_message: 'done' },
    },
  ];
  const history = createCodexHistoryProjector('response-only-session');
  const timeline = createCodexTimelineProjector('response-only-session');
  for (const record of records) {
    history.feed(record);
    timeline.feed(record);
  }

  const historyUsers = history.finalize().filter((entry) => entry.role === 'user');
  const timelineUsers = timeline.finalize().filter((entry) => entry.type === 'user');
  assert.equal(historyUsers.length, 1);
  assert.equal(timelineUsers.length, 1);
  assert.equal(historyUsers[0].content, ' [Image #1] response-only prompt');
  assert.equal(timelineUsers[0].content, ' [Image #1] response-only prompt');
  assert.equal(timelineUsers[0].hasImage, true);
  assert.equal(historyUsers[0].sourceIdentity, 'codex-user-source-response-only-session-200');
  assert.equal(timelineUsers[0].responseComplete, true);
  const wrappers = buildCodexVisibleRecordWrappers(records, 'response-only-session');
  const wrapperUsers = wrappers.filter((wrapper) => wrapper.kind === 'user');
  assert.equal(wrapperUsers.length, 1);
  assert.equal(wrapperUsers[0].sourceUuid, 'codex-user-response-only-session-1');
  assert.equal(wrapperUsers[0].turnIndex, 0);
});

test('paired response_item upgrades to one canonical event_msg user row', () => {
  const response = {
    __line: 10,
    __byteOffset: 1000,
    timestamp: '2026-08-17T10:30:00.100Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'paired prompt' }],
    },
  };
  const event = {
    __line: 11,
    __byteOffset: 1200,
    timestamp: '2026-08-17T10:30:00.200Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'paired prompt' },
  };
  for (const projector of [
    createCodexHistoryProjector('paired-session'),
    createCodexTimelineProjector('paired-session'),
  ]) {
    projector.feed(response);
    assert.equal(projector.finalize().filter((entry) => entry.role === 'user' || entry.type === 'user').length, 1);
    projector.feed(event);
    const users = projector.finalize().filter((entry) => entry.role === 'user' || entry.type === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].uuid, 'codex-user-paired-session-11');
    assert.equal(users[0].sourceIdentity, 'codex-user-source-paired-session-1200');
    assert.deepEqual(users[0].sourceIdentityAliases, [
      'codex-user-source-paired-session-1000',
    ]);
  }
});

test('event_msg remains canonical when its paired response_item arrives later', () => {
  const event = {
    __line: 20,
    __byteOffset: 2000,
    timestamp: '2026-08-17T10:31:00.100Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'event-first prompt' },
  };
  const response = {
    __line: 21,
    __byteOffset: 2200,
    timestamp: '2026-08-17T10:31:00.200Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'event-first prompt' }],
    },
  };
  for (const projector of [
    createCodexHistoryProjector('event-first-session'),
    createCodexTimelineProjector('event-first-session'),
  ]) {
    projector.feed(event);
    projector.feed(response);
    const users = projector.finalize().filter((entry) => entry.role === 'user' || entry.type === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].uuid, 'codex-user-event-first-session-20');
    assert.equal(users[0].sourceIdentity, 'codex-user-source-event-first-session-2000');
    assert.deepEqual(users[0].sourceIdentityAliases, [
      'codex-user-source-event-first-session-2200',
    ]);
  }
});

test('image response carrier aliases the canonical event row without creating a second turn', () => {
  const response = {
    __line: 30,
    __byteOffset: 3000,
    timestamp: '2026-08-17T10:32:00.100Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,image' },
        { type: 'input_text', text: 'image prompt' },
      ],
    },
  };
  const event = {
    __line: 31,
    __byteOffset: 3200,
    timestamp: '2026-08-17T10:32:00.200Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '[Image #1] image prompt',
      images: ['/tmp/image.png'],
    },
  };
  for (const projector of [
    createCodexHistoryProjector('paired-image-session'),
    createCodexTimelineProjector('paired-image-session'),
  ]) {
    projector.feed(response);
    projector.feed(event);
    const users = projector.finalize().filter((entry) => entry.role === 'user' || entry.type === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].uuid, 'codex-user-paired-image-session-31');
    assert.equal(users[0].sourceIdentity, 'codex-user-source-paired-image-session-3200');
    assert.deepEqual(users[0].sourceIdentityAliases, [
      'codex-user-source-paired-image-session-3000',
    ]);
  }
});

test('provider image block is presented as one clean History and Timeline marker', () => {
  const imagePath = '/tmp/noted-terminal-codex-image-input/incident.png';
  const message = `<image name=[Image #1] path="${imagePath}"> [Image] </image>[Image #1] fix colors`;
  const record = {
    __line: 40,
    __byteOffset: 4000,
    timestamp: '2026-08-17T16:06:30.049Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message,
      images: [imagePath],
    },
  };

  const history = createCodexHistoryProjector('provider-image-session');
  const timeline = createCodexTimelineProjector('provider-image-session');
  history.feed(record);
  timeline.feed(record);

  const historyUser = history.finalize().find((entry) => entry.role === 'user');
  const timelineUser = timeline.finalize().find((entry) => entry.type === 'user');
  assert.equal(historyUser?.content, ' [Image #1] fix colors');
  assert.equal(timelineUser?.content, ' [Image #1] fix colors');
  assert.equal(timelineUser?.hasImage, true);
});

test('two byte-identical paired sends keep separate canonical events and FIFO response aliases', () => {
  const records = [
    {
      __line: 40,
      __byteOffset: 4000,
      timestamp: '2026-08-17T10:33:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'identical prompt' }],
      },
    },
    {
      __line: 41,
      __byteOffset: 4200,
      timestamp: '2026-08-17T10:33:00.200Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'identical prompt' }],
      },
    },
    {
      __line: 42,
      __byteOffset: 4400,
      timestamp: '2026-08-17T10:33:00.300Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'identical prompt' },
    },
    {
      __line: 43,
      __byteOffset: 4600,
      timestamp: '2026-08-17T10:33:00.400Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'identical prompt' },
    },
  ];

  for (const projector of [
    createCodexHistoryProjector('identical-paired-session'),
    createCodexTimelineProjector('identical-paired-session'),
  ]) {
    records.forEach((record) => projector.feed(record));
    const users = projector.finalize().filter((entry) => entry.role === 'user' || entry.type === 'user');
    assert.deepEqual(
      users.map((entry) => ({
        uuid: entry.uuid,
        sourceIdentity: entry.sourceIdentity,
        sourceIdentityAliases: entry.sourceIdentityAliases,
      })),
      [
        {
          uuid: 'codex-user-identical-paired-session-42',
          sourceIdentity: 'codex-user-source-identical-paired-session-4400',
          sourceIdentityAliases: ['codex-user-source-identical-paired-session-4000'],
        },
        {
          uuid: 'codex-user-identical-paired-session-43',
          sourceIdentity: 'codex-user-source-identical-paired-session-4600',
          sourceIdentityAliases: ['codex-user-source-identical-paired-session-4200'],
        },
      ],
    );
  }
});

// ── File-cursor incremental projection ──────────────────────────────────────
// The real transport: records live in a rollout file; a refresh must read
// only appended bytes. Fixtures write records WITHOUT identity fields — the
// reader assigns __line/__byteOffset, so equality against a one-shot build
// over parseJsonlFile-loaded records is exact.

test('file-cursor projection: rebuild → append tail → unchanged → rewrite burn', async (t) => {
  const sessionId = 'sess-cursor-a';
  const records = buildFixtureRecords();
  const half = Math.floor(records.length / 2);
  const { dir, filePath } = await makeSessionFile(t, sessionId, records.slice(0, half));
  t.after(() => _api.invalidateJsonlCache(filePath));
  const opts = { sessionsDir: dir };
  // Reference build reads the file directly — parseJsonlFile(forceFresh)
  // would burn the projector cursor via invalidateCodexJsonlCache (that
  // coupling is intentional prod behavior, not a test tool).
  const oneShot = async () => {
    const stat = await fs.promises.stat(filePath);
    const result = await _api.readJsonlRange(filePath, 0, stat.size - 1);
    return strip(buildCodexFullHistory(result.records, sessionId));
  };

  // First open: full read.
  const first = await projectCodexFullHistoryFromFile(sessionId, null, opts);
  assert.equal(first.success, true);
  assert.equal(first.mode, 'rebuild');
  assert.deepEqual(strip(first.entries), await oneShot());
  assert.equal(first.sourceSnapshot.filePath, filePath);

  // Append the rest, including a PARTIAL last line completed by a second
  // append — the cursor must carry the straddling fragment.
  const tailJsonl = recordsToJsonl(records.slice(half));
  const splitAt = Math.floor(tailJsonl.length * 0.7);
  await fs.promises.appendFile(filePath, tailJsonl.slice(0, splitAt));
  const partial = await projectCodexFullHistoryFromFile(sessionId, null, opts);
  assert.equal(partial.mode, 'append');
  await fs.promises.appendFile(filePath, tailJsonl.slice(splitAt));
  const completed = await projectCodexFullHistoryFromFile(sessionId, null, opts);
  assert.equal(completed.mode, 'append');
  assert.deepEqual(strip(completed.entries), await oneShot());

  // No file change → unchanged, zero records fed.
  const unchanged = await projectCodexFullHistoryFromFile(sessionId, null, opts);
  assert.equal(unchanged.mode, 'unchanged');
  assert.equal(unchanged.fedRecords, 0);
  assert.deepEqual(strip(unchanged.entries), strip(completed.entries));

  // Rewrite (shrink): burn and rebuild from the new content.
  await fs.promises.writeFile(filePath, recordsToJsonl(records.slice(0, 4)));
  const rewritten = await projectCodexFullHistoryFromFile(sessionId, null, opts);
  assert.equal(rewritten.mode, 'rebuild');
  assert.deepEqual(strip(rewritten.entries), await oneShot());

  // Explicit invalidation burns the cursor even with an unchanged file.
  await projectCodexFullHistoryFromFile(sessionId, null, opts);
  invalidateCodexHistoryProjectors(filePath);
  const afterBurn = await projectCodexFullHistoryFromFile(sessionId, null, opts);
  assert.equal(afterBurn.mode, 'rebuild');
});

test('projector cache evicts by BYTE budget, keeping the served session', async (t) => {
  invalidateCodexHistoryProjectors();
  const previousBudget = _api.getCodexHistoryProjectorStats().budgetBytes;
  t.after(() => {
    _api.setCodexHistoryProjectorBudgetMb(Math.round(previousBudget / (1024 * 1024)));
    invalidateCodexHistoryProjectors();
  });
  const records = buildFixtureRecords();
  const sessions = ['budget-a', 'budget-b', 'budget-c'];
  const dirs = new Map();
  for (const name of sessions) {
    const { dir } = await makeSessionFile(t, name, records);
    dirs.set(name, { sessionsDir: dir });
  }

  // Roomy budget: every session stays resident, so returns are free.
  _api.setCodexHistoryProjectorBudgetMb(512);
  for (const name of sessions) {
    await projectCodexFullHistoryFromFile(name, null, dirs.get(name));
  }
  for (const name of sessions) {
    const again = await projectCodexFullHistoryFromFile(name, null, dirs.get(name));
    assert.equal(again.mode, 'unchanged', name + ' should still be cached');
  }
  const roomy = _api.getCodexHistoryProjectorStats();
  assert.equal(roomy.sessions, 3);
  assert.ok(roomy.approxBytes > 0, 'cost accounting is live');

  // Squeeze the budget to its floor: the cache sheds the least-recent
  // sessions but never the one it just served.
  _api.setCodexHistoryProjectorBudgetMb(64);
  invalidateCodexHistoryProjectors();
  for (const name of sessions) {
    await projectCodexFullHistoryFromFile(name, null, dirs.get(name));
  }
  const served = await projectCodexFullHistoryFromFile('budget-c', null, dirs.get('budget-c'));
  assert.equal(served.mode, 'unchanged', 'the just-served session is never evicted');
  const squeezed = _api.getCodexHistoryProjectorStats();
  assert.ok(squeezed.sessions >= 1, 'at least one session stays resident');

  // The count cap is the backstop behind the byte budget: even with a huge
  // budget the cache cannot grow without bound.
  _api.setCodexHistoryProjectorBudgetMb(2048);
  invalidateCodexHistoryProjectors();
  const many = [];
  for (let index = 0; index < 15; index += 1) {
    const name = 'cap-' + index;
    const { dir } = await makeSessionFile(t, name, records);
    many.push({ name, opts: { sessionsDir: dir } });
    await projectCodexFullHistoryFromFile(name, null, { sessionsDir: dir });
  }
  const capped = _api.getCodexHistoryProjectorStats();
  assert.ok(capped.sessions <= 12, 'count cap holds, got ' + capped.sessions);
  // The most recent session is still warm despite the churn.
  const newest = many[many.length - 1];
  const newestAgain = await projectCodexFullHistoryFromFile(newest.name, null, newest.opts);
  assert.equal(newestAgain.mode, 'unchanged');
});

test('concurrent refreshes of one session serialize on the projector chain', async (t) => {
  const sessionId = 'sess-serial';
  const records = buildFixtureRecords();
  const { dir, filePath } = await makeSessionFile(t, sessionId, records);
  t.after(() => _api.invalidateJsonlCache(filePath));
  const opts = { sessionsDir: dir };
  const [left, right] = await Promise.all([
    projectCodexFullHistoryFromFile(sessionId, null, opts),
    projectCodexFullHistoryFromFile(sessionId, null, opts),
  ]);
  assert.equal(left.success, true);
  assert.equal(right.success, true);
  // One did the read; the other observed the cursor as unchanged.
  const modes = [left.mode, right.mode].sort();
  assert.deepEqual(modes, ['rebuild', 'unchanged']);
  assert.deepEqual(strip(left.entries), strip(right.entries));
});

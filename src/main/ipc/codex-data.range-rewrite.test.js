const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./codex-data');

function record(type, payload, timestamp) {
  return { type, payload, timestamp };
}

function userRecords(text, timestamp) {
  return [
    record('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }, timestamp),
    record('event_msg', { type: 'user_message', message: text }, timestamp),
  ];
}

function assistantRecord(text, timestamp) {
  return record('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }, timestamp);
}

function rangeFixture() {
  const records = [
    record('session_meta', { id: 'source-session', cwd: '/tmp/project' }, '2026-07-13T10:00:00.000Z'),
    ...userRecords('turn zero', '2026-07-13T10:00:01.000Z'),
    assistantRecord('answer zero', '2026-07-13T10:00:02.000Z'),
    record('compacted', { replacement_history: [] }, '2026-07-13T10:00:03.000Z'),
    record('event_msg', { type: 'context_compacted' }, '2026-07-13T10:00:03.100Z'),
    ...userRecords('turn one', '2026-07-13T10:00:04.000Z'),
    assistantRecord('answer one', '2026-07-13T10:00:05.000Z'),
    ...userRecords('turn two', '2026-07-13T10:00:06.000Z'),
    assistantRecord('answer two', '2026-07-13T10:00:07.000Z'),
    record('compacted', { replacement_history: [] }, '2026-07-13T10:00:08.000Z'),
    record('event_msg', { type: 'context_compacted' }, '2026-07-13T10:00:08.100Z'),
    ...userRecords('turn three', '2026-07-13T10:00:09.000Z'),
    assistantRecord('answer three', '2026-07-13T10:00:10.000Z'),
  ];
  return records.map((entry, index) => ({ ...entry, __line: index }));
}

function timelineFor(records, sessionId = 'rewritten-session') {
  return _api.buildCodexTimeline(
    records.map((entry, index) => ({ ...entry, __line: index })),
    sessionId
  );
}

function userTexts(records) {
  return timelineFor(records)
    .filter((entry) => entry.type === 'user')
    .map((entry) => entry.content);
}

test('composite deletion separates identical physical line numbers and compact companions', () => {
  const segment = (id) => [
    record('session_meta', { id }),
    ...userRecords('same prompt', '2026-09-13T00:00:01Z'),
    assistantRecord('answer', '2026-09-13T00:00:02Z'),
    record('compacted', { replacement_history: [] }, '2026-09-13T00:00:03Z'),
    record('event_msg', { type: 'context_compacted' }, '2026-09-13T00:00:04Z'),
  ].map((r, i) => ({ ...r, fixtureOwner: id, __line: i, __physicalSessionId: id }));
  const a = segment('physical-A'), b = segment('physical-B');
  const records = [...a, ...b];
  const rows = _api.buildCodexTimeline(records, 'view-owner');
  const userA = rows.find(e => e.type === 'user' && e.sessionId === 'physical-A');
  const compactA = rows.find(e => e.type === 'compact' && e.sessionId === 'physical-A');
  const one = _api.planCodexRangeRewrite(records, 'view-owner', userA.uuid, userA.uuid);
  assert.equal(one.success, true, JSON.stringify(one));
  assert.equal(one.removedUsers, 1);
  const contains = (output, original) => output.some(r => r.fixtureOwner === original.fixtureOwner
    && r.type === original.type && JSON.stringify(r.payload) === JSON.stringify(original.payload));
  assert.ok(contains(one.outputRecords, b[2]), 'same line/text in another physical source is retained');
  const compact = _api.planCodexRangeRewrite(records, 'view-owner', compactA.uuid, compactA.uuid);
  assert.equal(compact.success, true, JSON.stringify(compact));
  assert.equal(contains(compact.outputRecords, a[4]), false);
  assert.equal(contains(compact.outputRecords, a[5]), false);
  assert.ok(contains(compact.outputRecords, b[4]));
  assert.ok(contains(compact.outputRecords, b[5]));
});

test('deletes one middle Codex turn without changing the source records', () => {
  const records = rangeFixture();
  const before = JSON.stringify(records);
  const timeline = _api.buildCodexTimeline(records, 'source-session');
  const target = timeline.find((entry) => entry.content === 'turn one');

  const plan = _api.planCodexRangeRewrite(
    records,
    'source-session',
    target.uuid,
    target.uuid
  );

  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.deepEqual(userTexts(plan.outputRecords), ['turn zero', 'turn two', 'turn three']);
  assert.equal(JSON.stringify(records), before);
});

test('response_item-only user turn remains editable as one real turn', () => {
  const records = [
    record('session_meta', { id: 'response-only-session', cwd: '/tmp/project' }, '2026-08-17T10:24:26.000Z'),
    record('event_msg', { type: 'task_started' }, '2026-08-17T10:24:26.100Z'),
    record('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'response-only turn' }],
    }, '2026-08-17T10:24:26.200Z'),
    assistantRecord('answer', '2026-08-17T10:24:27.000Z'),
    record('event_msg', { type: 'task_complete', last_agent_message: 'answer' }, '2026-08-17T10:24:27.100Z'),
  ].map((entry, index) => ({ ...entry, __line: index }));
  const timeline = _api.buildCodexTimeline(records, 'response-only-session');
  const target = timeline.find((entry) => entry.type === 'user');
  assert.equal(target?.content, 'response-only turn');

  const plan = _api.planCodexRangeRewrite(
    records,
    'response-only-session',
    target.uuid,
    target.uuid,
  );
  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.deepEqual(userTexts(plan.outputRecords), []);
});

function goalPreambleFixture() {
  const id = '918b29e9-3369-4d94-8739-3b2cbefe7351';
  const rows = [
    { __line: 0, type: 'session_meta', payload: { id, cwd: '/tmp/project' } },
    { __line: 23654, type: 'event_msg', payload: { type: 'task_started', turn_id: 'same-provider-turn' } },
    { __line: 23655, type: 'response_item', payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<codex_internal_context source="goal">Continue the active goal.</codex_internal_context>' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'same-provider-turn', content_item_kinds: ['goal.internal_context'] },
    } },
    { __line: 23656, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the new user prompt' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'same-provider-turn', content_item_kinds: ['user.text'] },
    } },
    { __line: 23657, type: 'event_msg', payload: { type: 'user_message', message: 'the new user prompt' } },
    { __line: 23658, ...assistantRecord('answer') },
  ];
  return { id, rows };
}

test('incident 23655 Goal preamble retains its exact address before the next canonical user carrier', () => {
  const { id, rows } = goalPreambleFixture();
  const before = JSON.stringify(rows);
  const timeline = _api.buildCodexTimeline(rows, id);
  assert.deepEqual(timeline.map(row => row.content), ['Goal continued', 'the new user prompt']);
  const wrappers = _api.buildCodexVisibleRecordWrappers(rows, id);
  for (const row of timeline) {
    const owner = wrappers.find(wrapper => wrapper.sourceUuid === row.uuid);
    assert.equal(owner?.kind, 'user', row.uuid);
    assert.ok(Number.isFinite(owner?.turnKey), row.uuid);
  }
  const plan = _api.planCodexRangeRewrite(rows, id, timeline[0].uuid, timeline[1].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(plan.removedUsers, 2);
  assert.deepEqual(userTexts(plan.outputRecords), []);
  assert.equal(JSON.stringify(rows), before);
});

test('deleting only the response-only Goal keeps the exact following prompt and its response/event pair', () => {
  const { id, rows } = goalPreambleFixture();
  const [goal, user] = _api.buildCodexTimeline(rows, id);
  const plan = _api.planCodexRangeRewrite(rows, id, goal.uuid, goal.uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(plan.removedUsers, 1);
  assert.deepEqual(userTexts(plan.outputRecords), ['the new user prompt']);
  assert.ok(plan.outputRecords.some(row => row.payload?.message === 'the new user prompt'));
  assert.ok(plan.outputRecords.some(row => row.payload?.content?.[0]?.text === 'the new user prompt'));
  assert.equal(user.uuid, 'codex-user-' + id + '-23657');
});

test('multiple response-only preambles keep distinct physical turns and exact duplicate text addresses', () => {
  const { id, rows } = goalPreambleFixture();
  const goal = rows[2];
  for (const row of rows.slice(3)) row.__line += 1;
  rows.splice(3, 0, { ...goal, __line: 23656 });
  const timeline = _api.buildCodexTimeline(rows, id);
  const plan = _api.planCodexRangeRewrite(rows, id, timeline[0].uuid, timeline.at(-1).uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(plan.removedUsers, 3);
  assert.equal(new Set(plan.selectedTurnKeys).size, 3);
});

test('response-only user is counted before a native rollback removes it, preserving the previous turn', () => {
  const rows = [
    { __line: 0, type: 'session_meta', payload: { id: 'rollback-source' } },
    ...userRecords('previous').map((row, i) => ({ ...row, __line: i + 1 })),
    { ...assistantRecord('previous answer'), __line: 3 },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rolled back' }] }, __line: 4 },
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 }, __line: 5 },
  ];
  const timeline = _api.buildCodexTimeline(rows, 'rollback-source');
  assert.deepEqual(timeline.map(row => row.content), ['previous']);
  const plan = _api.planCodexRangeRewrite(rows, 'rollback-source', timeline[0].uuid, timeline[0].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.deepEqual(userTexts(plan.outputRecords), []);
});

test('event-first response alias remains one exact turn, while the next identical prompt retains its own address', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'same-text-source' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'same text' } },
    userRecords('same text')[0],
    assistantRecord('first answer'),
    { type: 'event_msg', payload: { type: 'task_started' } },
    ...userRecords('same text'),
    assistantRecord('second answer'),
  ].map((row, __line) => ({ ...row, __line }));
  const timeline = _api.buildCodexTimeline(rows, 'same-text-source');
  assert.equal(timeline.length, 2);
  const plan = _api.planCodexRangeRewrite(rows, 'same-text-source', timeline[0].uuid, timeline[0].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.equal(plan.removedUsers, 1);
  assert.deepEqual(userTexts(plan.outputRecords), ['same text']);
  assert.ok(plan.outputRecords.some(row => row.payload?.content?.[0]?.text === 'second answer'));
  assert.equal(plan.outputRecords.some(row => row.payload?.content?.[0]?.text === 'first answer'), false);
});

test('service notification after a response-only input does not erase its mutation identity', () => {
  const { id, rows } = goalPreambleFixture();
  rows.splice(3, 0, { type: 'event_msg', __line: 23655, payload: { type: 'user_message', message: '<subagent_notification>done</subagent_notification>' } });
  for (let i = 0; i < rows.length; i += 1) rows[i].__line = i;
  const timeline = _api.buildCodexTimeline(rows, id);
  assert.equal(timeline.length, 2);
  const plan = _api.planCodexRangeRewrite(rows, id, timeline[0].uuid, timeline[0].uuid);
  assert.equal(plan.success, true, JSON.stringify(plan));
  assert.deepEqual(userTexts(plan.outputRecords), ['the new user prompt']);
});

test('unresolved user identity preserves exact range diagnostics without dumping or mutating the prompt', t => {
  const records = [
    { type: 'session_meta', payload: { id: 'source-session' }, __line: 0 },
    { type: 'event_msg', payload: { type: 'user_message', message: 'private prompt' }, __line: 'invalid-line' },
  ];
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const target = _api.buildCodexTimeline(records, 'source-session')[0];
  const before = JSON.stringify(records);
  const result = _api.planCodexRangeRewrite(records, 'source-session', target.uuid, target.uuid);
  assert.equal(result.success, false);
  assert.equal(result.code, 'codex_history_target_identity_unresolved');
  assert.equal(result.reason, 'canonical-turn-key-missing');
  assert.equal(result.entryUuid, target.uuid);
  const prefix = '[CodexRangeRewrite:IdentityRejected] ';
  assert.equal(warnings.length, 1);
  const details = JSON.parse(warnings[0].slice(prefix.length));
  assert.equal(details.startUuid, target.uuid);
  assert.equal(details.endUuid, target.uuid);
  assert.equal(details.entryUuid, target.uuid);
  assert.equal(warnings[0].includes('private prompt'), false);
  assert.equal(JSON.stringify(records), before);
});

test('deletes an arbitrary Codex range across compact records without extending to the start', () => {
  const records = rangeFixture();
  const timeline = _api.buildCodexTimeline(records, 'source-session');
  const start = timeline.find((entry) => entry.content === 'turn one');
  const secondCompact = timeline.filter((entry) => entry.type === 'compact')[1];

  const plan = _api.planCodexRangeRewrite(
    records,
    'source-session',
    start.uuid,
    secondCompact.uuid
  );

  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 2);
  assert.deepEqual(userTexts(plan.outputRecords), ['turn zero', 'turn three']);
  assert.equal(timelineFor(plan.outputRecords).filter((entry) => entry.type === 'compact').length, 1);
});

test('deletes every Codex entry from the beginning through the selected endpoint', () => {
  const records = rangeFixture();
  const timeline = _api.buildCodexTimeline(records, 'source-session');
  const end = timeline.find((entry) => entry.content === 'turn two');

  const plan = _api.planCodexRangeRewrite(
    records,
    'source-session',
    timeline[0].uuid,
    end.uuid
  );

  assert.equal(plan.success, true);
  assert.deepEqual(userTexts(plan.outputRecords), ['turn three']);
  assert.equal(timelineFor(plan.outputRecords).filter((entry) => entry.type === 'compact').length, 0);
});

test('keeps edit-range replacement behavior while sharing the range rewrite planner', () => {
  const records = rangeFixture();
  const timeline = _api.buildCodexTimeline(records, 'source-session');
  const start = timeline.find((entry) => entry.content === 'turn one');
  const end = timeline.find((entry) => entry.content === 'turn two');

  const plan = _api.planCodexRangeRewrite(
    records,
    'source-session',
    start.uuid,
    end.uuid,
    'replacement summary'
  );

  assert.equal(plan.success, true);
  assert.deepEqual(userTexts(plan.outputRecords), [
    'turn zero',
    'replacement summary',
    'turn three',
  ]);
});

test('plans a Codex fork from only the latest compact snapshot and its visible tail', () => {
  const records = rangeFixture();
  const before = JSON.stringify(records);
  const plan = _api.planCodexForkFromLatestCompact(records, 'source-session');

  assert.equal(plan.success, true);
  assert.equal(plan.outputRecords[0].type, 'session_meta');
  assert.equal(plan.outputRecords[1].type, 'compacted');
  assert.equal(plan.outputRecords[1].timestamp, '2026-07-13T10:00:08.000Z');
  assert.deepEqual(userTexts(plan.outputRecords), ['turn three']);
  assert.equal(plan.outputRecords.some((entry) => entry.payload?.message === 'turn zero'), false);
  assert.equal(plan.outputRecords.some((entry) => entry.payload?.message === 'turn one'), false);
  assert.equal(plan.outputRecords.some((entry) => entry.payload?.message === 'turn two'), false);
  assert.equal(JSON.stringify(records), before);
});

test('rewrites both Codex rollout identity aliases for an edited compact fork', () => {
  const records = rangeFixture();
  records[0].payload.session_id = 'source-session';
  const before = JSON.stringify(records);
  const plan = _api.planCodexForkFromLatestCompact(records, 'source-session');
  const childSessionId = 'child-session';
  const childTimestamp = '2026-07-27T08:15:00.000Z';

  _api.rewriteCodexEditedForkMetadata(
    records,
    'source-session',
    '/tmp/child-project',
    plan.outputRecords,
    childSessionId,
    childTimestamp,
  );

  assert.deepEqual(plan.outputRecords[0], {
    type: 'session_meta',
    payload: {
      id: childSessionId,
      session_id: childSessionId,
      cwd: '/tmp/child-project',
      timestamp: childTimestamp,
      forked_from_id: 'source-session',
      history_mode: 'legacy',
      source: 'cli',
      thread_source: 'user',
    },
    timestamp: childTimestamp,
  });
  assert.equal(JSON.stringify(records), before, 'source metadata must remain unchanged');
});

test('Codex compact fork planner fails explicitly when no compact snapshot exists', () => {
  const records = rangeFixture().filter((entry) => entry.type !== 'compacted');
  const plan = _api.planCodexForkFromLatestCompact(records, 'source-session');
  assert.deepEqual(plan, {
    success: false,
    reason: 'no-compact',
    error: 'В этой Codex-сессии ещё нет сжатия контекста',
  });
});

test('writes large rewritten rollouts in valid JSONL chunks and keeps exclusive ownership', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-range-rewrite-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  const records = [
    record('session_meta', { id: 'rewritten-session' }, '2026-07-13T10:00:00.000Z'),
    assistantRecord('x'.repeat((4 * 1024 * 1024) + 17), '2026-07-13T10:00:01.000Z'),
    ...userRecords('tail turn', '2026-07-13T10:00:02.000Z'),
  ];

  await _api.writeCodexJsonlExclusive(filePath, records);

  const written = (await fs.promises.readFile(filePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(written, records);
  await assert.rejects(
    _api.writeCodexJsonlExclusive(filePath, records),
    (error) => error?.code === 'EEXIST'
  );
  assert.deepEqual(
    (await fs.promises.readFile(filePath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line)),
    records
  );
});

test('removes a partial rollout when incremental serialization fails', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-range-rewrite-failure-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');

  await assert.rejects(
    _api.writeCodexJsonlExclusive(filePath, [
      record('session_meta', { id: 'rewritten-session' }, '2026-07-13T10:00:00.000Z'),
      { type: 'event_msg', payload: { unsupported: 1n } },
    ])
  );
  await assert.rejects(fs.promises.access(filePath), (error) => error?.code === 'ENOENT');
});

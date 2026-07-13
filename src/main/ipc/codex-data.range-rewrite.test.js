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

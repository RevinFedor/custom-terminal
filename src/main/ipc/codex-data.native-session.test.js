'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const codexData = require('./codex-data');

test('metadata-only Codex rollout is one resumable session record with no user turn', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-meta-only-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await fs.promises.mkdir(cwd);
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const result = await codexData._api.materializeEmptySession({
    cwd,
    sessionId,
    now: new Date('2026-08-19T02:00:00.000Z'),
    sessionsDir: path.join(root, 'sessions'),
  });

  assert.equal(result.success, true);
  assert.equal(result.sessionId, sessionId);
  const records = (await fs.promises.readFile(result.filePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'session_meta');
  assert.equal(records[0].payload.id, sessionId);
  assert.equal(records[0].payload.session_id, sessionId);
  assert.equal(records[0].payload.cwd, cwd);
  assert.equal(codexData._api.isCodexUserTuiSession(records[0].payload), true);
  assert.deepEqual(
    codexData._api.inspectConversationMaterialization(records, sessionId),
    {
      materialized: false,
      metadataOnly: true,
      userRecords: 0,
      userTurns: 0,
      reason: 'session-meta-only',
    },
  );
});

test('paired Codex user carriers materialize one logical conversation turn', () => {
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const records = [
    codexData._api.buildCodexEmptySessionMetaRecord({
      sessionId,
      cwd: '/tmp/project',
      timestamp: '2026-08-19T02:01:00.000Z',
    }),
    {
      type: 'response_item',
      timestamp: '2026-08-19T02:01:00.001Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'context' }],
      },
      __line: 1,
    },
    {
      type: 'event_msg',
      timestamp: '2026-08-19T02:01:00.002Z',
      payload: { type: 'user_message', message: 'context', kind: 'plain' },
      __line: 2,
    },
  ];
  const result = codexData._api.inspectConversationMaterialization(records, sessionId);
  assert.equal(result.materialized, true);
  assert.equal(result.metadataOnly, false);
  assert.equal(result.userTurns, 1);
});

test('bounded materialization probe does not parse a giant rollout for status reads', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-materialization-head-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  const cwd = path.join(root, 'project');
  await fs.promises.mkdir(cwd);

  const materialized = await codexData._api.materializeEmptySession({
    cwd,
    sessionId: '77777777-7777-4777-8777-777777777777',
    now: new Date('2026-08-19T02:02:00.000Z'),
    sessionsDir,
  });
  await fs.promises.appendFile(materialized.filePath, JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-19T02:02:00.010Z',
    payload: { type: 'user_message', message: 'hello', kind: 'plain' },
  }) + '\n' + ' '.repeat(1024 * 1024));

  const result = await codexData._api.inspectConversationMaterializationFromFile(
    materialized.sessionId,
    cwd,
    { sessionsDir, maxBytes: 4096 },
  );
  assert.equal(result.materialized, true);
  assert.equal(result.metadataOnly, false);
  assert.equal(result.bounded, true);
  assert.equal(result.inspectedBytes, 4096);

  const metadataOnly = await codexData._api.materializeEmptySession({
    cwd,
    sessionId: '88888888-8888-4888-8888-888888888888',
    now: new Date('2026-08-19T02:03:00.000Z'),
    sessionsDir,
  });
  const emptyResult = await codexData._api.inspectConversationMaterializationFromFile(
    metadataOnly.sessionId,
    cwd,
    { sessionsDir, maxBytes: 4096 },
  );
  assert.equal(emptyResult.materialized, false);
  assert.equal(emptyResult.metadataOnly, true);
  assert.equal(emptyResult.bounded, false);
});

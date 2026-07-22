const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./codex-data');
const { classifyCodexTurnRecord } = require('../codex-turn-outcome');

function sessionMeta(payload) {
  return JSON.stringify({
    timestamp: payload.timestamp || '2026-07-11T10:00:00.000Z',
    type: 'session_meta',
    payload,
  });
}

async function makeSessionsDir(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-discovery-'));
  const sessionsDir = path.join(root, 'sessions');
  await fs.promises.mkdir(sessionsDir, { recursive: true });
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return sessionsDir;
}

test('reads contiguous session metadata without parsing a large later payload', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const filePath = path.join(sessionsDir, 'rollout-head-only.jsonl');
  const currentId = 'current-session';
  const sourceId = 'source-session';
  const metadataText = [
    sessionMeta({ id: currentId, cwd: '/tmp/project', forked_from_id: 'middle-session' }),
    sessionMeta({ id: 'middle-session', cwd: '/tmp/project', forked_from_id: sourceId }),
  ].join('\n') + '\n';
  const largeIncompletePayload = '{"timestamp":"2026-07-11T10:00:01.000Z","type":"response_item","payload":"'
    + 'x'.repeat(2 * 1024 * 1024);
  await fs.promises.writeFile(filePath, metadataText + largeIncompletePayload, 'utf8');

  const metadata = await _api.readCodexSessionMetadata(filePath, { chunkBytes: 128 });

  assert.equal(metadata.meta.id, currentId);
  assert.deepEqual(metadata.records.map((record) => record.payload.id), [currentId, 'middle-session']);
  assert.equal(metadata.stoppedAtNonMetadata, true);
  assert.ok(metadata.bytesRead < metadataText.length + 512, `read ${metadata.bytesRead} bytes`);
  assert.ok(metadata.bytesRead < (await fs.promises.stat(filePath)).size / 1000);
});

test('findCodexSessionFile content scan matches the exact metadata id', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const targetPath = path.join(sessionsDir, 'rollout-without-id-in-name.jsonl');
  await fs.promises.writeFile(
    path.join(sessionsDir, 'unrelated.jsonl'),
    sessionMeta({ id: 'similar-session-extra', cwd: '/tmp/project' }) + '\n',
    'utf8'
  );
  await fs.promises.writeFile(
    targetPath,
    sessionMeta({ id: 'similar-session', cwd: '/tmp/project' }) + '\n',
    'utf8'
  );

  const found = await _api.findCodexSessionFile('similar-session', '/tmp/project', { sessionsDir });

  assert.equal(found?.filePath, targetPath);
});

test('findLatestCodexSession preserves source-chain matching from metadata records', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const cwd = path.join(sessionsDir, 'project');
  const matchingPath = path.join(sessionsDir, 'matching.jsonl');
  const unrelatedPath = path.join(sessionsDir, 'newer-unrelated.jsonl');
  const sourceId = 'source-session';
  await fs.promises.writeFile(matchingPath, [
    sessionMeta({
      id: 'matching-current',
      cwd,
      timestamp: '2026-07-11T10:00:00.000Z',
      thread_source: 'user',
      forked_from_id: 'middle-session',
    }),
    sessionMeta({
      id: 'middle-session',
      cwd,
      timestamp: '2026-07-11T09:00:00.000Z',
      forked_from_id: sourceId,
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n') + '\n', 'utf8');
  await fs.promises.writeFile(unrelatedPath, [
    sessionMeta({
      id: 'newer-unrelated',
      cwd,
      timestamp: '2026-07-11T11:00:00.000Z',
      thread_source: 'user',
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n') + '\n', 'utf8');
  const now = Date.now();
  await fs.promises.utimes(matchingPath, new Date(now - 2000), new Date(now - 2000));
  await fs.promises.utimes(unrelatedPath, new Date(now - 1000), new Date(now - 1000));

  const found = await _api.findLatestCodexSession({ cwd, sourceSessionId: sourceId, sessionsDir });

  assert.equal(found?.sessionId, 'matching-current');
  assert.equal(found?.filePath, matchingPath);
  assert.equal(found?.sourceMatched, true);
});

test('linked live boundary ignores copied history timestamps and keeps a late large live turn', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const filePath = path.join(sessionsDir, 'resume-child.jsonl');
  const launchedAt = Date.parse('2026-07-22T16:04:48.959Z');
  const linesBeforeLive = [
    sessionMeta({
      id: 'resume-child',
      cwd: '/tmp/project',
      timestamp: '2026-07-22T16:04:48.959Z',
      forked_from_id: 'resume-source',
      originator: 'codex-tui',
    }),
    JSON.stringify({
      timestamp: '2026-07-22T16:04:50.200Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'copied-turn', started_at: 1784730000 },
    }),
    JSON.stringify({
      timestamp: '2026-07-22T16:04:50.210Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'copied-turn', started_at: 1784730000 },
    }),
  ];
  const liveLine = JSON.stringify({
    timestamp: '2026-07-22T16:20:54.495Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'live-turn', started_at: 1784737254 },
  });
  const prefix = linesBeforeLive.join('\n') + '\n';
  await fs.promises.writeFile(
    filePath,
    prefix + liveLine + '\n' + JSON.stringify({ type: 'response_item', payload: 'x'.repeat(9 * 1024 * 1024) }) + '\n',
    'utf8',
  );

  const boundary = await _api.findCodexLinkedLiveBoundary(filePath, { startedAtMs: launchedAt });

  assert.equal(boundary.found, true);
  assert.equal(boundary.turnId, 'live-turn');
  assert.equal(boundary.offset, Buffer.byteLength(prefix));

  const stat = await fs.promises.stat(filePath);
  const liveRange = await _api.readJsonlRange(filePath, boundary.offset, stat.size - 1);
  const tracker = {};
  let latest = null;
  for (const record of liveRange.records) {
    latest = classifyCodexTurnRecord(tracker, record) || latest;
  }
  assert.equal(latest?.turnId, 'live-turn');
  assert.equal(latest?.busy, true);

  await fs.promises.appendFile(filePath, JSON.stringify({
    timestamp: '2026-07-22T16:38:00.465Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'live-turn',
      started_at: 1784737254,
      last_agent_message: 'Done.',
    },
  }) + '\n');
  const completedStat = await fs.promises.stat(filePath);
  const completedRange = await _api.readJsonlRange(filePath, boundary.offset, completedStat.size - 1);
  const completedTracker = {};
  latest = null;
  for (const record of completedRange.records) {
    latest = classifyCodexTurnRecord(completedTracker, record) || latest;
  }
  assert.equal(latest?.turnId, 'live-turn');
  assert.equal(latest?.busy, false);
  assert.equal(latest?.reason, 'task_complete');
});

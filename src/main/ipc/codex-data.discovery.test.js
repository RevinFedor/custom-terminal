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

test('findLatestCodexSession rejects a source found only in copied metadata ancestry', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const cwd = path.join(sessionsDir, 'project');
  const matchingPath = path.join(sessionsDir, 'matching.jsonl');
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
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', started_at: Date.now() / 1000 } }),
  ].join('\n') + '\n', 'utf8');
  const now = Date.now();
  await fs.promises.utimes(matchingPath, new Date(now - 1000), new Date(now - 1000));

  const found = await _api.findLatestCodexSession({ cwd, sourceSessionId: sourceId, sessionsDir });

  assert.equal(found, null);
});

test('findLatestCodexSession accepts only the root metadata direct fork edge', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const cwd = path.join(sessionsDir, 'project');
  const matchingPath = path.join(sessionsDir, 'matching.jsonl');
  const sourceId = 'source-session';
  await fs.promises.writeFile(matchingPath, [
    sessionMeta({
      id: 'matching-current',
      cwd,
      timestamp: new Date().toISOString(),
      thread_source: 'user',
      forked_from_id: sourceId,
    }),
    sessionMeta({
      id: sourceId,
      cwd,
      timestamp: '2026-07-11T09:00:00.000Z',
      forked_from_id: 'older-ancestor',
    }),
  ].join('\n') + '\n', 'utf8');
  const now = Date.now();
  await fs.promises.utimes(matchingPath, new Date(now - 1000), new Date(now - 1000));

  const found = await _api.findLatestCodexSession({ cwd, sourceSessionId: sourceId, sessionsDir });

  assert.equal(found?.sessionId, 'matching-current');
  assert.equal(found?.filePath, matchingPath);
  assert.equal(found?.sourceMatched, true);
  assert.equal(found?.sourceMatchMode, 'direct-fork');
  assert.equal(found?.reopenedExisting, false);
});

test('findLatestCodexSession accepts a fresh direct child before its first turn', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const cwd = path.join(sessionsDir, 'project');
  const filePath = path.join(sessionsDir, 'fresh-child.jsonl');
  const launchAt = Date.now();
  await fs.promises.writeFile(filePath, sessionMeta({
    id: 'fresh-child',
    cwd,
    timestamp: new Date(launchAt + 100).toISOString(),
    thread_source: 'user',
    forked_from_id: 'source-session',
  }) + '\n', 'utf8');

  const found = await _api.findLatestCodexSession({
    cwd,
    sinceMs: launchAt,
    sourceSessionId: 'source-session',
    sessionsDir,
  });

  assert.equal(found?.sessionId, 'fresh-child');
  assert.equal(found?.metadataFreshForLaunch, true);
  assert.equal(found?.reopenedExisting, false);
});

test('findLatestCodexSession reopens an old direct child only after a post-launch task starts', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const cwd = path.join(sessionsDir, 'project');
  const filePath = path.join(sessionsDir, 'old-child.jsonl');
  const launchAt = Date.parse('2026-07-22T12:00:00.000Z');
  const prefix = [
    sessionMeta({
      id: 'old-child',
      cwd,
      timestamp: '2026-07-22T10:00:00.000Z',
      thread_source: 'user',
      forked_from_id: 'source-session',
    }),
    JSON.stringify({
      timestamp: '2026-07-22T10:05:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'old-turn', started_at: launchAt / 1000 - 6900 },
    }),
    JSON.stringify({
      timestamp: '2026-07-22T12:01:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [] },
    }),
  ].join('\n') + '\n';
  await fs.promises.writeFile(filePath, prefix, 'utf8');
  await fs.promises.utimes(filePath, new Date(launchAt + 60_000), new Date(launchAt + 60_000));

  const beforeLive = await _api.findLatestCodexSession({
    cwd,
    sinceMs: launchAt,
    sourceSessionId: 'source-session',
    sessionsDir,
  });
  assert.equal(beforeLive, null);

  const liveLine = JSON.stringify({
    timestamp: '2026-07-22T12:02:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'current-turn', started_at: launchAt / 1000 + 120 },
  });
  await fs.promises.appendFile(filePath, liveLine + '\n');
  await fs.promises.utimes(filePath, new Date(launchAt + 120_000), new Date(launchAt + 120_000));

  const afterLive = await _api.findLatestCodexSession({
    cwd,
    sinceMs: launchAt,
    sourceSessionId: 'source-session',
    sessionsDir,
  });
  assert.equal(afterLive?.sessionId, 'old-child');
  assert.equal(afterLive?.reopenedExisting, true);
  assert.equal(afterLive?.linkedLiveBoundary?.found, true);
  assert.equal(afterLive?.linkedLiveBoundary?.turnId, 'current-turn');
  assert.equal(afterLive?.linkedLiveBoundary?.offset, Buffer.byteLength(prefix));
});

test('findLatestCodexSession leaves append-in-place source ownership to the source watcher', async (t) => {
  const sessionsDir = await makeSessionsDir(t);
  const cwd = path.join(sessionsDir, 'project');
  const filePath = path.join(sessionsDir, 'source.jsonl');
  const launchAt = Date.now();
  await fs.promises.writeFile(filePath, [
    sessionMeta({
      id: 'source-session',
      cwd,
      timestamp: '2026-07-11T10:00:00.000Z',
      thread_source: 'user',
    }),
    JSON.stringify({
      timestamp: new Date(launchAt + 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', started_at: launchAt / 1000 + 0.1 },
    }),
  ].join('\n') + '\n', 'utf8');

  const found = await _api.findLatestCodexSession({
    cwd,
    sinceMs: launchAt,
    sourceSessionId: 'source-session',
    sessionsDir,
  });
  assert.equal(found, null);
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SessionTranscriptService } = require('./session-transcript-service');

test('Codex Timeline reconciliation persists one child-addressable fork snapshot', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-session-event-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'child.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');
  const stat = await fs.promises.stat(filePath);
  const saved = [];
  const entries = [
    { uuid: 'child-inherited-compact', type: 'compact', sourceLine: 4 },
    { uuid: 'child-inherited-user', type: 'user', sourceLine: 8 },
    { uuid: 'child-live-user', type: 'user', sourceLine: 20 },
  ];
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData: {
      _api: {
        projectCodexTimelineFromFile: async () => ({
          success: true,
          entries,
          sessionMeta: {
            id: 'child',
            forked_from_id: 'source',
            timestamp: '2026-08-18T10:00:00.000Z',
            forkLiveStartLine: 10,
          },
          filePath,
          sourceSnapshot: {
            filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sessionId: 'child',
          },
        }),
      },
    },
    sessionHistoryStore: {
      saveSessionForkEvent: (event) => saved.push(event),
    },
  });

  const result = await service.getTimeline({
    toolType: 'codex',
    sessionId: 'child',
    cwd: dir,
  });

  assert.equal(result.success, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sourceSessionId, 'source');
  assert.equal(saved[0].childSessionId, 'child');
  assert.deepEqual(saved[0].entryUuids, [
    'child-inherited-compact',
    'child-inherited-user',
  ]);
  assert.equal(saved[0].snapshotComplete, true);
});

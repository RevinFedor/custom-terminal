const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { SessionTranscriptService } = require('./session-transcript-service');

// The delta contract end-to-end at the service boundary: first load is full
// and seeds the digest; a refresh with the previous revision returns only
// changed rows + order; consumers without deltaOk (web/iOS) and bounded
// requests always get the full shape; a digest that does not match the
// caller's revision falls back to full.
test('Codex history refresh returns a changed-rows delta to a digest-holding caller', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-delta-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-delta.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  const row = (uuid, content) => ({
    uuid,
    role: uuid.includes('user') ? 'user' : 'assistant',
    timestamp: '2026-08-06T10:00:00.000Z',
    content,
    sessionId: 'session-delta',
  });
  let projection = [row('codex-user-1', 'first prompt'), row('codex-assistant-2', 'first answer')];
  let loadCalls = 0;
  const codexData = {
    _api: {
      findCodexSessionFile: async () => ({ filePath }),
      loadSessionRecords: async () => {
        loadCalls += 1;
        const stat = await fs.promises.stat(filePath);
        return {
          success: true,
          records: [{ type: 'record' }],
          filePath,
          sourceSnapshot: {
            filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sessionId: 'session-delta',
            linkKind: 'end',
          },
        };
      },
      buildCodexFullHistory: () => projection.map((entry) => ({ ...entry })),
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    claudeData: null,
    codexData,
  });

  const base = { toolType: 'codex', sessionId: 'session-delta', cwd: dir, tabId: 'tab-d' };
  const first = await service.getHistory({ ...base, deltaOk: true });
  assert.equal(first.delta, undefined, 'no previous digest → full response');
  assert.equal(first.entries.length, 2);
  assert.ok(first.revision?.token);

  // The session appends one turn and enriches nothing else.
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  projection = [...projection, row('codex-user-3', 'second prompt')];
  const second = await service.getHistory({ ...base, deltaOk: true, ifRevision: first.revision });
  assert.equal(second.delta, true);
  assert.deepEqual(second.changedEntries.map((entry) => entry.uuid), ['codex-user-3']);
  assert.deepEqual(second.order, ['codex-user-1', 'codex-assistant-2', 'codex-user-3']);
  assert.equal(second.total, 3);
  assert.ok(second.revision.token !== first.revision.token);

  // An old-row enrichment (tool result landing) ships that row again.
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  projection = projection.map((entry) => entry.uuid === 'codex-assistant-2'
    ? { ...entry, content: 'first answer + attached output' }
    : entry);
  const third = await service.getHistory({ ...base, deltaOk: true, ifRevision: second.revision });
  assert.equal(third.delta, true);
  assert.deepEqual(third.changedEntries.map((entry) => entry.uuid), ['codex-assistant-2']);

  // A stale revision (caller missed a generation) gets the full shape.
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  const fourth = await service.getHistory({ ...base, deltaOk: true, ifRevision: first.revision });
  assert.equal(fourth.delta, undefined);
  assert.equal(fourth.entries.length, 3);

  // Consumers that never opted in (web/iOS) and bounded requests are full.
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  const plain = await service.getHistory({ ...base, ifRevision: fourth.revision });
  assert.equal(plain.delta, undefined);
  assert.equal(plain.entries.length, 3);
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  const bounded = await service.getHistory({
    ...base,
    deltaOk: true,
    ifRevision: plain.revision,
    bounds: { last: 2 },
  });
  assert.equal(bounded.delta, undefined);
  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.truncated, true);

  // Unchanged file still answers unchanged without loading anything.
  const callsBefore = loadCalls;
  const unchanged = await service.getHistory({ ...base, deltaOk: true, ifRevision: bounded.revision });
  assert.equal(unchanged.unchanged, true);
  assert.equal(loadCalls, callsBefore);
});

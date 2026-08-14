const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { SessionTranscriptService } = require('./session-transcript-service');

// getHistory routing around the file-cursor projector:
// - dehydrate consumers (desktop panel) go through projectCodexFullHistoryFromFile
//   and never call loadSessionRecords;
// - full-payload consumers (web/iOS) keep load + one-shot build;
// - the revision is built from the projector's cursor snapshot, so a
//   follow-up ifRevision call answers unchanged without any load;
// - the delta transport composes with the projector path.
test('dehydrate getHistory uses the file projector; plain consumers keep one-shot', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-projector-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-p.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  const row = (uuid, content) => ({
    uuid, role: 'user', timestamp: '2026-08-07T10:00:00.000Z', content, sessionId: 'session-p',
  });
  let projectorCalls = 0;
  let loadCalls = 0;
  let projection = [row('u1', 'первый')];
  const snapshotFor = async () => {
    const stat = await fs.promises.stat(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId: 'session-p', linkKind: 'end' };
  };
  const codexData = {
    _api: {
      findCodexSessionFile: async () => ({ filePath }),
      projectCodexFullHistoryFromFile: async () => {
        projectorCalls += 1;
        return {
          success: true,
          entries: projection.map((entry) => ({ ...entry })),
          filePath,
          mode: projectorCalls === 1 ? 'rebuild' : 'append',
          fedRecords: 1,
          sourceSnapshot: await snapshotFor(),
        };
      },
      loadSessionRecords: async () => {
        loadCalls += 1;
        return {
          success: true,
          records: [{ type: 'record' }],
          filePath,
          sourceSnapshot: await snapshotFor(),
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
  const base = { toolType: 'codex', sessionId: 'session-p', cwd: dir, tabId: 'tab-p' };

  // Desktop path: projector, no record load.
  const first = await service.getHistory({ ...base, dehydrate: true, deltaOk: true });
  assert.equal(first.success, true);
  assert.equal(projectorCalls, 1);
  assert.equal(loadCalls, 0);
  assert.equal(first.entries.length, 1);
  assert.ok(first.revision?.token);

  // Unchanged file + same revision → answered from stats, projector not asked.
  const unchanged = await service.getHistory({
    ...base, dehydrate: true, deltaOk: true, ifRevision: first.revision,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(projectorCalls, 1);

  // File grows → projector again, and the delta path engages on top of it.
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  projection = [...projection, row('u2', 'второй')];
  const second = await service.getHistory({
    ...base, dehydrate: true, deltaOk: true, ifRevision: first.revision,
  });
  assert.equal(projectorCalls, 2);
  assert.equal(loadCalls, 0);
  assert.equal(second.delta, true);
  assert.deepEqual(second.changedEntries.map((entry) => entry.uuid), ['u2']);
  assert.deepEqual(second.order, ['u1', 'u2']);

  // Web/iOS path (no dehydrate): load + one-shot, projector untouched.
  const plain = await service.getHistory(base);
  assert.equal(plain.success, true);
  assert.equal(loadCalls, 1);
  assert.equal(projectorCalls, 2);
  assert.equal(plain.entries.length, 2);

  // Projector failure surfaces as the error result, not a crash.
  codexData._api.projectCodexFullHistoryFromFile = async () => (
    { success: false, error: 'Codex session file not found' }
  );
  await fs.promises.appendFile(filePath, '{"type":"event_msg"}\n');
  const failed = await service.getHistory({ ...base, dehydrate: true });
  assert.equal(failed.success, false);
  assert.match(String(failed.error), /not found/);
});

// Row-level hydration windowing composed with the delta transport: moving the
// hydrated span must ship exactly the rows whose hydration state changed —
// the fingerprint of a stub differs from the fingerprint of its full row, so
// this falls out of the existing digest instead of needing its own protocol.
test('hydration span travels through the delta as changed rows', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-rowwindow-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-rw.jsonl');
  await fs.promises.writeFile(filePath, '{"type":"session_meta"}\n');

  const row = (index) => ({
    uuid: `r${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: '2026-08-07T10:00:00.000Z',
    sessionId: 'session-rw',
    content: 'body-' + index + '-' + 'x'.repeat(200),
    actions: [{ tool: '__raw__', rawTool: { toolUseId: 'c' + index, toolName: 'Bash', args: {}, result: 'ok' } }],
  });
  const projection = Array.from({ length: 60 }, (_u, index) => row(index));
  const snapshotFor = async () => {
    const stat = await fs.promises.stat(filePath);
    return { filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId: 'session-rw', linkKind: 'end' };
  };
  let projectorCalls = 0;
  const codexData = {
    _api: {
      findCodexSessionFile: async () => ({ filePath }),
      projectCodexFullHistoryFromFile: async () => {
        projectorCalls += 1;
        return {
          success: true,
          entries: projection.map((entry) => ({ ...entry })),
          filePath,
          mode: 'unchanged',
          fedRecords: 0,
          sourceSnapshot: await snapshotFor(),
        };
      },
      buildCodexFullHistory: () => projection.map((entry) => ({ ...entry })),
    },
  };
  const service = new SessionTranscriptService({
    getMainWindow: () => null, webBroadcast: null, claudeData: null, codexData,
  });
  const base = {
    toolType: 'codex', sessionId: 'session-rw', cwd: dir, tabId: 'tab-rw',
    dehydrate: true, deltaOk: true,
  };

  // Tail-anchored hydration: only the last rows carry content.
  const first = await service.getHistory({
    ...base, hydrate: { radius: 10, alwaysHydrateTail: 5 },
  });
  assert.equal(first.entries.length, 60, 'row list keeps full length');
  assert.equal(first.rowWindowApplied, true);
  assert.equal(first.hydratedCount, 10);
  assert.equal(first.entries[0].rowStub, true);
  assert.equal(first.entries[0].content, undefined);
  assert.equal(first.entries[59].rowStub, undefined);
  assert.equal(projectorCalls, 1);

  const sameWindow = await service.getHistory({
    ...base,
    ifRevision: first.revision,
    hydrate: { radius: 10, alwaysHydrateTail: 5 },
  });
  assert.equal(sameWindow.unchanged, true, 'the same file and same hydration window keep O(stat)');
  assert.equal(projectorCalls, 1, 'the unchanged fast path does not rebuild the projection');

  // The user scrolls up while the JSONL stays byte-identical: changing the
  // requested hydration span is itself a projection change. It must not be
  // swallowed by the file-level `unchanged` fast path. Only rows whose
  // hydration state changed travel; the rest keep their identity.
  const scrolled = await service.getHistory({
    ...base,
    ifRevision: first.revision,
    hydrate: { centerUuid: 'r20', radius: 5, alwaysHydrateTail: 5 },
  });
  assert.equal(scrolled.unchanged, false, 'a new hydration window is not an unchanged response');
  assert.equal(scrolled.delta, true, 'a hydration move is a delta, not a full reload');
  assert.equal(projectorCalls, 2, 'a changed hydration window rebuilds the requested projection');
  const changedUuids = scrolled.changedEntries.map((entry) => entry.uuid).sort();
  // r15..r25 became hydrated; r50..r54 (old span, outside the new one and
  // outside the tail) became stubs.
  assert.deepEqual(
    changedUuids,
    ['r15', 'r16', 'r17', 'r18', 'r19', 'r20', 'r21', 'r22', 'r23', 'r24', 'r25',
      'r50', 'r51', 'r52', 'r53', 'r54'].sort(),
  );
  assert.equal(scrolled.order.length, 60, 'order still names every row');
  const hydratedNow = scrolled.changedEntries.filter((entry) => !entry.rowStub);
  assert.equal(hydratedNow.length, 11);
  assert.equal(hydratedNow.every((entry) => typeof entry.content === 'string'), true);
});

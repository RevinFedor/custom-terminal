const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionTranscriptService } = require('./session-transcript-service');
const { buildHistoryRevision } = require('./history-revision');

test('rewrite receipt requires both exact source revision and actual child cursor, never lineage alone', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'child.jsonl');
  await fs.writeFile(filePath, '{}\n');
  const stat = await fs.stat(filePath);
  const sourceSnapshot = { filePath: path.join(root, 'parent.jsonl'), size: 24, mtimeMs: 1000, sessionId: 'parent' };
  const targetSnapshot = { filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId: 'child' };
  const receipt = { schema: 'codex-rewrite-prefix-v1', sourceSessionId: 'parent', sessionId: 'child', sourceSnapshot, targetSnapshot,
    records: [{ source: { __line: 3, __byteOffset: 14 }, target: { __line: 3, __byteOffset: 16 } }] };
  const revision = buildHistoryRevision({ toolType: 'codex', sessionId: 'parent', cwd: root }, [sourceSnapshot]);
  let projectedSnapshot = targetSnapshot;
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: {
    getCodexRewriteReceipt: (_child, parent) => parent === 'parent' ? receipt : null,
    projectCodexFullHistoryFromFile: async () => ({ success: true, filePath, sourceSnapshot: projectedSnapshot,
      entries: [{ uuid: 'codex-user-child-3', role: 'user', content: 'hi', sessionId: 'child' }] }),
  } } });
  const request = { toolType: 'codex', sessionId: 'child', cwd: root, tabId: 'tab', dehydrate: true,
    rewriteFrom: { sessionId: 'parent', revision }, hydrate: { centerUuid: 'codex-user-parent-3', radius: 2 } };
  const result = await service.getHistory(request);
  assert.equal(result.rewriteReceipt, receipt);
  assert.equal(result.hydrationRequest.centerUuid, 'codex-user-child-3');
  assert.equal(result.revision.sessionId, 'child');
  const forged = await service.getHistory({ ...request, rewriteFrom: { sessionId: 'parent', revision: { ...revision, token: 'forged' } } });
  assert.equal(forged.rewriteReceipt, undefined);
  projectedSnapshot = { ...targetSnapshot, size: 8 };
  assert.equal((await service.getHistory(request)).rewriteReceipt, undefined, 'actual cursor must match even after preflight stat');
  projectedSnapshot = targetSnapshot;
  await fs.appendFile(filePath, '{}\n');
  assert.equal((await service.getHistory(request)).rewriteReceipt, undefined, 'a later physical write invalidates reuse');
});

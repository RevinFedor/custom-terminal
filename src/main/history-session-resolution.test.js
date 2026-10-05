'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveHistorySession, historyReadError } = require('./history-session-resolution');
const sid = 'old-session';
function deps({ provider = 'claude', files = [], fork = null } = {}) {
  return { getBindings: () => provider ? [{ provider, tabId: 'a', cwd: '/saved-project' }] : [],
    getFork: () => fork, resolveFiles: async () => ({ results: files }) };
}
test('a missing Claude source never becomes a Codex error or a claim of deletion', async () => {
  await assert.rejects(resolveHistorySession({ sessionId: sid, cwd: '/different-cwd' }, deps()), error => {
    assert.equal(error.code, 'history_source_missing');
    assert.match(error.message, /^claude/);
    assert.equal(error.diagnostics.expectedProvider, 'claude');
    assert.equal(error.diagnostics.parentSubstitution, false);
    return true;
  });
});
test('global discovery resolves the exact file despite a changed cwd', async () => {
  const file = { provider: 'claude', state: 'available', filePath: '/other-project/exact.jsonl' };
  const result = await resolveHistorySession({ sessionId: sid, cwd: '/wrong' }, deps({ files: [file] }));
  assert.equal(result.filePath, file.filePath);
});
test('unknown I/O and provider conflicts stay distinct from absent files', async () => {
  await assert.rejects(resolveHistorySession({ sessionId: sid }, deps({ files: [{ provider: 'claude', state: 'unknown', reason: 'denied' }] })), { code: 'history_source_unavailable' });
  await assert.rejects(resolveHistorySession({ sessionId: sid }, deps({ files: [{ provider: 'codex', state: 'available', filePath: '/codex.jsonl' }] })), { code: 'history_provider_conflict' });
});
test('a legacy fork relation without a boundary remains unproven and preserves reason through HTTP', async () => {
  const result = await resolveHistorySession({ sessionId: sid }, deps({ provider: 'codex',
    files: [{ provider: 'codex', state: 'available', filePath: '/child.jsonl' }],
    fork: { provider: 'codex', childSessionId: sid, sourceSessionId: 'parent', forkMode: 'unknown', entryUuids: [] } }));
  assert.equal(result.diagnostics.fork.boundaryRecorded, false);
  assert.equal(result.diagnostics.fork.entryUuidCount, 0);
  const error = Object.assign(new Error('lineage_unresolved'), { lineageReason: 'provider-history-base-absent', diagnostics: result.diagnostics });
  assert.equal(historyReadError(error).lineageReason, 'provider-history-base-absent');
});
test('a partial child keeps its own identity; a legacy metadata lookup is retained', async () => {
  const partial = await resolveHistorySession({ sessionId: sid }, deps({ provider: 'codex', files: [{ provider: 'codex', state: 'partial', filePath: '/child' }] }));
  assert.equal(partial.filePath, '/child');
  const d = deps({ provider: 'codex' }); d.resolveLegacyCodexFile = async () => ({ filePath: '/legacy-name' });
  assert.equal((await resolveHistorySession({ sessionId: sid }, d)).filePath, '/legacy-name');
});

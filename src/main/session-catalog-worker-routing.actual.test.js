'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveSearchDateWindow, scoreSessionTurnMatch } = require('./session-catalog-search');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('async function searchSessionCatalog(options = {})');
const end = source.indexOf('\n// Литеральный grep', start);
assert.ok(start >= 0 && end > start);
function setup(candidates, readCodex) {
  const reads = [], phases = [];
  const context = vm.createContext({ require, path, srcMainDir: __dirname,
    resolveSearchDateWindow, scoreSessionTurnMatch,
    sessionCatalogTimestamp: value => value ? new Date(value * 1000).toISOString() : null,
    listSessionCatalogCandidates: async () => ({ candidates, total: candidates.length + 5, offset: 0, limit: candidates.length }),
    _resolveHistoryReadSession: async (id, cwd, provider) => ({ provider, diagnostics: { requestedSessionId: id } }),
    transcriptService: { searchCatalogCandidate: async payload => { reads.push(payload); return readCodex(payload); } },
    beginHistoryReadDiagnostic: () => ({ readId: 'hrm-fixture-1', end: (phase, fields) => phases.push({ phase, fields }) }),
    _loadSessionTurns: async (id, cwd, { provider }) => {
      assert.equal(provider, 'claude', 'Codex catalog must never enter full Main turn preparation');
      return { turns: [{ kind: 'user', userUuid: 'claude-user', userTimestamp: '2026-10-11T00:00:00Z' }],
        recordMap: new Map([['claude-user', 'alpha']]) };
    },
    _extractTurnPromptText: record => record,
    _collectAssistantBlocks: () => ({ text: ['beta'] }),
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: options => context.searchSessionCatalog(options), reads, phases };
}
const candidate = (id, extra = {}) => ({ sessionId: id, provider: 'codex', cwd: '/fixture',
  title: 'unrelated', createdAt: 100, status: 'closed', ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

test('actual catalog routes Codex through query RPC and preserves mixed-provider ranking/coordinates', async () => {
  const f = setup([candidate('codex-a'), candidate('claude-b', { provider: 'claude' })], async () => ({
    success: true, totalIterations: 7, bestMatches: [{ iterationIndex: 3, turnIndex: 5,
      entryUuid: 'codex-user', timestamp: '2026-10-11T00:00:01Z', matchedIn: ['user', 'assistant'],
      score: 20, userPreview: 'alpha', assistantPreview: 'beta' }],
  }));
  const result = plain(await f.run({ query: 'alpha beta' }));
  assert.equal(result.searchedSessions, 2);
  assert.equal(result.totalIterationsAcrossSessions, 8);
  assert.equal(result.hasMoreCandidates, true);
  assert.equal(result.matches[0].sessionId, 'codex-a');
  assert.equal(result.matches[0].iterationIndex, 3);
  assert.equal(result.matches[0].turnIndex, 5);
  assert.equal(result.matches[1].provider, 'claude');
  assert.equal(result.matches[1].score, 5);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].toolType, 'codex');
  assert.equal(f.reads[0].diagnosticReadId, 'hrm-fixture-1');
});

test('title fallback follows only a successful empty query result; read failure remains an error', async () => {
  const f = setup([candidate('empty', { title: 'alpha beta' }), candidate('failed', { title: 'alpha beta' })], async p => {
    if (p.sessionId === 'failed') throw Object.assign(new Error('revoked'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
    return { success: true, totalIterations: 11, bestMatches: [] };
  });
  const result = plain(await f.run({ query: 'alpha beta' }));
  assert.equal(result.searchedSessions, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].turnIndex, null);
  assert.deepEqual(result.matches[0].matchedIn, ['title']);
  assert.equal(result.matches[0].totalIterations, 11);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].sessionId, 'failed');
  assert.ok(f.phases.some(p => p.phase === 'error'));
});

test('blank query retains full counts without Main History; bounded global matches do not cap scanned sessions', async () => {
  const f = setup([candidate('a'), candidate('b')], async () => ({ success: true, totalIterations: 9, bestMatches: [] }));
  const result = plain(await f.run({ query: '', maxMatches: 1 }));
  assert.equal(result.totalIterationsAcrossSessions, 18);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.matches, undefined);
  assert.equal(f.reads.length, 2);
});

test('a malformed internal result does not publish partial counts or title fallback', async () => {
  const f = setup([candidate('bad', { title: 'alpha' })], async () => ({ success: true, totalIterations: 10 }));
  const result = plain(await f.run({ query: 'alpha' }));
  assert.equal(result.searchedSessions, 0);
  assert.equal(result.totalIterationsAcrossSessions, 0);
  assert.deepEqual(result.matches, []);
  assert.equal(result.errors.length, 1);
});

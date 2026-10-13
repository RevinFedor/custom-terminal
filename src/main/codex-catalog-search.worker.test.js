'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { HistoryReadClient } = require('./history-read-client');
const { _api } = require('./ipc/codex-data');
const event = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields } });
const answer = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function fixture(t, rows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-catalog-worker-'));
  const sessionId = 'catalog-worker-fixture';
  const file = path.join(directory, `rollout-${sessionId}.jsonl`);
  const records = [{ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: directory } }, ...rows];
  await fs.writeFile(file, encode(records));
  const diagnostics = [];
  let queryDiagnostic;
  const queryDiagnosticReady = new Promise(resolve => { queryDiagnostic = resolve; });
  const client = new HistoryReadClient({ codexData: { _api }, cacheDirectory: path.join(directory, 'cache'),
    sessionsDir: directory, memoryBudgetMb: 64, onDiagnostic: event => {
      diagnostics.push(event);
      if (event.side === 'worker' && event.method === 'searchCatalogCandidate') queryDiagnostic(event);
    } });
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, sessionId, file, client, diagnostics, queryDiagnosticReady,
    payload: { toolType: 'codex', sessionId, cwd: directory, query: 'alpha beta', matchesPerSession: 3,
      diagnosticReadId: 'catalog-worker-fixture-read' },
    rewrite: rows => fs.writeFile(file, encode([records[0], ...rows])),
  };
}

test('real worker returns query facts without materializing a Main raw cache', { timeout: 5000 }, async t => {
  const f = await fixture(t, [event('user_message', { message: 'alpha' }), answer('beta'),
    event('mcp_tool_call_end', { output: 'irrelevant'.repeat(250000) }), event('task_complete')]);
  const before = _api.getCodexJsonlCacheStats();
  const result = await f.client.call('searchCatalogCandidate', f.payload);
  assert.equal(result.success, true);
  assert.equal(result.totalIterations, 1);
  assert.equal(result.bestMatches.length, 1);
  assert.equal(result.bestMatches[0].score, 5);
  assert.equal(result.bestMatches[0].iterationIndex, 0);
  assert.equal(result.bestMatches[0].turnIndex, 0);
  assert.equal(result.diagnostics.observationFailures, 0, JSON.stringify(result.diagnostics));
  assert.deepEqual(_api.getCodexJsonlCacheStats(), before);
  assert.ok(v8.serialize(result).byteLength < 16384, 'query DTO must not carry transcript payload');
  // The worker posts its diagnostic after posting the result. Await that
  // channel's actual event instead of treating reply arrival as its ACK.
  const diagnostic = await f.queryDiagnosticReady;
  assert.ok(diagnostic.sourceBytes > 2000000);
  assert.equal(diagnostic.source, 'catalog-scan');
  assert.ok(f.diagnostics.some(event => event.side === 'worker' && event.method === 'searchCatalogCandidate'));
  assert.ok(f.client.sourceEpochSlots.has(f.file), 'actual physical source participates in Main revocation');
});

test('Main rejects an actual worker result invalidated between reply and acceptance and retries', async t => {
  const f = await fixture(t, [event('user_message', { message: 'alpha' }), answer('beta')]);
  const request = f.client.request.bind(f.client);
  let replies = 0;
  f.client.request = async (...args) => {
    const result = await request(...args);
    if (++replies === 1) {
      await f.rewrite([event('user_message', { message: 'different' }), answer('answer')]);
      f.client.invalidate({ filePath: f.file, sourceAppend: false });
    }
    return result;
  };
  const result = await f.client.call('searchCatalogCandidate', f.payload);
  assert.equal(result.success, true);
  assert.equal(result.totalIterations, 1);
  assert.deepEqual(result.bestMatches, []);
  assert.equal(replies, 2);
  assert.ok(f.diagnostics.some(event => event.event === 'request-retry' && event.reason === 'source-epoch-invalidated'));
});

test('missing worker source stays a read error rather than a successful empty search', async t => {
  const f = await fixture(t, [event('user_message', { message: 'alpha' })]);
  await fs.unlink(f.file);
  await assert.rejects(f.client.call('searchCatalogCandidate', f.payload));
  assert.equal(f.client.diagnosticCounters.retries, 0, 'a stable missing source is not a mutation retry');
});

for (const sameOwner of [true, false]) test('Main logical commit admission without a physical rewrite: sameOwner=' + sameOwner, async t => {
  const f = await fixture(t, [event('user_message', { message: 'alpha' }), answer('beta')]);
  const request = f.client.request.bind(f.client);
  let replies = 0;
  f.client.request = async (...args) => {
    const result = await request(...args);
    if (++replies === 1) f.client.lineageCommitted(sameOwner ? f.sessionId : 'unrelated-owner');
    return result;
  };
  const result = await f.client.call('searchCatalogCandidate', f.payload);
  assert.equal(result.bestMatches.length, 1);
  assert.equal(replies, sameOwner ? 2 : 1);
});

for (const mode of ['physical', 'logical', 'unrelated', 'always']) test('Main rechecks admission after synchronous diagnostic observer: ' + mode, async t => {
  const f = await fixture(t, [event('user_message', { message: 'alpha' }), answer('beta')]);
  f.client.diagnosticSlowMs = 0;
  const observe = f.client.onDiagnostic;
  let completions = 0;
  f.client.onDiagnostic = diagnostic => {
    observe(diagnostic);
    if (diagnostic.side !== 'main' || diagnostic.event !== 'call-complete' || diagnostic.outcome !== 'success') return;
    if (++completions > 1 && mode !== 'always') return;
    if (mode === 'physical' || mode === 'always') f.client.invalidate({ filePath: f.file, sourceAppend: false });
    else f.client.lineageCommitted(mode === 'logical' ? f.sessionId : 'unrelated-owner');
  };
  const result = await f.client.call('searchCatalogCandidate', f.payload);
  if (mode === 'always') {
    assert.equal(result.success, false);
    assert.equal(result.error, 'history_source_changed_during_preparation');
    assert.equal(completions, 3, 'bounded attempts, no stale success');
    assert.equal(f.client.diagnosticCounters.retries, 2);
  } else {
    assert.equal(result.success, true); assert.equal(result.bestMatches.length, 1);
    assert.equal(completions, mode === 'unrelated' ? 1 : 2);
    assert.equal(f.client.diagnosticCounters.retries, mode === 'unrelated' ? 0 : 1);
  }
});

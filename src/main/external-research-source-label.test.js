const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { externalResearchSourceLabel } = require('./external-research-source-label');
const run = { runId: 'own', runKind: 'external-research', externalResearchJobId: 'noted_own',
  sourceTabId: 'same-source', sourceTabName: 'iOS chat', status: 'failed', error: 'original error' };
test('source projection is display-only and identical for running and terminal outcomes', () => {
  for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled']) {
    const current = { ...run, status }; const before = JSON.stringify(current);
    assert.deepEqual(externalResearchSourceLabel(current), { runId: 'own', jobId: 'noted_own', tabId: 'same-source', tabName: 'iOS chat' });
    assert.equal(JSON.stringify(current), before);
  }
});
test('private input, result and errors are not read or exposed by label metadata', () => {
  const current = { ...run };
  for (const key of ['prompt', 'externalResearchIntent', 'deliveryIntent', 'result', 'error']) {
    Object.defineProperty(current, key, { get() { assert.fail('must not read ' + key); } });
  }
  assert.equal(externalResearchSourceLabel(current).tabName, 'iOS chat');
  assert.equal(Object.keys(externalResearchSourceLabel(current)).length, 4);
  assert.equal(externalResearchSourceLabel({ ...run, runKind: 'agent' }), null);
  assert.equal(externalResearchSourceLabel({ ...run, sourceTabId: null }), null);
  assert.equal(externalResearchSourceLabel({ ...run, sourceTabName: null }).tabName, null);
});
test('actual web route reads ONE exact stored record without status reconciliation or a result read', async () => {
  const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const start = source.indexOf('  const orchestrationSourceMatch =');
  const end = source.indexOf('  const orchestrationStatusMatch =', start);
  assert(start > 0 && end > start);
  const calls = [], context = {
    parsed: { pathname: '/api/orchestrations/own/source' }, req: { method: 'GET' }, res: {},
    decId: decodeURIComponent, getOrchestrationRunStore: () => ({ getInternal: async id => { calls.push(id); return run; } }),
    require: name => { assert.equal(name, './external-research-source-label'); return { externalResearchSourceLabel }; },
    sendJson: (_res, status, body) => ({ status, body }),
    reconcileExternalResearchRun: () => assert.fail('UI metadata must never reconcile Research'),
  };
  const response = await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', context);
  assert.equal(response.status, 200); assert.equal(response.body.source.tabName, 'iOS chat'); assert.deepEqual(calls, ['own']);
});

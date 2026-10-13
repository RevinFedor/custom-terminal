import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchModelCatalog, savedResearchModel } from './researchModelCatalog.mjs';

const run = { runId: 'run', sourceTabId: 'tab', runKind: 'external-research', externalResearchModel: '6', externalResearchEffort: 'xhigh', externalResearchMode: 'chat' };
test('History + Timeline single-flight only the identical tab/session catalog', async () => {
  const cache = createResearchModelCatalog(); let reads = 0, resolve;
  const load = () => { reads++; return new Promise(r => { resolve = r; }); };
  const a = cache.read('tab:sid-a', 'tab', load), b = cache.read('tab:sid-a', 'tab', load);
  assert.equal(a, b); await Promise.resolve(); assert.equal(reads, 1);
  resolve([run]); assert.deepEqual((await a).run, { model: '6', effort: 'xhigh', mode: 'chat', label: null });
  await cache.read('tab:sid-a', 'tab', load); assert.equal(reads, 1);
  const other = cache.read('tab:sid-b', 'tab', () => { reads++; return []; });
  assert.deepEqual(await other, {}); assert.equal(reads, 2);
});
test('late catalog cannot overwrite a newer exact run event or another owner', async () => {
  const cache = createResearchModelCatalog(); let resolve;
  const pending = cache.read('old', 'tab', () => new Promise(r => { resolve = r; }));
  await Promise.resolve();
  cache.publish('old', 'tab', { ...run, externalResearchEffort: 'max' });
  cache.publish('new', 'tab', { ...run, runId: 'new-run' });
  resolve([run]); assert.equal((await pending).run.effort, 'max');
  assert.equal(cache.peek('new').run, undefined);
  assert.equal(cache.publish('new', 'tab', { ...run, sourceTabId: 'other' }), null);
});
test('failure is not cached as empty success; unknown parameters never use current defaults', async () => {
  const cache = createResearchModelCatalog();
  await assert.rejects(cache.read('owner', 'tab', () => Promise.reject(Error('unavailable'))));
  const values = await cache.read('owner', 'tab', () => [{ ...run, externalResearchModel: null, externalResearchEffort: null }]);
  assert.deepEqual(values.run, { model: null, effort: null, mode: 'chat', label: null });
  assert.deepEqual(savedResearchModel({ model: 'current-model', effort: 'current-effort' }), { model: null, mode: null, effort: null, label: null });
});
test('owner budget evicts only metadata, without retaining result bodies', async () => {
  const cache = createResearchModelCatalog(2);
  for (const id of ['one', 'two', 'three']) await cache.read(id, 'tab', () => [{ ...run, answer: 'do not retain' }]);
  assert.equal(cache.peek('one'), null); assert.equal(cache.peek('three').run.answer, undefined);
});
test('unchanged operational events keep the same metadata projection for both UI consumers', () => {
  const cache = createResearchModelCatalog();
  const a = cache.publish('owner', 'tab', run);
  assert.equal(cache.publish('owner', 'tab', { ...run, status: 'running', updatedAt: 2 }), a);
  assert.notEqual(cache.publish('owner', 'tab', { ...run, externalResearchEffort: 'max' }), a);
});
test('task label is bounded saved metadata and a changed label publishes once', () => {
  const cache = createResearchModelCatalog();
  const first = cache.publish('owner', 'tab', { ...run, label: 'Core overlap · hear' });
  assert.equal(first.run.label, 'Core overlap · hear');
  assert.equal(cache.publish('owner', 'tab', { ...run, label: 'Core overlap · hear', status: 'completed' }), first);
  assert.notEqual(cache.publish('owner', 'tab', { ...run, label: 'Core overlap · involve' }), first);
  assert.equal(savedResearchModel({ ...run, label: 'x'.repeat(201) }).label, null);
});
test('unexpected catalog shape is unknown/retryable, not a cached successful empty list', async () => {
  const cache = createResearchModelCatalog();
  await assert.rejects(cache.read('owner', 'tab', () => ({ success: false })), /Invalid saved research catalog/);
  assert.ok((await cache.read('owner', 'tab', () => [run])).run);
});

test('a newly displayed completion refreshes an older owner catalog once; pruned IDs do not poll', async () => {
  const cache = createResearchModelCatalog(); let reads = 0;
  const first = () => { reads++; return [run]; };
  await cache.read('owner', 'tab', first, ['run']);
  const next = { ...run, runId: 'new-run', externalResearchModel: '6-astra' };
  const refresh = () => { reads++; return [run, next]; };
  const values = await cache.read('owner', 'tab', refresh, ['run', 'new-run']);
  assert.equal(values['new-run']?.model, '6-astra');
  assert.equal(reads, 2);
  await cache.read('owner', 'tab', refresh, ['run', 'new-run']);
  assert.equal(reads, 2);
  await cache.read('owner', 'tab', refresh, ['old-pruned']);
  await cache.read('owner', 'tab', refresh, ['old-pruned']);
  assert.equal(reads, 3, 'a completed negative metadata read is not retried on every show');
});

test('new demand during a pending catalog gets one follow-up read without losing newer events', async () => {
  const cache = createResearchModelCatalog(); let finish, reads = 0;
  const first = cache.read('owner', 'tab', () => { reads++; return new Promise(resolve => { finish = resolve; }); }, ['run']);
  await Promise.resolve();
  const load = () => { reads++; return [{ ...run, runId: 'second' }]; };
  const a = cache.read('owner', 'tab', load, ['second']);
  const b = cache.read('owner', 'tab', load, ['second']);
  cache.publish('owner', 'tab', { ...run, externalResearchEffort: 'max' });
  finish([run]);
  await first;
  const [x, y] = await Promise.all([a, b]);
  assert.equal(reads, 2);
  assert.equal(x.second.model, '6'); assert.equal(y.second.model, '6');
  assert.equal(x.run.effort, 'max');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestration-hydration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, 'store.cjs');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'useOrchestrationStore.ts')],
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const listeners = new Map();
  let reads = 0;
  const ipcRenderer = {
    on: (channel, callback) => listeners.set(channel, callback),
    invoke: channel => {
      assert.equal(channel, 'orchestration:list-active');
      assert.ok(listeners.has('orchestration:changed'));
      reads++;
      return pending;
    },
  };
  const original = global.window;
  global.window = { require: () => ({ ipcRenderer }) };
  t.after(() => { if (original === undefined) delete global.window; else global.window = original; });
  const module = require(outfile);
  const hydration = module.initializeOrchestrationStore();
  assert.equal(module.initializeOrchestrationStore(), hydration);
  return { module, hydration, resolve, reject, reads: () => reads,
    event: run => listeners.get('orchestration:changed')(null, { run }),
    state: () => module.useOrchestrationStore.getState() };
}

const run = patch => ({ runId: 'R', sourceTabId: 'S', sourceProjectId: 'P',
  targetTabId: 'T', status: 'running', createdAt: 1, updatedAt: 20, ...patch });

for (const failure of [false, true]) test(`accepted running event survives ${failure ? 'failed' : 'empty stale'} initial list`, async t => {
  const h = await fixture(t);
  h.event(run());
  if (failure) h.reject(new Error('controlled read failure')); else h.resolve([]);
  await h.hydration;
  assert.equal(h.reads(), 1);
  assert.equal(h.state().activeRuns.get('R').status, 'running');
  assert.ok(h.state().inheritedBusyTabIds.has('S'));
  assert.ok(h.state().completionBlockedTabIds.has('S'));
});

test('completed event is a hydration tombstone, not resurrection by a late running list', async t => {
  const h = await fixture(t);
  h.event(run({ status: 'completed', resultComplete: true }));
  h.resolve([run({ updatedAt: 10 })]);
  await h.hydration;
  assert.equal(h.state().activeRuns.size, 0);
  assert.equal(h.state().inheritedBusyTabIds.size, 0);
  assert.equal(h.state().completionBlockedTabIds.size, 0);
});

test('newer snapshot wins while equal versions prefer the accepted event', async t => {
  const h = await fixture(t);
  h.event(run({ status: 'completed', resultComplete: true }));
  h.event(run({ runId: 'equal', status: 'completed', resultComplete: true }));
  h.resolve([run({ updatedAt: 30 }), run({ runId: 'equal' })]);
  await h.hydration;
  assert.equal(h.state().activeRuns.get('R').updatedAt, 30);
  assert.equal(h.state().activeRuns.has('equal'), false);
});

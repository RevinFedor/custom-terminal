const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

async function harness(t, { pendingCatalog } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-loop-stores-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outfile = path.join(root, 'stores.cjs');
  await esbuild.build({ stdin: { contents: `export * from './usePromptQueueStore'; export { usePromptsStore } from './usePromptsStore';`, resolveDir: __dirname, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const writes = [];
  const loop = { id: 'run-after-loop', name: 'Run After Loop', content: 'canonical text', isBuiltIn: true, color: '#a78bfa', position: 10, model: 'gemini-3.8-flash', thinkingLevel: 'NONE', filePaths: [], showInContextMenu: false };
  global.window = { require: () => ({ ipcRenderer: {
    invoke: async (channel, args) => {
      if (channel === 'ai-prompts:get') return pendingCatalog ? pendingCatalog.promise : { success: true, data: [loop] };
      if (channel === 'app:getState') return args === 'promptQueueByTab' ? JSON.stringify({ owner: { items: [], loopPromptEnabled: true, loopPromptText: 'obsolete per-tab', loopPromptArmedAt: 10 } }) : null;
      if (channel === 'ai-prompts:save-content' || channel === 'ai-prompts:save' || channel === 'app:setState') { writes.push({ channel, args }); return { success: true }; }
      throw new Error('Unexpected IPC: ' + channel);
    },
    sendSync: (channel, args) => { writes.push({ channel, args }); return { success: true }; },
  } }) };
  t.after(() => { delete global.window; });
  return { ...require(outfile), writes, loop };
}

test('Settings is authoritative; both editors update all queues without resurrecting old debounce', async (t) => {
  const h = await harness(t);
  await h.hydratePromptQueueStore();
  const queue = h.usePromptQueueStore.getState();
  assert.equal(queue.getQueue('owner').loopPromptText, 'canonical text');
  queue.setLoopPromptEnabled('second', true);
  queue.setLoopPromptText('owner', 'pencil text');
  await delay(280);
  assert.equal(h.usePromptsStore.getState().getPromptById('run-after-loop').content, 'pencil text');
  assert.equal(h.usePromptsStore.getState().getPromptById('run-after-loop').color, '#a78bfa');
  queue.setLoopPromptText('owner', 'stale pending pencil');
  await h.usePromptsStore.getState().savePrompt({ ...h.loop, content: 'newer Settings body' });
  await delay(280);
  for (const id of ['owner', 'second']) assert.equal(h.usePromptQueueStore.getState().getQueue(id).loopPromptText, 'newer Settings body');
  assert.ok(!h.writes.some((w) => w.channel === 'ai-prompts:save-content' && w.args.content === 'stale pending pencil'));
  assert.ok(!h.writes.some((w) => w.args.key === 'promptQueueSharedLoopPrompt'));
  h.flushPromptQueueStoreSync();
  assert.ok(h.writes.some((w) => w.channel === 'ai-prompts:save-content-sync' && w.args.content === 'newer Settings body'));
});

test('late initial catalog read cannot erase a pencil edit made before hydration', async (t) => {
  const catalog = deferred();
  const h = await harness(t, { pendingCatalog: catalog });
  const hydrate = h.hydratePromptQueueStore();
  h.usePromptQueueStore.getState().setLoopPromptText('owner', 'pre-hydrate edit');
  catalog.resolve({ success: true, data: [h.loop] });
  await hydrate;
  await delay(280);
  assert.equal(h.usePromptQueueStore.getState().getQueue('owner').loopPromptText, 'pre-hydrate edit');
  assert.equal(h.usePromptsStore.getState().getPromptById('run-after-loop').content, 'pre-hydrate edit');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function loadQueueStore(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prompt-queue-editor-race-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, 'store.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'usePromptQueueStore.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });

  const ipcRenderer = {
    invoke: async (channel) => {
      if (channel === 'app:getState') return {};
      if (channel === 'app:setState') return { success: true };
      throw new Error('Unexpected IPC invoke: ' + channel);
    },
    sendSync: () => ({ success: true }),
  };
  global.window = { require: () => ({ ipcRenderer }) };
  t.after(() => { delete global.window; });

  const queueModule = require(outfile);
  await queueModule.hydratePromptQueueStore();
  t.after(() => queueModule.flushPromptQueueStoreSync());
  return queueModule;
}

test('editor lock is owner-scoped, token-safe, and notifies auto-run on release', async (t) => {
  const queueModule = await loadQueueStore(t);
  const events = [];
  const unsubscribe = queueModule.subscribePromptQueueEditorLocks((tabId, lock, options) => {
    events.push([tabId, lock?.token || null, lock?.itemId || null, options.wakeAutoRun]);
  });
  t.after(unsubscribe);

  assert.equal(queueModule.acquirePromptQueueEditorLock('tab-1', 'desktop-a', 'item-1'), true);
  assert.equal(queueModule.isPromptQueueEditorLocked('tab-1'), true);
  assert.equal(
    queueModule.acquirePromptQueueEditorLock('tab-1', 'desktop-b', 'item-1'),
    false,
    'a second editor cannot steal a live payload lock',
  );
  assert.equal(queueModule.releasePromptQueueEditorLock('tab-1', 'desktop-b'), false);
  assert.equal(queueModule.isPromptQueueEditorLocked('tab-1'), true);
  assert.equal(queueModule.releasePromptQueueEditorLock('tab-1', 'desktop-a'), true);
  assert.equal(queueModule.isPromptQueueEditorLocked('tab-1'), false);
  assert.equal(queueModule.acquirePromptQueueEditorLock('tab-1', 'desktop-a', 'item-2'), true);
  assert.equal(queueModule.releasePromptQueueEditorLock(
    'tab-1',
    'desktop-a',
    { wakeAutoRun: false },
  ), true);
  assert.deepEqual(events, [
    ['tab-1', 'desktop-a', 'item-1', false],
    ['tab-1', null, null, true],
    ['tab-1', 'desktop-a', 'item-2', false],
    ['tab-1', null, null, false],
  ]);
});

test('dirty-field updates and CAS never replay an open-time snapshot over remote edits', async (t) => {
  const queueModule = await loadQueueStore(t);
  const store = queueModule.usePromptQueueStore.getState();
  const id = store.addPrompt(
    'tab-race',
    'open-time text',
    undefined,
    undefined,
    'Open title',
    [{ id: 'chip-a', kind: 'prompt', text: 'instruction', sourceKey: 'prompt:a' }],
  );

  // Mobile changes the payload after desktop opened the editor. Desktop then
  // commits only its dirty title field; text/chips must stay remote-current.
  assert.equal(store.updatePrompt('tab-race', id, { text: 'mobile text' }), true);
  assert.equal(store.updatePrompt('tab-race', id, {
    title: 'Desktop title',
    titleManual: true,
  }), true);
  let item = store.getQueue('tab-race').items.find((entry) => entry.id === id);
  assert.equal(item.text, 'mobile text');
  assert.equal(item.title, 'Desktop title');
  assert.equal(item.chips[0].id, 'chip-a');

  // A chip-only desktop write-through must not resend stale title/text.
  assert.equal(store.updatePrompt('tab-race', id, {
    title: 'Mobile title',
    titleManual: true,
  }), true);
  assert.equal(store.updatePrompt('tab-race', id, {
    chips: [{ id: 'chip-b', kind: 'paste', text: 'new paste' }],
  }), true);
  item = store.getQueue('tab-race').items.find((entry) => entry.id === id);
  assert.equal(item.text, 'mobile text');
  assert.equal(item.title, 'Mobile title');
  assert.deepEqual(item.chips.map((chip) => chip.id), ['chip-b']);

  // Final trim/rollback from an old editor is conditional. Once mobile changed
  // the same field, the stale expected value is refused instead of overwriting.
  assert.equal(store.updatePrompt(
    'tab-race',
    id,
    { text: 'stale desktop commit' },
    { expected: { text: 'open-time text' } },
  ), false);
  assert.equal(store.getQueue('tab-race').items.find((entry) => entry.id === id).text, 'mobile text');
  assert.equal(store.updatePrompt(
    'tab-race',
    id,
    { text: 'desktop after fresh compare' },
    { expected: { text: 'mobile text' } },
  ), true);

  assert.equal(store.removePrompt(
    'tab-race',
    id,
    { expected: { text: 'mobile text' } },
  ), false);
  assert.equal(store.getQueue('tab-race').items.length, 1);
  assert.equal(store.removePrompt(
    'tab-race',
    id,
    { expected: { text: 'desktop after fresh compare' } },
  ), true);
  assert.equal(store.getQueue('tab-race').items.length, 0);
});

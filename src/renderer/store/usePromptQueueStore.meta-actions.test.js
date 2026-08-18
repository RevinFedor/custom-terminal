const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function loadQueueStore(t, persisted) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prompt-queue-actions-test-'));
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
    invoke: async (channel, key) => {
      if (channel === 'app:getState') {
        if (key === 'promptQueueByTab') return JSON.stringify(persisted || {});
        return null;
      }
      if (channel === 'app:setState') return { success: true };
      if (channel === 'prompt-queue:materialize-image-refs') {
        return { success: true, refs: [] };
      }
      throw new Error('Unexpected IPC invoke: ' + channel);
    },
    sendSync: () => ({ success: true }),
  };
  global.window = { require: () => ({ ipcRenderer }) };
  t.after(() => { delete global.window; });
  return require(outfile);
}

test('queued Restart and Rewind actions survive hydration as actions, not blank prompts', async (t) => {
  const queueModule = await loadQueueStore(t, {
    'tab-1': {
      items: [
        {
          id: 'restart-1', enabled: true, title: 'Restart tab', titleManual: true,
          text: '', images: 0, createdAt: 1, metaAction: { kind: 'restart' },
        },
        {
          id: 'rewind-1', enabled: true, title: 'Rewind: target', titleManual: true,
          text: '', images: 0, createdAt: 2,
          metaAction: {
            kind: 'rewind',
            targetUuid: 'user-uuid',
            targetText: 'target prompt',
            sourceSessionId: 'session-a',
            toolType: 'codex',
          },
        },
      ],
      autoRun: false,
    },
  });
  await queueModule.hydratePromptQueueStore();
  const items = queueModule.usePromptQueueStore.getState().getQueue('tab-1').items;
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].metaAction, { kind: 'restart' });
  assert.deepEqual(items[1].metaAction, {
    kind: 'rewind',
    targetUuid: 'user-uuid',
    targetText: 'target prompt',
    sourceSessionId: 'session-a',
    toolType: 'codex',
  });
  assert.equal(items[0].text, '');
  assert.equal(items[1].text, '');
});

test('addMetaAction uses the ordinary queue ordering and first-item staging contract', async (t) => {
  const queueModule = await loadQueueStore(t, {});
  await queueModule.hydratePromptQueueStore();
  const store = queueModule.usePromptQueueStore.getState();
  const restartId = store.addMetaAction('tab-2', { kind: 'restart' });
  const rewindId = store.addMetaAction('tab-2', {
    kind: 'rewind',
    targetUuid: 'target-2',
    targetText: 'second target',
    sourceSessionId: 'session-2',
    toolType: 'claude',
  });
  const queue = queueModule.usePromptQueueStore.getState().getQueue('tab-2');
  assert.deepEqual(queue.items.map((item) => item.id), [restartId, rewindId]);
  assert.equal(queue.autoRun, false);
  assert.equal(queue.firstChipHintActive, true);
  assert.equal(queue.items[0].title, 'Restart tab');
  assert.match(queue.items[1].title, /^Rewind: second target/);
});

test('corrupt persisted action is dropped instead of becoming an empty submitted prompt', async (t) => {
  const queueModule = await loadQueueStore(t, {
    'tab-3': {
      items: [{
        id: 'broken', enabled: true, text: '', images: 0, createdAt: 1,
        metaAction: { kind: 'rewind', targetUuid: 'missing-fields' },
      }],
      autoRun: true,
    },
  });
  await queueModule.hydratePromptQueueStore();
  const queue = queueModule.usePromptQueueStore.getState().getQueue('tab-3');
  assert.equal(queue.items.length, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('hydrate merges a pre-hydrate add and shutdown flush keeps durable image refs', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prompt-queue-store-test-'));
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

  const rawState = deferred();
  const syncWrites = [];
  const ipcRenderer = {
    invoke: async (channel, payload) => {
      if (channel === 'app:getState') return rawState.promise;
      if (channel === 'prompt-queue:materialize-image-refs') {
        return {
          success: true,
          refs: payload.refs.map((ref) => ({ ...ref, availability: 'available' })),
          available: payload.refs.length,
          missing: 0,
        };
      }
      if (channel === 'app:setState') return { success: true };
      throw new Error('Unexpected IPC invoke: ' + channel);
    },
    sendSync: (channel, payload) => {
      syncWrites.push({ channel, payload });
      return { success: true };
    },
  };
  global.window = { require: () => ({ ipcRenderer }) };
  t.after(() => { delete global.window; });

  const queueModule = require(outfile);
  assert.equal(queueModule.getShortGrabPromptTitle('  коротко  '), 'коротко');
  assert.equal(queueModule.getShortGrabPromptTitle('первая\nстрока'), 'первая строка');
  assert.equal(queueModule.getShortGrabPromptTitle('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(queueModule.getShortGrabPromptTitle('a'.repeat(25)), null);
  const hydration = queueModule.hydratePromptQueueStore();
  const newId = queueModule.usePromptQueueStore.getState().addPrompt('tab-1', 'new prompt');
  const firstAssetId = 'a'.repeat(64) + '.png';
  const secondAssetId = 'b'.repeat(64) + '.png';
  rawState.resolve({
    'tab-1': {
      items: [{
        id: 'persisted-item',
        text: '[Image #1] compare [Image #2]',
        images: 2,
        imagePaths: [
          { id: 1, assetId: firstAssetId, path: '/durable/a.png', mediaType: 'image/png', size: 10, availability: 'available' },
          { id: 2, assetId: secondAssetId, path: '/durable/b.png', mediaType: 'image/png', size: 20, availability: 'available' },
        ],
        createdAt: 1,
      }],
      autoRun: true,
      stopAfter: false,
      closeAfter: false,
      firstDelaySeconds: 0,
      postPromptEnabled: false,
      postPromptText: '',
      runAfterTabId: null,
      panelCollapsed: false,
      previewId: null,
    },
  });
  await hydration;

  const queue = queueModule.usePromptQueueStore.getState().getQueue('tab-1');
  assert.deepEqual(queue.items.map((item) => item.id), ['persisted-item', newId]);
  assert.equal(queue.autoRun, true);
  assert.equal(queue.firstChipHintActive, false);
  assert.equal(queueModule.getQueuedPromptAttachmentState(queue.items[0]), 'ready');
  assert.equal(
    queueModule.buildQueuedPromptPayload({ text: '[Image]', imagePaths: [] }),
    '[imageError: queued_image_path_unavailable #unknown]',
  );

  queueModule.flushPromptQueueStoreSync();
  assert.equal(syncWrites.length, 1);
  assert.equal(syncWrites[0].channel, 'app:setStateSync');
  const saved = JSON.parse(syncWrites[0].payload.value);
  assert.deepEqual(
    saved['tab-1'].items[0].imagePaths.map((ref) => ref.assetId),
    [firstAssetId, secondAssetId],
  );

  assert.deepEqual(
    queueModule.getQueuedImageMarkerHighlightRanges(queue.items[0].text, queue.items[0].imagePaths)
      .map((range) => [queue.items[0].text.slice(range.start, range.end), range.id]),
    [['[Image #1]', 1], ['[Image #2]', 2]],
  );
  assert.deepEqual(
    queueModule.getQueuedImageMarkerHighlightRanges('\\[Image #1] compare [Image #2]', queue.items[0].imagePaths)
      .map((range) => range.id),
    [2],
  );

  queueModule.usePromptQueueStore.getState().updatePrompt(
    'tab-1',
    'persisted-item',
    { text: '\\[Image #1] compare [Image #2]' },
  );
  const escaped = queueModule.usePromptQueueStore.getState().getQueue('tab-1').items[0];
  assert.equal(queueModule.getQueuedPromptAttachmentState(escaped), 'missing');
  assert.deepEqual(escaped.imagePaths.map((ref) => ref.id), [1, 2]);
  assert.equal((await queueModule.ensureQueuedPromptImagesReady('tab-1', 'persisted-item')).ready, false);

  queueModule.usePromptQueueStore.getState().updatePrompt(
    'tab-1',
    'persisted-item',
    { text: '[Image #3] compare [Image #2]' },
  );
  const unknownId = queueModule.usePromptQueueStore.getState().getQueue('tab-1').items[0];
  assert.equal(queueModule.getQueuedPromptAttachmentState(unknownId), 'missing');
  assert.deepEqual(unknownId.imagePaths.map((ref) => ref.id), [1, 2]);
  assert.deepEqual(
    queueModule.getQueuedImageMarkerHighlightRanges(unknownId.text, unknownId.imagePaths).map((range) => range.id),
    [2],
  );
  assert.equal((await queueModule.ensureQueuedPromptImagesReady('tab-1', 'persisted-item')).ready, false);

  queueModule.usePromptQueueStore.getState().updatePrompt(
    'tab-1',
    'persisted-item',
    { text: '[Image #1 compare [Image #2]' },
  );
  const malformed = queueModule.usePromptQueueStore.getState().getQueue('tab-1').items[0];
  assert.equal(queueModule.getQueuedPromptAttachmentState(malformed), 'missing');
  assert.deepEqual(malformed.imagePaths.map((ref) => ref.id), [1, 2]);
  assert.deepEqual(
    queueModule.getQueuedImageMarkerHighlightRanges(malformed.text, malformed.imagePaths).map((range) => range.id),
    [2],
  );
  const refused = await queueModule.ensureQueuedPromptImagesReady('tab-1', 'persisted-item');
  assert.equal(refused.ready, false);
  assert.equal(refused.state, 'missing');

  queueModule.usePromptQueueStore.getState().updatePrompt(
    'tab-1',
    'persisted-item',
    { text: 'compare [Image #2]' },
  );
  const removedFirst = queueModule.usePromptQueueStore.getState().getQueue('tab-1').items[0];
  assert.equal(queueModule.getQueuedPromptAttachmentState(removedFirst), 'ready');
  assert.deepEqual(removedFirst.imagePaths.map((ref) => ref.id), [2]);
  assert.equal(removedFirst.images, 1);

  queueModule.usePromptQueueStore.getState().updatePrompt(
    'tab-1',
    'persisted-item',
    { text: 'compare only' },
  );
  const removedAll = queueModule.usePromptQueueStore.getState().getQueue('tab-1').items[0];
  assert.equal(queueModule.getQueuedPromptAttachmentState(removedAll), 'ready');
  assert.equal(removedAll.imagePaths, undefined);
  assert.equal(removedAll.images, 0);
});

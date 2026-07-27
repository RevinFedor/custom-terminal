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
  assert.equal(queueModule.isPromptQueueStoreHydrated(), false);
  let hydrationNotifications = 0;
  const unsubscribeHydration = queueModule.subscribePromptQueueHydration(() => {
    hydrationNotifications += 1;
  });
  assert.equal(queueModule.getShortGrabPromptTitle('  коротко  '), 'коротко');
  assert.equal(queueModule.getShortGrabPromptTitle('первая\nстрока'), 'первая строка');
  assert.equal(queueModule.getShortGrabPromptTitle('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(queueModule.getShortGrabPromptTitle('a'.repeat(25)), null);
  const hydration = queueModule.hydratePromptQueueStore();
  const newId = queueModule.usePromptQueueStore.getState().addPrompt(
    'tab-1',
    'new prompt',
    undefined,
    undefined,
    undefined,
    [{ id: 'runtime-paste', kind: 'paste', text: 'runtime paste' }],
  );
  const originalDateNowBeforeHydration = Date.now;
  let mergedRuntimeId;
  try {
    Date.now = () => 5_000;
    mergedRuntimeId = queueModule.usePromptQueueStore.getState().addPrompt('tab-merge-arm', 'runtime prompt');
    queueModule.usePromptQueueStore.getState().setAutoRun('tab-merge-arm', true);
  } finally {
    Date.now = originalDateNowBeforeHydration;
  }
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
        chips: [
          { id: 'persisted-prompt', kind: 'prompt', text: 'old instruction', sourceKey: 'prompt:docs' },
          { id: 'replacement-id', kind: 'prompt', text: 'updated instruction', sourceKey: 'prompt:docs' },
          { id: 'persisted-paste', kind: 'paste', text: 'raw paste' },
          { id: 'invalid-chip', kind: 'unknown', text: 'drop me' },
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
    'tab-persisted-arm': {
      items: [{ id: 'persisted-armed-item', text: 'persisted armed', createdAt: 2 }],
      autoRun: true,
      workflowArmedAt: 777,
    },
    'tab-stale-target': {
      items: [{ id: 'persisted-stale-item', text: 'wait on missing tab', createdAt: 4 }],
      autoRun: true,
      runAfterTabId: 'closed-target',
      workflowArmedAt: 888,
    },
    'tab-long-delay': {
      items: [],
      autoRun: false,
      firstDelaySeconds: 90061,
    },
    'tab-loop': {
      items: [],
      loopPromptEnabled: true,
      loopPromptText: 'continue until done',
      loopPromptArmedAt: 444,
    },
    'tab-merge-arm': {
      items: [{ id: 'persisted-merge-item', text: 'persisted merge', createdAt: 3 }],
      autoRun: false,
      workflowArmedAt: 111,
    },
  });
  await hydration;
  unsubscribeHydration();
  assert.equal(queueModule.isPromptQueueStoreHydrated(), true);
  assert.equal(hydrationNotifications, 1);

  const queue = queueModule.usePromptQueueStore.getState().getQueue('tab-1');
  assert.deepEqual(queue.items.map((item) => item.id), ['persisted-item', newId]);
  assert.equal(queue.autoRun, true);
  assert.equal(queue.firstChipHintActive, false);
  assert.equal(queue.workflowArmedAt, null, 'legacy persisted workflow remains fail-closed');
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-1'), false);
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-persisted-arm').workflowArmedAt, 777);
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-persisted-arm'), false);
  assert.equal(
    queueModule.usePromptQueueStore.getState().getQueue('tab-long-delay').firstDelaySeconds,
    90061,
    'persisted delays longer than one hour are preserved',
  );
  const hydratedLoop = queueModule.usePromptQueueStore.getState().getQueue('tab-loop');
  assert.equal(hydratedLoop.loopPromptEnabled, true);
  assert.equal(hydratedLoop.loopPromptText, 'continue until done');
  assert.equal(hydratedLoop.loopPromptArmedAt, 444);
  assert.equal(queueModule.hasPendingPromptQueueContinuation(hydratedLoop), true);
  queueModule.usePromptQueueStore.getState().clearStaleRunAfterTab('tab-stale-target', 'different-target');
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-stale-target').runAfterTabId, 'closed-target');
  queueModule.usePromptQueueStore.getState().clearStaleRunAfterTab('tab-stale-target', 'closed-target');
  const repairedStaleTarget = queueModule.usePromptQueueStore.getState().getQueue('tab-stale-target');
  assert.equal(repairedStaleTarget.runAfterTabId, null);
  assert.equal(repairedStaleTarget.workflowArmedAt, 888);
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-stale-target'), false);
  assert.equal(queueModule.consumeAutomaticRunAfterTargetClear('tab-stale-target'), true);
  assert.equal(queueModule.consumeAutomaticRunAfterTargetClear('tab-stale-target'), false);
  const mergedRuntimeQueue = queueModule.usePromptQueueStore.getState().getQueue('tab-merge-arm');
  assert.deepEqual(mergedRuntimeQueue.items.map((item) => item.id), ['persisted-merge-item', mergedRuntimeId]);
  assert.equal(mergedRuntimeQueue.autoRun, true);
  assert.equal(mergedRuntimeQueue.workflowArmedAt, 5_000);
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-merge-arm'), true);
  assert.equal(queueModule.getQueuedPromptAttachmentState(queue.items[0]), 'ready');
  assert.deepEqual(queue.items[0].chips, [
    {
      id: 'persisted-prompt',
      kind: 'prompt',
      text: 'updated instruction',
      sourceKey: 'prompt:docs',
    },
    {
      id: 'persisted-paste',
      kind: 'paste',
      text: 'raw paste',
    },
  ]);
  assert.deepEqual(queue.items[1].chips, [
    {
      id: 'runtime-paste',
      kind: 'paste',
      text: 'runtime paste',
    },
  ]);
  assert.equal(
    queueModule.buildQueuedPromptPayload(queue.items[0]),
    [
      'updated instruction',
      '<pasted_content>\nraw paste\n</pasted_content>',
      '[imagePath: /durable/a.png] compare [imagePath: /durable/b.png]',
    ].join('\n\n'),
  );
  assert.equal(
    queueModule.buildQueuedPromptPayload({ text: '[Image]', imagePaths: [] }),
    '[imageError: queued_image_path_unavailable #unknown]',
  );
  assert.equal(
    queueModule.buildQueuedPromptPayload({
      text: '',
      chips: [{ id: 'literal-image-log', kind: 'paste', text: 'log says [Image #1]' }],
      imagePaths: [{
        id: 1,
        path: '/durable/should-not-be-consumed.png',
        mediaType: 'image/png',
        size: 10,
        availability: 'available',
      }],
    }),
    '<pasted_content>\nlog says [Image #1]\n</pasted_content>',
    'image-looking text inside an opaque chip stays literal',
  );
  assert.equal(
    queueModule.buildQueuedPromptPayload({
      text: '[Image #1]',
      chips: [],
      imagePaths: [{
        id: 1,
        path: '/durable/body-image.png',
        mediaType: 'image/png',
        size: 10,
        availability: 'available',
      }],
    }),
    '[imagePath: /durable/body-image.png]',
    'real textarea image markers still materialize',
  );

  const legacyDisarmed = queueModule.usePromptQueueStore.getState().disarmQueuesForTrigger('tab-1', null);
  assert.deepEqual(legacyDisarmed, ['tab-1']);
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-1').autoRun, false);
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-1').items.length, 2);

  const realDateNow = Date.now;
  let fakeNow = 10_000;
  Date.now = () => fakeNow;
  try {
    const store = queueModule.usePromptQueueStore.getState();
    store.addPrompt('tab-arm', 'keep me');
    store.setAutoRun('tab-arm', true);
    assert.equal(store.getQueue('tab-arm').workflowArmedAt, 10_000);
    assert.equal(queueModule.hasRuntimeWorkflowArm('tab-arm'), true);

    fakeNow = 20_000;
    store.setStopAfter('tab-arm', true);
    assert.equal(
      store.getQueue('tab-arm').workflowArmedAt,
      10_000,
      'adding Stop-after to active Run-after must not bless the older workflow',
    );

    store.setRunAfterTab('tab-arm', 'tab-target');
    assert.equal(store.getQueue('tab-arm').workflowArmedAt, 20_000);
    fakeNow = 30_000;
    store.setRunAfterTab('tab-arm', null);
    assert.equal(store.getQueue('tab-arm').workflowArmedAt, 30_000);

    assert.deepEqual(store.disarmQueuesForTrigger('tab-arm', null), []);
    assert.deepEqual(store.disarmQueuesForTrigger('tab-arm', 29_999), []);
    assert.equal(store.getQueue('tab-arm').autoRun, true);
    assert.deepEqual(store.disarmQueuesForTrigger('tab-arm', 30_000), ['tab-arm']);
    assert.equal(store.getQueue('tab-arm').autoRun, false);
    assert.equal(store.getQueue('tab-arm').workflowArmedAt, null);
    assert.equal(store.getQueue('tab-arm').items.length, 1, 'abnormal outcome preserves queued work');

    fakeNow = 40_000;
    const enableId = store.addPrompt('tab-enable-edge', 'disabled then enabled');
    store.updatePrompt('tab-enable-edge', enableId, { enabled: false });
    store.setAutoRun('tab-enable-edge', true);
    assert.equal(store.getQueue('tab-enable-edge').workflowArmedAt, 40_000);
    fakeNow = 50_000;
    store.updatePrompt('tab-enable-edge', enableId, { enabled: true });
    assert.equal(store.getQueue('tab-enable-edge').workflowArmedAt, 50_000);

    fakeNow = 60_000;
    store.setAutoRun('tab-add-edge', true);
    assert.equal(store.getQueue('tab-add-edge').workflowArmedAt, 60_000);
    fakeNow = 70_000;
    store.addPrompt('tab-add-edge', 'arrived while armed');
    assert.equal(store.getQueue('tab-add-edge').workflowArmedAt, 70_000);

    fakeNow = 80_000;
    store.setLoopPromptText('tab-loop-runtime', 'are you really finished?');
    store.setLoopPromptEnabled('tab-loop-runtime', true);
    assert.equal(store.getQueue('tab-loop-runtime').loopPromptArmedAt, 80_000);
    fakeNow = 81_000;
    store.setLoopPromptText('tab-loop-runtime', 'finish the remaining work');
    assert.equal(store.getQueue('tab-loop-runtime').loopPromptArmedAt, 81_000);

    fakeNow = 90_000;
    store.addPrompt('tab-pivot-owner', 'run after target');
    store.setAutoRun('tab-pivot-owner', true);
    store.setRunAfterTab('tab-pivot-owner', 'tab-pivot-target');
    assert.deepEqual(
      store.disarmQueuesForTrigger('tab-pivot-target', 90_000, { preservePivoted: true }),
      [],
      'recoverable target interrupt preserves a foreign Run After subscriber',
    );
    assert.equal(store.getQueue('tab-pivot-owner').autoRun, true);
    assert.equal(store.getQueue('tab-pivot-owner').runAfterTabId, 'tab-pivot-target');
    assert.deepEqual(store.disarmQueuesForTrigger('tab-pivot-target', 90_000), ['tab-pivot-owner']);
    assert.equal(store.getQueue('tab-pivot-owner').autoRun, false);
  } finally {
    Date.now = realDateNow;
  }

  queueModule.flushPromptQueueStoreSync();
  assert.equal(syncWrites.length, 1);
  assert.equal(syncWrites[0].channel, 'app:setStateSync');
  const saved = JSON.parse(syncWrites[0].payload.value);
  assert.deepEqual(
    saved['tab-1'].items[0].imagePaths.map((ref) => ref.assetId),
    [firstAssetId, secondAssetId],
  );
  assert.deepEqual(
    saved['tab-1'].items[0].chips.map((chip) => [chip.id, chip.kind, chip.text]),
    [
      ['persisted-prompt', 'prompt', 'updated instruction'],
      ['persisted-paste', 'paste', 'raw paste'],
    ],
  );
  assert.deepEqual(
    saved['tab-1'].items[1].chips.map((chip) => [chip.id, chip.kind, chip.text]),
    [['runtime-paste', 'paste', 'runtime paste']],
  );
  assert.equal(saved['tab-persisted-arm'].workflowArmedAt, 777);
  assert.equal(saved['tab-merge-arm'].workflowArmedAt, 5_000);
  assert.equal(saved['tab-enable-edge'].workflowArmedAt, 50_000);
  assert.equal(saved['tab-add-edge'].workflowArmedAt, 70_000);
  assert.equal(saved['tab-loop'].loopPromptArmedAt, 444);
  assert.equal(saved['tab-loop-runtime'].loopPromptText, 'finish the remaining work');
  assert.equal(saved['tab-loop-runtime'].loopPromptArmedAt, 81_000);
  queueModule.usePromptQueueStore.getState().cleanupClosedTab('tab-add-edge');
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-add-edge'), false);
  queueModule.usePromptQueueStore.getState().clearQueue('tab-enable-edge');
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-enable-edge'), false);

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

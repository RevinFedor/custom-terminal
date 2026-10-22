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
    on() {}, removeListener() {},
    invoke: async (channel, payload) => {
      if (channel === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: 'continue until done' }] };
      if (channel === 'ai-prompts:save-content') return { success: true };
      if (channel === 'app:getState') return rawState.promise;
      if (channel === 'prompt-queue:materialize-image-refs') {
        const refs = payload.refs.map((ref) => String(ref.path || '').includes('/missing/')
          ? { ...ref, availability: 'missing', error: 'image_path_missing' }
          : { ...ref, availability: 'available' });
        return {
          success: refs.every((ref) => ref.availability === 'available'),
          refs,
          available: refs.filter((ref) => ref.availability === 'available').length,
          missing: refs.filter((ref) => ref.availability === 'missing').length,
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
  assert.equal(queueModule.makeDefaultPromptTitle('/compact'), '/compact');
  assert.equal(queueModule.makeDefaultPromptTitle('  /compact\tcustom instructions  '), '/compact custom instructions');
  assert.equal(queueModule.makeDefaultPromptTitle('/Users/example/file'), '[19 символов]');
  assert.equal(queueModule.getQueuedPromptLocalCommand('/compact\nexplain'), null);
  assert.equal(queueModule.getQueuedPromptLocalCommand('/compact', 1), null);
  assert.equal(queueModule.getQueuedPromptLocalCommand('/compact', 0, 1), null);
  assert.equal(
    queueModule.parsePersistedSharedLoopPrompt(JSON.stringify('shared persisted prompt')),
    'shared persisted prompt',
  );
  assert.equal(
    queueModule.parsePersistedSharedLoopPrompt('legacy direct prompt'),
    'legacy direct prompt',
  );
  assert.equal(queueModule.parsePersistedSharedLoopPrompt({}), null);
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
      items: [{ id: 'persisted-stale-item', text: 'wait on missing tab', trigger: { kind: 'timer', seconds: 0 }, createdAt: 4 }],
      autoRun: true,
      runAfterTabId: 'closed-target',
      workflowArmedAt: 888,
    },
    'tab-migrated-trigger': {
      items: [{ id: 'persisted-migrated-item', text: 'migrate global target', createdAt: 5 }],
      autoRun: true,
      runAfterTabId: 'legacy-target',
      firstDelaySeconds: 25,
      workflowArmedAt: 999,
    },
    'tab-long-delay': {
      items: [],
      autoRun: false,
      firstDelaySeconds: 90061,
    },
    'tab-running-deadline': {
      items: [{ id: 'timer-item', text: 'run once', trigger: { kind: 'timer', seconds: 7200 }, createdAt: 10 }],
      autoRun: true,
      workflowArmedAt: 1000,
      firstDelayCountdownAt: 1000,
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
    'tab-command-title': {
      items: [
        { id: 'old-command-title', text: '/compact', title: '[8 символов]', titleManual: false, condition: { kind: 'context-used', operator: 'gte', percent: 50 }, createdAt: 6 },
        { id: 'manual-command-title', text: '/compact', title: 'Мой компакт', titleManual: true, createdAt: 7 },
        { id: 'ordinary-length-title', text: 'hello', title: '[5 символов]', titleManual: false, createdAt: 8 },
      ],
      autoRun: false,
    },
  });
  await hydration;
  unsubscribeHydration();
  assert.equal(queueModule.isPromptQueueStoreHydrated(), true);
  assert.equal(hydrationNotifications, 1);
  const restoredDeadline = queueModule.usePromptQueueStore.getState().getQueue('tab-running-deadline');
  assert.equal(restoredDeadline.firstDelayCountdownAt, 1000, 'restart preserves the original deadline origin');
  assert.equal(restoredDeadline.items[0].trigger.seconds, 7200);

  const queue = queueModule.usePromptQueueStore.getState().getQueue('tab-1');
  assert.deepEqual(queue.items.map((item) => item.id), ['persisted-item', newId]);
  assert.equal(queue.autoRun, true);
  assert.equal(queue.firstChipHintActive, false);
  assert.equal(queue.workflowArmedAt, null, 'legacy persisted workflow remains fail-closed');
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-1'), false);
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-persisted-arm').workflowArmedAt, 777);
  assert.equal(queueModule.hasRuntimeWorkflowArm('tab-persisted-arm'), false);
  const migratedTriggerQueue = queueModule.usePromptQueueStore.getState().getQueue('tab-migrated-trigger');
  assert.deepEqual(migratedTriggerQueue.items[0].trigger, { kind: 'onTab', tabId: 'legacy-target' });
  assert.equal(migratedTriggerQueue.runAfterTabId, null);
  assert.equal(migratedTriggerQueue.firstDelaySeconds, 0);
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
  const restoredTitles = queueModule.usePromptQueueStore.getState().getQueue('tab-command-title').items;
  assert.deepEqual(restoredTitles.map((item) => item.title), ['/compact', 'Мой компакт', '[5 символов]']);
  assert.equal(restoredTitles[0].titleManual, false);
  assert.deepEqual(restoredTitles[0].condition, { kind: 'context-used', operator: 'gte', percent: 50 });
  const newCommandId = queueModule.usePromptQueueStore.getState().addPrompt('tab-new-command', '/compact', 0);
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-new-command').items[0].title, '/compact');
  queueModule.usePromptQueueStore.getState().updatePromptText('tab-new-command', newCommandId, '/status');
  assert.equal(queueModule.usePromptQueueStore.getState().getQueue('tab-new-command').items[0].title, '/status');
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
      // Сохранённый промпт уезжает в своей метке — ровно как вставка ниже, и по
      // той же причине: чип в истории должен читаться из самого текста.
      '<saved_prompt name="PROMPT">\nupdated instruction\n</saved_prompt>',
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
    const queuedBeforeAbnormal = store.getQueue('tab-arm').items;
    assert.deepEqual(store.disarmQueuesForTrigger('tab-arm', 29_999), []);
    assert.equal(store.getQueue('tab-arm').autoRun, true);
    assert.deepEqual(store.disarmQueuesForTrigger('tab-arm', 30_000), ['tab-arm']);
    assert.equal(store.getQueue('tab-arm').autoRun, false);
    assert.equal(store.getQueue('tab-arm').workflowArmedAt, null);
    assert.deepEqual(store.getQueue('tab-arm').items, queuedBeforeAbnormal, 'abnormal outcome preserves prompts and queued Stop action');

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

    fakeNow = 100_000;
    store.setLoopPromptEnabled('tab-interrupted-loop', true);
    store.addPrompt('tab-interrupted-loop', 'one-shot work');
    store.setAutoRun('tab-interrupted-loop', true);
    assert.deepEqual(
      store.disarmQueuesForTrigger('tab-interrupted-loop', 100_000, {
        preservePivoted: true,
        preserveLoop: true,
      }),
      ['tab-interrupted-loop'],
      'recoverable interrupt still disarms the one-shot workflow',
    );
    assert.equal(store.getQueue('tab-interrupted-loop').autoRun, false);
    assert.equal(
      store.getQueue('tab-interrupted-loop').loopPromptEnabled,
      true,
      'recoverable interrupt keeps Loop armed for the next natural completion',
    );
  } finally {
    Date.now = realDateNow;
  }

  queueModule.flushPromptQueueStoreSync();
  assert.equal(syncWrites.length, 2);
  assert.deepEqual(syncWrites.map((write) => write.channel), ['app:setStateSync', 'ai-prompts:save-content-sync']);
  const queueWrite = syncWrites.find((write) => write.payload.key === 'promptQueueByTab');
  const sharedLoopWrite = syncWrites.find((write) => write.payload.id === 'run-after-loop');
  assert.ok(queueWrite);
  assert.ok(sharedLoopWrite);
  const saved = JSON.parse(queueWrite.payload.value);
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
  assert.equal(saved['tab-running-deadline'].firstDelayCountdownAt, 1000, 'shutdown flush does not reset the countdown');
  assert.deepEqual(saved['tab-migrated-trigger'].items[0].trigger, { kind: 'onTab', tabId: 'legacy-target' });
  assert.equal(saved['tab-migrated-trigger'].runAfterTabId, null);
  assert.equal(saved['tab-migrated-trigger'].firstDelaySeconds, 0);
  assert.equal(saved['tab-merge-arm'].workflowArmedAt, 5_000);
  assert.equal(saved['tab-enable-edge'].workflowArmedAt, 50_000);
  assert.equal(saved['tab-add-edge'].workflowArmedAt, 70_000);
  assert.equal(saved['tab-loop'].loopPromptArmedAt, 81_000);
  assert.equal(saved['tab-loop-runtime'].loopPromptText, undefined);
  assert.equal(saved['tab-loop-runtime'].loopPromptArmedAt, 81_000);
  assert.equal(sharedLoopWrite.payload.content, 'finish the remaining work');
  assert.equal(
    queueModule.usePromptQueueStore.getState().getQueue('tab-loop').loopPromptText,
    'finish the remaining work',
    'editing Loop in one tab changes the shared body for every tab',
  );
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
    {
      text: 'before [Image #2] after',
      imagePaths: [{
        id: 2,
        assetId: secondAssetId,
        path: '/missing/b.png',
        mediaType: 'image/png',
        size: 20,
        availability: 'missing',
        error: 'image_path_missing',
      }],
    },
  );
  const unavailable = await queueModule.ensureQueuedPromptImagesReady('tab-1', 'persisted-item');
  assert.equal(unavailable.ready, true, 'known missing bytes remain transferable as explicit error text');
  assert.equal(unavailable.degraded, true);
  assert.equal(unavailable.state, 'missing');
  const unavailablePayload = queueModule.buildQueuedPromptPayload(unavailable.item);
  assert.match(unavailablePayload, /updated instruction/);
  assert.match(unavailablePayload, /<pasted_content>\s*raw paste\s*<\/pasted_content>/);
  assert.match(unavailablePayload, /before \[imageError: queued_image_path_unavailable #2\] after$/);

  queueModule.usePromptQueueStore.getState().updatePrompt(
    'tab-1',
    'persisted-item',
    {
      text: 'compare [Image #2]',
      imagePaths: [{
        id: 2,
        assetId: secondAssetId,
        path: '/durable/b.png',
        mediaType: 'image/png',
        size: 20,
        availability: 'available',
      }],
    },
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

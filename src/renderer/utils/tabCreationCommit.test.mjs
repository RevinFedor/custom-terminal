import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectTabSaveQueue } from './projectTabSaveQueue.mjs';
import { commitCreatedTabSnapshot } from './tabCreationCommit.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('parallel creations build from the latest published Map inside one project lane', async () => {
  const queue = createProjectTabSaveQueue();
  const firstPersist = deferred();
  let committed = new Map([['base', { id: 'base' }]]);

  const create = (tabId, wait = null) => commitCreatedTabSnapshot({
    queue,
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => committed,
    buildCandidateTabs: (currentTabs) => new Map([...currentTabs, [tabId, { id: tabId }]]),
    persist: async () => {
      if (wait) await wait;
      return { success: true };
    },
    publish: (candidateTabs) => { committed = candidateTabs; },
  });

  const first = create('a', firstPersist.promise);
  const second = create('b');
  await Promise.resolve();
  firstPersist.resolve();
  await Promise.all([first, second]);

  assert.deepEqual([...committed.keys()], ['base', 'a', 'b']);
});

test('negative persistence ACK never publishes its candidate Map', async () => {
  const queue = createProjectTabSaveQueue();
  let committed = new Map([['base', { id: 'base' }]]);
  let publishCount = 0;

  const result = await commitCreatedTabSnapshot({
    queue,
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => committed,
    buildCandidateTabs: (currentTabs) => new Map([...currentTabs, ['rejected', { id: 'rejected' }]]),
    persist: async () => ({ success: false, error: 'disk-full' }),
    publish: (candidateTabs) => {
      publishCount += 1;
      committed = candidateTabs;
    },
  });

  assert.equal(result.success, false);
  assert.equal(publishCount, 0);
  assert.deepEqual([...committed.keys()], ['base']);
});

test('a concurrent tab mutation rebuilds and re-persists before publication', async () => {
  const queue = createProjectTabSaveQueue();
  const firstPersist = deferred();
  const firstPersistStarted = deferred();
  let committed = new Map([['base', { id: 'base' }]]);
  let persistCount = 0;

  const creating = commitCreatedTabSnapshot({
    queue,
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => committed,
    buildCandidateTabs: (currentTabs) => new Map([...currentTabs, ['created', { id: 'created' }]]),
    persist: async () => {
      persistCount += 1;
      if (persistCount === 1) {
        firstPersistStarted.resolve();
        await firstPersist.promise;
      }
      return { success: true };
    },
    publish: (candidateTabs) => { committed = candidateTabs; },
  });

  await firstPersistStarted.promise;
  committed = new Map([['concurrent', { id: 'concurrent' }]]);
  firstPersist.resolve();
  await creating;

  assert.equal(persistCount, 2);
  assert.deepEqual([...committed.keys()], ['concurrent', 'created']);
});

test('continuous mutation terminates with an explicit failure instead of hanging', async () => {
  const queue = createProjectTabSaveQueue();
  let committed = new Map([['base-0', { id: 'base-0' }]]);
  let persistCount = 0;
  let publishCount = 0;

  const result = await commitCreatedTabSnapshot({
    queue,
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => committed,
    buildCandidateTabs: (currentTabs) => new Map([...currentTabs, ['created', { id: 'created' }]]),
    persist: async () => {
      persistCount += 1;
      committed = new Map([[`base-${persistCount}`, { id: `base-${persistCount}` }]]);
      return { success: true };
    },
    publish: () => { publishCount += 1; },
  });

  assert.deepEqual(result, { success: false, error: 'tab_creation_concurrent_mutation' });
  assert.equal(persistCount, 4);
  assert.equal(publishCount, 0);
});

test('a newer full snapshot revision retries even when the Map identity is unchanged', async () => {
  const queue = createProjectTabSaveQueue();
  const firstPersist = deferred();
  const firstPersistStarted = deferred();
  let committed = new Map([['base', { id: 'base', name: 'before' }]]);
  let revision = 0;
  let persistCount = 0;

  const creating = commitCreatedTabSnapshot({
    queue,
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => committed,
    getPersistenceRevision: () => revision,
    buildCandidateTabs: (currentTabs) => new Map([...currentTabs, ['created', { id: 'created' }]]),
    persist: async () => {
      persistCount += 1;
      const ownRevision = ++revision;
      if (persistCount === 1) {
        firstPersistStarted.resolve();
        await firstPersist.promise;
      }
      return { success: true, persistenceRevision: ownRevision };
    },
    publish: (candidateTabs) => { committed = candidateTabs; },
  });

  await firstPersistStarted.promise;
  committed.get('base').name = 'renamed-in-place';
  revision += 1;
  firstPersist.resolve();
  await creating;

  assert.equal(persistCount, 2);
  assert.equal(committed.get('base').name, 'renamed-in-place');
  assert.equal(committed.has('created'), true);
});

test('a withdrawn creation never writes or publishes its candidate', async () => {
  let persistCount = 0;
  let publishCount = 0;
  const result = await commitCreatedTabSnapshot({
    queue: createProjectTabSaveQueue(),
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => new Map(),
    buildCandidateTabs: () => new Map([['created', { id: 'created' }]]),
    canPublish: () => false,
    persist: async () => { persistCount += 1; return { success: true }; },
    publish: () => { publishCount += 1; },
  });
  assert.equal(result.cancelled, true);
  assert.equal(persistCount, 0);
  assert.equal(publishCount, 0);
});

test('withdrawal during persistence returns cancellation without exposing the candidate', async () => {
  const started = deferred();
  const finish = deferred();
  let requested = true;
  let publishCount = 0;
  const creating = commitCreatedTabSnapshot({
    queue: createProjectTabSaveQueue(),
    projectId: 'project',
    isWorkspaceCurrent: () => true,
    getCurrentTabs: () => new Map(),
    buildCandidateTabs: () => new Map([['created', { id: 'created' }]]),
    canPublish: () => requested,
    persist: async () => {
      started.resolve();
      await finish.promise;
      return { success: true };
    },
    publish: () => { publishCount += 1; },
  });
  await started.promise;
  requested = false;
  finish.resolve();
  const result = await creating;
  assert.equal(result.cancelled, true);
  assert.equal(publishCount, 0);
});

test('closing the project during persistence prevents publication into its stale workspace', async () => {
  const started = deferred();
  const finish = deferred();
  let projectCurrent = true;
  let publishCount = 0;
  const creating = commitCreatedTabSnapshot({
    queue: createProjectTabSaveQueue(),
    projectId: 'project',
    isWorkspaceCurrent: () => projectCurrent,
    getCurrentTabs: () => new Map(),
    buildCandidateTabs: () => new Map([['created', { id: 'created' }]]),
    canPublish: () => true,
    persist: async () => {
      started.resolve();
      await finish.promise;
      return { success: true };
    },
    publish: () => { publishCount += 1; },
  });
  await started.promise;
  projectCurrent = false;
  finish.resolve();
  const result = await creating;
  assert.equal(result.success, false);
  assert.equal(result.error, 'project_closed_during_tab_creation');
  assert.equal(publishCount, 0);
});

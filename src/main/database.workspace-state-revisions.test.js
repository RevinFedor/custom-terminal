const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKSPACE_SESSION_KEY = 'workspace-session';
let activeTempRoot = null;
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: () => activeTempRoot,
    },
  },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];

function openManagerOrSkip(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-workspace-revisions-db-'));
  activeTempRoot = tempRoot;
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
  t.after(() => {
    manager.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return manager;
}

function fullWorkspaceSnapshot() {
  return {
    openProjects: [{ id: 'project-a', activeTabId: 'tab-right' }],
    activeProjectId: 'project-a',
    viewMode: 'workspace',
    tabVisitOrder: ['tab-left', 'tab-right'],
    projectOrder: ['project-a'],
    sidebarProjectId: 'project-a',
    windowLayout: {
      panes: [
        { id: 'left', tabId: 'tab-left' },
        { id: 'right', tabId: 'tab-right' },
      ],
    },
    focusedPaneId: 'right',
    spaces: [
      { id: 'space-main', layout: { panes: ['left', 'right'] } },
      { id: 'space-sc', layout: { panes: ['sc-left', 'sc-right'] } },
      { id: 'space-uav', layout: { panes: ['uav-left', 'uav-right'] } },
    ],
    activeSpaceId: 'space-main',
  };
}

function shortWorkspaceSnapshot() {
  return {
    openProjects: [{ id: 'project-a', activeTabId: 'tab-right' }],
    activeProjectId: 'project-a',
    viewMode: 'workspace',
    spaces: [
      { id: 'space-main', layout: {} },
      { id: 'space-sc', layout: {} },
      { id: 'space-uav', layout: {} },
    ],
    activeSpaceId: 'space-main',
  };
}

test('a short workspace snapshot keeps the full predecessor as a raw revision', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  const full = fullWorkspaceSnapshot();
  const short = shortWorkspaceSnapshot();

  manager.setAppState(WORKSPACE_SESSION_KEY, full);
  manager.setAppState(WORKSPACE_SESSION_KEY, short, {
    reason: 'quit-snapshot',
    source: 'beforeunload',
  });

  assert.deepEqual(manager.getAppState(WORKSPACE_SESSION_KEY), short);
  const revisions = manager.listAppStateRevisions(WORKSPACE_SESSION_KEY);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].value, JSON.stringify(full));
  assert.equal(revisions[0].reason, 'quit-snapshot');
  assert.equal(revisions[0].source, 'beforeunload');
  assert.ok(Number.isInteger(revisions[0].createdAt) && revisions[0].createdAt > 0);
  assert.deepEqual(manager.getAppStateRevision(WORKSPACE_SESSION_KEY, revisions[0].id), revisions[0]);
  assert.deepEqual(
    manager.getAppStateRevision(WORKSPACE_SESSION_KEY, revisions[0].id),
    revisions[0],
  );
  assert.equal(manager.getAppStateRevision(WORKSPACE_SESSION_KEY, -1), null);
  assert.equal(manager.getAppStateRevision('unrelated-app-state', revisions[0].id), null);
  assert.ok(manager.db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_app_state_revisions_key_id'
  `).get());
});

test('unchanged set and compare-and-set writes create no revision', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  const full = fullWorkspaceSnapshot();
  const short = shortWorkspaceSnapshot();

  manager.setAppState(WORKSPACE_SESSION_KEY, full);
  manager.setAppState(WORKSPACE_SESSION_KEY, full, { reason: 'duplicate-set' });
  assert.equal(
    manager.compareAndSetAppState(
      WORKSPACE_SESSION_KEY,
      full,
      full,
      { reason: 'duplicate-cas' },
    ),
    true,
  );
  assert.deepEqual(manager.listAppStateRevisions(WORKSPACE_SESSION_KEY), []);

  assert.equal(
    manager.compareAndSetAppState(
      WORKSPACE_SESSION_KEY,
      full,
      short,
      { reason: 'cas-update', source: 'test' },
    ),
    true,
  );
  assert.equal(manager.listAppStateRevisions(WORKSPACE_SESSION_KEY).length, 1);

  manager.setAppState('unrelated-app-state', 'first');
  manager.setAppState('unrelated-app-state', 'second');
  assert.deepEqual(manager.listAppStateRevisions('unrelated-app-state'), []);
  assert.equal(
    manager.db.prepare('SELECT COUNT(*) AS count FROM app_state_revisions WHERE key != ?')
      .get(WORKSPACE_SESSION_KEY).count,
    0,
  );
});

test('workflow ids cannot disappear without an explicit removal write', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  const full = fullWorkspaceSnapshot();
  const partialRestore = {
    ...shortWorkspaceSnapshot(),
    spaces: [{ id: 'space-main', layout: {} }],
  };

  manager.setAppState(WORKSPACE_SESSION_KEY, full);
  const rejected = manager.setAppState(WORKSPACE_SESSION_KEY, partialRestore, {
    reason: 'shutdown-mid-restore',
    source: 'beforeunload',
  });
  assert.deepEqual(rejected, {
    success: false,
    error: 'workspace_space_removal_requires_explicit_intent',
    missingSpaceIds: ['space-sc', 'space-uav'],
  });
  assert.deepEqual(manager.getAppState(WORKSPACE_SESSION_KEY), full);
  assert.deepEqual(manager.listAppStateRevisions(WORKSPACE_SESSION_KEY), []);

  const allowed = manager.setAppState(WORKSPACE_SESSION_KEY, partialRestore, {
    reason: 'workspace-space-remove',
    source: 'renderer',
    allowWorkspaceSpaceRemoval: true,
  });
  assert.deepEqual(allowed, { success: true, changed: true });
  assert.deepEqual(manager.getAppState(WORKSPACE_SESSION_KEY), partialRestore);
  assert.equal(manager.listAppStateRevisions(WORKSPACE_SESSION_KEY).length, 1);
});

test('restoring a revision returns it exactly and archives the displaced current value', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  const full = fullWorkspaceSnapshot();
  const short = shortWorkspaceSnapshot();

  manager.setAppState(WORKSPACE_SESSION_KEY, full);
  manager.setAppState(WORKSPACE_SESSION_KEY, short);
  const fullRevision = manager.listAppStateRevisions(WORKSPACE_SESSION_KEY)[0];

  const restored = manager.restoreAppStateRevision(
    WORKSPACE_SESSION_KEY,
    fullRevision.id,
    short,
    {
      reason: 'manual-restore',
      source: 'workspace-recovery',
    },
  );

  assert.equal(restored.success, true);
  assert.equal(restored.changed, true);
  assert.equal(restored.value, JSON.stringify(full));
  assert.equal(restored.restoredValue, JSON.stringify(full));
  assert.equal(restored.archivedValue, JSON.stringify(short));
  assert.deepEqual(manager.getAppState(WORKSPACE_SESSION_KEY), full);

  const revisions = manager.listAppStateRevisions(WORKSPACE_SESSION_KEY);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].value, JSON.stringify(short));
  assert.equal(revisions[0].reason, 'manual-restore');
  assert.equal(revisions[0].source, 'workspace-recovery');
  assert.equal(revisions[1].id, fullRevision.id);
  assert.equal(revisions[1].value, JSON.stringify(full));
});

test('restore rejects a stale expected-current proof without adding a revision', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;
  const full = fullWorkspaceSnapshot();
  const short = shortWorkspaceSnapshot();
  const concurrent = { ...short, activeProjectId: 'project-b' };

  manager.setAppState(WORKSPACE_SESSION_KEY, full);
  manager.setAppState(WORKSPACE_SESSION_KEY, short);
  const fullRevision = manager.listAppStateRevisions(WORKSPACE_SESSION_KEY)[0];
  manager.setAppState(WORKSPACE_SESSION_KEY, concurrent, { source: 'concurrent-writer' });
  const beforeRejectedRestore = manager.listAppStateRevisions(WORKSPACE_SESSION_KEY);

  const restored = manager.restoreAppStateRevision(
    WORKSPACE_SESSION_KEY,
    fullRevision.id,
    short,
    { reason: 'stale-restore-attempt' },
  );

  assert.equal(restored.success, false);
  assert.equal(restored.error, 'app_state_current_mismatch');
  assert.equal(restored.currentValue, JSON.stringify(concurrent));
  assert.deepEqual(manager.getAppState(WORKSPACE_SESSION_KEY), concurrent);
  assert.deepEqual(
    manager.listAppStateRevisions(WORKSPACE_SESSION_KEY),
    beforeRejectedRestore,
    'a rejected restore must not archive or mutate anything',
  );
});

test('workspace revision history retains only the latest 100 entries', (t) => {
  const manager = openManagerOrSkip(t);
  if (!manager) return;

  manager.setAppState(WORKSPACE_SESSION_KEY, { version: 0 });
  for (let version = 1; version <= 105; version += 1) {
    manager.setAppState(WORKSPACE_SESSION_KEY, { version });
  }

  const revisions = manager.listAppStateRevisions(WORKSPACE_SESSION_KEY, 1000);
  assert.equal(revisions.length, 100);
  assert.deepEqual(JSON.parse(revisions[0].value), { version: 104 });
  assert.deepEqual(JSON.parse(revisions[99].value), { version: 5 });
  assert.deepEqual(
    manager.listAppStateRevisions(WORKSPACE_SESSION_KEY, 3)
      .map((revision) => JSON.parse(revision.value).version),
    [104, 103, 102],
  );
});

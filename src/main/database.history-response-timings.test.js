const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-response-timings-db-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: () => tempRoot,
    },
  },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];

test('response timing sidecar moves from tab-owned pending state to an exact history entry', (t) => {
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }
  t.after(() => {
    manager.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const interval = manager.saveActivityInterval({
    tabId: 'tab-1',
    engine: 'codex',
    sessionId: 'session-1',
    startTs: 1_000,
    endTs: 8_500,
  });
  assert.ok(interval?.id);
  assert.equal(interval.durationMs, 7_500);
  assert.equal(manager.savePendingHistoryResponseTiming({
    intervalId: interval.id,
    toolType: 'codex',
    tabId: 'tab-1',
    sessionId: 'session-1',
  }), true);

  const pending = manager.getLatestPendingHistoryResponseTimingForTab('tab-1', 'codex');
  assert.equal(pending.intervalId, interval.id);
  assert.equal(pending.entryUuid, null);
  assert.equal(pending.durationMs, 7_500);
  const pendingRevision = manager.getHistoryResponseTimingRevision('codex', 'session-1', 'tab-1');
  assert.notEqual(
    manager.getHistoryResponseTimingRevision('codex', 'linked-child', 'tab-1'),
    'none',
    'tab-owned pending timing must invalidate a linked child revision',
  );

  assert.equal(manager.bindHistoryResponseTimingEntry({
    intervalId: interval.id,
    toolType: 'codex',
    sessionId: 'session-1',
    entryUuid: 'assistant-final',
    sourceIdentity: 'rollout:42',
  }), true);
  assert.equal(manager.getLatestPendingHistoryResponseTimingForTab('tab-1', 'codex'), null);

  const exact = manager.getHistoryResponseTimingsForEntries('codex', ['assistant-final']);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].durationMs, 7_500);
  assert.equal(exact[0].sourceIdentity, 'rollout:42');
  assert.notEqual(
    manager.getHistoryResponseTimingRevision('codex', 'session-1', 'tab-1'),
    pendingRevision,
  );
  assert.equal(manager.getHistoryResponseTimingRevision('codex', 'another-session'), 'none');

  assert.deepEqual(manager.cloneHistoryResponseTimingsForSession({
    toolType: 'codex',
    sourceSessionId: 'session-1',
    childSessionId: 'session-child',
    entryMappings: [{
      sourceEntryUuid: 'assistant-final',
      childEntryUuid: 'assistant-child',
      childSourceIdentity: 'child-rollout:42',
    }],
  }), { cloned: 1, unchanged: 0, skipped: 0, pendingReassigned: 0 });
  assert.deepEqual(manager.cloneHistoryResponseTimingsForSession({
    toolType: 'codex',
    sourceSessionId: 'session-1',
    childSessionId: 'session-child',
    entryMappings: [{
      sourceEntryUuid: 'assistant-final',
      childEntryUuid: 'assistant-child',
      childSourceIdentity: 'child-rollout:42',
    }],
  }), { cloned: 0, unchanged: 1, skipped: 0, pendingReassigned: 0 });

  const child = manager.getHistoryResponseTimingsForEntries('codex', ['assistant-child']);
  assert.equal(child.length, 1);
  assert.equal(child[0].sessionId, 'session-child');
  assert.equal(child[0].durationMs, 7_500);
  assert.equal(child[0].sourceIdentity, 'child-rollout:42');
  assert.notEqual(
    manager.getHistoryResponseTimingRevision('codex', 'session-child'),
    'none',
  );

  const handoffInterval = manager.saveActivityInterval({
    tabId: 'tab-1',
    engine: 'codex',
    sessionId: 'session-child',
    startTs: 10_000,
    endTs: 12_000,
  });
  manager.savePendingHistoryResponseTiming({
    intervalId: handoffInterval.id,
    toolType: 'codex',
    tabId: 'tab-1',
    sessionId: 'session-child',
  });
  assert.deepEqual(manager.cloneHistoryResponseTimingsForSession({
    toolType: 'codex',
    sourceSessionId: 'session-child',
    childSessionId: 'session-grandchild',
    tabId: 'tab-1',
    entryMappings: [],
  }), { cloned: 0, unchanged: 0, skipped: 0, pendingReassigned: 1 });
  assert.equal(
    manager.getPendingHistoryResponseTimings({
      toolType: 'codex',
      tabId: 'tab-1',
      sessionIds: ['session-grandchild'],
    }).find((row) => row.intervalId === handoffInterval.id)?.sessionId,
    'session-grandchild',
  );
});

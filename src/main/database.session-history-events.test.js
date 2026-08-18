const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-session-events-db-'));
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

test('session history events persist lineage and never resurrect a hidden fork stripe', (t) => {
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

  manager.saveForkMarker('source-a', 'child-a', ['a', 'b'], {
    forkMode: 'full',
    sourceTabId: 'source-tab',
    childTabId: 'child-tab',
  });
  assert.equal(manager.getParentSession('child-a').source_session_id, 'source-a');
  assert.equal(manager.getForkMarkers('child-a')[0].fork_mode, 'full');

  manager.hideForkMarker('source-a', 'child-a');
  manager.saveForkMarker('source-a', 'child-a', ['a', 'b', 'late'], {
    forkMode: 'full',
  });
  const hidden = manager.getForkMarkers('child-a')[0];
  assert.equal(hidden.hidden, true);
  assert.deepEqual(hidden.entry_uuids, ['a', 'b']);

  manager.saveSessionForkEvent({
    provider: 'codex',
    sourceSessionId: 'codex-source',
    childSessionId: 'codex-child',
    entryUuids: ['codex-child-row-1'],
    forkMode: 'latest_compact',
    origin: 'app',
  });
  manager.db.prepare(`
    UPDATE session_history_events SET updated_at = 123
    WHERE provider = 'codex' AND session_id = 'codex-child'
  `).run();
  manager.saveSessionForkEvent({
    provider: 'codex',
    sourceSessionId: 'codex-source',
    childSessionId: 'codex-child',
    entryUuids: ['codex-child-row-1'],
    forkMode: 'latest_compact',
    origin: 'app',
  });
  assert.equal(
    manager.db.prepare(`
      SELECT updated_at FROM session_history_events
      WHERE provider = 'codex' AND session_id = 'codex-child'
    `).get().updated_at,
    123,
    'unchanged Timeline reconciliation must not write SQLite',
  );
  assert.equal(manager.getSessionHistoryContext('codex-child').fork.provider, 'codex');
  assert.equal(
    manager.getSessionHistoryContext('codex-source').children[0].childSessionId,
    'codex-child',
  );
  assert.equal(
    manager.db.prepare('SELECT COUNT(*) AS count FROM fork_markers WHERE forked_to_session_id = ?').get('codex-child').count,
    0,
    'provider-less legacy storage must never receive Codex lineage',
  );

  manager.saveCompactHistoryEvents([{
    eventKey: 'compact:codex:codex-child:compact-1',
    eventType: 'compact',
    provider: 'codex',
    sessionId: 'codex-child',
    boundaryEntryUuid: 'compact-1',
    afterIterationIndex: 3,
    nextIterationIndex: 4,
    occurredAt: 1787000000,
    origin: 'transcript',
  }]);
  const compact = manager.getSessionHistoryContext('codex-child').compacts[0];
  assert.equal(compact.afterIterationIndex, 3);
  assert.equal(compact.nextIterationIndex, 4);

  manager.saveTimelineNote('source-codex-uuid', 'codex-source', 'source-tab', 'keep this', 'after');
  manager.saveRewindMarker('source-codex-uuid', 'codex-source');
  assert.deepEqual(
    manager.copyTimelineMetadataForMappedFork('codex-child', [{
      sourceUuid: 'source-codex-uuid',
      childUuid: 'child-codex-uuid',
    }], 'child-tab'),
    { notes: 1, rewindMarkers: 1 },
  );
  assert.equal(manager.getTimelineNotes('codex-child')[0].entry_uuid, 'child-codex-uuid');
  assert.equal(manager.getRewindMarkers('codex-child')[0].entry_uuid, 'child-codex-uuid');

  manager.db.prepare(`
    INSERT INTO fork_markers (
      source_session_id, forked_to_session_id, entry_uuids_json, hidden, created_at
    ) VALUES (?, ?, ?, 1, ?)
  `).run('legacy-source', 'legacy-child', '["legacy-entry"]', 1786000000);
  manager.close();
  manager = new DatabaseManager();
  const migrated = manager.getSessionHistoryContext('legacy-child').fork;
  assert.equal(migrated.sourceSessionId, 'legacy-source');
  assert.equal(migrated.hidden, true);
  assert.deepEqual(migrated.entryUuids, ['legacy-entry']);
});

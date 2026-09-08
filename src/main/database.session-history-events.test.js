const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCodexForkLineageManifest } = require('./session-history-events');

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
  assert.equal(manager.getForkMarkers('child-a')[0].operation_kind, 'fork');

  for (const operationKind of ['fork', 'rewind', 'edit', 'delete', 'provider']) {
    const childSessionId = 'operation-child-' + operationKind;
    manager.saveSessionForkEvent({
      provider: 'codex', sourceSessionId: 'operation-source', childSessionId,
      forkMode: 'direct-virtual', operationKind, entryUuids: ['inherited'],
      origin: operationKind === 'fork' ? 'app' : 'transcript',
    });
    // A later provider scan only knows the physical relation. It cannot
    // downgrade the already-proven reason for creating the branch.
    manager.saveSessionForkEvent({
      provider: 'codex', sourceSessionId: 'operation-source', childSessionId,
      forkMode: 'unknown', operationKind: 'provider', origin: 'transcript', entryUuids: [],
    });
    assert.equal(manager.getSessionHistoryContext(childSessionId).fork.operationKind, operationKind);
    assert.equal(manager.getForkMarkers(childSessionId)[0].operation_kind, operationKind);
  }

  const appOrigin = manager.saveSessionForkEvent({ provider: 'codex',
    sourceSessionId: 'origin-source', childSessionId: 'app-branch',
    operationKind: 'fork', forkMode: 'full', entryUuids: ['keep', 'app-edge'],
    boundaryEntryUuid: 'app-edge', origin: 'app' });
  manager.saveSessionForkEvent({ provider: 'codex', sourceSessionId: 'app-branch',
    childSessionId: 'rewound-branch', operationKind: 'rewind', forkMode: 'rewind',
    entryUuids: ['copy-keep', 'copy-edge'], origin: 'app',
    entryMappings: [{ sourceUuid: 'keep', childUuid: 'copy-keep' },
      { sourceUuid: 'app-edge', childUuid: 'copy-edge' }] });
  const inheritedOrigin = manager.getForkMarkers('rewound-branch').find((marker) => marker.view_session_id === 'rewound-branch');
  assert.ok(inheritedOrigin, 'a technical writer replacement must keep the surviving app Fork origin');
  assert.equal(inheritedOrigin.event_key, appOrigin.eventKey);
  assert.equal(inheritedOrigin.fork_session_id, 'app-branch', 'the actual Fork identity is not rewritten');
  assert.deepEqual(inheritedOrigin.entry_uuids, ['copy-edge']);
  assert.equal(manager.getSessionHistoryEvents('rewound-branch').length, 1,
    'an inherited drawing location is not another physical Fork event');
  assert.equal(manager.getParentSession('rewound-branch').source_session_id, 'app-branch');
  manager.saveSessionForkEvent({ provider: 'codex', sourceSessionId: 'rewound-branch',
    childSessionId: 'thin-descendant', operationKind: 'rewind', forkMode: 'direct-virtual',
    entryUuids: ['copy-keep', 'copy-edge'], origin: 'app' });
  assert.equal(manager.getForkMarkers('thin-descendant').find((marker) => marker.view_session_id)?.event_key, appOrigin.eventKey);
  manager.saveSessionForkEvent({ provider: 'codex', sourceSessionId: 'rewound-branch',
    childSessionId: 'cut-before-origin', operationKind: 'delete', forkMode: 'history_delete',
    entryUuids: ['copy-keep'], origin: 'app' });
  assert.equal(manager.getForkMarkers('cut-before-origin').some((marker) => marker.view_session_id), false);
  manager.hideForkMarker('origin-source', 'app-branch');
  assert.equal(manager.getForkMarkers('rewound-branch').find((marker) => marker.view_session_id)?.hidden, true);
  assert.equal(manager.getForkMarkers('thin-descendant').find((marker) => marker.view_session_id)?.hidden, true);
  const reopened = new DatabaseManager();
  assert.equal(reopened.getForkMarkers('rewound-branch').find((marker) => marker.view_session_id)?.event_key, appOrigin.eventKey);
  reopened.close();

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

  const lineageManifest = buildCodexForkLineageManifest({
    sourceSessionId: 'codex-source',
    childSessionId: 'codex-child',
    sourceSegments: [{
      physicalSessionId: 'codex-source',
      fromByte: 0,
      toByte: 128,
      startLine: 0,
      endLine: 4,
      prefixDigest: 'b'.repeat(64),
    }],
    childTailStart: { byteOffset: 64, line: 2, prefixDigest: 'c'.repeat(64) },
  });
  manager.saveSessionForkEvent({
    provider: 'codex',
    sourceSessionId: 'codex-source',
    childSessionId: 'codex-child',
    entryUuids: ['codex-child-row-1'],
    forkMode: 'direct-virtual',
    lineageManifest,
    origin: 'app',
  });
  const upgradedFork = manager.getSessionHistoryContext('codex-child').fork;
  assert.deepEqual(upgradedFork.lineageManifest, lineageManifest,
    'a V1 row is compatibly upgraded with the exact V2 raw manifest');

  manager.saveSessionForkEvent({
    provider: 'codex',
    sourceSessionId: 'recovery-source',
    childSessionId: 'recovery-child',
    entryUuids: [],
    snapshotComplete: true,
    afterIterationIndex: 32,
    nextIterationIndex: 33,
    forkMode: 'unknown',
    origin: 'transcript',
  });
  const recoveryManifest = buildCodexForkLineageManifest({
    sourceSessionId: 'recovery-source',
    childSessionId: 'recovery-child',
    sourceSegments: [{
      physicalSessionId: 'recovery-source',
      fromByte: 0,
      toByte: 256,
      startLine: 0,
      endLine: 8,
      prefixDigest: 'd'.repeat(64),
    }],
    childTailStart: { byteOffset: 64, line: 2, prefixDigest: 'e'.repeat(64) },
  });
  manager.saveSessionForkEvent({
    provider: 'codex',
    sourceSessionId: 'recovery-source',
    childSessionId: 'recovery-child',
    entryUuids: ['u1', 'u2'],
    boundaryEntryUuid: 'u2',
    snapshotComplete: true,
    afterIterationIndex: 46,
    nextIterationIndex: 47,
    forkMode: 'direct-virtual',
    lineageManifest: recoveryManifest,
    origin: 'app',
  });
  const recoveredFork = manager.getSessionHistoryContext('recovery-child').fork;
  assert.equal(recoveredFork.nextIterationIndex, 47);
  assert.equal(recoveredFork.afterIterationIndex, 46);
  assert.deepEqual(recoveredFork.entryUuids, ['u1', 'u2']);
  assert.equal(recoveredFork.boundaryEntryUuid, 'u2');
  assert.deepEqual(recoveredFork.lineageManifest, recoveryManifest);

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
  assert.equal(manager.getSessionHistoryContext('operation-child-fork').fork.operationKind, 'fork');
  assert.equal(manager.getSessionHistoryContext('operation-child-rewind').fork.operationKind, 'rewind');
  const migrated = manager.getSessionHistoryContext('legacy-child').fork;
  assert.equal(migrated.sourceSessionId, 'legacy-source');
  assert.equal(migrated.hidden, true);
  assert.deepEqual(migrated.entryUuids, ['legacy-entry']);
});

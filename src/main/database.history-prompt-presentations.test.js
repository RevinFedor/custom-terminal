const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  backfillConfirmedSystemPromptPresentations,
  cloneCodexPromptPresentationsForProvenChild,
  decorateHistoryPromptPresentations,
  promptTransportHash,
} = require('./history-prompt-presentations');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-prompt-presentations-db-'));
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

function codexUser(line, timestamp, message) {
  return {
    __line: line,
    type: 'event_msg',
    timestamp,
    payload: { type: 'user_message', message },
  };
}

test('Codex prompt sidecars clone to exact child UUIDs idempotently and conflicts fail closed', (t) => {
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

  const sourceText = 'saved prompt\r\nuser note';
  const childText = 'saved prompt\nuser note';
  manager.saveHistoryPromptPresentation({
    toolType: 'codex',
    sessionId: 'source',
    auditTimestamp: '2026-07-24T01:02:03Z',
    transportHash: promptTransportHash(sourceText),
    schemaVersion: 1,
    chips: [{
      id: 'chip-1',
      kind: 'prompt',
      label: 'Review',
      text: 'saved prompt',
    }],
  });

  const cloneOptions = {
    sourceSessionId: 'source',
    childSessionId: 'child',
    sourceRecords: [codexUser(4, '2026-07-24T01:02:03Z', sourceText)],
    childRecords: [codexUser(11, '2026-07-24T01:02:03.000Z', childText)],
  };
  const first = cloneCodexPromptPresentationsForProvenChild(manager, cloneOptions);
  assert.equal(first.cloned, 1);
  assert.equal(first.skipped, 0);

  const childRows = manager.getHistoryPromptPresentations('codex', 'child');
  assert.equal(childRows.length, 1);
  assert.equal(childRows[0].entryUuid, 'codex-user-child-11');
  assert.equal(childRows[0].auditTimestamp, '2026-07-24T01:02:03.000Z');
  assert.equal(childRows[0].transportHash, promptTransportHash(childText));
  assert.equal(childRows[0].chips[0].label, 'Review');
  assert.equal(cloneOptions.sourceRecords[0].payload.message, sourceText);
  assert.equal(cloneOptions.childRecords[0].payload.message, childText);

  const repeated = cloneCodexPromptPresentationsForProvenChild(manager, cloneOptions);
  assert.equal(repeated.cloned, 0);
  assert.equal(repeated.unchanged, 1);
  assert.equal(manager.getHistoryPromptPresentations('codex', 'child').length, 1);

  manager.saveHistoryPromptPresentation({
    toolType: 'codex',
    sessionId: 'conflicting-child',
    auditTimestamp: '2026-07-24T01:02:03.000Z',
    transportHash: promptTransportHash(childText),
    entryUuid: 'codex-user-conflicting-child-11',
    schemaVersion: 1,
    chips: [{
      id: 'different-chip',
      kind: 'prompt',
      label: 'Different',
      text: 'different prompt metadata',
    }],
  });
  const conflict = cloneCodexPromptPresentationsForProvenChild(manager, {
    ...cloneOptions,
    childSessionId: 'conflicting-child',
    childRecords: [codexUser(11, '2026-07-24T01:02:03.000Z', childText)],
  });
  assert.equal(conflict.cloned, 0);
  assert.equal(conflict.skipped, 1);
  assert.equal(
    manager.getHistoryPromptPresentations('codex', 'conflicting-child')[0].chips[0].label,
    'Different',
  );

  const referencedAssetId = 'b'.repeat(64) + '.png';
  manager.saveHistoryPromptPresentation({
    toolType: 'codex',
    sessionId: 'image-history',
    auditTimestamp: '2026-08-02T12:00:00.000Z',
    transportHash: promptTransportHash('[Image #1]'),
    schemaVersion: 3,
    chips: [
      { kind: 'image-ref', id: 1, assetId: referencedAssetId },
      { kind: 'image-ref', id: 2, path: `/tmp/${referencedAssetId}` },
      { kind: 'image-ref', id: 3, assetId: '../../not-an-asset' },
    ],
  });
  assert.deepEqual(manager.getHistoryPromptPresentationAssetIds(), [referencedAssetId]);

  // Real receipt + sidecar persistence: the old carrier had only byte identity,
  // and the later event_msg owns a different identity with that carrier alias.
  const receiptStore = createAgentSendReceiptStore(manager.db);
  const systemText = 'return after install';
  const systemHash = promptTransportHash(systemText);
  const systemTimestamp = '2026-09-05T12:22:23.562Z';
  const systemIdentity = {
    operationKey: 'project:system-tab:build-install-return:job', surface: 'project-api',
    tabId: 'system-tab', handoffId: 'build-install-return:job', requestFingerprint: 'system-request',
    provider: 'codex', sessionId: 'system-source', promptHash: systemHash, promptLength: systemText.length,
  };
  const attempt = receiptStore.beginAttempt(systemIdentity);
  assert.equal(attempt.ok, true);
  receiptStore.stageAttemptContext(systemIdentity.operationKey, attempt.attemptId, {
    source: 'codex-build-install-return',
  });
  receiptStore.settleAttempt(systemIdentity.operationKey, attempt.attemptId, {
    success: null, submitted: true, status: 'audit-pending', auditPending: true,
  });
  const promoted = receiptStore.promoteFromAudit({
    operationKey: systemIdentity.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', sessionId: 'system-source', success: true,
    expectedHash: systemHash, actualHash: systemHash, auditTimestamp: systemTimestamp,
    sourceIdentity: 'codex-user-source-system-source-100',
  });
  assert.equal(promoted.promoted, true);
  assert.equal(backfillConfirmedSystemPromptPresentations(manager, receiptStore.list({ state: 'confirmed' })), 1);
  manager.close();
  manager = new DatabaseManager();
  const systemEntry = {
    uuid: 'codex-user-system-source-8', type: 'user', content: systemText, timestamp: systemTimestamp,
    sourceIdentity: 'codex-user-source-system-source-200',
    sourceIdentityAliases: ['codex-user-source-system-source-100'],
  };
  const quotedEntry = { ...systemEntry, uuid: 'human-quote', sourceIdentity: 'human-source', sourceIdentityAliases: [] };
  const persisted = decorateHistoryPromptPresentations(manager, {
    toolType: 'codex', sessionId: 'system-source', entries: [quotedEntry, systemEntry],
  });
  assert.equal(persisted[0], quotedEntry);
  assert.equal(persisted[1].semanticTags[0].systemSource, 'build-install-return');
  assert.equal(manager.getHistoryPromptPresentations('codex', 'system-source')[0].entryUuid, systemEntry.uuid);
  const clonedSystem = cloneCodexPromptPresentationsForProvenChild(manager, {
    sourceSessionId: 'system-source', childSessionId: 'system-child',
    sourceRecords: [codexUser(8, systemTimestamp, systemText)],
    childRecords: [codexUser(18, systemTimestamp, systemText)],
  });
  assert.equal(clonedSystem.cloned, 1);
  assert.equal(decorateHistoryPromptPresentations(manager, {
    toolType: 'codex', sessionId: 'system-child', entries: [{
      uuid: 'codex-user-system-child-18', type: 'user', content: systemText, timestamp: systemTimestamp,
    }],
  })[0].semanticTags[0].systemSource, 'build-install-return');
});

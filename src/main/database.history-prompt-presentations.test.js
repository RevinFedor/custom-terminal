const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cloneCodexPromptPresentationsForProvenChild,
  promptTransportHash,
} = require('./history-prompt-presentations');

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
});

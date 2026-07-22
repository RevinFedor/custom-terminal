import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commitArchiveBeforeClose,
  isDurableSaveTabsAck,
} from './tabPersistenceTransactions.mjs';

test('close archive gate accepts only a committed history row', async () => {
  assert.deepEqual(
    await commitArchiveBeforeClose({
      shouldArchive: true,
      archive: async () => ({ success: true, historyId: 41 }),
    }),
    { ok: true, skipped: false, result: { success: true, historyId: 41 } },
  );

  const rejected = await commitArchiveBeforeClose({
    shouldArchive: true,
    archive: async () => ({ success: false, error: 'sqlite_busy' }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'sqlite_busy');

  const missingId = await commitArchiveBeforeClose({
    shouldArchive: true,
    archive: async () => ({ success: true }),
  });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.reason, 'archive_history_id_missing');

  const thrown = await commitArchiveBeforeClose({
    shouldArchive: true,
    archive: async () => { throw new Error('ipc disconnected'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'archive_ipc_failed');
  assert.match(thrown.error.message, /ipc disconnected/);
});

test('explicit no-history close bypasses archive, while save ACK stays strict', async () => {
  let archiveCalls = 0;
  assert.deepEqual(
    await commitArchiveBeforeClose({
      shouldArchive: false,
      archive: async () => {
        archiveCalls += 1;
        return { success: true, historyId: 1 };
      },
    }),
    { ok: true, skipped: true, result: null },
  );
  assert.equal(archiveCalls, 0);

  assert.equal(isDurableSaveTabsAck({ success: true }), true);
  assert.equal(isDurableSaveTabsAck({ success: false }), false);
  assert.equal(isDurableSaveTabsAck(undefined), false);
  assert.equal(isDurableSaveTabsAck({}), false);
});

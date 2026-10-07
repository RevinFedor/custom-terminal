import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveRecordKey, validateArchiveSnapshot, filterArchiveRecords, archiveRestoreTarget,
  archiveActionRequest, archiveActionAcknowledged, archiveReceiptMatches } from './globalTabArchive.mjs';
const legacy = { id: 7, namespace: 'old', tab_id: null, name: 'same', cwd: '/legacy', notes: 'draft', assets: ['asset'] };
test('Pre-opaque ID rows and identical names/IDs in different namespaces retain exact identity', () => {
  assert.notEqual(archiveRecordKey('history', legacy), archiveRecordKey('history', { ...legacy, namespace: 'other' }));
  assert.throws(() => archiveRecordKey('history', { ...legacy, id: '7' }));
  assert.equal(validateArchiveSnapshot({ version: 1, history: [legacy], favorites: [] }).history[0], legacy);
  assert.throws(() => validateArchiveSnapshot({ version: 1, history: [legacy, legacy], favorites: [] }));
});
test('Global search works for detached/deleted workflow records, cwd/notes/session filters', () => {
  const rows = [legacy, { ...legacy, id: 8, cwd: '/new', workflowId: 'a', codex_session_id: 'sid' }];
  assert.deepEqual(filterArchiveRecords(rows, { query: 'legacy draft' }), [legacy]);
  assert.equal(filterArchiveRecords(rows, { query: 'sid', workflowId: 'a', cwd: '/new' })[0].id, 8);
  assert.equal(filterArchiveRecords(rows, { workflowId: 'missing' }).length, 0);
});
test('Restore target uses explicit, saved workflow, then system kind Inbox, not its label', () => {
  const workflows = [{ id: 'a', name: 'Inbox' }, { id: 'inbox', kind: 'inbox', name: 'Renamed' }];
  assert.equal(archiveRestoreTarget({ workflowId: 'a' }, workflows), 'a');
  assert.equal(archiveRestoreTarget({ workflowId: 'gone' }, workflows), 'inbox');
  assert.equal(archiveRestoreTarget(legacy, workflows, 'a'), 'a');
  assert.throws(() => archiveRestoreTarget(legacy, workflows, 'gone'));
});
test('Immutable exact requests preserve provider/assets/notes and revisions without fabrication of tab ID', () => {
  const request = archiveActionRequest('history', legacy, { revision: 13 }, 'intent', 'inbox');
  assert.equal(request.historyId, 7); assert.equal(request.namespace, 'old'); assert.equal(request.expectedRevision, 13);
  assert.ok(!('expectedTabId' in request)); request.record.assets.push('changed'); assert.equal(legacy.assets.length, 1);
  assert.equal(archiveActionRequest('history', { ...legacy, tab_id: 'opaque' }, {}, 'x').expectedTabId, 'opaque');
  assert.equal(archiveActionRequest('favorite', legacy, {}, 'x').favoriteId, 7);
});
test('Promises, missing/negative receipts never acknowledge; restore result can preserve archive after delete failure', () => {
  for (const receipt of [false, undefined, null, Promise.resolve(true), {}, { success: false, tabId: 'x' }])
    assert.equal(archiveActionAcknowledged(receipt, 'restore'), false);
  assert.equal(archiveActionAcknowledged({ tabId: 'x', historyDeleteFailed: true }, 'restore'), true);
  assert.equal(archiveActionAcknowledged({ tabId: 'x' }, 'delete'), false);
  assert.equal(archiveActionAcknowledged({ success: true }, 'delete'), true);
});
test('Optional receipt addresses must match exact namespace, row ID and intent, never another record', () => {
  const request = archiveActionRequest('history', legacy, {}, 'intent');
  assert.equal(archiveReceiptMatches({ success: true, namespace: 'other', id: 7 }, request), false);
  assert.equal(archiveReceiptMatches({ success: true, id: 8 }, request), false);
  assert.equal(archiveReceiptMatches({ success: true, requestId: 'foreign' }, request), false);
  assert.equal(archiveReceiptMatches({ success: true, namespace: 'old', id: 7, requestId: 'intent' }, request), true);
});

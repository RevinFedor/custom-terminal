'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { TabWorkContext } = require('./tab-work-context');
function fixture(t) {
  const db = new Database(':memory:'), notifications = [];
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: 'T', name: 'Own tab',
    projectId: 'P', commandType: 'codex', codexSessionId: 'S' }], onChanged: value => notifications.push(value) });
  t.after(() => { context.dispose?.(); db.close(); });
  const record = (ids, revision = context.get('T').revision) => ({ tabId: 'T', operationId: 'own-rewind',
    toolType: 'codex', kind: 'rewind', expectedSessionId: 'S', targetUuid: 'earlier-user',
    request: { selfRewind: { retainedContext: 'Deployment already completed. Code and server state remain changed.',
      expectedContextRevision: revision, coveredContextUpdateIds: ids, nextPrompt: null } } });
  return { db, context, notifications, record };
}
test('self Rewind stages context durably but does not replace existing chips before binding', t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Old finding', sourceTabId: 'other', requestId: 'old' });
  const record = h.record([old.updateId]);
  record.rewindContext = h.context.stageRewindContext(record);
  assert.equal(h.context.get('T').updates.length, 1);
  assert.equal(h.context.get('T').updates[0].id, old.updateId);
  assert.equal(h.db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(record.rewindContext.updateId).status, 'rewind-held');
  assert.deepEqual(h.context.stageRewindContext(record), record.rewindContext);
});
test('binding activates one crimson context and supersedes only the captured unchanged members', t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Covered', requestId: 'old' });
  const record = h.record([old.updateId]);
  record.rewindContext = h.context.stageRewindContext(record);
  const late = h.context.publish('T', { text: 'Arrived later', requestId: 'late' });
  record.bindingCommitted = true; record.activeSessionId = 'COW-child';
  record.rewindContext = h.context.commitRewindContext(record);
  const updates = h.context.get('T').updates;
  assert.deepEqual(updates.map(row => row.id).sort(), [late.updateId, record.rewindContext.updateId].sort());
  const restored = updates.find(row => row.kind === 'rewind');
  assert.equal(restored.title, 'Контекст после отката'); assert.equal(restored.rewind.operationId, 'own-rewind');
  assert.match(restored.text, /Deployment already completed/);
  assert.equal(h.db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(old.updateId).status, 'rewind-superseded');
  assert.equal(h.context.get('T').updates.filter(row => row.kind === 'rewind').length, 1);
  h.context.commitRewindContext(record);
  assert.equal(h.context.get('T').updates.filter(row => row.kind === 'rewind').length, 1);
});
test('stale context revision, foreign members and missing binding cannot clear any update', t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Preserve', requestId: 'old' });
  assert.throws(() => h.context.stageRewindContext(h.record([old.updateId], 0)), /context_revision_changed/);
  assert.throws(() => h.context.stageRewindContext(h.record(['foreign'])), /context_member_changed/);
  const record = h.record([old.updateId]); record.rewindContext = h.context.stageRewindContext(record);
  assert.throws(() => h.context.commitRewindContext(record), /binding_unproven/);
  assert.equal(h.context.get('T').updates[0].id, old.updateId);
  assert.throws(() => h.context.publish('T', { text: 'Generic self publish stays forbidden', sourceTabId: 'T' }), /another tab/);
});
test('SQLite rollback keeps both old chip and hidden retained context intact', t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Preserve', requestId: 'old' });
  const record = h.record([old.updateId]); record.rewindContext = h.context.stageRewindContext(record);
  record.bindingCommitted = true; record.activeSessionId = 'child';
  const before = h.notifications.length;
  assert.throws(() => h.db.transaction(() => {
    h.context.commitRewindContext(record); throw Error('controlled receipt persistence failure');
  })(), /controlled/);
  assert.equal(h.context.get('T').updates[0].id, old.updateId);
  assert.equal(h.notifications.length, before, 'an uncommitted replacement must not be published');
});
test('a file context member changed after the cut remains pending rather than being swallowed', t => {
  const h = fixture(t);
  const file = { path: '/finite/work.md', beforeHash: 'a', afterHash: 'b', beforeText: 'old', afterText: 'first', sources: [], unknownSource: true };
  h.context.upsertPendingFileChange('T', file); h.context.touch('T');
  const member = h.context.get('T').updates[0];
  const record = h.record(member.memberIds || [member.id]); record.rewindContext = h.context.stageRewindContext(record);
  h.context.upsertPendingFileChange('T', { ...file, beforeHash: 'b', afterHash: 'c', beforeText: 'first', afterText: 'later version' });
  h.context.touch('T'); record.bindingCommitted = true; record.activeSessionId = 'child';
  record.rewindContext = h.context.commitRewindContext(record);
  assert.equal(h.context.get('T').updates.some(update => update.kind === 'file-batch'), true);
  assert.ok(record.rewindContext.changed.length > 0);
});
test('superseding an observed sending chip never rewrites its frozen handoff or marks it delivered', async t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Known old context', requestId: 'old' });
  const prepared = await h.context.prepare('T', 'old-immutable', 'Old task');
  const record = h.record([old.updateId]); record.rewindContext = h.context.stageRewindContext(record);
  record.bindingCommitted = true; record.activeSessionId = 'child'; h.context.commitRewindContext(record);
  const handoff = h.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get('T', 'old-immutable');
  assert.equal(handoff.prepared_prompt, prepared.prompt); assert.equal(handoff.status, 'preparing');
  assert.equal(h.db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(old.updateId).status, 'rewind-superseded');
});
test('omitted member IDs cover the complete observed snapshot, never later arrivals', t => {
  const h = fixture(t);
  const first = h.context.publish('T', { text: 'First', requestId: 'first' });
  const second = h.context.publish('T', { text: 'Second', requestId: 'second' });
  const record = h.record(undefined); record.rewindContext = h.context.stageRewindContext(record);
  const late = h.context.publish('T', { text: 'Late', requestId: 'late' });
  record.bindingCommitted = true; record.activeSessionId = 'child'; h.context.commitRewindContext(record);
  const visible = h.context.get('T').updates.map(row => row.id);
  assert.equal(visible.includes(first.updateId), false); assert.equal(visible.includes(second.updateId), false);
  assert.equal(visible.includes(late.updateId), true);
});

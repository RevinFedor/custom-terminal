'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { TabWorkContext } = require('./tab-work-context');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const db = new Database(':memory:'), notifications = [];
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: 'T', name: 'Own tab',
    projectId: 'P', commandType: 'codex', codexSessionId: 'S' }], onChanged: value => notifications.push(value) });
  t.after(async () => {
    await context.syncing;
    for (const watcher of context.watchers.values()) watcher.close();
    if (db.open) db.close();
  });
  const record = (ids, revision = context.get('T').revision) => ({ tabId: 'T', operationId: 'own-rewind',
    toolType: 'codex', kind: 'rewind', expectedSessionId: 'S', targetUuid: 'earlier-user',
    request: { selfRewind: { retainedContext: 'Deployment already completed. Code and server state remain changed.',
      expectedContextRevision: revision, coveredContextUpdateIds: ids, nextPrompt: null } } });
  return { db, context, notifications, record };
}
function observedRecord(h, ids) {
  const state = h.context.getRewindContext('T'), record = h.record(ids, state.revision);
  record.request.selfRewind.expectedContextSnapshot = state.rewindSnapshot;
  return { record, state };
}
test('observed context survives a delivery status transition without replacing its snapshot or frozen handoff', async t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Known finding', sourceTabId: 'other', requestId: 'old' });
  const prepared = await h.context.prepare('T', 'observed-send', 'Original task');
  const observed = h.context.getRewindContext ? h.context.getRewindContext('T') : h.context.get('T');
  const record = h.record(undefined, observed.revision);
  if (observed.rewindSnapshot) record.request.selfRewind.expectedContextSnapshot = observed.rewindSnapshot;
  h.context.confirm('T', 'observed-send', promptAuditFingerprint(prepared.prompt));
  assert.equal(h.context.get('T').revision, observed.revision + 1);
  record.rewindContext = h.context.stageRewindContext(record);
  assert.equal(record.rewindContext.covered.some(member => member.id === old.updateId), true);
  record.bindingCommitted = true; h.context.commitRewindContext(record);
  assert.equal(h.db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(old.updateId).status, 'delivered');
  assert.equal(h.db.prepare('SELECT prepared_prompt FROM tab_context_handoffs WHERE handoff_id=?').get('observed-send').prepared_prompt, prepared.prompt);
});
test('pending/sending/failed transport state changes preserve the same observed facts and never rewrite frozen bytes', async t => {
  const h = fixture(t), old = h.context.publish('T', { text: 'Keep', requestId: 'old' });
  const { record } = observedRecord(h);
  const prepared = await h.context.prepare('T', 'attempt', 'Task');
  h.context.release('T', 'attempt'); h.context.activate('T', 'attempt');
  record.rewindContext = h.context.stageRewindContext(record);
  assert.equal(record.rewindContext.covered[0].id, old.updateId);
  assert.equal(h.db.prepare('SELECT prepared_prompt FROM tab_context_handoffs WHERE handoff_id=?').get('attempt').prepared_prompt, prepared.prompt);
});
test('new facts, responsibility ABA, changed files and changed members cannot hide behind delivery state', async t => {
  for (const kind of ['new-note-delivered', 'responsibility-aba', 'file-no-touch', 'member-no-touch']) {
    const h = fixture(t), old = h.context.publish('T', { text: 'Observed', requestId: 'old' });
    const { record } = observedRecord(h);
    if (kind === 'new-note-delivered') {
      h.context.publish('T', { text: 'UNSEEN NEW FACT', requestId: 'new' });
      const prepared = await h.context.prepare('T', 'late', 'Task');
      h.context.confirm('T', 'late', promptAuditFingerprint(prepared.prompt));
    } else if (kind === 'responsibility-aba') {
      h.context.setResponsibility('T', 'Changed'); h.context.setResponsibility('T', '');
    } else if (kind === 'file-no-touch') {
      h.db.prepare('INSERT INTO tab_context_files(tab_id,path,content,hash) VALUES(?,?,?,?)').run('T', '/finite/new.md', '', 'new');
    } else h.db.prepare('UPDATE tab_context_updates SET text=? WHERE id=?').run('UNSEEN CONTENT', old.updateId);
    assert.throws(() => h.context.stageRewindContext(record), /context_revision_changed/, kind);
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM tab_context_updates WHERE kind='rewind'").get().n, 0);
  }
});
test('snapshot identity/signature and a missing legacy observation cannot be forged', t => {
  const h = fixture(t); h.context.publish('T', { text: 'Secret observation', requestId: 'old' });
  const { record, state } = observedRecord(h);
  const parts = state.rewindSnapshot.split('.'), payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(JSON.stringify(payload).includes('Secret observation'), false, 'proof stores hashes, not note bodies');
  assert.equal(JSON.stringify(state).includes(h.db.prepare('SELECT rewind_key FROM tab_work_context').get().rewind_key), false);
  for (const tamper of ['body', 'unicode-signature', 'revision']) {
    const changed = structuredClone(record);
    if (tamper === 'body') changed.request.selfRewind.expectedContextSnapshot = parts[0] + '.' + Buffer.from(JSON.stringify({ ...payload, tabId: 'foreign' })).toString('base64url') + '.' + parts[2];
    if (tamper === 'unicode-signature') changed.request.selfRewind.expectedContextSnapshot = parts[0] + '.' + parts[1] + '.' + 'é'.repeat(43);
    if (tamper === 'revision') changed.request.selfRewind.expectedContextRevision++;
    assert.throws(() => h.context.stageRewindContext(changed), /snapshot_invalid/);
  }
  h.context.touch('T', { rewindChanged: false });
  const legacy = h.record(undefined, state.revision);
  assert.throws(() => h.context.stageRewindContext(legacy), /context_revision_changed/, 'no unsigned revision relaxation');
});
test('explicit dismissal, restoration ABA and deletion are composition changes, not delivery acknowledgements', t => {
  for (const kind of ['dismiss', 'restore-aba', 'delete']) {
    const h = fixture(t), old = h.context.publish('T', { text: 'Observed', requestId: 'old' });
    const { record } = observedRecord(h);
    if (kind === 'delete') h.context.deleteUpdate('T', old.updateId);
    else {
      h.context.dismiss('T', old.updateId);
      if (kind === 'restore-aba') h.context.restoreDismissed('T', old.updateId);
    }
    assert.throws(() => h.context.stageRewindContext(record), /context_revision_changed/, kind);
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM tab_context_updates WHERE kind='rewind'").get().n, 0);
  }
});
test('same responsibility is not a new fact, and issuing a proof does not change revision or notify UI', t => {
  const h = fixture(t); h.context.publish('T', { text: 'Keep', requestId: 'old' });
  const before = h.context.get('T'), count = h.notifications.length;
  const { record } = observedRecord(h);
  assert.equal(h.context.get('T').revision, before.revision); assert.equal(h.notifications.length, count);
  h.context.setResponsibility('T', '');
  assert.doesNotThrow(() => h.context.stageRewindContext(record));
});
test('real partial owner Read ACK is compatible; the original logical chip and text hashes survive for draft cleanup', async t => {
  const h = fixture(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-context-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'work.md');
  const before = 'one\nold two\nthree\nfour\nfive\nsix\nseven\nold eight\nnine\n';
  const after = before.replace('old two', 'new two').replace('old eight', 'new eight');
  fs.writeFileSync(file, after);
  h.db.prepare('INSERT INTO tab_context_files(tab_id,path,content,hash) VALUES(?,?,?,?)').run('T', file, after, digest(after));
  h.context.upsertPendingFileChange('T', { path: file, beforeText: before, afterText: after }); h.context.touch('T');
  const { record, state } = observedRecord(h, [h.context.get('T').updates[0].id]);
  const oldChip = state.updates[0];
  await h.context.acceptAgentRead('T', { id: 'read', tool: 'Read', args: { file_path: file, offset: 1, limit: 4 },
    result: '1→one\n2→new two\n3→three\n4→four', isError: false }, Date.now() + 2000);
  assert.notEqual(h.context.get('T').updates[0].text, oldChip.text);
  record.rewindContext = h.context.stageRewindContext(record);
  assert.ok(record.rewindContext.draftContexts.some(chip => chip.id === oldChip.id && chip.textHash === digest(oldChip.text)));
  h.context.publish('T', { text: 'Later unrelated fact', requestId: 'late' });
  record.bindingCommitted = true; h.context.commitRewindContext(record);
  assert.equal(h.context.get('T').updates.some(update => update.kind === 'file-batch'), false);
  assert.equal(h.context.get('T').updates.some(update => update.text.includes('Later unrelated fact')), true);
});
test('a genuine later file version remains pending after admission, even though ACK-only changes are allowed', t => {
  const h = fixture(t), file = { path: '/finite/work.md', beforeText: 'a\n', afterText: 'b\n' };
  h.context.upsertPendingFileChange('T', file); h.context.touch('T');
  const { record } = observedRecord(h); record.rewindContext = h.context.stageRewindContext(record);
  h.context.upsertPendingFileChange('T', { ...file, beforeText: 'b\n', afterText: 'c\n' }); h.context.touch('T');
  record.bindingCommitted = true; const result = h.context.commitRewindContext(record);
  assert.ok(result.changed.length); assert.equal(h.context.get('T').updates.some(update => update.kind === 'file-batch'), true);
});
test('the context proof survives real SQLite close/reopen without an in-memory read watermark', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-context-reopen-')), file = path.join(root, 'context.sqlite');
  const options = { listTabs: () => [{ tabId: 'T', name: 'Own', commandType: 'codex', codexSessionId: 'S' }] };
  let db = new Database(file), context = new TabWorkContext({ db, ...options });
  t.after(async () => {
    await context.syncing;
    for (const watcher of context.watchers.values()) watcher.close();
    if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  context.publish('T', { text: 'Known', requestId: 'one' });
  const state = context.getRewindContext('T'); await context.syncing; db.close();
  db = new Database(file); context = new TabWorkContext({ db, ...options });
  const record = { tabId: 'T', operationId: 'reopen', expectedSessionId: 'S', targetUuid: 'U',
    request: { selfRewind: { retainedContext: 'Known', expectedContextRevision: state.revision, expectedContextSnapshot: state.rewindSnapshot } } };
  assert.doesNotThrow(() => context.stageRewindContext(record));
});
test('a foreign tab proof cannot select another context, even with the same numeric revision', t => {
  const h = fixture(t); h.context.publish('T', { text: 'Own', requestId: 'one' });
  const { record } = observedRecord(h);
  const other = new TabWorkContext({ db: h.db, listTabs: () => [{ tabId: 'U' }] });
  other.publish('U', { text: 'Other', requestId: 'one' });
  record.request.selfRewind.expectedContextSnapshot = other.getRewindContext('U').rewindSnapshot;
  assert.throws(() => h.context.stageRewindContext(record), /snapshot_invalid/);
});
test('snapshot metadata stays small for a maximum-size note and never embeds responsibility or file bodies', t => {
  const h = fixture(t);
  h.context.setResponsibility('T', 'Private source responsibility');
  h.context.publish('T', { text: 'x'.repeat(100000), requestId: 'big' });
  const state = h.context.getRewindContext('T');
  const payload = Buffer.from(state.rewindSnapshot.split('.')[1], 'base64url').toString();
  assert.equal(payload.includes('Private source responsibility'), false); assert.equal(payload.includes('x'.repeat(30)), false);
  assert.ok(Buffer.byteLength(state.rewindSnapshot) < 4096, 'one-member proof size depends on metadata, not the 100000-character body');
});
test('observed grouped/sending context is removed from restored draft while a changed user copy is preserved', async t => {
  const h = fixture(t);
  h.context.upsertPendingFileChange('T', { path: '/finite/work.md', beforeText: 'before\n', afterText: 'after\n' }); h.context.touch('T');
  const prepared = await h.context.prepare('T', 'frozen-group', 'Keep user draft');
  const { record } = observedRecord(h); record.rewindContext = h.context.stageRewindContext(record);
  const { restoreComposerDraftFromHistoryPresentation, removeRewindCoveredDraftContext } = await import('../shared/composer-chips.mjs');
  const restored = restoreComposerDraftFromHistoryPresentation({ text: prepared.prompt });
  assert.equal(restored.chips.length, 1);
  const clean = removeRewindCoveredDraftContext(restored, record.rewindContext.draftContexts, digest);
  assert.equal(clean.chips.length, 0); assert.equal(clean.text, 'Keep user draft');
  const changed = { ...restored, chips: restored.chips.map(chip => ({ ...chip, text: chip.text + '\nNew user fact' })) };
  assert.equal(removeRewindCoveredDraftContext(changed, record.rewindContext.draftContexts, digest).chips.length, 1);
});
test('legacy normalized requests do not acquire a new null field that would break immutable request hashes', t => {
  const h = fixture(t), { normalizeSavedHistoryRequest } = require('./saved-history-operation');
  const record = h.record(undefined);
  const value = normalizeSavedHistoryRequest('T', { ...record, selfRewind: record.request.selfRewind });
  assert.equal(Object.hasOwn(value.selfRewind, 'expectedContextSnapshot'), false);
});
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

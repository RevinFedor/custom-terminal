'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { resolveTimelineNoteAnchor } = require('./timeline-note-identity');
const request = { entryUuid: 'codex-live-S-timestamp-73-user', sessionId: 'S', tabId: 'T',
  sourceIdentity: 'codex-user-source-S-500', cwd: '/fixture', content: 'my note', position: 'before' };
const entry = { uuid: 'codex-user-S-40', type: 'user', sessionId: 'S',
  sourceIdentity: 'codex-user-source-S-600', sourceIdentityAliases: ['codex-user-source-S-500'] };

test('live note resolves only its exact source/alias into the current physical UUID', async () => {
  const result = await resolveTimelineNoteAnchor(request, async read => {
    assert.equal(read.sessionId, 'S'); return { success: true, entries: [entry] };
  });
  assert.equal(result.entryUuid, entry.uuid);
  assert.equal(result.anchor.sourceIdentity, entry.sourceIdentity);
  assert.deepEqual(result.anchor.sourceUuidAliases, [request.entryUuid]);
});

test('equal text/time, foreign session, missing source or ambiguous read cannot attach a note', async () => {
  for (const changed of [
    { ...request, sourceIdentity: '' }, { ...request, sourceIdentity: 'codex-user-source-OTHER-500' },
    { ...request, entryUuid: 'codex-live-OTHER-timestamp-73-user' },
  ]) assert.equal((await resolveTimelineNoteAnchor(changed, () => assert.fail('foreign identity must not read'))).success, false);
  for (const entries of [[], [entry, { ...entry, uuid: 'other-physical-entry' }],
    [{ ...entry, sourceIdentity: 'different', sourceIdentityAliases: [], content: request.content, timestamp: 'timestamp' }]]) {
    assert.equal((await resolveTimelineNoteAnchor(request, async () => ({ success: true, entries }))).success, false);
  }
});

test('actual note IPC saves a canonical address, never a watcher UUID, and refuses failed proof', async () => {
  const ast = ts.createSourceFile('claude-data.js', fs.readFileSync(require.resolve('./ipc/claude-data'), 'utf8'), ts.ScriptTarget.Latest, true);
  let node;
  const walk = n => { if (ts.isCallExpression(n) && n.expression.getText(ast) === 'ipcMain.handle'
    && n.arguments[0]?.text === 'timeline:save-note') node = n; ts.forEachChild(n, walk); };
  walk(ast); assert.ok(node);
  for (const success of [true, false]) {
    let handler; const writes = [];
    vm.runInNewContext(node.getText(ast), { ipcMain: { handle: (_key, fn) => { handler = fn; } },
      console, projectManager: { db: { saveTimelineNote: (...args) => writes.push(args) } },
      resolveTimelineNoteAnchor: input => resolveTimelineNoteAnchor(input, async () => ({ success, entries: [entry] })),
    });
    const result = await handler({}, request);
    assert.equal(result.success, success);
    assert.equal(writes.length, success ? 1 : 0);
    if (success) assert.equal(writes[0][0], entry.uuid);
  }
});

test('physical Claude/Codex anchors need no extra transcript read', async () => {
  for (const entryUuid of ['claude-uuid', 'codex-user-S-40']) {
    assert.equal((await resolveTimelineNoteAnchor({ ...request, entryUuid }, () => assert.fail('unnecessary full read'))).entryUuid, entryUuid);
  }
});

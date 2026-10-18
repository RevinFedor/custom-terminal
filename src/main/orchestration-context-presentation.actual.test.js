'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { TabWorkContext } = require('./tab-work-context');
const { sourceCompletionFacts, completionContextPresentation } = require('./orchestration-source-context');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { decorateHistoryPromptPresentations, normalizePromptPresentationSnapshot,
  saveAuditedPromptPresentation, cloneCodexPromptPresentationsForProvenChild } = require('./history-prompt-presentations');
const hash = text => createHash('sha256').update(text).digest('hex');

async function fixture(t, toolType = 'codex') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-context-presentation-'));
  const file = path.join(directory, 'fixture.sqlite');
  let db = new Database(file), store = new DatabaseManager({ existingConnection: db });
  db.exec(`CREATE TABLE history_prompt_presentations(tool_type TEXT,session_id TEXT,audit_timestamp TEXT,
    transport_hash TEXT,entry_uuid TEXT,schema_version INTEGER,chips_json TEXT,created_at INTEGER,updated_at INTEGER,
    PRIMARY KEY(tool_type,session_id,audit_timestamp,transport_hash));
    CREATE INDEX idx_history_prompt_presentations_uuid ON history_prompt_presentations(tool_type,entry_uuid);
    CREATE TABLE session_history_events(id INTEGER PRIMARY KEY,session_id TEXT,source_session_id TEXT,occurred_at INTEGER,created_at INTEGER);`);
  const owner = { tabId: 'own', commandType: toolType, tabType: 'terminal', codexSessionId: 'source', claudeSessionId: 'source' };
  const scope = { toolType, sessionId: 'source' }, records = [], publications = [];
  const run = { runId: 'completed-fixture', sourceTabId: 'own', sourceToolType: toolType,
    sourceExecutionContext: { provider: toolType, sessionId: 'source' }, notifySource: true,
    notificationSuppressed: true, sourceAttentionDismissedAt: 123, sourceFollowupStartedAt: null,
    status: 'completed', resultComplete: true, completedAt: 100, outcome: 'success' };
  const configure = context => context.configure({ transcriptService: { promptPresentationStore: store },
    readReceipts: () => records, resolveAttributionSource: () => scope,
    readContinuationFacts: value => sourceCompletionFacts([run], value) });
  const create = () => { const value = new TabWorkContext({ db, listTabs: () => [owner], onChanged() {
    publications.push(store.getHistoryPromptPresentations(toolType, 'source').some(row => row.chips.some(tag => tag.kind === 'context-prefix')));
  } }); configure(value); return value; };
  let context = create();
  const h = { get context() { return context; }, get store() { return store; }, records, toolType, publications,
    saved: () => db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get('own', 'send'),
    async prepare(text = '# A literal question\n\nDo **not** restyle me.') { return context.prepare('own', 'send', text); },
    confirmed(prepared, patch = {}) {
      const value = { state: 'confirmed', provider: toolType, tabId: 'own', handoffId: 'send',
        operationKey: 'history:own:send', attemptId: 'attempt', sessionId: 'source',
        auditIdentity: { provider: toolType, sessionId: 'source', attemptId: 'attempt', entryUuid: 'exact-user',
          sourceIdentity: 'exact-source', auditTimestamp: '2026-10-18T09:00:34.818Z', promptHash: promptAuditFingerprint(prepared.prompt) },
        receipt: { transportText: prepared.prompt, presentationSnapshot: null, sessionId: 'source',
          auditTimestamp: '2026-10-18T09:00:34.818Z', exactAuditConfirmed: true, actualHash: promptAuditFingerprint(prepared.prompt) }, ...patch };
      records.splice(0, records.length, value); return value;
    },
    reopen() { db.close(); db = new Database(file); store = new DatabaseManager({ existingConnection: db }); context = create(); },
    decorate(text) { return decorateHistoryPromptPresentations(store, { toolType, sessionId: 'source', entries: [
      { role: 'user', uuid: 'exact-user', sessionId: 'source', timestamp: '2026-10-18T09:00:34.818Z', content: text }] })[0]; },
  };
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return h;
}

for (const provider of ['codex', 'claude']) test(provider + ' exact handoff+receipt creates display-only prefix proof, restored after restart', async t => {
  const h = await fixture(t, provider), prepared = await h.prepare();
  const receipt = h.confirmed(prepared), before = JSON.stringify(receipt);
  const { projectHistoryServicePromptBody, resolveHistoryOrchestrationPromptPresentation } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const entryBefore = h.decorate(prepared.prompt);
  assert.equal(projectHistoryServicePromptBody(entryBefore, hash).text, prepared.prompt, 'baseline has the raw app envelope');
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  const entry = h.decorate(prepared.prompt), projection = projectHistoryServicePromptBody(entry, hash);
  assert.deepEqual(projection, { text: '# A literal question\n\nDo **not** restyle me.', projected: true, markdown: false });
  assert.equal(entry.content, prepared.prompt, 'canonical Copy/Rewind bytes stay unchanged');
  assert.equal(resolveHistoryOrchestrationPromptPresentation(entry), null, 'context does not change ordinary user origin');
  const { timelinePromptPreview } = await import('../renderer/utils/timelineEntryPreview.mjs');
  const preview = timelinePromptPreview(entry, hash);
  assert.equal(preview.service, null);
  assert.equal(preview.source, null);
  assert.ok(!preview.text.includes('orchestration_state'));
  assert.equal(JSON.stringify(receipt), before, 'delivery/outcome and receipt stay unchanged');
  assert.equal(h.publications.at(-1), true, 'presentation exists before publishing the confirmed context change');
  const sidecar = h.store.getHistoryPromptPresentations(provider, 'source')[0];
  h.store.db.prepare('DELETE FROM history_prompt_presentations').run();
  h.reopen();
  assert.deepEqual(projectHistoryServicePromptBody(h.decorate(prepared.prompt), hash), projection);
  const restored = h.store.getHistoryPromptPresentations(provider, 'source')[0];
  assert.deepEqual(restored.chips, sidecar.chips);
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  assert.equal(h.store.getHistoryPromptPresentations(provider, 'source').length, 1);
  assert.equal(h.context.get('own').pendingCount, 0);
});

test('unconfirmed, foreign or changed receipt/handoff cannot hide any text', async t => {
  const h = await fixture(t), prepared = await h.prepare();
  const record = h.confirmed(prepared), saved = h.saved();
  assert.ok(completionContextPresentation(saved, record));
  const variants = [
    { ...record, state: 'delivery-unknown' }, { ...record, tabId: 'other' }, { ...record, handoffId: 'other' },
    { ...record, attemptId: 'other' }, { ...record, sessionId: 'other' },
    { ...record, receipt: { ...record.receipt, exactAuditConfirmed: false } },
    { ...record, receipt: { ...record.receipt, transportText: prepared.prompt.replace('literal', 'altered') } },
    { ...record, auditIdentity: { ...record.auditIdentity, promptHash: 'wrong' } },
  ];
  for (const value of variants) assert.equal(completionContextPresentation(saved, value), null);
  for (const patch of [{ continuation_facts: '[]' }, { prefix: '' }, { payload_hash: 'wrong' },
    { prepared_prompt: prepared.prompt + 'edit' }, { continuation_facts: JSON.stringify([JSON.stringify(['orchestration-completion-v1', 'run', 100, 'codex', 'foreign'])]) }]) {
    assert.equal(completionContextPresentation({ ...saved, ...patch }, record), null);
  }
  const { projectHistoryServicePromptBody } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  assert.deepEqual(projectHistoryServicePromptBody({ role: 'user', content: prepared.prompt }, hash), { text: prepared.prompt, projected: false });
  const tag = completionContextPresentation(saved, record);
  assert.equal(normalizePromptPresentationSnapshot({ semanticTags: [tag] }), null, 'caller cannot claim a trusted context prefix');
  for (const content of [prepared.prompt.replace('literal', 'altered'), prepared.prompt + 'suffix']) {
    assert.equal(projectHistoryServicePromptBody({ role: 'user', content, semanticTags: [tag] }, hash).text, content);
  }
});

test('late ordinary sidecar writes preserve the trusted prefix and send timing', async t => {
  const h = await fixture(t), prepared = await h.prepare(), record = h.confirmed(prepared);
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  saveAuditedPromptPresentation(h.store, { toolType: 'codex', sessionId: 'source', entryUuid: 'exact-user',
    auditTimestamp: record.auditIdentity.auditTimestamp, actualText: prepared.prompt,
    snapshot: { historySendStartedAt: 12345, promptChips: [{ kind: 'prompt', id: 'chip', label: 'Related', text: 'chip text' }] } });
  const entry = h.decorate(prepared.prompt);
  assert.equal(entry.semanticTags[0].kind, 'context-prefix');
  assert.equal(entry.promptChips[0].label, 'Related');
  assert.ok(normalizePromptPresentationSnapshot({ historySendStartedAt: 12345 }));
});

test('exact saved COW remap retains context projection, not just raw body', async t => {
  const h = await fixture(t), prepared = await h.prepare(), record = h.confirmed(prepared);
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  const row = h.store.getHistoryPromptPresentations('codex', 'source')[0];
  h.store.db.prepare('UPDATE history_prompt_presentations SET entry_uuid=?').run('codex-user-source-1');
  const source = [{ type: 'event_msg', __line: 1, timestamp: record.auditIdentity.auditTimestamp,
    payload: { type: 'user_message', message: prepared.prompt } }];
  const child = source.map(value => ({ ...value, __line: 5 }));
  const result = cloneCodexPromptPresentationsForProvenChild(h.store, { sourceSessionId: 'source', childSessionId: 'child', sourceRecords: source, childRecords: child });
  assert.equal(result.cloned, 1);
  const copied = h.store.getHistoryPromptPresentations('codex', 'child')[0];
  assert.deepEqual(copied.chips, row.chips);
});

test('quiet context and a separate audited service envelope compose without changing service Markdown', async t => {
  const h = await fixture(t), envelope = 'APP MESSAGE HEADER\n\n', body = '## Actual answer\n\n**kept**';
  const prepared = await h.prepare(envelope + body), record = h.confirmed(prepared);
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  saveAuditedPromptPresentation(h.store, { toolType: 'codex', sessionId: 'source', entryUuid: 'exact-user',
    auditTimestamp: record.auditIdentity.auditTimestamp, actualText: prepared.prompt,
    snapshot: { semanticTags: [{ kind: 'tab-message', messageId: 'reply', phase: 'reply', replyTo: 'question',
      sourceTabId: 'sender', targetTabId: 'own', envelopeStart: prepared.prefix.length,
      envelopeText: envelope, bodyStart: prepared.prefix.length + envelope.length,
      bodyEnd: prepared.prompt.length, bodyProjectionHash: hash(prepared.prompt) }] } });
  const entry = h.decorate(prepared.prompt);
  const { projectHistoryServicePromptBody } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  assert.deepEqual(projectHistoryServicePromptBody(entry, hash), { text: body, projected: true });
  assert.equal(entry.content, prepared.prompt);
});

test('user-authored lookalikes inside the body and ordinary prompt chips are preserved', async t => {
  const h = await fixture(t), text = 'My quoted <orchestration_state> is literal.\n<saved_prompt name="literal">kept</saved_prompt>';
  const prepared = await h.prepare(text), record = h.confirmed(prepared);
  saveAuditedPromptPresentation(h.store, { toolType: 'codex', sessionId: 'source', entryUuid: 'exact-user',
    auditTimestamp: record.auditIdentity.auditTimestamp, actualText: prepared.prompt,
    snapshot: { promptChips: [{ kind: 'prompt', id: 'chip', label: 'User prompt', text: 'kept' }] } });
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  const entry = h.decorate(prepared.prompt);
  const { projectHistoryServicePromptBody } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  assert.equal(projectHistoryServicePromptBody(entry, hash).text, text);
  assert.equal(entry.promptChips[0].id, 'chip');
});

test('failed metadata save never changes confirmed delivery or consumes the context again', async t => {
  const h = await fixture(t), prepared = await h.prepare(), record = h.confirmed(prepared);
  const before = JSON.stringify(record);
  h.store.saveHistoryPromptPresentation = () => { throw Error('fixture sidecar failure'); };
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  assert.equal(h.saved().status, 'delivered');
  assert.equal(JSON.stringify(record), before);
  assert.equal((await h.context.prepare('own', 'next', 'next')).prompt, 'next');
});

test('an early context confirmation can acquire its exact presentation when the durable receipt arrives later', async t => {
  const h = await fixture(t), prepared = await h.prepare();
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  assert.equal(h.saved().status, 'delivered');
  assert.equal(h.store.getHistoryPromptPresentations('codex', 'source').length, 0);
  h.confirmed(prepared);
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  assert.equal(h.publications.at(-1), true);
  const count = h.publications.length;
  h.context.confirm('own', 'send', promptAuditFingerprint(prepared.prompt));
  assert.equal(h.publications.length, count, 'the same successful metadata proof is not republished');
});

test('actual History caller keeps context-only projection literal and accepts its presentation kind', () => {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
  const tree = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(tree.parseDiagnostics.length, 0);
  const values = [];
  const visit = node => {
    if (ts.isJsxAttribute(node) && node.name.text === 'markdown' && ts.isJsxExpression(node.initializer)) values.push(node.initializer.expression.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(values.some(value => value === 'serviceBody.projected && !serviceBody.questionReply && serviceBody.markdown !== false'));
  assert.match(source, /kind: 'orchestration' \| 'prompt-origin' \| 'tab-message' \| 'context-prefix'/);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { resolveContextFileRefs, prependContextFileChips, MAX_CONTEXT_FILE_BYTES, MAX_CONTEXT_TOTAL_BYTES } = require('./agent-context-files');
const { TabWorkContext } = require('./tab-work-context');
const MAX = 1048576;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, ready = false) {
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db), writes = [];
  const queue = new AgentSendQueue({ store, ready: () => ready, execute: async request => {
    writes.push(request.handoffId);
    return { success: false, submitted: false, pasteWritten: false, enterWritten: false,
      code: 'controlled-physical-boundary-reached' }; // No fake provider success.
  } });
  t.after(async () => { queue.dispose(); await tick(); db.close(); });
  function enqueue(prompt, extra = {}, provider = 'codex', handoffId = 'oversized') {
    const request = { tabId: 'T', handoffId, prompt, provider, source: 'history-panel',
      authoringSnapshot: { editorText: prompt, chips: [], imagePaths: [] }, ...extra };
    const identity = { operationKey: 'history:T:' + handoffId, surface: 'desktop-history', tabId: 'T', handoffId,
      provider, sessionId: 'S', requestFingerprint: fingerprintAgentSendRequest(request),
      promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
    return { admitted: queue.enqueue({ identity, request }), identity, request };
  }
  return { db, store, queue, writes, enqueue };
}
test('oversized assembled Codex request is terminal before dispatch even when the target is not ready', async t => {
  const h = fixture(t), prompt = 'x'.repeat(MAX + 1), sent = h.enqueue(prompt);
  const record = h.store.get(sent.identity.operationKey);
  assert.equal(record.state, 'not-submitted'); assert.equal(record.attemptId, null);
  assert.equal(record.receipt.code, 'codex_message_too_large');
  assert.deepEqual(record.receipt.inputLimit, { provider: 'codex', actual: MAX + 1, max: MAX, unit: 'unicode-scalars' });
  assert.equal(record.receipt.promptText, prompt); assert.equal(record.receipt.authoringSnapshot.editorText, prompt);
  assert.equal(h.queue.item(sent.identity.operationKey).state, 'failed');
  assert.equal(sent.admitted.receipt, null, 'an invalid input must not receive a queued acceptance');
  await h.queue.pump('T'); assert.deepEqual(h.writes, []);
  h.enqueue(prompt); assert.equal(h.store.get(sent.identity.operationKey).attemptId, null);
  assert.equal(h.store.list({ tabId: 'T' }).length, 1, 'same immutable request replays its failure');
});
test('multiple individually valid context files cannot bypass the final Codex scalar limit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-codex-input-files-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const refs = [];
  for (let i = 0; i < 3; i++) {
    const file = path.join(root, i + '.md'); fs.writeFileSync(file, 'x'.repeat(400000)); refs.push({ path: file, role: 'source' });
    assert(fs.statSync(file).size < MAX_CONTEXT_FILE_BYTES);
  }
  assert(1200000 < MAX_CONTEXT_TOTAL_BYTES);
  const files = await resolveContextFileRefs({ refs }), prompt = prependContextFileChips('small task', files);
  const h = fixture(t, true), sent = h.enqueue(prompt);
  await tick();
  assert.equal(h.store.get(sent.identity.operationKey).state, 'not-submitted');
  assert.deepEqual(h.writes, []);
  assert.equal(h.store.get(sent.identity.operationKey).receipt.inputLimit.actual, prompt.length);
});
test('working-context expansion is counted rather than the small original authoring', async t => {
  const h = fixture(t), context = new TabWorkContext({ db: h.db, listTabs: () => [{ tabId: 'T', projectId: 'P' }] });
  context.publish('T', { sourceTabId: 'B', title: 'large context', text: 'x'.repeat(9000), requestId: 'context' });
  const original = 'x'.repeat(MAX - 5000), prepared = await context.prepare('T', 'expanded', original);
  assert(prepared.prompt.length > MAX);
  const sent = h.enqueue(prepared.prompt, { authoringSnapshot: { editorText: original, chips: [], imagePaths: [] } }, 'codex', 'expanded');
  assert.equal(h.store.get(sent.identity.operationKey).state, 'not-submitted');
  assert.equal(h.store.get(sent.identity.operationKey).receipt.authoringSnapshot.editorText, original);
  assert.equal(h.store.get(sent.identity.operationKey).receipt.inputLimit.actual, prepared.prompt.length);
  assert.equal(h.writes.length, 0);
});

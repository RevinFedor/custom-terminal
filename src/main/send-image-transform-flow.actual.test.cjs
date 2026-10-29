'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const { fixture, drainMicrotasks: drain } = require('./fixtures/send-preparation-write.cjs');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { createSendPreparationScope } = require('./agent-send-preparation');
const { promptAuditFingerprint: hash } = require('./prompt-audit-fingerprint');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const image = require('./codex-image-transport'), projection = require('./codex-image-request-projection');
const audit = require('./codex-prompt-audit');
const main = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = name => { const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast); };
const tick = () => new Promise(resolve => setImmediate(resolve));
function wireImages(h, boundary, { preflightMissing = false, badProjection = false } = {}) {
  const staged = [], routed = [];
  Object.assign(h.ctx, { require, path, srcMainDir: __dirname, ...image,
    createCodexImageRequestProjection: badProjection ? () => null : projection.createCodexImageRequestProjection,
    projectCodexImageAuditToRequest: projection.projectCodexImageAuditToRequest,
    fs: { promises: { stat: async source => ({ isFile: () => !(preflightMissing && source.includes('missing')) }) } },
    stageCodexImagePathForPasteSync: (_tab, source) => {
      staged.push(source); return source.includes('missing') ? { success: false, error: 'image_path_missing', path: source }
        : { success: true, path: source, inputPath: '/synthetic/alias-' + staged.length + '.png', size: 4, mediaType: 'image/png' };
    }, captureCodexPromptAuditBoundary: () => boundary,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'controlled-provider' }),
    isOrchestrationPromptAudit: () => false, enrichCodexAuditAddress() {}, routeAgentPromptAuditDetail: detail => routed.push(detail),
  });
  for (const name of ['validatePromptQueueImageMarkers', 'prepareCodexImagePathMarkersForPaste', 'publishAgentPromptAuditResult']) {
    vm.runInContext(declaration(name), h.ctx);
  }
  return { staged, routed };
}
function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-image-proof-'));
  const filePath = path.join(dir, 'owned-rollout.jsonl'); fs.writeFileSync(filePath, '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, filePath, boundary: { sessionId: 'S', filePath, fileSize: 0, capturedAt: Date.now() } };
}
function confirm(h, file, { corrupt = null, offset = 0 } = {}) {
  const pending = h.ctx.getPendingCodexPasteAudits('T').at(-1); assert.ok(pending);
  const text = corrupt || pending.expectedText;
  const stamp = new Date(Math.max(Date.now(), file.boundary.capturedAt + 1)).toISOString();
  const actualIdentity = { sessionId: 'S', filePath: file.filePath, byteOffset: offset, timestamp: stamp };
  const selected = audit.selectCodexPendingPromptAudit([pending], { actualText: text, actualHash: hash(text), actualIdentity });
  if (!selected) return false;
  return h.ctx.publishAgentPromptAuditResult('T', pending, { success: true, actualText: text, actualHash: hash(text), actualLen: text.length,
    expectedHash: pending.expectedHash, expectedLen: pending.expectedLen, sessionId: 'S',
    entryUuid: 'native-' + offset, sourceIdentity: 'codex-user-source-S-' + offset,
    recordByteOffset: offset, auditTimestamp: stamp, actualIdentity,
    canonicalized: !!selected.canonicalMatch, canonicalReason: selected.canonicalMatch?.reason || null }, 'codex');
}

for (const preflightMissing of [false, true]) test('actual Main writer: all-missing ' +
  (preflightMissing ? 'preflight' : 'staging') + ' stages proof before ONE payload/Enter and confirms original request', { timeout: 5000 }, async t => {
  const file = files(t), prompt = 'keep  exact\n[imagePath: /synthetic/missing.png]\nend';
  const h = fixture(t, { open: false, prompt, attachOwned: false });
  const observed = wireImages(h, file.boundary, { preflightMissing });
  const pending = h.start({ source: 'codex-history-panel' }); await drain(120);
  const result = await pending;
  assert.notEqual(result.submitted, false, JSON.stringify(result));
  assert.equal(h.writes.filter(x => x === '\r').length, 1);
  const saved = h.store.get(h.identity.operationKey);
  assert.equal(saved.receipt.imageRequestProjection?.version, 2);
  assert.equal(saved.receipt.expectedImageRefs.length, 0);
  assert.equal(saved.receipt.expectedImagePaths.length, 0);
  assert.ok(saved.receipt.transportText.includes(preflightMissing ? 'queue_image_path_unavailable' : 'codex_image_path_unavailable'));
  assert.equal(saved.promptHash, hash(prompt));
  assert.equal(observed.staged.length, preflightMissing ? 0 : 1);
  assert.equal(confirm(h, file), true);
  assert.equal(h.store.get(h.identity.operationKey).state, 'confirmed');
  assert.equal(observed.routed.length, 1);
  assert.equal(observed.routed[0].expectedHash, hash(prompt));
});

test('missing/invalid transformation proof is refused before payload, never converted to fake success', async t => {
  const file = files(t), prompt = '[imagePath: /synthetic/missing.png]';
  const h = fixture(t, { open: false, prompt, attachOwned: false }); wireImages(h, file.boundary, { badProjection: true });
  const pending = h.start({ source: 'codex-history-panel' }); await drain(120);
  const result = await pending;
  assert.equal(result.error, 'codex_image_transform_proof_invalid');
  assert.equal(h.writes.length, 0);
});

for (const invalid of [false, true]) test('actual FIFO + Main writer + SQLite/native audit: ' +
  (invalid ? 'invalid carrier keeps follower held' : 'exact input proof releases follower without a model final'), { timeout: 5000 }, async t => {
  const file = files(t), prompt = 'first [imagePath: /synthetic/missing.png]';
  const h = fixture(t, { open: false, prompt, attachOwned: false, deferAttempt: true }); wireImages(h, file.boundary);
  let ready = false, executions = 0;
  const execute = async request => {
    executions++;
    const record = h.store.get(request.sendOperationKey);
    const begun = h.store.beginAttempt(record); assert.ok(begun.attemptId);
    assert.equal(h.store.get(record.operationKey).state, 'in-flight');
    const scope = createSendPreparationScope({ ...record, attemptId: begun.attemptId }, h.clock.now());
    h.store.stageAttemptContext(record.operationKey, begun.attemptId, { preflightScope: scope });
    const result = await h.ctx.safePasteAndSubmit(h.term, request.prompt, { ...h.opts,
      source: 'codex-history-panel', handoffId: request.handoffId, sendOperationKey: record.operationKey,
      sendAttemptId: begun.attemptId, preflightScope: scope });
    h.store.settleAttempt(record.operationKey, begun.attemptId, result); return result;
  };
  const queue = new AgentSendQueue({ store: h.store, ready: () => ready, execute });
  t.after(() => queue.dispose());
  const enqueue = (handoffId, text) => {
    const request = { tabId: 'T', provider: 'codex', prompt: text, handoffId, sendOperationKey: 'history:T:' + handoffId,
      source: 'history-panel', settingsIntent: { kind: 'none' } };
    const identity = { ...h.identity, handoffId, operationKey: request.sendOperationKey,
      promptHash: hash(text), promptLength: text.length, requestFingerprint: fingerprintAgentSendRequest(request) };
    assert.equal(queue.enqueue({ identity, request }).ok, true); return { request, identity };
  };
  const first = enqueue('H', prompt); enqueue('H2', 'second exact text');
  ready = true; await queue.pump('T'); await drain(120); await tick();
  assert.equal(executions, 1); assert.equal(h.writes.filter(x => x === '\r').length, 1);
  if (invalid) {
    assert.equal(confirm(h, file, { corrupt: h.store.get(first.identity.operationKey).receipt.transportText.replace('#1', '#9') }), false);
    queue.notifyRuntime('T'); queue.resume(); await drain(100); await tick();
    assert.equal(queue.enqueue(first).ok, true, 'same frozen H reads existing operation');
    assert.equal(executions, 1); assert.notEqual(h.store.get(first.identity.operationKey).state, 'confirmed');
    queue.cancelWaiting('T', 'H2');
    confirm(h, file); await drain(150); await tick();
    assert.equal(h.store.get(first.identity.operationKey).state, 'confirmed', 'late exact audit retains its original owner');
    assert.equal(queue.item('history:T:H2').state, 'cancelled');
    assert.equal(executions, 1, 'late audit cannot revive a cancelled follower or replay its own input');
  } else {
    confirm(h, file); await drain(150); await tick(); await drain(150);
    assert.equal(h.store.get(first.identity.operationKey).state, 'confirmed');
    assert.equal(executions, 2); assert.equal(h.writes.filter(x => x === '\r').length, 2);
    assert.equal(queue.item(first.identity.operationKey).state, 'completed');
  }
});

test('actual SQLite reopen/startup matcher reuses pre-Enter all-missing proof without fresh staging', { timeout: 5000 }, async t => {
  const file = files(t), prompt = '[imagePath: /synthetic/missing.png]';
  const filename = path.join(file.dir, 'receipts.sqlite');
  const h = fixture(t, { open: false, prompt, attachOwned: false, receiptFilename: filename });
  const observed = wireImages(h, file.boundary);
  const pending = h.start(); await drain(120); const result = await pending;
  h.store.settleAttempt(h.identity.operationKey, h.attempt.attemptId, result);
  const before = h.store.get(h.identity.operationKey);
  const stamp = new Date(Date.now() + 1).toISOString();
  fs.writeFileSync(file.filePath, JSON.stringify({ type: 'event_msg', timestamp: stamp,
    payload: { type: 'user_message', message: before.receipt.transportText } }) + '\n');
  h.store.db.close();
  const db = new Database(filename); t.after(() => db.close());
  const store = createAgentSendReceiptStore(db);
  const record = store.get(h.identity.operationKey);
  assert.deepEqual(record.receipt.imageRequestProjection, before.receipt.imageRequestProjection);
  const reconciled = await require('./agent-send-startup-reconcile').reconcileAgentSendStartupRecord(record, {
    resolveCodexFile: async () => file.filePath,
  });
  assert.equal(reconciled.decision, 'found', JSON.stringify(reconciled));
  assert.equal(store.promoteFromAudit(reconciled.audit).promoted, true);
  assert.equal(observed.staged.length, 1);
  assert.equal(h.writes.filter(x => x === '\r').length, 1);
  assert.equal(store.get(record.operationKey).promptHash, hash(prompt));
  const foreign = { ...record, attemptId: 'foreign-A' };
  assert.notEqual((await require('./agent-send-startup-reconcile').reconcileAgentSendStartupRecord(foreign,
    { resolveCodexFile: async () => file.filePath })).decision, 'confirmed');
});

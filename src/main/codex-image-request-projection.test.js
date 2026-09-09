'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { createCodexImageRequestProjection, projectCodexImageAuditToRequest } = require('./codex-image-request-projection');
const { createAgentSendReceiptRegistry } = require('./agent-send-receipt-registry');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { reconcileAgentSendStartupRecord } = require('./agent-send-startup-reconcile');

function fixture(twoImages = false) {
  const sources = ['/source/first image.png', '/source/second.png'];
  const aliases = ['/tmp/codex-images/first.png', '/tmp/codex-images/second.png'];
  const requestText = 'Exact text before.\n[imagePath: ' + sources[0] + ']\nKeep the exact tail.'
    + (twoImages ? '\n[imagePath: ' + sources[1] + ']' : '');
  const plan = buildCodexImagePastePlan(requestText, sourcePath => ({
    success: true, path: sourcePath, inputPath: aliases[sources.indexOf(sourcePath)],
    assetId: sources.indexOf(sourcePath) === 0 ? 'first-asset' : 'second-asset', mediaType: 'image/png', size: 123,
  }));
  const scope = { tabId: 'tab-a', handoffId: 'handoff-a', operationKey: 'project:tab-a:handoff-a', attemptId: 'attempt-a' };
  const record = { ...scope, provider: 'codex', sessionId: 'session-a', promptHash: promptAuditFingerprint(requestText), promptLength: requestText.length };
  const projection = createCodexImageRequestProjection({ ...scope, requestText, transportText: plan.text, segments: plan.segments, imageRefs: plan.staged });
  const audit = {
    handoffId: scope.handoffId, sendOperationKey: scope.operationKey, sendAttemptId: scope.attemptId,
    expectedText: plan.text, expectedHash: promptAuditFingerprint(plan.text), expectedLen: plan.text.length,
    expectedImagePaths: plan.segments.filter(segment => segment.kind === 'image').map(segment => segment.text),
    expectedImageRefs: plan.staged, imageRequestProjection: projection,
  };
  const result = { success: true, canonicalized: true, canonicalReason: 'codex_image_placeholder_canonical',
    expectedHash: audit.expectedHash, expectedLen: audit.expectedLen, actualHash: 'native-image-carrier-hash',
    sessionId: 'session-a', sourceIdentity: 'codex-user-session-a-4242', entryUuid: 'entry-a',
    auditTimestamp: '2026-09-05T00:17:37.251Z' };
  return { scope, requestText, plan, record, audit, result };
}

test('exact ordered image-path alias projection preserves original immutable request identity', () => {
  const f = fixture(true);
  const projected = projectCodexImageAuditToRequest({ tabId: f.scope.tabId, ...f });
  assert.equal(projected.applied, true);
  assert.equal(projected.requestHash, f.record.promptHash);
  assert.equal(projected.transportHash, f.audit.expectedHash);
  assert.notEqual(projected.requestHash, projected.transportHash);
  assert.equal(projected.imageCount, 2);
});

test('physical Inbox719char path carrier composes with its own persisted image mapping, including source refs', () => {
  const { run, entry } = require('./fixtures/inbox-png-path-audit-20260909.json');
  assert.equal(entry.content, run.transportText);
  assert.equal(entry.content.length, 719);
  const record = {
    ...run, promptHash: run.imageRequestProjection.requestHash,
    promptLength: run.imageRequestProjection.requestLength,
  };
  const audit = {
    handoffId: run.handoffId, sendOperationKey: run.operationKey, sendAttemptId: run.attemptId,
    expectedText: run.transportText, expectedLen: run.transportText.length,
    expectedHash: promptAuditFingerprint(run.transportText), expectedImagePaths: run.expectedImagePaths,
    expectedImageRefs: run.expectedImageRefs, imageRequestProjection: run.imageRequestProjection,
  };
  const result = { success: true, canonicalized: false, actualText: entry.content,
    actualHash: promptAuditFingerprint(entry.content), actualLen: entry.content.length,
    expectedHash: audit.expectedHash, expectedLen: audit.expectedLen,
    actualImagePaths: entry.imagePaths.map(ref => ref.path) };
  const input = { tabId: run.tabId, record, audit, result };
  const proved = projectCodexImageAuditToRequest(input);
  assert.equal(proved.applied, true);
  assert.equal(proved.canonicalReason, 'codex_image_path_alias_exact');
  // Both are real provider representations: a path in exact user text, or a
  // separate image reference. Neither admits a different path/order/scope.
  assert.equal(projectCodexImageAuditToRequest({ ...input, result: { ...result, actualImagePaths: [] } }).applied, true);
  for (const mutate of [
    x => { x.audit.imageRequestProjection = null; },
    x => { x.record.attemptId = 'another-attempt'; },
    x => { x.result.actualText += ' '; },
    x => { x.result.actualText = x.result.actualText.replace('aa2dd578', 'bb2dd578'); },
    x => { x.result.actualImagePaths = ['/foreign/same-name.png']; },
    x => { x.audit.expectedImageRefs[0].path = '/different/Inbox-retake-image.png'; },
    x => { x.result.actualLen--; },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.equal(projectCodexImageAuditToRequest(changed).applied, false, String(mutate));
  }
});

test('only image replacements may differ; unrelated text, lost markers and relative examples have no projection', () => {
  const f = fixture();
  for (const transportText of [f.plan.text + ' extra text', f.plan.text.replace('exact tail', 'wrong tail'), '']) {
    assert.equal(createCodexImageRequestProjection({ ...f.scope, requestText: f.requestText,
      transportText, segments: f.plan.segments, imageRefs: f.plan.staged }), null);
  }
  assert.equal(createCodexImageRequestProjection({ ...f.scope, requestText: '[imagePath: relative.png]',
    transportText: '/tmp/codex-images/first.png', segments: f.plan.segments, imageRefs: f.plan.staged }), null);
});

test('wrong attempt/owner, image identity/order, or provider proof cannot bridge different hashes', () => {
  const mutations = [
    f => { f.audit.sendAttemptId = 'newer-attempt'; },
    f => { f.record.attemptId = 'newer-attempt'; },
    f => { f.audit.sendOperationKey = 'different-operation'; },
    f => { f.audit.handoffId = 'different-handoff'; },
    f => { f.record.tabId = 'different-tab'; },
    f => { f.record.provider = 'claude'; },
    f => { f.audit.expectedImagePaths.reverse(); },
    f => { f.audit.expectedImageRefs.reverse(); },
    f => { f.audit.expectedImageRefs[0].path = '/source/wrong-image.png'; },
    f => { f.audit.expectedImageRefs[0].assetId = 'wrong-image-content'; },
    f => { f.audit.expectedText = f.audit.expectedText.replace('exact tail', 'wrong tail'); },
    f => { f.audit.imageRequestProjection.requestText += '\nUNRELATED NEW TEXT'; },
    f => { f.record.promptHash = 'a-different-request'; },
    f => { f.result.expectedHash = 'a-different-transport'; },
    f => { f.result.canonicalized = false; },
    f => { f.result.canonicalReason = 'generic-canonicalized'; },
  ];
  for (const mutate of mutations) {
    const f = JSON.parse(JSON.stringify(fixture(true)));
    mutate(f);
    assert.equal(projectCodexImageAuditToRequest({ tabId: f.scope.tabId, ...f }).applied, false, mutate.toString());
  }
});

function physicalImageFixture() {
  const source = '/private/tmp/noted-control-20260905.NgdE2L/dev/build-resources/icon.png';
  const alias = '/tmp/noted-terminal-codex-image-input/8bc1e693bb52e8853ad99cff0d30b63274f3851d8a8e4d4dd016ca733a2e3cf2.png';
  const requestText = 'This is a resume-auto first-input test. Read the full multiline text and attached image, then reply with exactly E2E_RESUME_IMAGE_OK and nothing else. Do not call tools.\nSTART_IMAGE_PAYLOAD 🧩\n'
    + Array.from({ length: 45 }, (_, index) => 'Row ' + (index + 1) + ': retain the complete message across cold composer initialization.').join('\n')
    + '\n[imagePath: ' + source + ']\nEND_PAYLOAD final backslash \\';
  const plan = buildCodexImagePastePlan(requestText, sourcePath => ({ success: true, path: sourcePath, inputPath: alias, size: 278148, mediaType: 'image/png' }));
  assert.equal(requestText.length, 3583);
  assert.equal(promptAuditFingerprint(requestText), '771bcdfd7914f8ff');
  assert.equal(plan.text.length, 3605);
  assert.equal(promptAuditFingerprint(plan.text), 'e8f14d6ece349948');
  return { requestText, plan };
}

test('actual3583→3605 E2E fixture is reconstructed without reading image files or altering text', () => {
  const f = physicalImageFixture();
  const scope = fixture().scope;
  const proof = createCodexImageRequestProjection({ ...scope, ...f, transportText: f.plan.text, segments: f.plan.segments, imageRefs: f.plan.staged });
  assert.equal(proof.requestHash, '771bcdfd7914f8ff');
  assert.equal(proof.transportHash, 'e8f14d6ece349948');
});

test('actual main publication promotes durable and registry receipts for the physical image fixture', async t => {
  let db;
  try { db = new (require('better-sqlite3'))(':memory:'); }
  catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error.message)) {
      t.skip('run this durable integration with ELECTRON_RUN_AS_NODE=1'); return;
    }
    throw error;
  }
  t.after(() => db.close());
  const store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt-a' });
  const f = fixture();
  const actual = physicalImageFixture();
  const identity = { ...f.record, surface: 'project-api', requestFingerprint: 'exact-image-request',
    promptHash: promptAuditFingerprint(actual.requestText), promptLength: actual.requestText.length };
  const started = store.beginAttempt(identity);
  assert.equal(started.attemptId, 'attempt-a');
  store.settleAttempt(identity.operationKey, started.attemptId, { success: null, submitted: true, status: 'audit-pending', auditPending: true });
  const registry = createAgentSendReceiptRegistry();
  await registry.run(identity, async () => ({ submitted: true, status: 'audit-pending', auditPending: true }));
  const audit = {
    ...f.audit,
    expectedText: actual.plan.text,
    expectedHash: promptAuditFingerprint(actual.plan.text), expectedLen: actual.plan.text.length,
    expectedImagePaths: actual.plan.segments.filter(s => s.kind === 'image').map(s => s.text),
    expectedImageRefs: actual.plan.staged,
    imageRequestProjection: createCodexImageRequestProjection({ ...f.scope, requestText: actual.requestText,
      transportText: actual.plan.text, segments: actual.plan.segments, imageRefs: actual.plan.staged }),
  };
  const result = { ...f.result, actualLen: 3510, actualHash: 'eedd2ac5484b3664', expectedLen: audit.expectedLen, expectedHash: audit.expectedHash };
  const legacy = store.promoteFromAudit({ ...result, operationKey: identity.operationKey, attemptId: started.attemptId,
    provider: 'codex', promptHash: audit.expectedHash });
  assert.deepEqual(legacy.mismatchedFields, ['promptHash', 'expectedHash']);
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = mainSource.indexOf('function publishAgentPromptAuditResult(');
  const end = mainSource.indexOf('\nfunction holdPasteAuditCompletionForTest(', start);
  const routed = [];
  const publish = vm.runInNewContext('(' + mainSource.slice(start, end) + ')', {
    console: { log() {}, warn() {}, error() {} }, agentSendReceiptStore: store,
    AGENT_SEND_DURABLE_STATES: STORE_STATES, projectCodexImageAuditToRequest,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'not-an-orchestration' }),
    isOrchestrationPromptAudit: () => false,
    routeAgentPromptAuditDetail: detail => { routed.push(detail); registry.promoteFromAudit(detail); },
  });
  publish(f.scope.tabId, audit, result, 'codex');
  assert.equal(store.get(identity.operationKey).state, 'confirmed');
  assert.equal(store.get(identity.operationKey).receipt.expectedHash, identity.promptHash);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].expectedHash, '771bcdfd7914f8ff');
  assert.equal(routed[0].transportExpectedHash, 'e8f14d6ece349948');
  assert.equal(routed[0].actualHash, 'eedd2ac5484b3664');
  assert.equal(registry.snapshot(identity.tabId)[0].state, 'confirmed');
  assert.equal(result.expectedHash, 'e8f14d6ece349948', 'transport audit input is never mutated');
});

test('actual pre-Enter staging persists typed image proof across SQLite close/reopen and reuses raw native hash', async t => {
  const directory = fs.mkdtempSync('/tmp/codex-image-restart-proof-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'receipts.sqlite');
  const transcriptPath = path.join(directory, 'rollout.jsonl');
  let db;
  const Database = require('better-sqlite3');
  try { db = new Database(dbPath); }
  catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error.message)) {
      t.skip('run durable close/reopen integration with ELECTRON_RUN_AS_NODE=1'); return;
    }
    throw error;
  }
  t.after(() => { if (db?.open) db.close(); });
  let store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt-a' });
  const f = fixture();
  const actual = physicalImageFixture();
  const identity = { ...f.record, surface: 'project-api', requestFingerprint: 'image-request-restart',
    promptHash: promptAuditFingerprint(actual.requestText), promptLength: actual.requestText.length };
  store.beginAttempt(identity);
  fs.writeFileSync(transcriptPath, '');
  const boundary = { sessionId: identity.sessionId, filePath: transcriptPath, fileSize: 0,
    capturedAt: Date.parse('2026-09-05T00:17:36.000Z') };

  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = mainSource.indexOf('  if (sendOperationKey && sendAttemptId) {\n    durablePreSubmitBoundary = isCodexPasteSource');
  const end = mainSource.indexOf('\n  if (shouldStageClaudeAudit', start);
  assert.ok(start > 0 && end > start);
  const runStage = vm.runInNewContext('(function runStage(){' + mainSource.slice(start, end) + '\n})', {
    agentSendReceiptStore: store, createCodexImageRequestProjection,
    sendOperationKey: identity.operationKey, sendAttemptId: identity.attemptId,
    handoffId: identity.handoffId, broadcastTabId: identity.tabId,
    isCodexPasteSource: true, durablePreSubmitBoundary: null, codexImageRequestProjection: null,
    captureCodexPromptAuditBoundary: () => boundary,
    durableRawPrompt: actual.requestText, content: actual.plan.text,
    codexImagePasteSegments: actual.plan.segments, stagedCodexImageRefs: actual.plan.staged,
    source: 'codex-terminal-mcp', normalizedPresentationSnapshot: null,
    console: { log() {}, warn() {} },
  });
  assert.equal(runStage(), undefined);
  const staged = store.get(identity.operationKey);
  assert.equal(staged.receipt.imageRequestProjection.requestHash, '771bcdfd7914f8ff');
  assert.equal(staged.receipt.imageRequestProjection.transportHash, 'e8f14d6ece349948');
  assert.equal(staged.receipt.expectedImageRefs[0].path, actual.plan.staged[0].path);
  assert.equal(fs.statSync(transcriptPath).size, 0, 'proof is durable before the native user record');
  store.markAttemptState(identity.operationKey, identity.attemptId, STORE_STATES.ENTER_ARMED);
  store.settleAttempt(identity.operationKey, identity.attemptId, { submitted: true, status: 'audit-pending', auditPending: true });
  // Exact get_user_prompt payload preserved in the physical E2E trace: Codex
  // replaces the image path with its numbered slot plus a trailing space.
  const nativeText = actual.requestText.replace(/\[imagePath:[^\]]+\]/, '[Image #1] ');
  assert.equal(nativeText.length, 3510);
  assert.equal(promptAuditFingerprint(nativeText), 'eedd2ac5484b3664');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'event_msg', timestamp: '2026-09-05T00:17:37.251Z',
    payload: { type: 'user_message', message: nativeText } }) + '\n');
  db.close();
  db = new Database(dbPath);
  store = createAgentSendReceiptStore(db);
  const reopened = store.get(identity.operationKey);
  const reconciled = await reconcileAgentSendStartupRecord(reopened);
  assert.equal(reconciled.decision, 'found', reconciled.reason);
  assert.equal(reconciled.audit.expectedHash, '771bcdfd7914f8ff');
  assert.equal(reconciled.audit.transportExpectedHash, 'e8f14d6ece349948');
  assert.equal(reconciled.audit.actualHash, 'eedd2ac5484b3664');
  assert.equal(store.promoteFromAudit(reconciled.audit).promoted, true);
  const confirmed = store.get(identity.operationKey);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.promptHash, '771bcdfd7914f8ff');
  assert.equal(confirmed.auditIdentity.promptHash, 'eedd2ac5484b3664');

  for (const mutate of [
    r => { delete r.receipt.imageRequestProjection; },
    r => { delete r.receipt.transportText; },
    r => { r.receipt.operationKey = 'other-operation'; },
    r => { r.receipt.attemptId = 'other-attempt'; },
    r => { r.receipt.imageRequestProjection.attemptId = 'other-attempt'; },
    r => { r.receipt.promptText += 'unrelated text'; },
    r => { r.receipt.transportText += 'unrelated text'; },
    r => { r.receipt.expectedImagePaths[0] = '/tmp/wrong-image.png'; },
    r => { r.receipt.expectedImageRefs[0].path = '/source/wrong-image.png'; },
    r => { r.receipt.expectedImageRefs[0].assetId = 'wrong-content'; },
    r => { r.receipt.imageRequestProjection.requestText += 'unrelated text'; },
  ]) {
    const tampered = JSON.parse(JSON.stringify(reopened));
    mutate(tampered);
    const rejected = await reconcileAgentSendStartupRecord(tampered);
    assert.equal(rejected.decision, 'unknown', mutate.toString());
    assert.equal(rejected.audit, null);
  }
});

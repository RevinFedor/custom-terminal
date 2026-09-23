'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { promptAuditFingerprint: hash } = require('./prompt-audit-fingerprint');
const auditModule = require('./claude-prompt-audit');
const { planClaudePostEnterRetry } = require('./claude-paste-submit-readiness');
const { classifyClaudePostEnterOutcome } = require('./claude-post-enter-outcome');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const Database = require('better-sqlite3');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n)
  && n.name?.text === 'inspectClaudePostEnterTimeoutAtWriteBoundary').getText(ast);
const raw = '[Image #8] [Image #9] [Image #10] [Image #11] [Image #12]';
const portable = raw.replace(/\[Image #(\d+)\]/g, '[imageError: claude_image_path_unavailable #$1]');
const original = [4439, 4438, 4437, 4436, 4435].map(n => '/fixture/IMG_' + n + '.JPG').join(' ');

async function inspect(overrides = {}) {
  const audit = { handoffId: 'image-handoff', sendOperationKey: 'image-operation',
    sendAttemptId: 'image-attempt', submitted: true, submitWritten: true,
    expectedText: original, expectedLen: original.length, expectedHash: hash(original),
    historySessionId: 'session', enterRetryCount: 0,
    preSubmitBoundary: { available: true, transcriptPath: '/fixture/session.jsonl',
      fileSize: 100, endedWithNewline: true },
    pasteReadyProof: { ready: true, form: 'inline-text', inputRevision: 18,
      terminalRunSeq: 1, terminalLifecycleGeneration: 'life', mirrorGeneration: 'mirror',
      expectedImageCount: 1 } };
  const capture = { success: true, editorReturnReady: true, terminalIdentityStable: true,
    inputRevision: 19, terminalRunSeq: 1, terminalLifecycleGeneration: 'life',
    mirrorGeneration: 'mirror', text: portable, capturedText: raw, images: 5,
    imagePaths: [], ...overrides };
  const context = vm.createContext({
    ...auditModule, planClaudePostEnterRetry, classifyClaudePostEnterOutcome,
    console: { log() {}, warn() {} },
    claudeTurnBusy: new Map(), bridgeKnownSessions: new Map([['T', 'session']]),
    captureAgentInputAtWriteBoundary: async () => capture,
    resolveClaudeSessionFileForTab: () => '/fixture/session.jsonl',
    readClaudeUserRecords: async () => [],
    observeClaudePromptShapeCandidates() {}, pasteAuditHash: hash,
    persistClaudePostEnterForensicArtifact: async () => null,
    settleClaudePasteAuditWithoutProjection: () => assert.fail('images do not prove refusal'),
  });
  vm.runInContext(fn, context);
  const result = await context.inspectClaudePostEnterTimeoutAtWriteBoundary({
    tabId: 'T', term: {}, audit, expectedText: original,
    timeoutResult: { success: false, error: 'claude_user_message_audit_timeout' },
  });
  return { audit, capture, result };
}

test('actual image capture preserves raw provider text through retry planning and exact receipt confirmation', async t => {
  const { audit, capture, result } = await inspect();
  assert.equal(result.retryRecommended, true);
  assert.equal(audit.providerAcceptedText, raw);
  assert.equal(audit.providerAcceptedImageCount, 5);
  assert.equal(capture.text, portable, 'missing attachment rollback still reports imageError');
  assert.equal(auditModule.selectUniqueClaudePromptSubmitAudit([audit], raw).audit, audit);
  const candidate = { record: { type: 'user', uuid: 'exact-image-user', sessionId: 'session',
    timestamp: '2026-09-23T01:56:47.870Z' }, text: raw,
    byteOffset: 120, transcriptPath: '/fixture/session.jsonl', promptCarrierKind: 'user' };
  const selection = auditModule.selectClaudePendingPromptAudit([audit], [candidate]);
  assert.equal(selection?.audit, audit);
  const confirmed = auditModule.buildClaudeLivePromptAuditConfirmation(selection, candidate, { sessionId: 'session' }).result;
  assert.equal(confirmed.success, true);
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createAgentSendReceiptStore(db);
  const begun = store.beginAttempt({ operationKey: audit.sendOperationKey, tabId: 'T',
    handoffId: audit.handoffId, provider: 'claude', sessionId: 'session', surface: 'desktop-history',
    promptHash: audit.expectedHash, promptLength: audit.expectedLen, requestFingerprint: 'fixture' });
  store.markAttemptState(audit.sendOperationKey, begun.attemptId, 'enter-armed');
  store.settleAttempt(audit.sendOperationKey, begun.attemptId, { submitted: true, auditPending: true });
  const promotion = store.promoteFromAudit({ ...confirmed, provider: 'claude',
    operationKey: audit.sendOperationKey, attemptId: begun.attemptId, promptHash: audit.expectedHash });
  assert.equal(promotion.promoted, true, JSON.stringify(promotion));
  assert.equal(store.get(audit.sendOperationKey).state, 'confirmed');
});

test('owned image-only hook text uses exact captured count, not the pre-conversion path estimate', async () => {
  const { audit } = await inspect();
  // Versions whose hook omits images report an empty text body.
  Object.assign(audit, { providerAcceptedText: '', providerAcceptedLen: 0, providerAcceptedHash: hash('') });
  assert.equal(auditModule.claudeAuditTextMatches(audit, raw), true);
  assert.equal(auditModule.claudeAuditTextMatches(audit, '[Image #8]'), false);
  assert.equal(auditModule.claudeAuditTextMatches(audit, raw + ' [Image #13]'), false);
});

test('raw capture cannot authorize a different input, owner, partial capture or already-created user turn', async () => {
  for (const changed of [{ inputRevision: 20 }, { terminalLifecycleGeneration: 'other' },
    { mirrorGeneration: 'other' }, { terminalRunSeq: 2 }, { success: false },
    { terminalIdentityStable: false }, { editorReturnReady: false }]) {
    const { audit, result } = await inspect(changed);
    assert.equal(result.retryRecommended, false, JSON.stringify(changed));
    assert.equal(audit.providerAcceptedText, undefined);
  }
  const { audit } = await inspect();
  for (const candidate of [
    { text: raw + ' changed', byteOffset: 120, transcriptPath: '/fixture/session.jsonl' },
    { text: raw, byteOffset: 99, transcriptPath: '/fixture/session.jsonl' },
    { text: raw, byteOffset: 120, transcriptPath: '/foreign/session.jsonl' },
  ]) assert.equal(auditModule.selectClaudePendingPromptAudit([audit], [{
    ...candidate, record: { type: 'user', uuid: 'U', timestamp: '2026-09-23T01:56:47.870Z' },
  }]), null);
});

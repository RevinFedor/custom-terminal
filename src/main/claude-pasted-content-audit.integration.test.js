'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  buildDesktopHistorySendIdentity,
} = require('./agent-history-send-receipt');
const {
  createAgentSendReceiptStore,
  STORE_STATES,
} = require('./agent-send-receipt-store');
const {
  captureClaudePromptAuditBoundary,
  claudeAuditCanonicalIdentity,
  claudeAuditTextMatches,
  claudeNativePastedPromptText,
  readClaudeUserRecordsFromBuffer,
  selectClaudePendingPromptAudit,
  selectUniqueClaudePromptSubmitAudit,
} = require('./claude-prompt-audit');
const { reconcileAgentSendStartupRecords } = require('./agent-send-startup-reconcile');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const SESSION = '919f66d5-3923-4932-9119-06826fade7ad';
const PROMPT = ('Plain inline prompt: ' + 'x'.repeat(217 - 'Plain inline prompt: '.length));
const HANDOFF = 'fixture-inline-wrapper-handoff';
const TAB = 'fixture-inline-wrapper-tab';

let createAgentSendVisualActivity;
let resolveWorkflowActivityCounts;
test.before(async () => {
  ({ createAgentSendVisualActivity } = await import('../renderer/utils/agentSendVisualActivity.mjs'));
  ({ resolveWorkflowActivityCounts } = await import('../renderer/utils/workflowActivityCounts.mjs'));
});

function nativeWrapper(body, { openId = '1fe1', closeId = openId, prefix = '\n\n', suffix = '\n' } = {}) {
  return prefix + '<pasted_content id="' + openId + '">\n'
    + body + '\n</pasted_content id="' + closeId + '">' + suffix;
}

function userRecord(text, { uuid, sessionId = SESSION, timestamp = '2026-09-20T12:00:01.000Z' } = {}) {
  return {
    type: 'user',
    uuid,
    sessionId,
    timestamp,
    message: { role: 'user', content: text },
  };
}

async function tempRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-pasted-content-audit-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return root;
}

function openPrivateDb(t, filename) {
  try {
    const db = new Database(filename);
    t.after(() => { if (db.open) db.close(); });
    return db;
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
}

async function createSavedAttempt(t, {
  prompt = PROMPT,
  sessionId = SESSION,
  receiptSessionId = sessionId,
  handoffId = HANDOFF,
  tabId = TAB,
  beforeBoundary = [],
  afterBoundary = [],
} = {}) {
  const root = await tempRoot(t);
  const transcriptPath = path.join(root, sessionId + '.jsonl');
  const initialText = beforeBoundary.length
    ? beforeBoundary.map(record => JSON.stringify(record)).join('\n') + '\n'
    : '';
  await fs.promises.writeFile(transcriptPath, initialText);
  const boundary = await captureClaudePromptAuditBoundary(transcriptPath, { sessionId });
  assert.equal(boundary.available, true);
  assert.equal(boundary.endedWithNewline, true);
  if (afterBoundary.length) {
    await fs.promises.appendFile(transcriptPath,
      afterBoundary.map(record => JSON.stringify(record)).join('\n') + '\n');
  }

  const databasePath = path.join(root, 'receipts.sqlite');
  let db = openPrivateDb(t, databasePath);
  if (!db) return null;
  let sequence = 0;
  let store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt-' + (++sequence) });
  const identity = buildDesktopHistorySendIdentity({
    tabId,
    handoffId,
    provider: 'claude',
    source: 'history-panel',
    sessionId: receiptSessionId,
    rawPrompt: prompt,
    promptHash: promptAuditFingerprint(prompt),
    promptLength: prompt.length,
  });
  const begun = store.beginAttempt(identity);
  assert.equal(begun.ok, true);
  assert.equal(begun.action, 'attempt-started');
  assert.equal(store.stageAttemptContext(identity.operationKey, begun.attemptId, {
    source: 'history-panel',
    sessionId: receiptSessionId,
    promptText: prompt,
    transportText: prompt,
    transcriptBoundary: boundary,
  }).ok, true);
  assert.equal(store.markAttemptState(identity.operationKey, begun.attemptId, STORE_STATES.ENTER_ARMED).ok, true);
  assert.equal(store.settleAttempt(identity.operationKey, begun.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: STORE_STATES.AUDIT_PENDING,
    auditPending: true,
    operationKey: identity.operationKey,
    attemptId: begun.attemptId,
    tabId,
    handoffId,
    promptHash: identity.promptHash,
    transcriptBoundary: boundary,
  }).record.state, STORE_STATES.AUDIT_PENDING);

  // Simulate an app restart by reopening only this private fixture database.
  db.close();
  db = openPrivateDb(t, databasePath);
  if (!db) return null;
  store = createAgentSendReceiptStore(db, { randomUUID: () => 'unused-' + (++sequence) });
  const startup = store.reconcileStartup();
  const unresolved = startup.records.filter(record => (
    record.state === STORE_STATES.AUDIT_PENDING || record.state === STORE_STATES.DELIVERY_UNKNOWN
  ));
  return {
    root,
    databasePath,
    transcriptPath,
    boundary,
    identity,
    attemptId: begun.attemptId,
    prompt,
    sessionId: receiptSessionId,
    tabId,
    handoffId,
    db,
    store,
    startup,
    unresolved,
    async reconcile() {
      return reconcileAgentSendStartupRecords(unresolved, { allRecords: startup.records });
    },
  };
}

function auditExpectation({ prompt, sessionId, transcriptPath, boundary, sentAt = Date.parse('2026-09-20T12:00:00.000Z'), handoffId }) {
  return {
    handoffId,
    expectedText: prompt,
    expectedLen: prompt.length,
    expectedHash: promptAuditFingerprint(prompt),
    sentAt,
    historySessionId: sessionId,
    preSubmitBoundary: { ...boundary, transcriptPath },
    finished: false,
    submitWritten: true,
  };
}

function parseCandidate(text, transcriptPath, byteOffset, uuid, sessionId = SESSION) {
  const bytes = Buffer.from(JSON.stringify(userRecord(text, { uuid, sessionId })) + '\n');
  const candidates = readClaudeUserRecordsFromBuffer(bytes, transcriptPath, {
    baseOffset: byteOffset,
    skipLeadingPartial: false,
    bytesRead: bytes.length,
    readMode: 'private-fixture',
  });
  return candidates[0];
}

async function applyStartupDecision(store, decision) {
  if (decision.decision === 'found' && decision.audit) {
    return store.promoteFromAudit(decision.audit);
  }
  if (decision.operationKey && decision.attemptId) {
    store.markStartupUnconfirmed(decision.operationKey, decision.attemptId, decision);
  }
  return null;
}

function addPendingAttemptToSavedSession(f, { prompt, handoffId }) {
  const identity = buildDesktopHistorySendIdentity({
    tabId: f.tabId,
    handoffId,
    provider: 'claude',
    source: 'history-panel',
    sessionId: f.sessionId,
    rawPrompt: prompt,
    promptHash: promptAuditFingerprint(prompt),
    promptLength: prompt.length,
  });
  const begun = f.store.beginAttempt(identity);
  assert.equal(begun.ok, true);
  f.store.stageAttemptContext(identity.operationKey, begun.attemptId, {
    source: 'history-panel',
    sessionId: f.sessionId,
    promptText: prompt,
    transportText: prompt,
    transcriptBoundary: f.boundary,
  });
  f.store.markAttemptState(identity.operationKey, begun.attemptId, STORE_STATES.ENTER_ARMED);
  f.store.settleAttempt(identity.operationKey, begun.attemptId, {
    success: null, accepted: true, submitted: true, status: STORE_STATES.AUDIT_PENDING,
    auditPending: true, operationKey: identity.operationKey,
    attemptId: begun.attemptId, tabId: f.tabId, handoffId,
    promptHash: identity.promptHash, transcriptBoundary: f.boundary,
  });
  return { identity, attemptId: begun.attemptId };
}

function createVisualHarness(db) {
  const visual = createAgentSendVisualActivity();
  const { createAgentSendActivity } = require('./agent-send-activity');
  const activity = createAgentSendActivity({ generation: 'restart-fixture', onChanged: visual.applyMain });
  const store = createAgentSendReceiptStore(db, { onChanged: activity.update });
  for (const record of store.reconcileStartup().records) activity.update(record);
  const busyCount = (busy = false, processAlive = true) => resolveWorkflowActivityCounts([{
    tabId: TAB,
    processAlive,
    busy,
    pasteBusy: false,
    sendPending: visual.snapshot().has(TAB),
  }]).busyCount;
  return { store, visual, activity, busyCount };
}

test('native inline wrapper is selected as one exact send and restart reconciliation confirms its saved receipt and loader', async (t) => {
  const wrapper = nativeWrapper(PROMPT);
  const f = await createSavedAttempt(t, {
    afterBoundary: [userRecord(wrapper, { uuid: 'fixture-user-exact' })],
  });
  if (!f) return;

  const candidate = parseCandidate(wrapper, f.transcriptPath, f.boundary.fileSize, 'fixture-user-exact');
  assert.equal(candidate.text, wrapper, 'candidate keeps raw provider JSONL text');
  assert.equal(claudeNativePastedPromptText(candidate.text), PROMPT);

  const expectedAudit = auditExpectation({
    prompt: f.prompt,
    sessionId: f.sessionId,
    transcriptPath: f.transcriptPath,
    boundary: f.boundary,
    handoffId: f.handoffId,
  });
  assert.equal(claudeAuditTextMatches(expectedAudit, candidate.text), true);
  for (const hookText of [PROMPT, wrapper]) {
    const hookSelection = selectUniqueClaudePromptSubmitAudit([expectedAudit], hookText, {
      hookTabId: f.tabId,
      hookPpid: 701,
    });
    assert.equal(hookSelection.audit, expectedAudit,
      'plain or provider-wrapped hook and saved JSONL share the original send identity');
  }
  const selected = selectClaudePendingPromptAudit([expectedAudit], [candidate]);
  assert.equal(selected.audit, expectedAudit);
  assert.equal(selected.candidate.record.uuid, 'fixture-user-exact');
  const liveIdentity = claudeAuditCanonicalIdentity(expectedAudit, candidate.text);
  assert.equal(liveIdentity.accepted, true);
  assert.equal(liveIdentity.canonicalized, true);
  assert.equal(liveIdentity.canonicalReason, 'claude_owned_composer_provider_transform');
  assert.equal(liveIdentity.actualHash, promptAuditFingerprint(wrapper));
  assert.notEqual(liveIdentity.actualHash, f.identity.promptHash);

  const ui = createVisualHarness(f.db);
  f.store = ui.store;
  const pendingSnapshot = ui.activity.snapshot();
  assert.equal(ui.busyCount(false, true), 1,
    'status-bar/provider busy=false does not hide an unresolved send receipt');
  assert.equal(f.store.get(f.identity.operationKey).state, STORE_STATES.AUDIT_PENDING);

  const startupRecords = f.store.reconcileStartup().records;
  const [decision] = await reconcileAgentSendStartupRecords(
    startupRecords.filter(record => record.state === STORE_STATES.AUDIT_PENDING
      || record.state === STORE_STATES.DELIVERY_UNKNOWN),
    { allRecords: startupRecords },
  );
  assert.equal(decision.decision, 'found', JSON.stringify(decision));
  assert.equal(decision.audit.attemptId, f.attemptId);
  assert.equal(decision.audit.entryUuid, 'fixture-user-exact');
  assert.equal(decision.audit.recordByteOffset, f.boundary.fileSize);
  assert.equal(decision.audit.canonicalReason, 'claude_owned_composer_provider_transform');
  const promotion = await applyStartupDecision(f.store, decision);
  assert.equal(promotion.promoted, true, JSON.stringify(promotion));
  assert.equal(f.store.get(f.identity.operationKey).state, STORE_STATES.CONFIRMED);
  assert.equal(ui.busyCount(false, true), 0, 'exact wrapper confirmation releases the loader');
  ui.visual.applyMain(pendingSnapshot);
  assert.equal(ui.busyCount(false, true), 0, 'an older pre-confirmation snapshot cannot revive the loader');

  const second = f.store.beginAttempt(buildDesktopHistorySendIdentity({
    tabId: TAB,
    handoffId: 'fixture-second-handoff',
    provider: 'claude',
    source: 'history-panel',
    sessionId: f.sessionId,
    rawPrompt: f.prompt,
    promptHash: promptAuditFingerprint(f.prompt),
    promptLength: f.prompt.length,
  }));
  f.store.stageAttemptContext(second.record.operationKey, second.attemptId, {
    source: 'history-panel',
    sessionId: f.sessionId,
    promptText: f.prompt,
    transportText: f.prompt,
    transcriptBoundary: f.boundary,
  });
  f.store.markAttemptState(second.record.operationKey, second.attemptId, STORE_STATES.ENTER_ARMED);
  f.store.settleAttempt(second.record.operationKey, second.attemptId, {
    success: null, accepted: true, submitted: true, status: STORE_STATES.AUDIT_PENDING,
    auditPending: true, operationKey: second.record.operationKey,
    attemptId: second.attemptId, tabId: TAB, handoffId: 'fixture-second-handoff',
    promptHash: second.record.promptHash, transcriptBoundary: f.boundary,
  });
  assert.equal(ui.busyCount(false, true), 1, 'a distinct still-pending send keeps the same tab active');
  f.store.promoteFromAudit(decision.audit);
  assert.equal(ui.busyCount(false, true), 1, 'late idempotent proof for the first send cannot clear the second');
});

test('mismatched wrapper close ID and changed body remain unconfirmed after restart', async (t) => {
  for (const [label, text] of [
    ['close-id', nativeWrapper(PROMPT, { closeId: 'different-id' })],
    ['changed-body', nativeWrapper(PROMPT + ' changed')],
  ]) {
    const f = await createSavedAttempt(t, {
      handoffId: 'fixture-' + label,
      afterBoundary: [userRecord(text, { uuid: 'fixture-user-' + label })],
    });
    if (!f) return;
    const [decision] = await f.reconcile();
    assert.notEqual(decision.decision, 'found', label + ':' + JSON.stringify(decision));
    await applyStartupDecision(f.store, decision);
    assert.equal(f.store.get(f.identity.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
    assert.equal(f.store.get(f.identity.operationKey).attemptId, f.attemptId);
  }
});

test('foreign session receipt and byte-before-boundary match cannot confirm', async (t) => {
  const foreign = await createSavedAttempt(t, {
    handoffId: 'fixture-foreign-session',
    afterBoundary: [userRecord(nativeWrapper(PROMPT), { uuid: 'fixture-foreign-user' })],
  });
  if (!foreign) return;
  const foreignRecord = { ...foreign.store.get(foreign.identity.operationKey),
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const foreignDecision = await reconcileAgentSendStartupRecords([foreignRecord], {
    allRecords: [foreignRecord],
  }).then(([decision]) => decision);
  assert.equal(foreignDecision.decision, 'unknown');
  assert.equal(foreignDecision.reason, 'transcript-boundary-foreign-session');
  await applyStartupDecision(foreign.store, foreignDecision);
  assert.equal(foreign.store.get(foreign.identity.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);

  const older = await createSavedAttempt(t, {
    handoffId: 'fixture-older-byte',
    beforeBoundary: [userRecord(nativeWrapper(PROMPT), { uuid: 'fixture-old-user' })],
    afterBoundary: [userRecord('different later turn', { uuid: 'fixture-later-user' })],
  });
  if (!older) return;
  const [olderDecision] = await older.reconcile();
  assert.equal(olderDecision.decision, 'absent');
  assert.equal(olderDecision.evidence.candidateCount, 1);
  assert.equal(olderDecision.evidence.matchCount, 0);
  await applyStartupDecision(older.store, olderDecision);
  assert.equal(older.store.get(older.identity.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
});

test('same-text wrapped attempts consume distinct byte records FIFO and literal wrapper text stays literal', () => {
  const transcriptPath = path.resolve('/private-fixture/session.jsonl');
  const boundary = { available: true, sessionId: SESSION, transcriptPath, fileSize: 100 };
  const first = auditExpectation({ prompt: PROMPT, sessionId: SESSION, transcriptPath,
    boundary, handoffId: 'attempt-A' });
  const second = auditExpectation({ prompt: PROMPT, sessionId: SESSION, transcriptPath,
    boundary, handoffId: 'attempt-B' });
  const candidateA = parseCandidate(nativeWrapper(PROMPT, { openId: 'wrapper-A' }),
    transcriptPath, 100, 'user-A');
  const candidateB = parseCandidate(nativeWrapper(PROMPT, { openId: 'wrapper-B' }),
    transcriptPath, 500, 'user-B');
  const claimedByteOffsets = new Set();
  const firstSelection = selectClaudePendingPromptAudit([first, second], [candidateA, candidateB], { claimedByteOffsets });
  assert.equal(firstSelection.audit, first);
  assert.equal(firstSelection.candidate.record.uuid, 'user-A');
  claimedByteOffsets.add(firstSelection.candidate.byteOffset);
  const secondSelection = selectClaudePendingPromptAudit([second], [candidateA, candidateB], { claimedByteOffsets });
  assert.equal(secondSelection.audit, second);
  assert.equal(secondSelection.candidate.record.uuid, 'user-B');

  const literalWrapperRequest = nativeWrapper('literal body', { openId: 'literal-id' });
  const literalAudit = auditExpectation({ prompt: literalWrapperRequest, sessionId: SESSION,
    transcriptPath, boundary, handoffId: 'literal-wrapper-request' });
  const literalCandidate = parseCandidate(literalWrapperRequest, transcriptPath, 700, 'literal-user');
  const literalSelection = selectClaudePendingPromptAudit([literalAudit], [literalCandidate]);
  assert.equal(literalSelection.audit, literalAudit);
  const literalIdentity = claudeAuditCanonicalIdentity(literalAudit, literalCandidate.text);
  assert.equal(literalIdentity.accepted, true);
  assert.equal(literalIdentity.canonicalized, false,
    'the user-authored wrapper-looking prompt remains an exact raw-text request');
  assert.equal(literalIdentity.actualHash, promptAuditFingerprint(literalWrapperRequest));
  assert.equal(claudeAuditTextMatches(literalAudit, literalCandidate.text), true);
});

test('restart refuses to assign one native wrapper UUID to plain-body and literal-wrapper intents', async t => {
  const wrapperForFirst = nativeWrapper(PROMPT, { openId: 'collision-id' });
  const f = await createSavedAttempt(t, {
    handoffId: 'fixture-plain-body-intent',
    afterBoundary: [userRecord(wrapperForFirst, { uuid: 'fixture-shared-native-user' })],
  });
  if (!f) return;
  // The second prompt is intentionally the exact raw JSONL wrapper text, so
  // one provider record could look like either a transformed first send or a
  // literal second send unless startup considers both saved causal attempts.
  const literal = addPendingAttemptToSavedSession(f, {
    handoffId: 'fixture-literal-wrapper-intent',
    prompt: wrapperForFirst,
  });
  const startupRecords = f.store.reconcileStartup().records;
  const decisions = await reconcileAgentSendStartupRecords(
    startupRecords.filter(record => record.state === STORE_STATES.AUDIT_PENDING
      || record.state === STORE_STATES.DELIVERY_UNKNOWN),
    { allRecords: startupRecords },
  );
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every(decision => decision.decision === 'unknown'), JSON.stringify(decisions));
  assert.ok(decisions.every(decision => !decision.audit), 'no UUID is shared across different prompt intents');
  for (const decision of decisions) await applyStartupDecision(f.store, decision);
  assert.equal(f.store.get(f.identity.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(f.store.get(literal.identity.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
});

test('fresh hook route from a foreign tab cannot adopt a native wrapped prompt', () => {
  const audit = {
    handoffId: 'fresh-native-wrapper',
    expectedText: PROMPT,
    expectedLen: PROMPT.length,
    expectedHash: promptAuditFingerprint(PROMPT),
    preSubmitBoundary: { available: false, reason: 'transcript-unresolved', transcriptPath: null },
    preSubmitRouteProof: { tabId: 'owned-tab', pid: 701 },
    finished: false,
    submitWritten: true,
  };
  const foreign = selectUniqueClaudePromptSubmitAudit([audit], PROMPT, {
    hookTabId: 'foreign-tab',
    hookPpid: 701,
    hookPidTabId: 'foreign-tab',
  });
  assert.equal(foreign.audit, null);
  assert.equal(foreign.reason, 'fresh-hook-route-mismatch');
  const owned = selectUniqueClaudePromptSubmitAudit([audit], PROMPT, {
    hookTabId: 'owned-tab',
    hookPpid: 701,
    hookPidTabId: 'owned-tab',
  });
  assert.equal(owned.audit, audit);
});

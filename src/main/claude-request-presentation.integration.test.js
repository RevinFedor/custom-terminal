'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  backfillConfirmedCanonicalAuthoringPresentations,
  decorateHistoryPromptPresentations,
  promptTransportHash,
  saveAuditedPromptPresentation,
} = require('./history-prompt-presentations');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { prepareClaudePromptTransport } = require('./claude-prompt-transport');

const clone = value => JSON.parse(JSON.stringify(value));
const timestamp = n => `2026-09-21T10:00:${String(n).padStart(2, '0')}.000Z`;

function createPrivateDatabase(t, reuseDirectory = null) {
  const directory = reuseDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'claude-request-presentation-'));
  if (!reuseDirectory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const electronPath = require.resolve('electron');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app: { isPackaged: false, getPath: () => directory } },
  };
  const databasePath = require.resolve('./database');
  const previousDatabase = require.cache[databasePath];
  delete require.cache[databasePath];
  const DatabaseManager = require('./database');
  if (previousDatabase) require.cache[databasePath] = previousDatabase;
  else delete require.cache[databasePath];
  if (previousElectron) require.cache[electronPath] = previousElectron;
  else delete require.cache[electronPath];

  try {
    const manager = new DatabaseManager();
    manager.__testDirectory = directory;
    return manager;
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error.message)) {
      t.skip('run this SQLite integration test with the Electron ABI');
      return null;
    }
    throw error;
  }
}

function outerClaudeEnvelope(text, id) {
  return `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
}

function createReceiptHarness(db) {
  let nextAttempt = 0;
  const receiptStore = createAgentSendReceiptStore(db.db, {
    randomUUID: () => `attempt-${++nextAttempt}`,
  });

  function confirm({ requestText, sessionId = 'claude-request-session', entryUuid,
    auditTimestamp, wrapperId = null, snapshot = null, exactRaw = false }) {
    const prepared = prepareClaudePromptTransport(requestText);
    const operationKey = `history:tab-request:${entryUuid}`;
    const handoffId = `handoff-${entryUuid}`;
    const identity = {
      operationKey,
      surface: 'project-api',
      tabId: 'tab-request',
      handoffId,
      requestFingerprint: `request-${entryUuid}`,
      provider: 'claude',
      sessionId,
      promptHash: prepared.raw.auditHash,
      promptLength: prepared.raw.utf16Length,
    };
    const attempt = receiptStore.beginAttempt(identity);
    assert.equal(attempt.action, 'attempt-started');
    const attemptId = attempt.attemptId;
    const transportText = prepared.transport.text;
    const staged = receiptStore.stageAttemptContext(operationKey, attemptId, {
      sessionId,
      promptText: requestText,
      transportText,
      presentationSnapshot: snapshot,
      source: 'history-panel',
    });
    assert.equal(staged.ok, true);

    const actualText = exactRaw ? transportText : outerClaudeEnvelope(transportText, wrapperId);
    const actualHash = promptTransportHash(actualText);
    const audit = {
      operationKey,
      attemptId,
      provider: 'claude',
      sessionId,
      success: true,
      actualHash,
      expectedHash: prepared.raw.auditHash,
      canonicalized: !exactRaw,
      canonicalReason: exactRaw ? null : 'claude_owned_composer_provider_transform',
      entryUuid,
      auditTimestamp,
      sourceIdentity: `claude-user:${entryUuid}`,
    };
    const promoted = receiptStore.promoteFromAudit(audit);
    assert.equal(promoted.promoted, true, JSON.stringify(promoted));
    return {
      record: receiptStore.get(operationKey),
      receiptStore,
      operationKey,
      attemptId,
      audit,
      actualText,
      actualHash,
      entry: {
        uuid: entryUuid,
        role: 'user',
        timestamp: auditTimestamp,
        sessionId,
        physicalSessionId: sessionId,
        content: actualText,
        promptPresentationTransportHash: actualHash,
      },
    };
  }

  function confirmQueued({ requestText, sessionId = 'claude-request-session', entryUuid,
    auditTimestamp, wrapperId, sourceIdentity = `claude-queue:offset:${entryUuid}` }) {
    const prepared = prepareClaudePromptTransport(requestText);
    const operationKey = `history:tab-request:queued:${entryUuid}`;
    const handoffId = `handoff-queued-${entryUuid}`;
    const identity = {
      operationKey, surface: 'project-api', tabId: 'tab-request', handoffId,
      requestFingerprint: `request-queued-${entryUuid}`, provider: 'claude', sessionId,
      promptHash: prepared.raw.auditHash, promptLength: prepared.raw.utf16Length,
    };
    const attempt = receiptStore.beginAttempt(identity);
    assert.equal(attempt.action, 'attempt-started');
    const attemptId = attempt.attemptId;
    assert.equal(receiptStore.stageAttemptContext(operationKey, attemptId, {
      sessionId, promptText: requestText, transportText: prepared.transport.text,
      presentationSnapshot: null, source: 'history-panel',
    }).ok, true);
    receiptStore.markAttemptState(operationKey, attemptId, STORE_STATES.ENTER_ARMED);
    assert.equal(receiptStore.markProviderQueueAccepted(operationKey, attemptId, {
      provider: 'claude', sessionId, entryUuid: `queue-operation-${entryUuid}`,
      sourceIdentity, recordByteOffset: 100, acceptedAt: auditTimestamp,
    }).ok, true);
    receiptStore.settleAttempt(operationKey, attemptId, {
      success: null, accepted: true, submitted: true, status: 'audit-pending', auditPending: true,
    });
    const audit = {
      operationKey, attemptId, provider: 'claude', sessionId, success: true,
      actualHash: prepared.raw.auditHash, expectedHash: prepared.raw.auditHash,
      canonicalized: true, canonicalReason: 'provider-queue-remove', entryUuid: null,
      sourceIdentity, auditTimestamp,
    };
    const promoted = receiptStore.promoteFromAudit(audit);
    assert.equal(promoted.promoted, true, JSON.stringify(promoted));
    const actualText = outerClaudeEnvelope(prepared.transport.text, wrapperId);
    const rawTransportHash = promptTransportHash(actualText);
    return { record: receiptStore.get(operationKey), receiptStore, operationKey,
      attemptId, audit, actualText, rawTransportHash,
      entry: { uuid: entryUuid, role: 'user', timestamp: auditTimestamp, sessionId,
        physicalSessionId: sessionId, content: actualText, sourceIdentity,
        promptPresentationTransportHash: rawTransportHash } };
  }

  return { receiptStore, confirm, confirmQueued };
}

function present(db, entry, sessionId = entry.sessionId) {
  return decorateHistoryPromptPresentations(db, {
    toolType: 'claude',
    sessionId,
    entries: [entry],
  })[0];
}

test('actual main audit publisher persists request presentation before notifying History', t => {
  const db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db.close());
  const h = createReceiptHarness(db);
  const item = h.confirm({ requestText: 'ordinary message', entryUuid: 'live-U',
    auditTimestamp: timestamp(1), wrapperId: 'native-live' });
  const source = fs.readFileSync(require.resolve('./main'), 'utf8');
  const start = source.indexOf('function publishAgentPromptAuditResult(');
  const end = source.indexOf('\nfunction holdPasteAuditCompletionForTest(', start);
  assert.ok(start > 0 && end > start);
  const publications = [];
  const context = vm.createContext({
    agentSendReceiptStore: h.receiptStore, AGENT_SEND_DURABLE_STATES: STORE_STATES,
    projectManager: { db }, backfillConfirmedCanonicalAuthoringPresentations,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'fixture-no-runtime' }),
    isOrchestrationPromptAudit: () => false,
    routeAgentPromptAuditDetail: detail => {
      publications.push(detail);
      assert.equal(present(db, item.entry).content, item.record.receipt.promptText,
        'the renderer notification must not precede the durable presentation');
    },
    console: { log() {}, warn() {} },
  });
  vm.runInContext(source.slice(start, end), context);
  context.publishAgentPromptAuditResult(item.record.tabId, {
    handoffId: item.record.handoffId, sendOperationKey: item.operationKey,
    sendAttemptId: item.attemptId, expectedHash: item.record.promptHash,
    expectedLen: item.record.promptLength,
  }, { ...item.audit, expectedLen: item.record.promptLength }, 'claude');
  assert.equal(publications.length, 1);
  assert.equal(publications[0].sendAttemptId, item.attemptId);
});

test('confirmed Claude request presentation restores plain text and preserves inner paste chips', async t => {
  let db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db?.close());
  const harness = createReceiptHarness(db);
  const plain = harness.confirm({
    requestText: 'Please summarize the following ordinary message.',
    entryUuid: 'claude-user-plain',
    auditTimestamp: timestamp(1),
    wrapperId: 'native-plain-1',
  });
  const explicitPasteRequest = 'before <pasted_content>\n[imagePath: /literal.png]\nkeep this as one paste\n</pasted_content> after';
  const pasted = harness.confirm({
    requestText: explicitPasteRequest,
    entryUuid: 'claude-user-paste',
    auditTimestamp: timestamp(2),
    wrapperId: 'native-paste-2',
  });
  const formatted = harness.confirm({ requestText: 'before\r\n\tindented text',
    entryUuid: 'claude-user-formatted', auditTimestamp: timestamp(3), wrapperId: 'native-formatted' });

  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [plain.record, pasted.record, formatted.record]), 3);
  const plainRow = db.getHistoryPromptPresentationByAudit(
    'claude', plain.record.sessionId, timestamp(1), plain.actualHash,
  );
  const pasteRow = db.getHistoryPromptPresentationByAudit(
    'claude', pasted.record.sessionId, timestamp(2), pasted.actualHash,
  );
  assert.equal(plainRow.schemaVersion, 5);
  assert.equal(plainRow.entryUuid, plain.entry.uuid);
  assert.equal(plainRow.chips[0].kind, 'claude-request-presentation');
  assert.equal(plainRow.chips[0].origin.attemptId, plain.attemptId);
  assert.equal(Object.hasOwn(plainRow.chips[0], 'transportText'), false,
    'ordinary request text is not duplicated in the persisted presentation');
  assert.equal(pasteRow.chips[0].kind, 'claude-request-presentation');
  assert.equal(pasteRow.chips[0].origin.attemptId, pasted.attemptId);

  const plainProjected = present(db, plain.entry);
  assert.equal(plainProjected.content, plain.record.receipt.promptText);
  assert.equal(plainProjected.content, 'Please summarize the following ordinary message.');
  const composer = await import('../shared/composer-chips.mjs');
  assert.deepEqual(composer.buildHistoryComposerPresentationParts({ text: plainProjected.content }), {
    matchedPromptChips: false,
    parts: [{ kind: 'text', text: plainProjected.content }],
  });

  const pasteProjected = present(db, pasted.entry);
  assert.equal(pasteProjected.content, explicitPasteRequest);
  const pasteParts = composer.buildHistoryComposerPresentationParts({ text: pasteProjected.content }).parts;
  assert.deepEqual(pasteParts.map(part => part.kind), ['text', 'paste', 'text']);
  assert.equal(pasteParts[0].text, 'before ');
  assert.equal(pasteParts[1].text, '[imagePath: /literal.png]\nkeep this as one paste');
  assert.equal(pasteParts[2].text, ' after');
  assert.equal(pasteParts.filter(part => part.kind === 'paste').length, 1);
  assert.equal(present(db, formatted.entry).content, 'before\r\n\tindented text',
    'the proven existing request/transport codec retains original formatting');
});

test('Voice Record auto-send queued during busy restores ordinary text by exact queue source identity', async t => {
  const db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db.close());
  const h = createReceiptHarness(db);
  const dictatedText = 'Диктовка Voice Record остаётся обычным текстом. '.repeat(34).trim();
  const queued = h.confirmQueued({ requestText: dictatedText,
    entryUuid: '1f0721cc-51b3-4108-93fb-b684a6c3e491',
    auditTimestamp: '2026-09-21T18:22:54.940Z', wrapperId: '1fe1',
    sourceIdentity: 'claude-queue:offset:919f66d5:35628318' });

  assert.equal(queued.record.receipt.canonicalReason, 'provider-queue-remove');
  assert.equal(queued.record.receipt.entryUuid, null);
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [queued.record]), 1);
  const pending = db.getHistoryPromptPresentationByAudit('claude', queued.record.sessionId,
    queued.audit.auditTimestamp, queued.audit.actualHash);
  assert.equal(pending.entryUuid, null, 'the queue receipt predates the materialized user UUID');
  assert.equal(pending.chips[0].binding.sourceIdentity, queued.entry.sourceIdentity);

  const projected = present(db, queued.entry);
  assert.equal(projected.content, dictatedText);
  const rebound = db.getHistoryPromptPresentationByAudit('claude', queued.record.sessionId,
    queued.audit.auditTimestamp, queued.audit.actualHash);
  assert.equal(rebound.entryUuid, queued.entry.uuid);
  const composer = await import('../shared/composer-chips.mjs');
  assert.deepEqual(composer.buildHistoryComposerPresentationParts({ text: projected.content }).parts,
    [{ kind: 'text', text: dictatedText }]);

  assert.notEqual(present(db, { ...queued.entry, sourceIdentity: 'foreign-queue-source' }).content,
    dictatedText, 'the same wrapper/timestamp without the exact queue source cannot borrow authorship');
  assert.notEqual(present(db, { ...queued.entry,
    content: outerClaudeEnvelope('foreign body', '1fe1') }).content,
  dictatedText, 'the exact queue address cannot hide a different provider body');
});

test('two pending queue receipts cannot claim one source identity by timestamp or text similarity', t => {
  const db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db.close());
  const h = createReceiptHarness(db);
  const sourceIdentity = 'claude-queue:offset:shared-conflict';
  const first = h.confirmQueued({ requestText: 'first ordinary dictation', entryUuid: 'queue-conflict-a',
    auditTimestamp: timestamp(7), wrapperId: 'qa', sourceIdentity });
  const second = h.confirmQueued({ requestText: 'second ordinary dictation', entryUuid: 'queue-conflict-b',
    auditTimestamp: timestamp(8), wrapperId: 'qb', sourceIdentity });
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [first.record, second.record]), 2);
  assert.notEqual(present(db, first.entry).content, first.record.receipt.promptText,
    'ambiguous source identity remains provider-authored presentation');
  assert.notEqual(present(db, second.entry).content, second.record.receipt.promptText,
    'neither contender wins by insertion order');
});

test('exact raw-authored native-looking request keeps its existing presentation', async t => {
  let db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db?.close());
  const harness = createReceiptHarness(db);
  const composer = await import('../shared/composer-chips.mjs');
  const rawAuthoredText = '<pasted_content id="authored-raw">\nmy literal wrapper\n</pasted_content id="authored-raw">';
  const rawAuthored = harness.confirm({
    requestText: rawAuthoredText,
    entryUuid: 'claude-user-raw-authored',
    auditTimestamp: timestamp(3),
    exactRaw: true,
  });
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [rawAuthored.record]), 0);
  const rawProjected = present(db, rawAuthored.entry);
  assert.equal(rawProjected.content, rawAuthoredText);
  assert.deepEqual(composer.buildHistoryComposerPresentationParts({ text: rawProjected.content }).parts,
    [{ kind: 'paste', text: 'my literal wrapper' }]);
});

test('receipt and entry identity mismatches cannot apply Claude request projection', t => {
  const db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db?.close());
  const harness = createReceiptHarness(db);
  const plain = harness.confirm({
    requestText: 'Please summarize the following ordinary message.',
    entryUuid: 'claude-user-identity',
    auditTimestamp: timestamp(1),
    wrapperId: 'native-identity-1',
  });
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [plain.record]), 1);

  // The decorator must fail closed for each changed binding or changed
  // canonical carrier; none may inherit another entry's request text.
  const invalidEntries = [
    { ...plain.entry, content: outerClaudeEnvelope('wrong body', 'native-identity-1') },
    { ...plain.entry, content: plain.entry.content.replace('</pasted_content id="native-identity-1">', '</pasted_content id="foreign">') },
    { ...plain.entry, promptPresentationTransportHash: 'f'.repeat(16) },
    { ...plain.entry, physicalSessionId: 'another-session' },
    { ...plain.entry, uuid: 'another-entry-uuid' },
    { ...plain.entry, timestamp: timestamp(9) },
  ];
  for (const candidate of invalidEntries) {
    assert.notEqual(present(db, candidate).content, plain.record.receipt.promptText);
  }

  // Confirmed receipts with altered identity fields cannot create sidecars.
  const invalidReceiptRecords = [
    { ...plain.record, state: 'audit-pending' },
    { ...plain.record, attemptId: 'wrong-attempt' },
    { ...plain.record, operationKey: 'wrong-operation' },
    { ...plain.record, sessionId: 'wrong-session' },
    { ...plain.record, receipt: { ...plain.record.receipt, actualHash: 'f'.repeat(16) } },
    { ...plain.record, receipt: { ...plain.record.receipt, entryUuid: 'wrong-entry' } },
    { ...plain.record, receipt: { ...plain.record.receipt, auditTimestamp: timestamp(8) } },
    { ...plain.record, receipt: { ...plain.record.receipt, transportText: 'different body' } },
  ];
  for (const [index, invalidRecord] of invalidReceiptRecords.entries()) {
    const writes = [];
    const emptyStore = {
      getHistoryPromptPresentationByAudit: () => null,
      saveHistoryPromptPresentation: value => { writes.push(value); return true; },
    };
    // Exactly ONE invalid field, and an empty store: idempotency or a second
    // broken field must not mask a missing validation of the field under test.
    assert.equal(backfillConfirmedCanonicalAuthoringPresentations(emptyStore, [invalidRecord]), 0, `invalid-${index}`);
    assert.equal(writes.length, 0, `invalid-${index}`);
  }
});

test('competing receipt origins cannot claim one canonical presentation binding', t => {
  const db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db.close());
  const h = createReceiptHarness(db);
  const a = h.confirm({ requestText: 'same text', entryUuid: 'U', auditTimestamp: timestamp(1), wrapperId: 'native' });
  const b = clone(a.record);
  b.operationKey += '-other'; b.handoffId += '-other'; b.attemptId += '-other';
  Object.assign(b.receipt, { operationKey: b.operationKey, handoffId: b.handoffId, attemptId: b.attemptId });
  b.auditIdentity.attemptId = b.attemptId;
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [a.record, b]), 0);
  assert.equal(db.getHistoryPromptPresentations('claude', a.record.sessionId).length, 0);
});

test('same-text receipts remain separately bound and request sidecar survives late save/restart/prune', async t => {
  let db = createPrivateDatabase(t);
  if (!db) return;
  t.after(() => db?.close());
  const harness = createReceiptHarness(db);
  const composerPromise = import('../shared/composer-chips.mjs');
  const duplicateA = harness.confirm({
    requestText: 'same repeated request', entryUuid: 'claude-user-repeat-a',
    auditTimestamp: timestamp(1), wrapperId: 'native-repeat-a',
  });
  const duplicateB = harness.confirm({
    requestText: 'same repeated request', entryUuid: 'claude-user-repeat-b',
    auditTimestamp: timestamp(2), wrapperId: 'native-repeat-b',
  });
  assert.equal(backfillConfirmedCanonicalAuthoringPresentations(db, [duplicateA.record, duplicateB.record]), 2);
  const composer = await composerPromise;
  for (const item of [duplicateA, duplicateB]) {
    const row = db.getHistoryPromptPresentationByAudit('claude', item.record.sessionId,
      item.entry.timestamp, item.actualHash);
    assert.equal(row.entryUuid, item.entry.uuid);
    assert.equal(row.chips[0].origin.attemptId, item.attemptId);
    assert.equal(present(db, item.entry).content, 'same repeated request');
  }

  // A later ordinary presentation write for the same audit must preserve the
  // exact request projection instead of replacing schema 5 with schema 2.
  assert.equal(saveAuditedPromptPresentation(db, {
    toolType: 'claude',
    sessionId: duplicateA.record.sessionId,
    entryUuid: duplicateA.entry.uuid,
    auditTimestamp: duplicateA.entry.timestamp,
    actualHash: duplicateA.actualHash,
    actualText: duplicateA.actualText,
    snapshot: { promptChips: [{ id: 'late-chip', kind: 'prompt', label: 'Saved', text: 'saved context' }] },
  }), true);
  const preserved = db.getHistoryPromptPresentationByAudit('claude', duplicateA.record.sessionId,
    duplicateA.entry.timestamp, duplicateA.actualHash);
  assert.equal(preserved.schemaVersion, 5);
  assert.equal(preserved.chips.filter(chip => chip.kind === 'claude-request-presentation').length, 1);
  assert.equal(preserved.chips.filter(chip => chip.kind === 'prompt').length, 1);
  assert.equal(present(db, duplicateA.entry).content, duplicateA.record.receipt.promptText);

  const rawCanonicalContent = duplicateA.entry.content;
  const directory = db.__testDirectory;
  const requestSidecars = [duplicateA, duplicateB].map(item => clone(db
    .getHistoryPromptPresentationByAudit('claude', item.record.sessionId, item.entry.timestamp, item.actualHash)
    .chips.find(chip => chip.kind === 'claude-request-presentation')));
  db.close();
  db = createPrivateDatabase(t, directory);
  if (!db) return;
  const reopenedStore = createAgentSendReceiptStore(db.db);
  assert.equal(reopenedStore.get(duplicateA.operationKey).state, 'confirmed');
  assert.equal(reopenedStore.prune(Date.now() + 8 * 24 * 60 * 60 * 1000).deleted, 2);
  assert.equal(reopenedStore.get(duplicateA.operationKey), null);
  for (const [index, item] of [duplicateA, duplicateB].entries()) {
    const reopenedRow = db.getHistoryPromptPresentationByAudit('claude', item.record.sessionId,
      item.entry.timestamp, item.actualHash);
    assert.equal(reopenedRow.schemaVersion, 5);
    assert.deepEqual(reopenedRow.chips.find(chip => chip.kind === 'claude-request-presentation'), requestSidecars[index]);
    assert.equal(present(db, item.entry).content, 'same repeated request');
    assert.deepEqual(composer.buildHistoryComposerPresentationParts({ text: present(db, item.entry).content }).parts,
      [{ kind: 'text', text: 'same repeated request' }]);
  }
  assert.equal(duplicateA.entry.content, rawCanonicalContent, 'projection must not mutate the raw History source row');
});

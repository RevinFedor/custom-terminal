'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const retry = require('./codex-post-enter-retry');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'retryCodexEnterAfterAuditTimeout');
assert.ok(node);

for (const boundary of ['before', 'capture']) for (const disposition of ['cancel', 'unknown']) {
  test('actual Main + SQLite: ' + disposition + ' ' + boundary + ' capture cannot write another Enter; late audit survives', async t => {
    // Run on Electron-as-Node: never silently skip a missing native SQLite ABI.
    const db = new Database(':memory:'); t.after(() => db.close());
    const store = createAgentSendReceiptStore(db, { now: () => 200 });
    const identity = { operationKey: 'test:O', tabId: 'test-tab', handoffId: 'H',
      requestFingerprint: 'immutable-request', provider: 'codex', sessionId: 'S',
      surface: 'history', promptHash: 'hash-A', promptLength: 9 };
    const attempt = store.beginAttempt(identity);
    store.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, accepted: true,
      status: 'audit-pending', auditPending: true, promptText: 'unchanged', enterWritten: true });
    const revoke = () => {
      if (disposition === 'cancel') assert.equal(store.cancelDelivery({ ...identity, attemptId: attempt.attemptId }).ok, true);
      else assert.equal(store.markDeliveryUnknown(identity.operationKey, attempt.attemptId,
        { reason: 'test-audit-timeout', decision: 'unknown' }).applied, true);
    };
    if (boundary === 'before') revoke();
    let revision = 8, copies = 0; const writes = [], term = { write: bytes => writes.push(bytes) };
    const audit = { sendOperationKey: identity.operationKey, sendAttemptId: attempt.attemptId,
      handoffId: 'H', submitWritten: true, expectedText: 'unchanged', enterInputRevision: 8,
      enterRunSeq: 3, enterLifecycleGeneration: 'G' };
    const context = vm.createContext({ ...retry, agentSendReceiptStore: store, terminals: new Map([[identity.tabId, term]]),
      terminalCommandState: new Map([[identity.tabId, { runSeq: 3 }]]), codexTurnWatchers: new Map(),
      ptyLastQueuedWriteOperation: new Map(), getTerminalLifecycleGeneration: () => 'G', getTerminalInputRevision: () => revision,
      async captureAgentInputAtWriteBoundary() {
        copies++; await Promise.resolve(); if (boundary === 'capture') revoke(); revision++;
        return { success: true, terminalIdentityStable: true, terminalRunSeq: 3,
          terminalLifecycleGeneration: 'G', inputRevision: revision, text: 'unchanged', images: 0 };
      }, recordComposerForensicPtyInput() {}, codexSubmitDropTestFault: { consume: () => false },
      markActivePtySubmit() {}, console: { warn() {} } });
    vm.runInContext(node.getText(ast), context);
    await context.retryCodexEnterAfterAuditTimeout({ tabId: identity.tabId, term, audit,
      timeoutResult: { error: 'codex_user_message_audit_timeout' }, logPrefix: 'test' });
    assert.deepEqual(writes, []);
    assert.equal(copies, boundary === 'before' ? 0 : 1);
    const record = store.get(identity.operationKey);
    assert.equal(record.attemptId, attempt.attemptId);
    assert.equal(record.receipt.submitted, true, 'cancellation cannot claim the earlier Enter did not happen');
    const promoted = store.promoteFromAudit({ ...identity, attemptId: attempt.attemptId, success: true,
      expectedHash: 'hash-A', entryUuid: 'entry-A', sourceIdentity: 'codex-user-S-42',
      auditTimestamp: '2026-10-16T09:45:34.795Z', transcriptBoundary: { byteOffset: 42, line: 7 } });
    assert.equal(promoted.promoted, true, 'exact late audit is still allowed');
    assert.equal(store.get(identity.operationKey).state, 'confirmed');
    if (disposition === 'cancel') assert.equal(store.get(identity.operationKey).deliveryControl.attemptId, attempt.attemptId);
  });
}

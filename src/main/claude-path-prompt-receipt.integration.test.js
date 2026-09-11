'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { createAgentSendActivity } = require('./agent-send-activity');
const history = require('./agent-history-send-receipt');
const audit = require('./claude-prompt-audit');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function find(predicate, root = ast) {
  let result;
  function visit(node) {
    if (!result && predicate(node)) result = node;
    if (!result) ts.forEachChild(node, visit);
  }
  visit(root);
  assert.ok(result, 'actual main boundary found');
  return result;
}
const noAudit = find(node => ts.isIfStatement(node)
  && node.expression.getText(ast) === '!isCodexPasteSource && awaitClaudeUserMessageAudit');
const noAuditBody = noAudit.thenStatement.getText(ast);
const sendCommand = find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'sendClaudeCommandUnclaimed').getText(ast);
const append = find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'ipcMain.handle'
  && node.expression.arguments[0]?.text === 'claude:append-input').getText(ast);
const log = { log() {}, warn() {}, error() {} };

for (const prompt of ['/Users/fedor/Desktop/voice-record Так, хочу описать задачу',
  '/tmp/input.txt', '/status\nexplain this example', 'ordinary prompt', '/compact', '/model haiku']) {
  test('actual command and append callers agree with receipt/audit for ' + JSON.stringify(prompt), async () => {
    const calls = [], handlers = new Map();
    const context = vm.createContext({
      ...history, ...require('./prompt-queue-source'), console: log,
      terminals: new Map([['T', {}]]), mainWindow: null,
      claudeCtrlCDangerZone: new Map(), hasLiveClaudeInTab: () => true,
      claudeStartupTestFaultActive: () => false, CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 8000,
      validatePromptQueueImageMarkers: async () => ({ success: true }),
      submitWithClaudeLocalCommandLifecycle: async ({ submit }) => submit(),
      safePasteAndSubmit: async (_term, content, options) => {
        calls.push({ content, options }); return { success: true, submitted: true };
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    });
    vm.runInContext(sendCommand + '\n' + append, context);
    await context.sendClaudeCommandUnclaimed('T', prompt, { source: 'prompt-queue',
      handoffId: 'H', awaitUserMessageAudit: true });
    await handlers.get('claude:append-input')(null, 'T', prompt, { submit: true });
    assert.equal(calls.length, 2);
    const expected = !history.isLocalSlashCommandPrompt(prompt);
    for (const call of calls) {
      assert.equal(call.options.awaitClaudeUserMessageAudit, expected);
      assert.equal(audit.shouldStageClaudeUserPromptAudit({
        content: call.content, submit: true, broadcastTabId: 'T',
      }), expected);
    }
    assert.equal(history.isDesktopHistorySendReceiptEligible({ source: 'history-panel',
      rawPrompt: prompt, tabId: 'T', handoffId: 'H', submit: true }), expected);
  });
}

function receiptHarness(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const activity = createAgentSendActivity();
  const store = createAgentSendReceiptStore(db, { onChanged: activity.update });
  const identity = history.buildDesktopHistorySendIdentity({
    tabId: 'T', handoffId: 'H', provider: 'claude', source: 'history-panel',
    rawPrompt: '/Users/fedor/project request', promptHash: 'hash', promptLength: 28,
  });
  const begun = store.beginAttempt(identity);
  store.markAttemptState(identity.operationKey, begun.attemptId, 'enter-armed');
  store.settleAttempt(identity.operationKey, begun.attemptId, {
    submitted: true, success: null, status: 'audit-pending', auditPending: true,
  });
  const context = vm.createContext({
    ...history, console: log, Date, logPrefix: '[test]', t0: Date.now(),
    broadcastTabId: 'T', sendOperationKey: identity.operationKey,
    sendAttemptId: begun.attemptId, agentSendReceiptStore: store,
    AGENT_SEND_DURABLE_STATES: STORE_STATES, chunks: ['prompt'], renderTimes: [],
    resolvedSubmitLabel: 'Enter',
  });
  vm.runInContext('function completeMissingAudit() ' + noAuditBody, context);
  return { store, activity, identity, attemptId: begun.attemptId, context };
}

test('209: actual no-audit exit settles SQLite and clears shared send activity without pretending failure or SENT', t => {
  const h = receiptHarness(t);
  assert.deepEqual(h.activity.snapshot().pendingTabIds, ['T']);
  const result = h.context.completeMissingAudit();
  assert.equal(result.status, 'delivery-unknown');
  assert.equal(result.submitted, true);
  assert.equal(result.auditPending, false);
  assert.equal(h.store.get(h.identity.operationKey).state, 'delivery-unknown');
  assert.deepEqual(h.activity.snapshot().pendingTabIds, []);
  const replay = h.store.beginAttempt(h.identity);
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attemptId, h.attemptId, 'unknown never authorizes another Enter');
});

test('a late exact confirmation wins the missing-observer fallback', t => {
  const h = receiptHarness(t);
  h.store.promoteFromAudit({ operationKey: h.identity.operationKey, attemptId: h.attemptId,
    tabId: 'T', handoffId: 'H', provider: 'claude', sessionId: 'S', promptHash: 'hash',
    expectedHash: 'hash', actualHash: 'hash', success: true, entryUuid: 'user-1',
    auditTimestamp: new Date().toISOString() });
  const result = h.context.completeMissingAudit();
  assert.equal(result.success, true);
  assert.equal(h.store.get(h.identity.operationKey).state, 'confirmed');
  assert.deepEqual(h.activity.snapshot().pendingTabIds, []);
});

test('a stale no-audit callback cannot settle another attempt', t => {
  const h = receiptHarness(t);
  h.context.sendAttemptId = 'stale-attempt';
  h.context.completeMissingAudit();
  assert.equal(h.store.get(h.identity.operationKey).state, 'audit-pending');
  assert.deepEqual(h.activity.snapshot().pendingTabIds, ['T']);
});

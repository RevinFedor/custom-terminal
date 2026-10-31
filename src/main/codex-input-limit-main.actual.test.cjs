'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createCodexSettingsSendRuntime } = require('./codex-settings-send');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const main = fs.readFileSync(require.resolve('./main'), 'utf8'), tree = ts.createSourceFile('main.js', main, 99, true);
const fn = name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const large = 'x'.repeat(1048577), forbidden = () => assert.fail('no composer/settings/payload/Enter is allowed');
function harness(t, provider = 'codex') {
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  t.after(() => db.close());
  const term = { write: forbidden }, handlers = new Map();
  const context = vm.createContext({ require, path, srcMainDir: __dirname,
    console: { log() {}, warn() {} }, Buffer, nodePerformance: { now: Date.now },
    agentSendReceiptStore: store, terminals: new Map([['T', term]]),
    resolveAiToolTypeForTab: () => provider, findTabIdForTerm: () => 'T',
    captureAgentInputIdentity: () => ({}), captureCodexSendStartupFrameWait: () => null,
    readAgentSendPreparation: () => null, agentSendExecutionFailure: () => null,
    agentSendCancellations: { isCancelled: () => false }, isPromptQueueAutomationSource: () => false,
    prepareCodexMainComposerForSend: forbidden, desktopHistorySendReplayResult: record => ({
      code: 'existing-receipt-replay', state: record.state, submitted: null }),
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 8000, CODEX_PASTE_AUDIT_TIMEOUT_MS: 8000,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  const registration = tree.statements.find(node => ts.isExpressionStatement(node)
    && node.expression.expression?.getText(tree) === 'ipcMain.handle'
    && node.expression.arguments[0]?.text === 'codex:send-command');
  vm.runInContext([fn('agentCodexInputLimitFailure').getText(tree), fn('_safePasteAndSubmitInner').getText(tree),
    registration.getText(tree)].join('\n'), context);
  return { context, store, term, command: handlers.get('codex:send-command') };
}
test('actual Codex command and common paste reject before composer, settings or PTY writes', async t => {
  const h = harness(t);
  for (const scalar of ['x', '\u044f', '\ud83d\ude00']) {
    const input = scalar.repeat(1048577);
    for (const result of [await h.command(null, 'T', input, { source: 'history-panel' }),
      await h.context._safePasteAndSubmitInner(h.term, input, { source: 'codex-history-panel' })]) {
      assert.equal(result.code, 'codex_message_too_large'); assert.equal(result.submitted, false);
      assert.equal(result.pasteWritten, false); assert.equal(result.enterWritten, false);
      assert.equal(result.inputLimit.actual, 1048577);
    }
  }
});
test('existing Stop/preparation refusal wins before the command input-limit guard', async t => {
  const h = harness(t), cancelled = { code: 'agent_send_cancelled', submitted: false };
  h.context.agentSendExecutionFailure = () => cancelled;
  assert.equal(await h.command(null, 'T', large, {}), cancelled);
});
test('final private image projection is counted without a false raw-path rejection', t => {
  const h = harness(t);
  const paste = fn('_safePasteAndSubmitInner');
  let declaration, next;
  const visit = node => {
    if (ts.isBlock(node)) {
      const index = node.statements.findIndex(value => ts.isVariableStatement(value)
        && value.declarationList.declarations.some(value => value.name.getText(tree) === 'finalInputFailure'));
      if (index >= 0) { declaration = node.statements[index]; next = node.statements[index + 1]; }
    }
    ts.forEachChild(node, visit);
  };
  visit(paste); assert.ok(declaration && next);
  const verifyFinal = vm.runInContext('(function(content, codexImagePasteSegments, submit=true) {'
    + 'const broadcastTabId="T", options={}, sendOperationKey=null, sendAttemptId=null;'
    + declaration.getText(tree) + '\n' + next.getText(tree) + '; return null; })', h.context);
  assert.equal(h.context.agentCodexInputLimitFailure('T', large + '[imagePath: /long/path]', {}), null);
  assert.equal(verifyFinal(large, [{ kind: 'text', text: 'x'.repeat(1048566) }, { kind: 'image', path: '/image' }]), null);
  const rejected = verifyFinal('short transformed path', [{ kind: 'text', text: 'x'.repeat(1048567) }, { kind: 'image', path: '/image' }]);
  assert.equal(rejected.inputLimit.actual, 1048577);
  assert.equal(rejected.submitted, false);
  assert.equal(verifyFinal(large, null, false), null, 'editable draft paste is not a message submit');
});
test('current crossed/UNKNOWN receipt is replayed, not rewritten as a fresh no-submit', t => {
  const h = harness(t), identity = { operationKey: 'O', handoffId: 'H', tabId: 'T', surface: 'desktop-history',
    provider: 'codex', sessionId: 'S', requestFingerprint: 'request', promptHash: promptAuditFingerprint(large), promptLength: large.length };
  h.store.reserveOrGet(identity);
  const attempt = h.store.beginAttempt(identity);
  h.store.markAttemptState('O', attempt.attemptId, 'enter-armed');
  h.store.settleAttempt('O', attempt.attemptId, { submitted: true, pasteWritten: true, enterWritten: true,
    auditPending: true, status: 'audit-pending' });
  h.store.markDeliveryUnknown('O', attempt.attemptId, { code: 'original-unknown' });
  assert.equal(h.store.get('O').state, 'delivery-unknown');
  const result = h.context.agentCodexInputLimitFailure('T', large, { sendOperationKey: 'O', handoffId: 'H', sendAttemptId: attempt.attemptId });
  assert.equal(result.code, 'existing-receipt-replay'); assert.equal(result.submitted, null);
  assert.equal(h.store.get('O').state, 'delivery-unknown');
  assert.equal(h.store.get('O').receipt.code, 'original-unknown');
});
test('atomic settings owner rejects oversized input before selector or settings writes', async () => {
  const runtime = createCodexSettingsSendRuntime({ readScope: () => ({ terminal: {}, live: true }),
    readSettings: forbidden, withSettingsQueue: forbidden, withWriteLock: forbidden,
    selectSettings: forbidden, paste: forbidden, sendLocalCommand: forbidden });
  const result = await runtime.sendPrompt({ tabId: 'T', content: large, model: 'requested-model', effort: 'high' });
  assert.equal(result.code, 'codex_message_too_large'); assert.equal(result.enterWritten, false);
});
test('Main limit helper leaves equally large Claude input on its existing path', t => {
  const h = harness(t, 'claude');
  assert.equal(h.context.agentCodexInputLimitFailure('T', large, {}, true), null);
});

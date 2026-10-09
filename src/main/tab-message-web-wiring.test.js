'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { CompletionContentStore, buildOrchestrationCompletionContent, MAX_INLINE_ASSISTANT_CHARS } = require('./orchestration-completion-content');
const { captureOrchestrationResultAttempt, orchestrationResultAttemptMatches, isCompleteOrchestrationResult } = require('./orchestration-runs');
const { formatTabMessagePrompt } = require('./tab-messages');
const { isDesktopHistorySendReceiptEligible } = require('./agent-history-send-receipt');
const { isResponseObservation } = require('./orchestration-response-observation');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};

test('actual dismiss IPC routes to presentation-only service and returns compact metadata', async () => {
  const exported = ast.statements.find(n => ts.isExpressionStatement(n)
    && ts.isBinaryExpression(n.expression) && n.expression.left.getText(ast) === 'module.exports').expression.right;
  const dismiss = exported.properties.find(n => n.name?.getText(ast) === 'dismissTabMessage').initializer.getText(ast);
  const calls = [];
  const context = vm.createContext({ compactTabMessage: require('./tab-message-api').compactTabMessage,
    getTabMessageService: () => ({ dismissMessage: input => {
      calls.push(JSON.parse(JSON.stringify(input)));
      return { message: { messageId: 'q', sourceDismissedAt: 9, text: 'private body', deliveryState: 'sent' }, deduplicated: false };
    } }) });
  const dismissTabMessage = vm.runInContext('(' + dismiss + ')', context);
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const tree = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
  let registration;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle'
      && node.arguments[0]?.text === 'tab-messages:dismiss') registration = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(registration);
  let handler;
  vm.runInNewContext(registration, { ipcMain: { handle: (_name, fn) => { handler = fn; } }, webServer: { dismissTabMessage } });
  const result = await handler({}, { tabId: 'a', messageId: 'q' });
  assert.deepEqual(calls, [{ tabId: 'a', messageId: 'q' }]);
  assert.equal(result.message.sourceDismissedAt, 9);
  assert.equal(Object.hasOwn(result.message, 'text'), false);
  assert.equal(result.message.deliveryState, 'sent');
});

test('actual message adapter pins the recipient, prepares context once and passes durable receipts to the shared sender', async () => {
  const calls = [], frozen = [];
  const message = { messageId: 'm', kind: 'question', text: 'Exact question', sourceTabId: 'a', sourceTabName: 'A',
    sourceProjectId: 'p', targetTabId: 'b', targetTabName: 'B', targetProjectId: 'p',
    targetProvider: 'codex', targetSessionId: 'sb', targetCwd: '/synthetic',
    handoffId: 'tab-message:m', operationKey: 'tab-message:m' };
  message.prompt = formatTabMessagePrompt(message);
  const prefix = '<saved_prompt name="state" context-update-id="c">Updated file</saved_prompt>\n\n';
  const service = { updateFrozenPrompt: (...args) => frozen.push(args), reconcileReceipts() {},
    assertDeliveryActive: id => assert.equal(id, message.messageId) };
  const context = vm.createContext({
    crypto: require('node:crypto'),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: { pinForOwner() {} }, getTabMessageService: () => service,
    formatTabMessagePrompt, resolveAgentSessionInfo: async () => ({ status: 'busy' }),
    tabWorkContext: { prepare: async (_tabId, _handoffId, prompt) => ({ prompt: prefix + prompt }) },
    runAgentSendScenario: async args => { calls.push(args); return { status: 'queued', submitted: true, accepted: true }; },
  });
  vm.runInContext(declaration('sendTabMessage') + '\nthis.send = sendTabMessage;', context);
  await context.send(message);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.queue, true);
  assert.equal(call.expectedTarget.sessionId, 'sb');
  assert.equal(call.expectedTarget.toolType, 'codex');
  assert.equal(call.sendOperationKey, message.operationKey);
  assert.equal(call.workContextPrepared, true);
  assert.equal(call.sendSurface, 'tab-message');
  assert.equal(frozen[0][1], call.prompt);
  const tag = call.presentationSnapshot.semanticTags[0];
  assert.equal(call.prompt.slice(tag.bodyStart, tag.bodyEnd), message.text);
  assert.equal(call.prompt.slice(0, tag.envelopeStart), prefix);
  for (const sendSource of ['tab-message:m', 'codex-tab-message:m']) {
    assert.equal(isDesktopHistorySendReceiptEligible({ submit: true, tabId: 'b', handoffId: message.handoffId,
      source: sendSource, rawPrompt: call.prompt }), true, 'provider queue must have an eligible durable receipt');
  }
  await context.send({ ...message, preparedPrompt: call.prompt });
  assert.equal(frozen.length, 1);
  assert.equal(calls[1].prompt, call.prompt, 'prepared context cannot be appended twice');
});

test('actual completion preparation freezes verified native/browser content and preserves old handoffs', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const snapshots = new CompletionContentStore({ db });
  let run = { runId: 'native', status: 'completed', resultComplete: true, completedAt: 5,
    sourceSendTarget: { toolType: 'codex', sessionId: 'sa' },
    sourceTabId: 'a', targetTabId: 'b', targetToolType: 'codex', sessionId: 'sb', targetTabName: 'B' };
  let reads = 0;
  const context = vm.createContext({
    crypto: require('node:crypto'),
    getCompletionContentStore: () => snapshots, getOrchestrationRunStore: () => ({ getInternal: async () => run }),
    captureOrchestrationResultAttempt, orchestrationResultAttemptMatches, isCompleteOrchestrationResult,
    buildOrchestrationCompletionContent, MAX_INLINE_ASSISTANT_CHARS,
    isResponseObservation, isExternalResearchRun: run => run.runKind === 'external-research', resolvedPort: 7988,
    probeOrchestrationResult: async () => { reads++; return { found: true, sourceVerified: true, complete: true,
      resultComplete: true, assistantText: '## Verified result\n\nFull **Markdown** answer', assistantChars: 43 }; },
    readExternalResearchResult: async () => { reads++; return { statusCode: 200, body: { ready: true, success: true,
      assistantText: 'Browser answer', conversationUrl: 'https://chatgpt.com/c/saved', jobId: 'job-b' } }; },
    console: { log() {} },
  });
  vm.runInContext(declaration('prepareOrchestrationCompletionContent') + '\n' + declaration('orchestrationPresentationSnapshot')
    + '\nthis.prepare = prepareOrchestrationCompletionContent;this.presentation = orchestrationPresentationSnapshot;', context);
  const native = await context.prepare(run);
  assert.equal(native.mode, 'inline');
  assert.match(native.prompt, /Full \*\*Markdown\*\* answer/);
  assert.doesNotMatch(native.prompt, /get_delegation_result/);
  assert.equal((await context.prepare(run)).prompt, native.prompt);
  assert.equal(reads, 1, 'retry uses persisted snapshot without rereading a mutable result');
  const prefix = '<saved_prompt name="context">delta</saved_prompt>\n';
  const tag = context.presentation(run, 'completion', native, prefix + native.prompt).semanticTags[0];
  assert.equal((prefix + native.prompt).slice(tag.bodyStart, tag.bodyEnd), '## Verified result\n\nFull **Markdown** answer');
  assert.equal(tag.envelopeStart, prefix.length);
  run = { ...run, runId: 'legacy', notificationAttempt: 1 };
  assert.equal(await context.prepare(run), null, 'old in-flight handoff retains old technical payload');
  run = { ...run, runId: 'browser', runKind: 'external-research', notificationAttempt: 0 };
  const browser = await context.prepare(run);
  assert.equal(browser.mode, 'inline');
  assert.equal(browser.metadata.conversationUrl, 'https://chatgpt.com/c/saved');
  run = { ...run, runId: 'failure', status: 'failed', error: 'Provider refused' };
  const failure = await context.prepare(run);
  assert.equal(failure.mode, 'failure');
  assert.match(failure.prompt, /Provider refused/);
});

test('completion read that races cancellation never freezes or sends the answer', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = new CompletionContentStore({ db });
  const run = { runId: 'changed', status: 'completed', completedAt: 5, sourceSendTarget: { toolType: 'codex', sessionId: 'sa' } };
  const context = vm.createContext({ getCompletionContentStore: () => store,
    getOrchestrationRunStore: () => ({ getInternal: async () => ({ ...run, notificationSuppressed: true }) }),
    captureOrchestrationResultAttempt, orchestrationResultAttemptMatches, isCompleteOrchestrationResult,
    buildOrchestrationCompletionContent, MAX_INLINE_ASSISTANT_CHARS, isResponseObservation, isExternalResearchRun: () => false,
    probeOrchestrationResult: async () => ({ found: true, sourceVerified: true, complete: true, resultComplete: true, assistantText: 'Answer' }),
  });
  vm.runInContext(declaration('prepareOrchestrationCompletionContent') + '\nthis.prepare = prepareOrchestrationCompletionContent;', context);
  await assert.rejects(context.prepare(run), /completion_changed_during_read/);
  assert.equal(store.get(run.runId), null);
});

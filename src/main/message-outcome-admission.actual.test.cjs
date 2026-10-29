'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const ts = require('typescript'), Database = require('better-sqlite3');
const { MessageLoopWaits } = require('./message-loop-waits');
const { TabWorkContext } = require('./tab-work-context');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
async function fixture(t) {
  const db = new Database(':memory:'), admitted = Symbol('admission'), notices = [];
  const q = { messageId: '34ed1e13-8ec5-453c-97f6-0de0df0c5c07', kind: 'question', requestId: 'Q', deliveryState: 'failed',
    source: { tabId: 'A', projectId: 'P', provider: 'codex', sessionId: 'S', cwd: '/controlled' }, targetTabId: 'B', targetTabName: 'B' };
  const owner = new MessageLoopWaits({ db,
    messages: { questionWaitReference: () => q, questionWaitReferences: () => [q] },
    readSource: async () => ({ ...q.source, known: true }),
    readDelivery: () => ({ state: 'absent', provenNoInput: true }), readCompletion: async () => ({ known: false }),
    sendNotice: async (notice, _source, ref) => { notices.push({ notice, ref }); },
    setDeadline: () => 1, clearDeadline() {} });
  owner.observe(q); await owner.reconcile();
  const { notice, ref } = notices[0];
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: 'A', projectId: 'P' }] });
  context.publish('A', { sourceTabId: 'B', title: 'Controlled context', text: 'one preserved prefix', requestId: 'CTX' });
  const prepared = await context.prepare('A', notice.handoffId, notice.prompt);
  assert.notEqual(prepared.prompt, notice.prompt);
  const c = vm.createContext({ MESSAGE_OUTCOME_ADMISSION: admitted, getMessageLoopWaits: () => owner,
    tabWorkContext: context, crypto, fingerprintAgentSendRequest });
  vm.runInContext(declaration('resolveMessageWaitOutcome') + declaration('runAgentSendScenario')
    + '\nglobalThis.resolve=resolveMessageWaitOutcome; globalThis.send=runAgentSendScenario;', c);
  const args = { tabId: 'A', provider: 'codex', sessionId: 'S', source: notice.id,
    sendOperationKey: notice.operationKey, handoffId: notice.handoffId, expectedTarget: notice.destination.expectedTarget,
    prompt: prepared.prompt, messageOutcomeRef: ref, [admitted]: true };
  t.after(() => { owner.dispose(); db.close(); });
  return { q, owner, notice, ref, args, c, admitted, context };
}
test('actual restored outcome resolver accepts only the same logical body through the app-owned prepared prefix', async t => {
  const h = await fixture(t); const result = await h.c.resolve(h.args); await result.prepareSend();
  assert.equal(h.context.readPreparedHandoff('A', h.notice.handoffId).prepared_prompt, h.args.prompt);
  assert.equal(h.owner.entrySnapshot(h.q.messageId).state, 'settled', 'durable outcome needs no mandatory processing turn');
});
for (const [name, change] of [
  ['foreign tab', args => ({ ...args, tabId: 'C' })],
  ['foreign operation', args => ({ ...args, sendOperationKey: 'other' })],
  ['foreign handoff', args => ({ ...args, handoffId: 'other' })],
  ['replacement SID', args => ({ ...args, sessionId: 'other' })],
  ['replacement target', args => ({ ...args, expectedTarget: { toolType: 'codex', sessionId: 'other' } })],
  ['mutable payload', args => ({ ...args, prompt: args.prompt + 'changed' })],
  ['mutable logical ref', args => ({ ...args, messageOutcomeRef: { ...args.messageOutcomeRef, logicalPrompt: 'changed' } })],
]) test('actual outcome admission refuses ' + name + ' before input', async t => {
  const h = await fixture(t); await assert.rejects(h.c.resolve(change(h.args)), /message_outcome_/);
});
test('cancel after preparation revokes the same restored FIFO callback before a new input', async t => {
  const h = await fixture(t); const prepared = await h.c.resolve(h.args);
  h.q.cancelledAt = '2026-10-23T00:00:00Z'; h.owner.observe(h.q);
  await assert.rejects(prepared.prepareSend(), /message_outcome_revoked/);
});
test('public source/ref forgery cannot get the private outcome admission or enter the sender', async t => {
  const h = await fixture(t), args = { ...h.args }; delete args[h.admitted];
  await assert.rejects(h.c.send(args), /server-owned/);
  await assert.rejects(h.c.resolve(args), /server-owned/);
});

test('new presentation metadata cannot rewrite a frozen old outcome during receipt recovery', async () => {
  const original = { tabId: 'A', source: 'tab-message-outcome:34ed1e13-8ec5-453c-97f6-0de0df0c5c07',
    handoffId: 'fixed-outcome', sendOperationKey: 'fixed-operation', provider: 'codex', sessionId: 'S',
    prompt: 'frozen old notice', presentationSnapshot: null, messageOutcomeRef: { questionId: 'Q' } };
  const frozen = JSON.stringify(original), writes = [], admitted = Symbol('private');
  const c = vm.createContext({ MESSAGE_OUTCOME_ADMISSION: admitted, agentSendReceiptStartupReady: Promise.resolve(),
    agentSendReceiptStore: { pinForOwner() {} }, fingerprintAgentSendRequest,
    agentSendQueue: { item: () => ({ request_json: frozen, request_hash: fingerprintAgentSendRequest(original) }) },
    withPromptOriginPresentation: () => assert.fail('frozen request is not re-prepared'),
    runAgentSendScenario: request => { writes.push(request); return { accepted: true }; } });
  vm.runInContext(declaration('sendMessageWaitOutcome') + '\nglobalThis.send=sendMessageWaitOutcome;', c);
  await c.send({ operationKey: original.sendOperationKey }, { tabId: 'replacement' }, { questionId: 'other' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].prompt, original.prompt);
  assert.equal(writes[0].presentationSnapshot, null);
  assert.equal(writes[0].sessionId, 'S');
  assert.equal(writes[0].handoffId, 'fixed-outcome');
  assert.equal(writes[0].messageOutcomeRef.questionId, 'Q');
  assert.equal(writes[0][admitted], true);
  assert.equal(JSON.stringify(original), frozen);
});

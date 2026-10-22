'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { DirectorySqlite } = require('./fixtures/workflow-directory-sqlite.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createSendPreparationScope } = require('./agent-send-preparation');
const { historySendReturnControl } = require('./history-send-return');
const { writeWithSendEnterTiming, writeWithSendPayloadTiming } = require('./agent-send-enter-timing');
const source = fs.readFileSync(process.env.HISTORY_TIMING_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
async function fixture(t, promptText = 'original message', { returned = false } = {}) {
  const db = new DirectorySqlite(); t.after(() => db.close());
  const store = createAgentSendReceiptStore(db), identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H',
    provider: 'codex', surface: 'desktop-history', requestFingerprint: 'immutable', promptHash: 'hash', promptLength: promptText.length };
  const control = historySendReturnControl(store);
  assert.equal(control.register({ ...identity, token: 'return-token' }).success, true);
  const attemptId = store.beginAttempt(identity).attemptId;
  const scope = createSendPreparationScope({ ...identity, attemptId }, 6000);
  assert.equal(store.stageAttemptContext(identity.operationKey, attemptId, { preflightScope: scope, promptText }).ok, true);
  if (returned) assert.equal(control.request({ ...identity, token: 'return-token' }).returned, true);
  const events = [], writes = [], clock = { now: 7000 };
  const context = vm.createContext({ agentSendReceiptStore: store, historySendReturnControl,
    writeWithSendEnterTiming, writeWithSendPayloadTiming, queueMicrotask,
    Date: { now: () => clock.now }, console: { log() {}, warn() {} },
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } } });
  vm.runInContext(['publishHistorySendReturn','writeHistorySendPayload','writeHistorySendEnter'].map(declaration).join('\n'), context);
  const owner = { sendOperationKey: identity.operationKey, sendAttemptId: attemptId, preparationStartedAt: 6000 };
  const term = { write(data) { writes.push({ data, at: clock.now }); return 'write-return'; } };
  return { db, store, identity, attemptId, scope, control, events, writes, clock, context, owner, term,
    flush: () => new Promise(resolve => queueMicrotask(resolve)) };
}

test('actual Main+private SQLite: queue residence excluded; first authored payload call is distinct from earlier Enter/service paste', async t => {
  const h = await fixture(t), before = h.store.get(h.identity.operationKey);
  assert.deepEqual(before.receipt.sendInputTiming, { version: 1, preparationStartedAt: 6000 });
  h.context.writeHistorySendEnter(h.term, '\r', { ...h.identity, ...h.owner }); await h.flush();
  assert.equal(h.store.get(h.identity.operationKey).receipt.enterAttemptAt, 7000);
  h.clock.now = 8000; h.context.writeHistorySendPayload(h.term, '/model', 'T', 'H'); await h.flush();
  assert.equal(h.store.get(h.identity.operationKey).receipt.sendInputTiming.payloadStartedAt, undefined);
  h.clock.now = 18000;
  assert.equal(h.context.writeHistorySendPayload(h.term, 'original message', 'T', 'H', h.owner), 'write-return');
  await h.flush();
  const timing = h.store.get(h.identity.operationKey).receipt.sendInputTiming;
  assert.deepEqual(timing, { version: 1, preparationStartedAt: 6000, payloadStartedAt: 18000 });
  const posted = h.events.filter(e => e.channel === 'agent:send-input-attempt');
  assert.equal(posted.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(posted[0].data.sendInputTiming)), timing);
  h.clock.now = 27000; h.context.writeHistorySendPayload(h.term, 'second chunk', 'T', 'H', h.owner); await h.flush();
  assert.deepEqual(h.store.get(h.identity.operationKey).receipt.sendInputTiming, timing);
  assert.equal(h.events.filter(e => e.channel === 'agent:send-input-attempt').length, 2,
    'two explicit helper calls were observed; real caller supplies timing only on chunk0 and replica preserves its first');
});

test('receipt timing never changes state/slot/audit/target/deadline; stale H/O/A and old scope cannot edit it', async t => {
  const h = await fixture(t); h.store.markAttemptState(h.identity.operationKey, h.attemptId, 'enter-armed');
  const before = h.store.get(h.identity.operationKey);
  assert.equal(h.store.recordPayloadAttempt({ ...h.identity, attemptId: 'old', payloadStartedAt: 18000 }), null);
  assert.equal(h.store.recordPayloadAttempt({ ...h.identity, handoffId: 'foreign', attemptId: h.attemptId, payloadStartedAt: 18000 }), null);
  assert.equal(h.store.recordPayloadAttempt({ ...h.identity, attemptId: h.attemptId, payloadStartedAt: 18000 }).newlyStarted, true);
  const after = h.store.get(h.identity.operationKey);
  assert.deepEqual({ ...after, receipt: before.receipt }, before);
  assert.deepEqual(after.receipt.preflightScope, before.receipt.preflightScope);
  h.store.settleAttempt(h.identity.operationKey, h.attemptId, { submitted: true, status: 'audit-pending', auditPending: true,
    sendInputTiming: { version: 1, preparationStartedAt: 1, payloadStartedAt: 2 } });
  assert.equal(h.store.get(h.identity.operationKey).receipt.sendInputTiming.payloadStartedAt, 18000);
});

test('write-then-throw captures the start, not callback end, and telemetry throw never replaces transport outcome', async t => {
  const h = await fixture(t), original = Error('possible partial write');
  h.clock.now = 18000; h.term.write = () => { h.clock.now = 35000; throw original; };
  assert.throws(() => h.context.writeHistorySendPayload(h.term, 'original message', 'T', 'H', h.owner), e => e === original);
  await h.flush(); assert.equal(h.store.get(h.identity.operationKey).receipt.sendInputTiming.payloadStartedAt, 18000);
  h.store.recordPayloadAttempt = () => { throw Error('controlled metadata failure'); };
  h.events.length = 0;
  h.term.write = () => 77;
  assert.equal(h.context.writeHistorySendPayload(h.term, 'original message', 'T', 'H', h.owner), 77);
  assert.equal(h.events.filter(e => e.channel === 'agent:send-input-attempt').length, 1,
    'live exact call observation must precede fallible receipt telemetry');
  await h.flush();
});

test('existing return fence refuses before physical payload; cancellation is not a timing event', async t => {
  const h = await fixture(t, 'original message', { returned: true });
  assert.throws(() => h.context.writeHistorySendPayload(h.term, 'original message', 'T', 'H', h.owner), e => e.code === 'history_send_returned');
  await h.flush(); assert.equal(h.writes.length, 0);
  assert.equal(h.store.get(h.identity.operationKey).receipt.sendInputTiming.payloadStartedAt, undefined);
});

test('authored local slash counts as input; preparation slash belonging to another message does not', async t => {
  const h = await fixture(t, '/compact');
  h.context.writeHistorySendPayload(h.term, '/model', 'T', 'H', { ...h.owner, authoredCommand: '/model' }); await h.flush();
  assert.equal(h.store.get(h.identity.operationKey).receipt.sendInputTiming.payloadStartedAt, undefined);
  h.clock.now = 18000;
  h.context.writeHistorySendPayload(h.term, '/compact', 'T', 'H', { ...h.owner, authoredCommand: '/compact' }); await h.flush();
  assert.equal(h.store.get(h.identity.operationKey).receipt.sendInputTiming.payloadStartedAt, 18000);
});

test('actual caller wiring measures first chunk only and propagates prepared native slash identity', () => {
  const inner = declaration('_safePasteAndSubmitInner'), slash = declaration('sendCodexSlashCommand');
  assert.match(inner, /writeHistorySendPayload\(term, payload, broadcastTabId, handoffId,\s*i === 0 \? \{ sendOperationKey, sendAttemptId,/);
  assert.match(inner, /preparationStartedAt: destinationRecord\?\.attemptId === sendAttemptId/);
  assert.match(slash, /authoredCommand: text/);
  const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  assert.match(web, /else if \(preflightScope\)[\s\S]{0,350}agentSendQueue\?\.publishRecord\?\.\(staged.record, false\)/);
});

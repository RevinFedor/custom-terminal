'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { createCodexSettingsSendRuntime } = require('./codex-settings-send');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
};
const boundaryStart = source.indexOf('    if (stagedCodexAudit && awaitCodexUserMessageAudit && broadcastTabId)');
const boundaryEnd = source.indexOf('\n    } else if (source', boundaryStart);
assert.ok(boundaryStart >= 0 && boundaryEnd > boundaryStart);
const actualAuditHandoff = source.slice(boundaryStart, boundaryEnd) + '\n    }';
let auditWriteOwnerExpression;
const visit = node => {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'writeOperation'
    && node.initializer.getText(ast).includes('queueProofWriteOperation')) {
    auditWriteOwnerExpression = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(auditWriteOwnerExpression, 'actual staged queue-proof owner');

function harness({ outcome = 'confirmed', pending = false, competingWriter = false, proofDuringRetry = null } = {}) {
  const events = [];
  let inputRevision = 1;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const term = { write: value => events.push({ kind: 'write', value }) };
  const audit = { expectedHash: 'hash', expectedLen: 6, enterRetryCount: 0, submitted: true };
  const settingsQueue = createCodexSettingsMutationQueue();
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    terminals: new Map([['tab', term]]),
    terminalCommandState: new Map([['tab', { runSeq: 1 }]]),
    findTabIdForTerm: () => 'tab',
    getTerminalInputRevision: () => inputRevision,
    bumpTerminalInputRevision: () => ++inputRevision,
    getTerminalLifecycleGeneration: () => 'generation',
    getHeadlessTerminalMirror: () => null,
    reserveClaudeExactEmptyEvidence: () => null,
    // This fixture has no known-empty binding precondition. Its separate
    // owner-contract suite covers that additive guard; retain the real wrapper.
    assertKnownEmptySend() {}, isLocalSlashCommandPrompt: () => false,
    conversationOwners: { noteInput() {} },
    AGENT_SEND_DURABLE_STATES: { AUDIT_PENDING: 'audit-pending' },
    audit, onWritten: () => {},
    observeQueueOwner: owned => events.push({ kind: 'queue-proof', owned }),
  });
  const lockStart = source.indexOf('const pasteInflight = new WeakMap();');
  const lockEnd = source.indexOf('\nfunction markActivePtySubmit(', lockStart);
  vm.runInContext(source.slice(lockStart, lockEnd), context);
  const ownerActive = () => vm.runInContext('ptyWriteOwners.get(terminals.get("tab"))?.active === true', context);
  if (competingWriter) context.onWritten = () => {
    void context.withPtyWriteLock(term, () => events.push({ kind: 'competing-write' }), { kind: 'other-writer' });
  };
  context.waitForCodexPasteAudit = async () => {
    events.push({ kind: 'audit', ownerActive: ownerActive(), settingsPending: settingsQueue.pending });
    if (pending) await gate;
    if (outcome === 'throw') throw new Error('audit-reader-failed');
    if (outcome === 'timeout') return { success: false, error: 'codex_user_message_audit_timeout' };
    if (outcome === 'queued') return { success: null, submitted: true,
      status: 'queued', providerQueueAccepted: true, sourceIdentity: 'exact-queue-frame' };
    return { success: true, actualHash: 'hash', actualLen: 6 };
  };
  context.retryCodexEnterAfterAuditTimeout = async () => {
    events.push({ kind: 'retry-check', ownerActive: ownerActive() });
    if (proofDuringRetry === 'confirmed') {
      audit.finished = true;
      audit.result = { success: true, actualHash: 'hash', actualLen: 6 };
    } else if (proofDuringRetry === 'queued') {
      audit.providerQueueAcceptedResult = { success: null, submitted: true,
        status: 'queued', providerQueueAccepted: true, sourceIdentity: 'exact-queue-frame' };
    }
    return { retried: false, reason: 'exact-draft-proof-unavailable' };
  };
  context.markCodexAuditDeliveryUnknown = () => events.push({ kind: 'unknown' });
  // Physical byte production is a fixture. Everything after that boundary is
  // the actual _safePaste handoff branch, wrapper, audit resolution and locks.
  vm.runInContext(`async function _safePasteAndSubmitInner(term, content, options) {
    term.write(content); term.write('\\r');
    options.sendOperationContext.submitted = true;
    const sendOperationContext = options.sendOperationContext;
    audit.writeOperation = ${auditWriteOwnerExpression};
    onWritten();
    observeQueueOwner(!ptyLastQueuedWriteOperation.get(term)
      || ptyLastQueuedWriteOperation.get(term) === audit.writeOperation);
    const stagedCodexAudit = audit, awaitCodexUserMessageAudit = true, broadcastTabId = 'tab';
    const codexAuditTimeoutMs = 10, logPrefix = '[fixture]', t0 = Date.now();
    const submit = true, chunks = [content], renderTimes = [], resolvedSubmitLabel = 'Enter';
    ${actualAuditHandoff}
  }`, context);
  vm.runInContext(['safePasteAndSubmit', 'finishSafePasteAfterWrite', 'finishCodexPasteAuditAfterWrite']
    .map(declaration).join('\n'), context);
  const scope = () => ({ terminal: term, runSeq: 1, lifecycleGeneration: 'generation',
    ownerId: 'writer', inputRevision, live: true, busy: false });
  const runtime = createCodexSettingsSendRuntime({
    readScope: scope,
    readSettings: async () => ({ ownerId: 'writer', model: 'model', effort: 'high' }),
    withSettingsQueue: work => settingsQueue.run(work),
    withWriteLock: context.withPtyWriteLock,
    selectSettings: () => assert.fail('same pair must not open a picker'),
    paste: context.safePasteAndSubmit,
  });
  return {
    context, events, audit, release, term,
    send: () => runtime.sendPrompt({ tabId: 'tab', content: 'prompt', model: 'model', effort: 'high',
      pasteOptions: { queuedAtSubmit: outcome === 'queued' } }),
  };
}

test('actual safe-paste audit starts after both settings and PTY owners have released', async () => {
  const h = harness({ pending: true });
  const sending = h.send();
  await new Promise(resolve => setImmediate(resolve));
  const audit = h.events.find(event => event.kind === 'audit');
  assert.deepEqual(audit, { kind: 'audit', ownerActive: false, settingsPending: 0 });
  await h.context.withPtyWriteLock(h.term, () => h.events.push({ kind: 'later-write' }));
  h.release();
  const result = await sending;
  assert.equal(result.success, true);
  assert.equal(result.submitted, true);
  assert.equal(h.events.filter(event => event.kind === 'write' && event.value === '\r').length, 1);
  assert.equal('__codexPostEnterDeferred' in result, false);
});

test('immediate native queue proof keeps the exact outer owner and remains pending canonical audit', async () => {
  const h = harness({ outcome: 'queued' });
  const result = await h.send();
  assert.equal(h.events.find(event => event.kind === 'queue-proof').owned, true);
  assert.equal(result.success, true);
  assert.equal(result.status, 'queued');
  assert.equal(result.providerQueueAccepted, true);
  assert.equal(result.auditPending, true);
  assert.equal(result.receiptState, 'audit-pending');
  assert.equal(h.events.filter(event => event.kind === 'write' && event.value === '\r').length, 1);
});

test('a separately queued writer still prevents borrowing the current operation for queue proof', async () => {
  const h = harness({ competingWriter: true });
  await h.send();
  assert.equal(h.events.find(event => event.kind === 'queue-proof').owned, false);
});

test('deferred timeout reacquires the PTY only for exact retry proof, never another blind Enter', async () => {
  const h = harness({ outcome: 'timeout' });
  const result = await h.send();
  assert.equal(h.events.find(event => event.kind === 'audit').ownerActive, false);
  assert.equal(h.events.find(event => event.kind === 'retry-check').ownerActive, true);
  assert.equal(h.events.filter(event => event.kind === 'unknown').length, 0);
  assert.equal(result.status, 'audit-pending');
  assert.equal(result.success, null);
  assert.equal(result.auditPending, true);
  assert.equal(result.deliveryUnknown, false);
  assert.equal(result.submitted, true);
  assert.equal(h.events.filter(event => event.kind === 'write' && event.value === '\r').length, 1);
});

test('late exact or native queue proof wins over the deadline result during recovery', async () => {
  for (const proofDuringRetry of ['confirmed', 'queued']) {
    const h = harness({ outcome: 'timeout', proofDuringRetry });
    const result = await h.send();
    assert.equal(result.success, true);
    if (proofDuringRetry === 'queued') {
      assert.equal(result.status, 'queued');
      assert.equal(result.providerQueueAccepted, true);
    } else {
      assert.equal(result.codexAudit.actualHash, 'hash');
    }
    assert.equal(h.events.filter(event => event.kind === 'write' && event.value === '\r').length, 1);
  }
});

test('an audit reader exception preserves the known Enter boundary', async () => {
  const h = harness({ outcome: 'throw' });
  const result = await h.send();
  assert.equal(result.deliveryUnknown, true);
  assert.equal(result.submitted, true);
  assert.equal(result.enterWritten, true);
  assert.equal(h.events.filter(event => event.kind === 'write' && event.value === '\r').length, 1);
});

test('ordinary non-atomic callers keep their existing await behavior and cannot forge queue proof ownership', async () => {
  const h = harness();
  const forged = {};
  const result = await h.context.safePasteAndSubmit(h.term, 'prompt', { queueProofWriteOperation: forged });
  assert.equal(result.success, true);
  assert.equal(h.events.find(event => event.kind === 'audit').ownerActive, true);
  assert.notEqual(h.audit.writeOperation, forged);
});

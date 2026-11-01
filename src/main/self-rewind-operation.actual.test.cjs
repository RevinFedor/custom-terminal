'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { SavedHistoryOperations } = require('./saved-history-operation');
const { TabWorkContext } = require('./tab-work-context');
const { ConversationOwners } = require('./conversation-owner');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { historyReadOwnerFromProjection } = require('./history-read-session');
const tick = () => new Promise(resolve => setImmediate(resolve));

function actualFactorySourceResolver(runtime, publicRead, tabType = 'terminal') {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  let selected;
  const visit = node => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'SavedHistoryOperations') {
      selected = node.arguments[0].properties.find(property => property.name?.getText(ast) === 'resolveSession');
    }
    ts.forEachChild(node, visit);
  }; visit(ast); assert.ok(selected);
  return vm.runInNewContext('(' + selected.initializer.getText(ast) + ')', {
    savedHistoryRuntime: runtime, resolveHistorySessionInfo: publicRead,
    findOrchestrationTabDescriptor: () => ({ tabType }),
  });
}

function fixture(t, options = {}) {
  const provider = options.toolType || 'codex';
  const sql = new Database(':memory:');
  sql.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const db = { db: sql, getAppState: key => {
    const row = sql.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null;
  }, setAppState: (key, value) => sql.prepare('INSERT INTO app_state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(key, JSON.stringify(value), Date.now()) };
  const state = { terminalToken: {}, projectId: 'P', cwd: '/finite', sessionId: 'S', toolType: provider,
    inputRevision: 1, runSeq: 1, lifecycleGeneration: 'L1', launchId: 'old-launch', inputOwnerLaunchId: 'old-launch',
    isRunning: true, stopping: false, inputReady: true };
  const publicRead = () => historyReadOwnerFromProjection({ toolType: provider, sessionId: 'S', cwd: '/finite' },
    { sessionId: null, readSessionId: null, provenWriterSessionId: null, writerConfirmed: false }, true);
  db.compareAndSetTabClaudeSessionId = (_project, _tab, previous, next) => {
    if (state.sessionId !== previous) return false; state.sessionId = next; return true;
  };
  const tabs = () => [{ tabId: 'T', name: 'Own', projectId: 'P', commandType: provider,
    ...(provider === 'codex' ? { codexSessionId: state.sessionId } : { claudeSessionId: state.sessionId }) }];
  const context = new TabWorkContext({ db: sql, listTabs: tabs });
  const covered = context.publish('T', { sourceTabId: 'other', text: 'Known old context', requestId: 'old' });
  const source = [{ uuid: 'keep', type: 'user', text: 'Keep this iteration' },
    { uuid: 'deploy', type: 'user', role: 'user', content: 'Deploy task', text: 'Deploy task', fullText: 'Deploy task' },
    { uuid: 'later', type: 'user', text: 'Deployment iterations' }];
  if (provider === 'claude') source.splice(0, source.length, source.find(row => row.uuid === 'deploy'));
  const receipts = createAgentSendReceiptStore(sql), effects = [], dispatched = [];
  let operations, queue;
  const gate = createHistoryMutationInputGate({ capture: () => ({ ...state }), readSendBusy: () => false,
    wake: () => queue?.notifyRuntime('T'), log: { log() {}, warn() {} }, readInputBoundary: async () => ({
      known: true, ownerStable: true, processStatus: state.isRunning ? 'found' : 'absent',
      status: state.isRunning ? 'active' : 'inactive', inputReady: state.inputReady,
      isCurrent: () => true,
    }) });
  const owner = new ConversationOwners({ db, capture: () => ({ known: true, provider, sessionId: state.sessionId,
    projectId: 'P', cwd: '/finite', instanceId: 'finite', terminalId: 'pty', runSeq: state.runSeq, launchId: state.launchId }) });
  queue = new AgentSendQueue({ store: receipts, admit: request => !gate.held('T') && operations.admitSelfFollowup(request),
    publish: record => operations.observeSelfFollowup(record),
    execute: async request => { effects.push(['send-leaf', request]);
      return { submitted: false, pasteWritten: false, enterWritten: false, code: 'controlled-leaf-no-input' }; } });
  operations = new SavedHistoryOperations({ db, runtime: { owner, capture: () => ({ ...state }),
    reserveInput: request => gate.reserve(request), assertInput: proof => gate.assert('T', proof, { action: 'mutation' }),
    finishInput: proof => gate.finish(proof), bindInput: (proof, sid) => gate.bound(proof, sid),
    runInput: (proof, action) => gate.run(proof, action), inspectDraft: () => ({ hasDraft: false }) },
    resolveSession: options.actualFactory
      ? actualFactorySourceResolver({ capture: () => {
        const selected = { ...state }; options.afterSourceCapture?.(state); return selected;
      } }, publicRead, options.tabType)
      : async () => ({ sessionId: state.sessionId, toolType: provider, cwd: '/finite' }),
    transcript: { getTimeline: async () => ({ success: true, entries: source, contentRevision: 'R', latestSessionId: 'S' }),
      getHistory: async () => ({ success: true, entries: source }),
      loadCodexOperationSource: async () => ({ success: true, records: source }) },
    buildTimeline: records => records,
    deleteRange: async () => { effects.push(['rewrite']); return { success: true, newSessionId: 'child', removedUsers: 2 }; },
    claude: { loadOperationSource: async () => ({ success: true, revision: { token: 'R' }, records: source }),
      deleteRange: async params => { params.beforeCommit(); effects.push(['rewrite']);
        return { success: true, committed: true, fileDeleted: true, removedUsers: 3 }; } },
    dispatch: async (_action, request) => { dispatched.push(request); },
    selfRewind: { context, send: async record => {
      if (options.beforeFollowup) await options.beforeFollowup({ state, record, operations });
      const prepared = await context.prepare('T', record.followup.handoffId, record.request.selfRewind.nextPrompt);
      const request = { tabId: 'T', prompt: prepared.prompt, provider, source: record.followup.handoffId,
        handoffId: record.followup.handoffId, sendOperationKey: record.followup.operationKey,
        expectedTarget: record.followup.expectedTarget, selfRewindRef: { tabId: 'T', operationId: record.operationId } };
      try { operations.validateSelfReservation(request); }
      catch (error) { context.release('T', record.followup.handoffId); throw error; }
      const admitted = queue.enqueue({ identity: { operationKey: request.sendOperationKey, tabId: 'T',
        handoffId: request.handoffId, provider, sessionId: record.followup.expectedTarget.sessionId || null, surface: 'self-rewind',
        promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length,
        requestFingerprint: fingerprintAgentSendRequest(request) }, request });
      assert.equal(gate.held('T'), true, 'new task reserves before the original history hold releases');
      assert.equal(effects.filter(row => row[0] === 'send-leaf').length, 0);
      return admitted.receipt;
    } } });
  const observedContext = context.getRewindContext('T');
  const body = { operationId: 'self-1', kind: 'rewind', expectedSessionId: 'S', targetUuid: 'deploy', toolType: provider,
    ...(provider === 'claude' ? { expectedContentRevision: 'R' } : {}),
    selfRewind: { retainedContext: 'Deployment completed. Current code is deployed; do not repeat it.',
      expectedContextRevision: observedContext.revision, expectedContextSnapshot: observedContext.rewindSnapshot,
      coveredContextUpdateIds: [covered.updateId],
      nextPrompt: options.nextPrompt || null }, sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'T' } };
  async function drive(completing) {
    const request = { tabId: 'T', operationId: body.operationId };
    const step = (phase, data) => operations.step({ ...request, phase, data });
    const prepared = await step('prepare');
    await step('stopping'); state.isRunning = false; state.launchId = null; state.inputOwnerLaunchId = null;
    await step('stopped'); await step('rewrite', { draft: { text: 'Deploy task', chips: [], imagePaths: [] } });
    await step('adopting');
    if (provider === 'claude') {
      await step('adopted'); return step('completed', { resume: { skipped: true, launchWritten: false, status: 'inactive' } });
    }
    operations.commitCodexBinding({ ...request, sessionId: 'child' }, () => { state.sessionId = 'child'; });
    await step('adopted'); await step('resuming');
    gate.authorizeResume(prepared.historyInput, { command: 'codex-c', sessionId: 'child' });
    return gate.run(prepared.historyInput, async () => {
      operations.validateResume(request, 'claim', { sessionId: 'child' });
      state.runSeq++; state.lifecycleGeneration = 'L2'; state.launchId = 'own-launch'; state.inputOwnerLaunchId = 'own-launch'; state.isRunning = true;
      operations.validateResume(request, 'claimed', { sessionId: 'child', launchId: 'own-launch' });
      operations.validateResume(request, 'write', { sessionId: 'child', launchId: 'own-launch' });
      gate.claimLaunch(prepared.historyInput, 'own-launch', state.runSeq);
      const data = { resume: { launchWritten: true, launchId: 'own-launch', status: 'starting' } };
      return completing ? completing(() => step('completed', data)) : step('completed', data);
    });
  }
  t.after(async () => { queue.dispose(); await tick(); await context.syncing; sql.close(); });
  return { sql, db, context, covered, body, state, gate, operations, queue, receipts, effects, dispatched, drive, publicRead };
}
test('actual factory selects the durable Rewind source when the independent public read SID is unavailable', async t => {
  const h = fixture(t, { actualFactory: true });
  assert.equal(h.publicRead().sessionId, null);
  h.operations.acceptSelf('T', h.body); await tick();
  const result = await h.drive();
  assert.equal(result.state, 'completed'); assert.equal(result.historyMutated, true);
  assert.equal(h.effects.filter(row => row[0] === 'rewrite').length, 1);
  assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 0);
  assert.equal(h.publicRead().sessionId, null, 'selecting a source grants neither a public read nor a confirmed writer');
});
test('actual factory still rejects changed source/provider and SDK before any Stop/rewrite', async t => {
  for (const change of ['session', 'provider', 'sdk']) {
    const h = fixture(t, { actualFactory: true, tabType: change === 'sdk' ? 'claude-sdk' : 'terminal' });
    h.operations.acceptSelf('T', h.body); await tick();
    if (change === 'session') h.state.sessionId = 'another-source';
    if (change === 'provider') h.state.toolType = 'claude';
    await assert.rejects(h.operations.step({ tabId: 'T', operationId: 'self-1', phase: 'prepare' }), error =>
      error.code === (change === 'sdk' ? 'history_operation_provider_unsupported' : 'history_operation_session_changed'));
    assert.equal(h.effects.length, 0); assert.equal(h.state.isRunning, true);
    assert.equal(h.operations.read('T', 'self-1').historyMutated, false);
  }
});
test('actual factory cannot mix the selected source cwd with an owner changed across the resolver await', async t => {
  const h = fixture(t, { actualFactory: true, afterSourceCapture: state => { state.cwd = '/changed'; } });
  h.operations.acceptSelf('T', h.body); await tick();
  await assert.rejects(h.operations.step({ tabId: 'T', operationId: 'self-1', phase: 'prepare' }),
    error => error.code === 'history_operation_owner_changed');
  assert.equal(h.effects.length, 0); assert.equal(h.state.isRunning, true);
});
test('self Rewind only reuses the existing phase protocol and retains context without a new Send', async t => {
  const h = fixture(t); h.operations.acceptSelf('T', h.body); await tick();
  const result = await h.drive(); await tick();
  assert.equal(result.state, 'completed'); assert.equal(result.historyMutated, true);
  assert.equal(result.activeSessionId, 'child'); assert.equal(result.followup, undefined);
  assert.equal(h.effects.filter(row => row[0] === 'rewrite').length, 1);
  assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 0);
  assert.equal(h.context.get('T').updates[0].kind, 'rewind');
  assert.equal(h.operations.acceptSelf('T', h.body).idempotent, true);
  assert.equal(h.dispatched.length, 1, 'same unchanged request never repeats Stop/rewrite');
});
test('self Rewind plus new task reserves one immutable FIFO operation with the retained context', { timeout: 3000 }, async t => {
  const h = fixture(t, { nextPrompt: 'Now inspect the deployed result without deploying again.' });
  h.operations.acceptSelf('T', h.body); await tick(); const result = await h.drive(); await tick(); await tick();
  await h.queue.result(result.followup.operationKey);
  assert.equal(result.state, 'completed'); assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 1,
    JSON.stringify({ operation: h.operations.publicSelf(h.operations.read('T', 'self-1')), hold: h.gate.read('T') }));
  const input = h.effects.find(row => row[0] === 'send-leaf')[1];
  assert.match(input.prompt, /context-update-kind="rewind"/); assert.match(input.prompt, /Deployment completed/);
  assert.equal(input.prompt.includes('Known old context'), false);
  const original = h.queue.item(input.sendOperationKey).request_json;
  h.operations.acceptSelf('T', h.body); await tick();
  assert.equal(h.queue.item(input.sendOperationKey).request_json, original);
  assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 1,
    JSON.stringify(h.operations.publicSelf(h.operations.read('T', 'self-1'))));
  assert.equal(h.operations.read('T', 'self-1').followup.receiptState, 'not-submitted', 'controlled sender is not claimed as native success');
});
test('missing/foreign self caller, stale context and local commands cannot start a Rewind', async t => {
  const h = fixture(t);
  for (const body of [{ ...h.body, sourceMeta: { ...h.body.sourceMeta, tabId: 'foreign' } },
    { ...h.body, selfRewind: { ...h.body.selfRewind, expectedContextRevision: -1 } },
    { ...h.body, selfRewind: { ...h.body.selfRewind, nextPrompt: '/compact' } }]) {
    assert.throws(() => h.operations.acceptSelf('T', body));
  }
  assert.equal(h.dispatched.length, 0); assert.equal(h.state.isRunning, true);
  assert.equal(h.context.get('T').updates[0].id, h.covered.updateId);
});
test('reopened owner exposes an interrupted operation without starting another executor', async t => {
  const h = fixture(t); h.operations.acceptSelf('T', h.body); await tick();
  const reopened = new SavedHistoryOperations({ db: h.db });
  const rows = reopened.listSelf('T');
  assert.equal(rows[0].state, 'outcome-unknown');
  assert.equal(reopened.read('T', 'self-1').historyMutated, false);
  assert.equal(h.dispatched.length, 1);
});
test('concurrent completion joins the existing followup instead of reserving a second input', { timeout: 3000 }, async t => {
  let release, entered;
  const arrived = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const h = fixture(t, { nextPrompt: 'New task', beforeFollowup: async () => { entered(); await held; } });
  h.operations.acceptSelf('T', h.body); await tick();
  const work = h.drive(async complete => {
    const first = complete(); await arrived; const second = complete(); release();
    const results = await Promise.all([first, second]); assert.equal(results[0].state, 'completed'); return results[1];
  });
  await work; await tick(); await tick();
  await h.queue.result(h.operations.read('T', 'self-1').followup.operationKey);
  assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 1);
});
test('Claude clear-to-empty uses the existing known-none owner for a new task, not a guessed old SID', { timeout: 3000 }, async t => {
  const h = fixture(t, { toolType: 'claude', nextPrompt: 'New task after clearing the conversation' });
  h.operations.acceptSelf('T', h.body); await tick();
  const result = await h.drive();
  assert.equal(result.state, 'completed'); assert.equal(result.fileDeleted, true);
  assert.equal(result.binding.mode, 'cleared'); assert.equal(result.activeSessionId, null);
  assert.equal(result.followup.expectedTarget.expectedBinding, 'none');
  assert.ok(result.followup.expectedTarget.ownerToken);
  await h.queue.result(result.followup.operationKey);
  assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 1);
});
test('receipt/context publication failure cannot strand an accepted self Rewind before dispatch', async t => {
  const h = fixture(t);
  h.operations.broadcast = () => { throw Error('controlled unavailable window'); };
  h.operations.acceptSelf('T', h.body); await tick();
  h.context.onChanged = () => { throw Error('controlled unavailable context subscriber'); };
  const result = await h.drive();
  assert.equal(result.state, 'completed'); assert.equal(h.dispatched.length, 1);
  assert.equal(h.context.get('T').updates[0].kind, 'rewind');
});
test('late preparation after terminal failure cannot resurrect the owner or enqueue a task', async t => {
  const h = fixture(t, { nextPrompt: 'Do not enqueue after failure', beforeFollowup: async ({ operations }) => {
    await operations.step({ tabId: 'T', operationId: 'self-1', phase: 'failed', data: { error: 'controlled terminal failure' } });
  } });
  h.operations.acceptSelf('T', h.body); await tick();
  const result = await h.drive(); await tick();
  assert.equal(result.state, 'failed'); assert.equal(h.effects.filter(row => row[0] === 'send-leaf').length, 0);
  assert.equal(h.queue.item('self-rewind:T:self-1'), null);
  assert.equal(h.context.get('T').updates[0].status, 'pending');
});
test('dock summaries read only the index and compact projection, not stored context or draft bodies', async t => {
  const h = fixture(t); h.operations.acceptSelf('T', h.body); await tick(); await h.drive();
  const reads = [], get = h.db.getAppState;
  h.db.getAppState = key => { reads.push(key); return get(key); };
  const rows = h.operations.listSelf('T');
  assert.equal(rows.length, 1);
  assert.equal(reads.includes(h.operations.key('T', 'self-1')), false);
  assert.equal(JSON.stringify(rows).includes('Deployment completed'), false);
  assert.equal(JSON.stringify(rows).includes('Deploy task'), false);
});
test('an older active self operation survives the normal recent-History limit without loading transcript bodies', async t => {
  const h = fixture(t); h.operations.acceptSelf('T', h.body); await tick();
  const ids = ['self-1'];
  for (let n = 0; n < 105; n++) {
    const operationId = 'history-' + n; ids.push(operationId);
    h.db.setAppState(h.operations.selfSummaryKey('T', operationId), { tabId: 'T', operationId,
      state: 'completed', phase: 'completed', hasNextPrompt: false, createdAt: Date.now() + n, revision: 1 });
  }
  h.db.setAppState(h.operations.selfIndexKey('T'), ids);
  assert.equal(h.operations.listSelf('T').some(row => row.operationId === 'self-1'), true);
});

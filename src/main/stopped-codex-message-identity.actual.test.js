'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { messageRuntimeIdentity, scenarioDestination } = require('./agent-message-identity');
const { TabMessageService } = require('./tab-messages');
const { handleTabMessageApi } = require('./tab-message-api');
const plain = value => JSON.parse(JSON.stringify(value));
const main = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['getCodexPublicWriterFields', 'readAgentSendDestinationAtWriteBoundary',
  'readMainAgentStartReadiness', 'readMainPublicRuntimeSnapshot'];
const code = names.map(name => {
  const node = main.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(main);
}).join('\n');

// Actual Main readiness/public/write-destination functions. Runtime event and
// process lookup leaves are controlled; there is no production PTY or storage.
function fixture() {
  const terminal = {}, tabId = 'target';
  const controls = { sid: 'saved-target', status: 'inactive', live: false,
    process: 'absent', owner: 1, writer: null, beforeLookup: null, reconciles: 0,
    canonical: null, beforeReconcile: null };
  const ctx = vm.createContext({
    sdkSessions: new Map(), terminals: new Map([[tabId, terminal]]),
    terminalLifecycleEpochs: new Map([[terminal, 'terminal-A']]),
    terminalCommandState: new Map([[tabId, { runSeq: 1 }]]), codexTurnWatchers: new Map(),
    bridgeKnownSessions: new Map(), codexKnownSessions: new Map(), claudeTurnBusy: new Map(),
    claudeStartupGateRevisions: new Map(), codexLastRunCommandPayload: new Map(),
    codexRuntimePolicies: null, codexLiveSettingsObserver: null,
    captureAiProcessLookupScope: () => ({ generation: 'G', cwd: '/private/test', owner: controls.owner }),
    aiProcessLookupScopeCurrent: (_id, scope) => scope.owner === controls.owner,
    conversationOwners: { current: () => ({ ownerToken: 'owner-' + controls.owner, ownerOrder: controls.owner }) },
    resolveAiToolTypeForTab: () => 'codex', getTerminalInputRevision: () => 0,
    getTerminalStopRevision: () => 0,
    getTerminalLifecycleGeneration: () => 'G', getActiveAgentExecutionContext: () => null,
    currentClaudeStartupDefaultsGate: () => null,
    getCodexWriterProofSnapshot: () => controls.writer,
    isCodexWriterUsableForMutation: () => !!controls.writer,
    getCodexSavedSessionId: () => controls.sid,
    getCodexRuntimeSessionId: () => controls.writer?.sessionId || null,
    currentCodexAcceptedResumeSourceProof: () => null, getCodexResumeReadIdentityLeaseForTab: () => null,
    projectCodexRuntimeSnapshotFromEvents: () => ({ success: true, sessionStatus: controls.status,
      sessionId: controls.live === false ? controls.sid : controls.writer?.sessionId || null,
      savedSessionId: controls.sid, liveLifecycle: controls.live, inputReady: controls.status === 'active' }),
    getCodexTuiReadyState: async () => ({ inputReady: false }),
    getCodexRuntimeSessionSnapshot: async (_id, options) => {
      assert.equal(options.reason, 'public-runtime-physical-absence');
      assert.equal(options.forceWriterReconcile, true);
      controls.reconciles++;
      await controls.beforeReconcile?.();
      return controls.canonical || { sessionStatus: 'inactive', liveLifecycle: false,
        sessionId: controls.sid, savedSessionId: controls.sid, inputReady: false };
    },
    readAiLifecycleIdentityForTab: async () => { await controls.beforeLookup?.();
      return { processStatus: controls.process, processPid: controls.process === 'found' ? 123 : null }; },
  });
  vm.runInContext(code, ctx);
  const descriptor = { tabId, tabName: 'Target', projectId: 'project', toolType: 'codex',
    tabType: 'terminal', sessionId: 'stale-descriptor', cwd: '/private/test' };
  return { controls, terminal, descriptor, snapshot: () => ctx.readMainPublicRuntimeSnapshot(tabId) };
}

test('stopped saved Codex survives actual Main snapshot and message identity without becoming a live writer', async () => {
  const h = fixture(), snapshot = await h.snapshot();
  assert.equal(snapshot.processStatus, 'absent'); assert.equal(snapshot.status, 'inactive');
  assert.equal(snapshot.canResume, true);
  assert.equal(snapshot.inputReady, false); assert.equal(snapshot.writerConfirmed, false);
  assert.equal(snapshot.sendTarget.sessionId, null);
  const address = messageRuntimeIdentity(h.descriptor, snapshot);
  assert.equal(address.sessionId, 'saved-target');
  assert.deepEqual(plain(address.sendTarget), { toolType: 'codex', sessionId: 'saved-target' });
  assert.deepEqual(plain(scenarioDestination(snapshot)), address.sendTarget);
});

test('retained event uncertainty plus complete absence uses the existing canonical runtime authority', async () => {
  const h = fixture();
  Object.assign(h.controls, { live: null, status: 'unknown' });
  const result = await h.snapshot();
  assert.equal(h.controls.reconciles, 1);
  assert.equal(result.canResume, true);
  assert.equal(result.sessionId, 'saved-target');
  assert.equal(result.sendTarget.sessionId, null);
  assert.equal(result.writerConfirmed, false);
  assert.equal(result.inputReady, false);
  assert.equal(messageRuntimeIdentity(h.descriptor, result).sessionId, 'saved-target');
  assert.equal(scenarioDestination(result).sessionId, 'saved-target');
});

test('canonical pending-launch hold never becomes stopped merely from a fresh absent snapshot', async () => {
  const h = fixture();
  Object.assign(h.controls, { live: null, status: 'unknown', canonical: {
    sessionStatus: 'starting', liveLifecycle: null, sessionId: null,
    savedSessionId: 'saved-target', inputReady: false,
  } });
  const result = await h.snapshot();
  assert.equal(h.controls.reconciles, 1);
  assert.equal(result.status, 'starting');
  assert.equal(result.canResume, false);
  assert.throws(() => messageRuntimeIdentity(h.descriptor, result), { code: 'message_runtime_identity_unavailable' });
});

test('fresh absence cannot reuse a retained live writer projection as physical proof', async () => {
  const h = fixture();
  Object.assign(h.controls, { live: true, status: 'active', writer: {
    sessionId: 'old-writer', terminalToken: h.terminal, runSeq: 1, lifecycleGeneration: 'G', launchId: 'L',
  }, canonical: { sessionStatus: 'inactive', liveLifecycle: false,
    sessionId: 'saved-target', savedSessionId: 'saved-target', inputReady: false,
    writerConfirmed: false, writerUsableForMutation: false } });
  h.controls.beforeReconcile = () => { h.controls.writer = null; };
  const result = await h.snapshot();
  assert.equal(h.controls.reconciles, 1);
  assert.equal(result.canResume, true);
  assert.equal(result.writerConfirmed, false);
  assert.equal(result.inputReady, false);
  assert.equal(result.sendTarget.sessionId, null);
});

test('process uncertainty does not authorize canonical-absence recovery', async () => {
  const h = fixture(); Object.assign(h.controls, { live: null, status: 'unknown', process: 'unknown' });
  const result = await h.snapshot();
  assert.equal(h.controls.reconciles, 0);
  assert.equal(result.canResume, false);
});

test('owner change during the canonical recheck retries the same bounded observation', async () => {
  const h = fixture(); Object.assign(h.controls, { live: null, status: 'unknown' });
  h.controls.beforeReconcile = () => {
    if (h.controls.reconciles === 1) { h.controls.owner++; h.controls.sid = 'new-owner'; }
  };
  const result = await h.snapshot();
  assert.equal(h.controls.reconciles, 2);
  assert.equal(result.sessionId, 'new-owner');
});

for (const process of ['unknown', 'found']) test('saved SID cannot bypass ' + process + ' process ownership', async () => {
  const h = fixture(); h.controls.process = process;
  const snapshot = await h.snapshot();
  assert.notEqual(snapshot.canResume, true);
  assert.throws(() => messageRuntimeIdentity(h.descriptor, snapshot), { code: 'message_runtime_identity_unavailable' });
});

test('no saved binding stays unavailable even with a coherent absent process', async () => {
  const h = fixture(); h.controls.sid = null;
  const snapshot = await h.snapshot();
  assert.notEqual(snapshot.canResume, true);
  assert.throws(() => messageRuntimeIdentity(h.descriptor, snapshot), { code: 'message_runtime_identity_unavailable' });
});

test('active writer continues to own the address independently of saved history', async () => {
  const h = fixture();
  Object.assign(h.controls, { live: true, status: 'active', process: 'found', writer: {
    sessionId: 'live-writer', terminalToken: h.terminal, runSeq: 1, lifecycleGeneration: 'G', launchId: 'L' } });
  const snapshot = await h.snapshot();
  assert.notEqual(snapshot.canResume, true);
  assert.equal(messageRuntimeIdentity(h.descriptor, snapshot).sessionId, 'live-writer');
});

test('owner change during lookup rereads current saved binding; continuing churn remains unknown', async () => {
  for (const continual of [false, true]) {
    const h = fixture(); let reads = 0;
    h.controls.beforeLookup = () => { if (++reads === 1 || continual) {
      h.controls.owner++; h.controls.sid = 'changed-target';
    } };
    if (continual) await assert.rejects(h.snapshot, { code: 'runtime_snapshot_unstable' });
    else assert.equal(messageRuntimeIdentity(h.descriptor, await h.snapshot()).sessionId, 'changed-target');
    assert.equal(reads, 2);
  }
});

test('actual message API/SQLite reserves one stopped-target message; identical replay retains its original address', async t => {
  const h = fixture(), db = new Database(':memory:');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const source = { tabId: 'source', tabName: 'Source', projectId: 'project', provider: 'codex',
    sessionId: 'source-session', cwd: '/private/test' };
  const resolveTab = async id => id === 'source' ? source
    : messageRuntimeIdentity(h.descriptor, await h.snapshot());
  const deliveries = [];
  const service = new TabMessageService({ db, resolveTab, send: async message => {
    deliveries.push(message); await gate;
    return { success: false, submitted: false, pasteWritten: false, enterWritten: false,
      error: 'controlled transport; no physical input' };
  } });
  await service.initialize();
  t.after(async () => { release(); service.dispose(); await Promise.allSettled([...service.lanes.values()]); db.close(); });
  const body = { sourceTabId: 'source', targetTabId: 'target', requestId: 'same-request', text: 'test question',
    sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'source' } };
  const post = async () => {
    let result;
    await handleTabMessageApi({ method: 'POST' }, {}, { pathname: '/api/tab-messages' }, {
      service, resolveTab, readBody: async () => body,
      sendJson: (_res, status, value) => { result = { status, value }; },
    });
    return result;
  };
  const first = await post();
  assert.equal(first.status, 202, JSON.stringify(first));
  assert.ok(first.value.messageId);
  assert.equal(service.getMessage(first.value.messageId).message.targetSessionId, 'saved-target');
  h.controls.sid = 'different-history';
  const replay = await post();
  assert.equal(replay.status, 202); assert.equal(replay.value.messageId, first.value.messageId);
  assert.equal(replay.value.deduplicated, true);
  assert.equal(service.getMessage(first.value.messageId).message.targetSessionId, 'saved-target');
  assert.ok(deliveries.length <= 1);
});

for (const changedHistory of [false, true]) test(changedHistory
  ? 'saved reply refuses a changed stopped conversation without retargeting'
  : 'saved reply passes actual Main identity after its original caller stops', async t => {
  const h = fixture(), db = new Database(':memory:');
  Object.assign(h.controls, { live: true, status: 'active', process: 'found', writer: {
    sessionId: 'saved-target', terminalToken: h.terminal, runSeq: 1, lifecycleGeneration: 'G', launchId: 'L' } });
  const responder = { tabId: 'responder', tabName: 'Responder', projectId: 'project', provider: 'codex',
    sessionId: 'responder-session', cwd: '/private/test' };
  const resolveTab = async id => id === 'responder' ? responder
    : messageRuntimeIdentity(h.descriptor, await h.snapshot());
  const deliveries = [];
  const service = new TabMessageService({ db, resolveTab, send: async message => {
    deliveries.push(message);
    return { success: true, submitted: true, status: 'sent' };
  } });
  await service.initialize();
  t.after(async () => { service.dispose(); await Promise.allSettled([...service.lanes.values()]); db.close(); });
  const question = await service.sendMessage({ source: await resolveTab('target'), target: responder,
    text: 'test question before caller stops', requestId: 'question-before-stop' });
  await service.lanes.get('responder');
  assert.equal(service.getMessage(question.message.messageId).message.deliveryState, 'sent');
  Object.assign(h.controls, { live: false, status: 'inactive', process: 'absent', writer: null,
    sid: changedHistory ? 'replacement-history' : 'saved-target' });
  const body = { sourceTabId: 'responder', requestId: 'same-reply', text: 'saved answer',
    sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'responder' } };
  const post = async () => {
    let result;
    await handleTabMessageApi({ method: 'POST' }, {}, {
      pathname: '/api/tab-messages/' + question.message.messageId + '/replies',
    }, { service, resolveTab, readBody: async () => body,
      sendJson: (_res, status, value) => { result = { status, value }; } });
    return result;
  };
  const accepted = await post();
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  await service.lanes.get('target');
  const reply = service.getMessage(question.message.messageId).reply;
  assert.equal(reply.messageId, accepted.value.messageId);
  assert.equal(reply.targetSessionId, 'saved-target');
  assert.equal(reply.text, 'saved answer');
  assert.equal(reply.deliveryState, changedHistory ? 'failed' : 'sent');
  assert.equal(reply.code, changedHistory ? 'tab_message_address_changed' : null);
  assert.equal(deliveries.length, changedHistory ? 1 : 2);
  assert.equal(deliveries.filter(m => m.kind === 'reply').length, changedHistory ? 0 : 1);
  h.controls.sid = 'another-history-after-delivery';
  const replay = await post();
  assert.equal(replay.status, 202);
  assert.equal(replay.value.deduplicated, true);
  assert.equal(replay.value.messageId, reply.messageId);
  assert.equal(deliveries.length, changedHistory ? 1 : 2);
});

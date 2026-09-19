'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const http = require('node:http'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const ts = require('typescript'), Database = require('better-sqlite3');
const receipts = require('./agent-send-receipt-registry');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { resolveOrchestrationSendOptions } = require('./orchestration-request-plan');
const { prepareReusedInboxTab } = require('./inbox-tab-reuse');
const pairedVoice = require('../../../voice-record/src/main/codex-inbox-attempt');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const fn = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const functions = ['bridgeRequest', 'registerBridgeReplyHandler', 'sendJson', 'externalRunResponseFields', 'getInboxResultResponse',
  'inboxSetupOutcome', 'readDurableInboxRun', 'inboxSetupRetryable', 'assertInboxSetupOwner', 'settleInboxSetupBeforeSend',
  'replayExternalRunResponse', 'externalRunStatusFromDurableRecord', 'durableRecordHasProviderQueueAcceptance',
  'durableAgentSendReplay', 'durableAgentSendFailure', 'runAgentSendScenario', 'runPreparedAgentSendScenario',
  'sendAuditPending', 'sendSendFailure', 'sendDeliveryUnknown'];

async function harness(t, { startupFailure = false, queued = false } = {}) {
  let db;
  try { db = new Database(':memory:'); } catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Electron ABI required'); return null; } throw error;
  }
  const store = createAgentSendReceiptStore(db), ipc = new EventEmitter(), contents = new EventEmitter();
  const requests = [], deadlines = [], bridges = [], runs = new Map(), events = []; let descriptor = null;
  const body = { runId: 'exact-request', conversationKey: 'fixture-chat', provider: 'codex', prompt: 'fixture-only' };
  const identity = { operationKey: 'inbox:' + body.runId, surface: 'inbox', runId: body.runId,
    tabId: '__noted_inbox__-tab-fixture', handoffId: 'external-run:' + body.runId,
    requestFingerprint: '', provider: 'codex', sessionId: null,
    promptHash: promptAuditFingerprint(body.prompt), promptLength: body.prompt.length };
  const context = {
    ...receipts, AGENT_SEND_RECEIPT_STATES: receipts.RECEIPT_STATES,
    bindStructuredAuthoringPresentation: require('./structured-authoring').bindStructuredAuthoringPresentation,
    withPromptOriginPresentation: require('./history-prompt-presentations').withPromptOriginPresentation,
    crypto, Buffer, console: process.env.NOTED_CREATION_TEST_DIAGNOSTICS ? console : { log() {}, warn() {} }, Number, Error, Promise,
    zlib: require('node:zlib'), GZIP_THRESHOLD: 4096, shortId: x => x, promptAuditFingerprint,
    classifyAgentSendReceipt, resolveOrchestrationSendOptions, prepareReusedInboxTab,
    agentSendReceiptStore: store, agentSendReceiptRegistry: receipts.createAgentSendReceiptRegistry(),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 60_000,
    externalRuns: runs, externalRunByTabId: new Map(), externalRunByConversationKey: new Map(),
    INBOX_PROJECT_ID: '__noted_inbox__', pendingBridge: new Map(), ipcMain: ipc,
    LATE_BRIDGE_REPLY_RETENTION_MS: 60_000, e2eBoundaryTestGate: null,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: contents }] },
    bridgePayloadLabel: () => '', setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() {} }; deadlines.push(timer); return timer;
    }, clearTimeout: timer => { if (timer) timer.cleared = true; },
    cleanOptionalString: (v, fallback = '') => typeof v === 'string' ? v.trim() || fallback : fallback,
    clampAutoStopMs: () => 30_000, clampAutoCloseMs: () => 900_000, assertAgentProviderModel() {},
    reservedInboxTabId: () => identity.tabId, clearExternalRunTimer() {}, setExternalRunMeta() {},
    webBroadcast: (tabId, event) => events.push({ tabId, event }),
    findOrchestrationTabDescriptor: () => descriptor, tabWorkContext: null, inboxSavedHistoryOperations: null,
    normalizeSendAttachments: input => input || [],
    resolveInboxAttachmentPrompt: async (prompt, attachments) => ({ prompt, attachments }),
    inboxAttachmentPresentationSnapshot: () => null,
    readAgentReadyStatus: async () => ({ status: 'active', toolType: 'codex', inputReady: true }),
    codexSessionIdFromAuthoritativeStatus: value => value.sessionId || null,
    waitForAgentReady: async () => {
      if (startupFailure) throw Object.assign(new Error('fixture startup refused'), { code: 'agent_startup_defaults_failed' });
      return { status: 'active', toolType: 'codex', sessionId: 'fixture-session' };
    },
    readBody: req => new Promise((resolve, reject) => {
      let text = ''; req.on('data', data => text += data); req.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    }),
    sendTerminalBridgeError: (res, error) => {
      if (process.env.NOTED_CREATION_TEST_DIAGNOSTICS) console.warn(error.stack);
      return context.sendJson(res, 500, { error: error.message, code: error.code });
    },
    decId: decodeURIComponent,
  };
  vm.createContext(context); vm.runInContext(functions.map(fn).join('\n'), context);
  context.registerBridgeReplyHandler();
  contents.send = (_channel, request) => {
    bridges.push(request);
    if (request.action === 'ensureInboxProject') queueMicrotask(() => ipc.emit('web:bridge-reply', { sender: contents }, { requestId: request.requestId, ok: true, data: {} }));
    if (request.action === 'sendAgentPromptScenario') {
      const payload = request.payload;
      assert.equal(store.get(identity.operationKey).inboxSetup.creationState, 'created', 'creation committed BEFORE send');
      store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, STORE_STATES.ENTER_ARMED);
      const receipt = { success: true, accepted: true, submitted: true, auditPending: true, status: 'audit-pending' };
      store.settleAttempt(payload.sendOperationKey, payload.sendAttemptId, receipt);
      if (queued) {
        const accepted = store.markProviderQueueAccepted(payload.sendOperationKey, payload.sendAttemptId, {
          provider: 'codex', sessionId: 'fixture-session', sourceIdentity: 'codex-tui-queue:fixture:1:1:1:1:hash',
          evidence: { kind: 'committed-tui-queue-card', committedFrameGeneration: 1 },
        });
        assert.equal(accepted.ok, true);
        const queueReceipt = accepted.record.receipt;
        queueMicrotask(() => ipc.emit('web:bridge-reply', { sender: contents }, { requestId: request.requestId, ok: true, data: queueReceipt }));
      } else {
        const audit = { success: true, operationKey: payload.sendOperationKey, attemptId: payload.sendAttemptId,
          provider: 'codex', sessionId: 'fixture-session', expectedHash: promptAuditFingerprint(payload.prompt),
          actualHash: promptAuditFingerprint(payload.prompt), entryUuid: 'fixture-user', sourceIdentity: 'fixture-source',
          auditTimestamp: '2026-09-16T08:00:00.000Z' };
        assert.equal(store.promoteFromAudit(audit).promoted, true);
        queueMicrotask(() => ipc.emit('web:bridge-reply', { sender: contents }, { requestId: request.requestId, ok: true,
          data: { success: true, submitted: true, status: 'sent', exactAuditConfirmed: true, codexAudit: audit } }));
      }
    }
  };
  const postStart = source.indexOf("  if (parsed.pathname === '/api/inbox/runs' && req.method === 'POST')");
  const postEnd = source.indexOf("  if (parsed.pathname === '/api/inbox/sessions/resume'", postStart);
  const getStart = source.indexOf("  m = parsed.pathname.match(/^\\/api\\/inbox\\/runs\\/([^/]+)$/);");
  const getEnd = source.indexOf("  m = parsed.pathname.match(/^\\/api\\/inbox\\/runs\\/([^/]+)\\/result$/);", getStart);
  assert.ok(getStart > 0 && getEnd > getStart);
  const handle = vm.runInContext('(async(req,res,parsed)=>{let m;' + source.slice(postStart, postEnd) + source.slice(getStart, getEnd) + '})', context);
  const server = http.createServer((req, res) => {
    // Exact HTTP body/handler, no live app/storage/provider. The global auth
    // gate is covered by the existing API suite, not replaced by a login here.
    const task = handle(req, res, new URL(req.url, 'http://fixture')).catch(error => context.sendJson(res, 500, { error: error.message }));
    requests.push(task);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    contents.emit('destroyed');
    await Promise.allSettled(requests);
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); db.close();
  });
  const request = async (method, value = body, signal) => {
    const response = await fetch(url + (method === 'POST' ? '/api/inbox/runs' : '/api/inbox/runs/' + body.runId),
      { method, signal, ...(method === 'POST' ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const untilCreate = async () => {
    for (let i = 0; i < 100 && !bridges.some(r => r.action === 'createAgentTab'); i++) await new Promise(setImmediate);
    assert.ok(bridges.some(r => r.action === 'createAgentTab'));
  };
  const reply = (data = {}, ok = true) => {
    const create = bridges.find(r => r.action === 'createAgentTab');
    const result = { tabId: identity.tabId, toolType: 'codex', projectId: '__noted_inbox__', launchId: 'fixture-launch', ...data };
    if (ok) descriptor = { ...result, externalRun: { ...create.payload.externalRun } };
    ipc.emit('web:bridge-reply', { sender: contents }, { requestId: create.requestId, ok, data: ok ? result : data, error: ok ? null : 'fixture create refused' });
  };
  return { store, db, context, body, identity, bridges, events, requests, request, untilCreate, reply,
    expire: () => deadlines.find(timer => timer.ms === 8000 && !timer.cleared).callback(),
    destroy: () => contents.emit('destroyed'),
    sends: () => bridges.filter(r => r.action === 'sendAgentPromptScenario').length,
    creations: () => bridges.filter(r => r.action === 'createAgentTab').length,
  };
}

test('8s observation -> late SAME creation -> one original send; duplicate POST and GET never create/send', async t => {
  const h = await harness(t); if (!h) return;
  const original = h.request('POST'); await h.untilCreate(); h.expire();
  const observed = await original;
  assert.equal(observed.status, 202); assert.equal(observed.body.submitted, null);
  assert.equal(observed.body.setupOutcome.creationState, 'pending');
  assert.equal(observed.body.setupOutcome.submissionState, 'unknown');
  const voiceIntent = pairedVoice.createInboxRunIntent({ requestId: h.body.runId,
    clientAttemptId: 'fixture-client', chatId: h.body.conversationKey, baseUrl: 'http://fixture.invalid' });
  const readScope = pairedVoice.freezeInboxReadScope(voiceIntent, observed.body);
  assert.equal(readScope.tabId, h.identity.tabId);
  assert.equal(pairedVoice.projectInboxRunObservation(voiceIntent, observed.body).pending, true);
  assert.equal((await h.request('POST')).status, 202);
  assert.equal(h.creations(), 1); assert.equal(h.sends(), 0);
  h.reply(); await h.requests[0];
  const settled = await h.request('GET');
  assert.equal(settled.status, 200, JSON.stringify(settled));
  assert.equal(settled.body.setupOutcome.creationState, 'created');
  assert.equal(settled.body.setupOutcome.submissionState, 'sent');
  assert.equal(settled.body.setupOutcome.submissionProof.kind, 'exact-audit');
  assert.equal(h.sends(), 1); assert.equal(h.context.pendingBridge.size, 0);
  h.context.externalRuns.clear(); // observation/restart: no new continuation
  assert.equal((await h.request('GET')).body.setupOutcome.submissionState, 'sent');
  assert.equal((await h.request('POST')).status, 200);
  assert.equal(h.creations(), 1); assert.equal(h.sends(), 1);
});

test('HTTP disconnect before completion does not cancel or duplicate background creation', async t => {
  const h = await harness(t); if (!h) return;
  const controller = new AbortController();
  const original = h.request('POST', h.body, controller.signal).catch(error => error);
  await h.untilCreate(); controller.abort(); await original;
  h.reply(); await h.requests[0];
  assert.equal(h.sends(), 1); assert.equal((await h.request('GET')).body.setupOutcome.submissionState, 'sent');
});

test('restart observation of a pending original creator is unknown and cannot create or submit', async t => {
  const h = await harness(t); if (!h) return;
  const original = h.request('POST'); await h.untilCreate(); h.expire(); await original;
  h.context.externalRuns.clear();
  const observed = await h.request('GET');
  assert.equal(observed.status, 202); assert.equal(observed.body.setupOutcome.creationState, 'unknown');
  assert.equal(observed.body.conversationKey, h.body.conversationKey);
  await h.request('POST'); assert.equal(h.creations(), 1); assert.equal(h.sends(), 0);
  h.destroy(); await h.requests[0];
});

test('another renderer cannot settle an owned creation even with the same requestId', async t => {
  const h = await harness(t); if (!h) return;
  const original = h.request('POST'); await h.untilCreate();
  const create = h.bridges.find(r => r.action === 'createAgentTab');
  h.context.ipcMain.emit('web:bridge-reply', { sender: new EventEmitter() }, {
    requestId: create.requestId, ok: true,
    data: { tabId: h.identity.tabId, projectId: '__noted_inbox__', toolType: 'codex' },
  });
  assert.equal(h.store.get(h.identity.operationKey).inboxSetup.creationState, 'pending');
  assert.equal(h.sends(), 0); h.reply(); await original; assert.equal(h.sends(), 1);
});

test('late owned creation followed by exact startup refusal yields durable no-write, not fake Worked/result', async t => {
  const h = await harness(t, { startupFailure: true }); if (!h) return;
  const original = h.request('POST'); await h.untilCreate(); h.expire(); await original;
  h.reply(); await h.requests[0];
  const settled = await h.request('GET');
  assert.equal(settled.status, 409);
  assert.equal(settled.body.setupOutcome.creationState, 'created');
  assert.equal(settled.body.setupOutcome.submissionState, 'not-submitted');
  assert.equal(settled.body.setupOutcome.submissionProof.kind, 'no-submit');
  const voiceIntent = pairedVoice.createInboxRunIntent({ requestId: h.body.runId,
    clientAttemptId: 'fixture-client', chatId: h.body.conversationKey, baseUrl: 'http://fixture.invalid' });
  assert.equal(pairedVoice.projectInboxRunObservation(voiceIntent, settled.body).refused, true);
  assert.equal(h.store.get(h.identity.operationKey).attemptId, null); assert.equal(h.sends(), 0);
  assert.equal((await h.context.getInboxResultResponse(h.body.runId)).body.code, 'inbox_setup_not_submitted');
  assert.equal(h.events.length, 1); assert.equal(h.events[0].event.type, 'inbox-result');
});

for (const failure of ['refused', 'wrong-tab', 'channel-closed', 'foreign-owner']) test('creation boundary ' + failure + ' cannot submit/recreate', async t => {
  const h = await harness(t); if (!h) return;
  const original = h.request('POST'); await h.untilCreate(); h.expire(); await original;
  if (failure === 'refused') h.reply({}, false);
  if (failure === 'wrong-tab') h.reply({ tabId: 'FOREIGN' });
  if (failure === 'channel-closed') h.destroy();
  if (failure === 'foreign-owner') { h.context.externalRuns.clear(); h.reply(); }
  await h.requests[0]; h.context.externalRuns.clear();
  const observed = await h.request('GET');
  assert.equal(observed.body.setupOutcome.submissionState, failure === 'refused' ? 'not-submitted' : 'unknown');
  assert.equal(h.sends(), 0);
  await h.request('POST');
  assert.equal(h.creations(), 1);
});

test('settled HTTP observer does not cancel the original background creation/send', async t => {
  const h = await harness(t); if (!h) return;
  // The exact operation survives sending its 202 even if this observer never
  // asks again. Subtitles/foreground have no role in its continuation.
  const original = h.request('POST'); await h.untilCreate(); h.expire(); await original;
  h.reply(); await h.requests[0];
  assert.equal(h.sends(), 1); assert.equal(h.store.get(h.identity.operationKey).state, 'confirmed');
  assert.equal(h.context.pendingBridge.size, 0);
});

test('ordinary bridge timeout/late Send callback remains separate from owned creation observation', async t => {
  const h = await harness(t); if (!h) return;
  let late = 0;
  const ordinary = h.context.bridgeRequest('fixture-ordinary', {}, 37, { onLateReply: () => late++ });
  const request = h.bridges.find(r => r.action === 'fixture-ordinary');
  h.context.pendingBridge.get(request.requestId).timer.callback();
  await assert.rejects(ordinary, { code: 'bridge_timeout' });
  h.context.ipcMain.emit('web:bridge-reply', null, { requestId: request.requestId, ok: true, data: {} });
  await new Promise(setImmediate); assert.equal(late, 1);
  assert.equal(h.context.pendingBridge.size, 0); assert.equal(h.sends(), 0);
});

test('queued proof stays queued (not final answer); raw submitted=false is never no-write proof', async t => {
  const h = await harness(t, { queued: true }); if (!h) return;
  const original = h.request('POST'); await h.untilCreate(); h.reply(); await original;
  const outcome = (await h.request('GET')).body.setupOutcome;
  assert.equal(outcome.submissionState, 'queued'); assert.equal(outcome.submissionProof.kind, 'provider-queue');
  const legacyRun = { runId: h.body.runId, provider: 'codex', handoffId: h.identity.handoffId, conversationKey: h.body.conversationKey };
  const row = h.store.get(h.identity.operationKey);
  h.context.agentSendReceiptStore = { get: () => ({ ...row, state: 'preparing', attemptId: null, inboxSetup: null,
    receipt: { submitted: false, code: 'bridge_timeout' }, auditIdentity: null }) };
  const legacy = h.context.inboxSetupOutcome(legacyRun);
  assert.equal(legacy.creationRequestId, null); assert.equal(legacy.creationState, 'unknown');
  assert.equal(legacy.submissionState, 'unknown'); assert.equal(legacy.submissionProof, null);
});

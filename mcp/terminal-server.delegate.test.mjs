import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, appendFile, stat, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SavedHistoryOperations } = require('../src/main/saved-history-operation.js');
const { SessionTranscriptService } = require('../src/main/session-transcript-service.js');

const terminalServerPath = fileURLToPath(new URL('./terminal-server.mjs', import.meta.url));

test('continue_delegation is one app-owned action, keeps the original recipient and does not replay a task', async t => {
  const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { orchestrationContinuation: { version: 1 } } } }
    : { status: 200, body: { ok: true, pending: true, run: { runId: 'old-run', sourceTabId: 'original-source' } } });
  const response = await h.invoke({ runId: 'old-run' }, 'continue_delegation');
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(h.requests.map(r => [r.method, r.url]), [['GET', '/api/me'], ['POST', '/api/orchestrations/old-run/action']]);
  assert.equal(h.requests[1].body.action, 'continue'); assert.equal(h.requests[1].body.prompt, undefined);
});

test('continue_delegation rejects an old Main before any mutation', async t => {
  const h = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  const response = await h.invoke({ runId: 'old-run' }, 'continue_delegation');
  assert.equal(response.result.isError, true); assert.equal(h.requests.length, 1);
});

const userNotifyCapability = { userNotifications: { version: 1, telegramOnly: true } };
function userNotifyReceipt(body, extra = {}) {
  const sentAt = Date.now() - 2000;
  return { ok: true, accepted: true, durable: true, requestId: body.requestId, tabId: 'test-source-tab',
    channel: 'telegram', deliveryState: 'sent', sentAt, messageId: 101,
    waitSeconds: body.waitSeconds || 0, waitUntil: sentAt + (body.waitSeconds || 0) * 1000, ...extra };
}

test('notify_user exposes Telegram-only warning and waits after the exact sent receipt', async t => {
  const h = await createHarness(t, (body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: userNotifyCapability } }
    : (() => { const sentAt = Date.now(); return { status: 200,
      body: userNotifyReceipt(body, { sentAt, waitUntil: sentAt + 1000 }) }; })());
  const started = Date.now();
  const response = await h.invoke({ text: 'Cursor warning', waitSeconds: 1 }, 'notify_user');
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.waitCompleted, true);
  assert.ok(Date.now() - started >= 1000);
  assert.deepEqual(h.requests.map(r => [r.method, r.url]), [
    ['GET', '/api/me'], ['POST', '/api/terminal-tabs/test-source-tab/notifications'],
  ]);
  assert.equal(h.requests[1].body.sourceMeta.tabId, 'test-source-tab');
  assert.equal(h.requests[1].body.sourceMeta.projectId, 'test-project');
});

test('notify_user pending is not delivery and never starts its requested wait', async t => {
  const h = await createHarness(t, (body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: userNotifyCapability } }
    : { status: 202, body: userNotifyReceipt(body, { deliveryState: 'pending', sentAt: null, waitUntil: null, messageId: null }) });
  const response = await h.invoke({ text: 'warning', waitSeconds: 30 }, 'notify_user');
  assert.equal(response.result.structuredContent.waitCompleted, false);
  assert.equal(response.result.structuredContent.deliveryState, 'pending');
  assert.equal(h.requests.length, 2);
});

test('notify_user rejects old app and keeps a generated ID after lost ACK', async t => {
  const old = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  const rejected = await old.invoke({ text: 'warning' }, 'notify_user');
  assert.equal(rejected.result.structuredContent.code, 'app_update_required');
  assert.equal(rejected.result.structuredContent.mutationAttempted, false);
  assert.equal(old.requests.length, 1);
  const lost = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: userNotifyCapability } } : { disconnect: true });
  const unknown = await lost.invoke({ text: 'warning' }, 'notify_user');
  assert.equal(unknown.result.structuredContent.deliveryState, 'unknown');
  assert.equal(unknown.result.structuredContent.requestId, lost.requests[1].body.requestId);
  assert.equal(lost.requests.length, 2);
});

test('get_user_notification is exact/passive and preserves the original wait deadline', async t => {
  const receipt = userNotifyReceipt({ requestId: 'original', waitSeconds: 20 });
  const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: userNotifyCapability } } : { status: 200, body: receipt });
  const response = await h.invoke({ requestId: 'original' }, 'get_user_notification');
  assert.equal(response.result.structuredContent.waitUntil, receipt.waitUntil);
  assert.equal(response.result.structuredContent.waitCompleted, false);
  assert.deepEqual(h.requests.map(r => r.method), ['GET', 'GET']);
  assert.equal(h.requests[1].url, '/api/terminal-tabs/test-source-tab/notifications?requestId=original');
});

test('notify_user forbids source/target overrides before network and is discoverable', async t => {
  const h = await createHarness(t, () => assert.fail('invalid input must not reach HTTP'));
  const response = await h.invoke({ text: 'warning', tabId: 'foreign' }, 'notify_user');
  assert.equal(response.result.isError, true);
  assert.equal(h.requests.length, 0);
  const tool = (await h.rpc('tools/list')).result.tools.find(tool => tool.name === 'notify_user');
  assert.deepEqual(tool.inputSchema.required, ['text']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['text', 'waitSeconds', 'requestId']);
});

test('cancel_message uses the exact thread and trusted calling tab, never Send/Stop/dismiss', async t => {
  const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { tabMessages: { cancellation: { version: 1 } } } } }
    : { status: 200, body: { ok: true, cancelled: true, messageId: 'question-1', requestedMessageId: 'question-1' } });
  const result = await h.invoke({ messageId: 'question-1', tabId: 'untrusted-override' }, 'cancel_message');
  assert.equal(result.result.isError, undefined);
  assert.equal(result.result.structuredContent.cancelled, true);
  assert.deepEqual(h.requests.map(r => [r.method, r.url]), [
    ['GET', '/api/me'], ['POST', '/api/tab-messages/question-1/cancel'],
  ]);
  assert.equal(h.requests[1].body.tabId, 'test-source-tab');
  assert.equal(h.requests[1].body.prompt, undefined);
});

test('cancel_message distinguishes old app and unknown ACK without a fallback mutation', async t => {
  const old = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  const unsupported = await old.invoke({ messageId: 'q-old' }, 'cancel_message');
  assert.equal(unsupported.result.structuredContent.code, 'app_update_required');
  assert.equal(unsupported.result.structuredContent.mutationAttempted, false);
  assert.deepEqual(old.requests.map(r => r.method), ['GET']);
  const lost = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { tabMessages: { cancellation: { version: 1 } } } } }
    : { disconnect: true });
  const unknown = await lost.invoke({ messageId: 'q-exact' }, 'cancel_message');
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.messageId, 'q-exact');
  assert.equal(unknown.result.structuredContent.mutationAttempted, true);
  assert.equal(lost.requests.length, 2);
});

test('cancel_message is discoverable with no target/runtime/attempt override', async t => {
  const h = await createHarness(t, () => assert.fail('tool catalog is local'));
  const tool = (await h.rpc('tools/list')).result.tools.find(t => t.name === 'cancel_message');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['messageId']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['messageId']);
});

test('passive response observation uses one durable request without a target prompt', async t => {
  const h = await createHarness(t, (body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { responseObservations: { version: 1 } } } }
    : { status: 202, body: { accepted: true, runId: body.runId, run: { runKind: 'response-observation' } } });
  const result = await h.invoke({ tabId: 'target', runId: 'observe-target', waitForDescendants: true }, 'wait_for_tab_response');
  assert.equal(result.result.isError, undefined);
  assert.equal(result.result.structuredContent.runId, 'observe-target');
  const calls = h.requests.filter(request => request.method === 'POST');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/terminal-tabs/target/response-observations');
  assert.equal(calls[0].body.sourceTabId, 'test-source-tab');
  assert.equal(calls[0].body.waitForDescendants, true);
  assert.equal(calls[0].body.prompt, undefined);
});

test('response observation fails clearly on an old app and retains its ID after lost ACK', async t => {
  const old = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  const unsupported = await old.invoke({ tabId: 'target' }, 'wait_for_tab_response');
  assert.equal(unsupported.result.structuredContent.code, 'app_update_required');
  assert.equal(unsupported.result.structuredContent.mutationAttempted, false);
  assert.ok(unsupported.result.structuredContent.runId);
  assert.deepEqual(old.requests.map(request => request.method), ['GET']);
  const lost = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { responseObservations: { version: 1 } } } }
    : { disconnect: true });
  const failed = await lost.invoke({ tabId: 'target' }, 'wait_for_tab_response');
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.runId, lost.requests[1].body.runId);
  assert.equal(failed.result.structuredContent.mutationAttempted, true);
  assert.equal(lost.requests.length, 2);
});

test('response observation crosses actual MCP/HTTP, durable registry, Codex bytes and source notification owner', async t => {
  const Database = require('better-sqlite3');
  let db;
  try { db = new Database(':memory:'); }
  catch (error) {
    if (/NODE_MODULE_VERSION/.test(error.message)) { t.skip('Run with ELECTRON_RUN_AS_NODE=1 for native SQLite'); return; }
    throw error;
  }
  const { OrchestrationRunStore, isTerminalStatus, isExternalResearchRun, isCompleteOrchestrationResult,
    captureOrchestrationResultAttempt, orchestrationResultAttemptMatches, classifyAgentSendReceipt } = require('../src/main/orchestration-runs');
  const { createResponseObservationApi } = require('../src/main/response-observation-api');
  const { createResponseObservationService } = require('../src/main/response-observation-service');
  const { ResponseObservationEvidenceStore } = require('../src/main/response-observation-evidence');
  const { isResponseObservation } = require('../src/main/orchestration-response-observation');
  const { createAgentResponseObservationReader } = require('../src/main/agent-response-observation-reader');
  const contentModule = require('../src/main/orchestration-completion-content');
  const { promptFingerprint } = require('../src/main/claude-prompt-carriers');
  const { promptAuditFingerprint } = require('../src/main/prompt-audit-fingerprint');
  const { _api } = require('../src/main/ipc/codex-data');
  const root = await mkdtemp(join(tmpdir(), 'mcp-observed-response-'));
  const file = join(root, 'rollout.jsonl');
  const event = (type, values = {}) => ({ type: 'event_msg', payload: { type, ...values } });
  const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(file, encode([event('task_started', { turn_id: 'T' }), event('user_message', { message: 'existing task' })]));
  const execution = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 3 };
  const resolveSource = async () => { const s = await stat(file); return { success: true, sessionId: 'S', revisionKey: file,
    sourceSnapshot: { filePath: file, sessionId: 'S', size: s.size, mtimeMs: s.mtimeMs },
    segments: [{ filePath: file, physicalSessionId: 'S', fromByte: 0, toByte: s.size, startLine: 0, frozen: false }] }; };
  let busy = true;
  const reader = createAgentResponseObservationReader({
    captureState: () => ({ known: true, exists: true, toolType: 'codex', sessionId: 'S', cwd: root,
      busy, revision: busy ? 'active' : 'done', backgroundWorkCount: 0,
      executionContext: execution, turn: { ...execution, active: busy } }),
    readLifecycle: async () => ({ processStatus: 'found', processName: 'codex', processPid: 42 }),
    loadSessionTurns: async () => { throw Error('Pinned execution must not materialize full History'); },
    readTurnResult: async () => { throw Error('Pinned execution must not use a guessed prompt'); },
    readCodexExecution: request => _api.loadCodexObservedExecution({ ...request, resolveSource }),
  });
  const store = new OrchestrationRunStore(join(root, 'runs.json'));
  await store.initialize();
  const evidence = new ResponseObservationEvidenceStore(db), contents = new contentModule.CompletionContentStore({ db });
  const writes = [], sourceReads = [];
  let service;
  const webSource = await readFile(new URL('../src/main/web-server.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('web-server.js', webSource, ts.ScriptTarget.Latest, true);
  const functions = ['orchestrationNotificationText', 'orchestrationPresentationSnapshot',
    'prepareOrchestrationCompletionContent', 'sendOrchestrationCompletionNotification'].map(name => {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, name); return fn.getText(ast);
  });
  const context = vm.createContext({ console, crypto: require('node:crypto'), Set, Date,
    resolvedPort: 1, orchestrationNotificationInflight: new Set(), tabWorkContext: null,
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: null,
    getOrchestrationRunStore: () => store, getCompletionContentStore: () => contents,
    getResponseObservationService: () => service,
    ...contentModule, captureOrchestrationResultAttempt, orchestrationResultAttemptMatches,
    isTerminalStatus, isExternalResearchRun, isResponseObservation, isCompleteOrchestrationResult,
    promptFingerprint, promptAuditFingerprint, classifyAgentSendReceipt,
    AGENT_SEND_RECEIPT_STATES: require('../src/main/agent-send-receipt-registry').RECEIPT_STATES,
    isAgentSendProviderQueueAccepted: () => false,
    emitOrchestrationChanges() {}, finalizeSettledOrchestration: async () => {},
    releaseOrchestrationSourceProof: async () => {}, armOrchestrationSourceProof: async () => ({ success: true }),
    resolveAgentSessionInfo: async tabId => { sourceReads.push(tabId); assert.equal(tabId, 'test-source-tab');
      return { toolType: 'codex', commandType: 'codex', sessionId: 'source-session', status: 'busy' }; },
    resolveOrchestrationSourceNotificationSendOptions: () => ({ statusAtSend: 'busy', queue: true }),
    runAgentSendScenario: async request => {
      writes.push(request); assert.equal(request.tabId, 'test-source-tab');
      return { success: true, submitted: true, receiptState: 'confirmed', codexAudit: {
        success: true, actualHash: promptAuditFingerprint(request.prompt), expectedHash: promptAuditFingerprint(request.prompt),
        sessionId: 'source-session', entryUuid: 'source-notification', sourceIdentity: 'source-notification-physical',
        executionContext: { provider: 'codex', sessionId: 'source-session', turnId: 'source-followup', generation: 4 },
      } };
    },
    notifyAgentPromptAuditResult: async detail => store.confirmSourceFollowup('observed', { ...detail,
      kind: 'prompt-audit', sourceTabId: detail.tabId, userUuid: detail.entryUuid }),
    reconcileOrchestrationSourceFollowup: async () => ({ confirmed: true }),
  });
  vm.runInContext(functions.join('\n'), context);
  service = createResponseObservationService({ store, evidence,
    readState: reader.getAgentResponseState, readResponse: reader.readAgentObservedResponse,
    subscribe: async () => ({ success: true }), unsubscribe: async () => {},
    onChanged() {}, onSettled: context.sendOrchestrationCompletionNotification,
    log: { log() {}, warn() {} },
  });
  const api = createResponseObservationApi({ store,
    descriptor: tabId => ({ tabId, tabName: tabId, projectId: 'test-project', projectPath: root, cwd: root, toolType: 'codex' }),
    readState: reader.getAgentResponseState, sourceExecutionContext: () => null,
    captureSourceTarget: async () => ({ toolType: 'codex', sessionId: 'source-session' }), onAccepted() {},
  });
  const handler = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleApi');
  const matchDeclaration = handler.body.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'responseObservationMatch'));
  const route = handler.body.statements.find(node => ts.isIfStatement(node)
    && node.expression.getText(ast) === "responseObservationMatch && req.method === 'POST'");
  assert.ok(matchDeclaration && route);
  const routeContext = vm.createContext({ getResponseObservationApi: () => api,
    decId: decodeURIComponent, withOrchestrationUrls: run => run,
    readBody: async request => request.parsedBody,
    sendJson: (_response, status, body) => ({ status, body }),
  });
  const actualRoute = vm.runInContext('(async (req,res,parsed) => {'
    + matchDeclaration.getText(ast) + '\n' + route.getText(ast) + '})', routeContext);
  t.after(async () => { await service.dispose(); await store.flush(); db.close(); await rm(root, { recursive: true, force: true }); });
  const h = await createHarness(t, async (body, _i, req) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    context.resolvedPort = Number(new URL('http://' + req.headers.host).port);
    if (req.url === '/api/me') return { status: 200, body: { capabilities: { responseObservations: { version: 1 } } } };
    assert.equal(req.url, '/api/terminal-tabs/target/response-observations');
    req.parsedBody = body;
    return actualRoute(req, null, { pathname: new URL(req.url, 'http://localhost').pathname });
  });
  const accepted = await h.invoke({ tabId: 'target', runId: 'observed', waitForDescendants: false }, 'wait_for_tab_response');
  assert.equal(accepted.result.structuredContent.accepted, true);
  await service.arm(await store.getInternal('observed'));
  assert.equal(writes.length, 0);
  assert.deepEqual(store.readInheritedActivity().sourceTabIds, ['test-source-tab']);
  await appendFile(file, encode([{ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'EXACT OBSERVED FINAL' }] } }, event('task_complete', { turn_id: 'T', last_agent_message: 'EXACT OBSERVED FINAL' })]));
  busy = false;
  await service.handleLifecycle('target', { type: 'done', reason: 'task_complete', executionContext: execution });
  await service.reconcile('observed', 'actual-private-completion');
  assert.equal(writes.length, 1);
  assert.match(writes[0].prompt, /EXACT OBSERVED FINAL/);
  assert.equal(writes[0].handoffId, 'orchestration-complete:observed');
  assert.equal(writes[0].sendOperationKey, 'history:test-source-tab:orchestration-complete:observed');
  assert.equal(writes[0].expectedTarget.sessionId, 'source-session');
  assert.equal(writes[0].presentationSnapshot.semanticTags[0].runKind, 'response-observation');
  const run = await store.get('observed');
  assert.equal(run.status, 'completed');
  assert.equal(run.notificationStatus, 'sent');
  assert.ok(run.sourceFollowupStartedAt);
  assert.ok(sourceReads.every(id => id === 'test-source-tab'));
  await service.reconcile('observed', 'duplicate-completion');
  assert.equal(writes.length, 1);
});

test('exact receipt recovery methods forward only operation/attempt and explicit caller-owned release identity', async t => {
  const h = await createHarness(t, (body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { sendQueue: { receiptReconciliation: { version: 1, exactAttempt: true },
      explicitUnknownRelease: { version: 1, exactAttempt: true } } } } }
    : { status: 200, body: { ok: true, tabId: 'target', ...body, receipt: { state: 'delivery-unknown', submitted: true } } });
  const exact = { tabId: 'target', operationKey: 'old-operation', attemptId: 'old-attempt' };
  const audit = await h.invoke(exact, 'reconcile_send_receipt');
  const release = await h.invoke({ ...exact, requestId: 'release-old-v1', acknowledgeDeliveryUnknown: true }, 'release_send_queue_head');
  assert.equal(audit.result.isError, undefined);
  assert.equal(release.result.isError, undefined);
  assert.equal(audit.result.structuredContent.receipt.state, 'delivery-unknown');
  assert.equal(release.result.structuredContent.requestId, 'release-old-v1');
  assert.deepEqual(h.requests.filter(request => request.method === 'POST'), [
    { method: 'POST', url: '/api/terminal-tabs/target/send-receipts/reconcile', body: { operationKey: exact.operationKey, attemptId: exact.attemptId } },
    { method: 'POST', url: '/api/terminal-tabs/target/send-receipts/release', body: { operationKey: exact.operationKey, attemptId: exact.attemptId,
      requestId: 'release-old-v1', acknowledgeDeliveryUnknown: true } },
  ]);
});

test('recovery refuses old capabilities/extra proof and retains original recovery IDs after ACK loss', async t => {
  const exact = { tabId: 'target', operationKey: 'old-operation', attemptId: 'old-attempt',
    requestId: 'release-old-v1', acknowledgeDeliveryUnknown: true };
  const old = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  assert.equal((await old.invoke(exact, 'release_send_queue_head')).result.structuredContent.code, 'app_update_required');
  assert.deepEqual(old.requests.map(request => request.method), ['GET']);
  const invalid = await createHarness(t, () => { throw Error('invalid recovery must not use HTTP'); });
  assert.equal((await invalid.invoke({ ...exact, prompt: 'do not replay' }, 'release_send_queue_head')).result.isError, true);
  assert.equal((await invalid.invoke({ ...exact, acknowledgeDeliveryUnknown: false }, 'release_send_queue_head')).result.isError, true);
  assert.deepEqual(invalid.requests, []);
  const lost = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { sendQueue: { explicitUnknownRelease: { version: 1, exactAttempt: true } } } } }
    : { disconnect: true });
  const result = await lost.invoke(exact, 'release_send_queue_head');
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.requestId, exact.requestId);
  assert.equal(result.result.structuredContent.operationKey, exact.operationKey);
  assert.equal(result.result.structuredContent.attemptId, exact.attemptId);
  assert.equal(result.result.structuredContent.mutationAttempted, true);
  assert.equal(lost.requests.filter(request => request.method === 'POST').length, 1);
  const rejected = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { sendQueue: { explicitUnknownRelease: { version: 1, exactAttempt: true } } } } }
    : { status: 409, body: { error: 'send_queue_release_not_head' } });
  assert.equal((await rejected.invoke(exact, 'release_send_queue_head')).result.structuredContent.code, 'send_queue_release_not_head');
});

test('Codex Goal tools read exact state and choose only an addressed native option', async t => {
  const h = await createHarness(t, (body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { codexGoal: { version: 1 } } } }
    : { status: 200, body: { status: 'available', availableActions: ['resume', 'leave-paused'], ...body } });
  await h.invoke({ tabId: 'target' }, 'get_codex_goal');
  await h.invoke({ tabId: 'target', operationId: 'op', action: 'leave-paused', requestId: 'choice' }, 'resolve_codex_goal');
  await h.invoke({ tabId: 'target', requestId: 'choice' }, 'get_codex_goal');
  assert.deepEqual(h.requests.filter(x => x.url !== '/api/me'), [
    { method: 'GET', url: '/api/terminal-tabs/target/codex/goal', body: {} },
    { method: 'POST', url: '/api/terminal-tabs/target/codex/goal', body: { operationId: 'op', requestId: 'choice', action: 'leave-paused' } },
    { method: 'GET', url: '/api/terminal-tabs/target/codex/goal?requestId=choice', body: {} },
  ]);
});

test('Codex Goal errors retain recovery identity and cannot fall back to terminal keys or Resume', async t => {
  const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { codexGoal: { version: 1 } } } }
    : { status: 409, body: { error: 'goal-action-outcome-unknown', code: 'goal-action-outcome-unknown', status: 'rejected' } });
  const result = await h.invoke({ tabId: 'target', operationId: 'op', action: 'resume' }, 'resolve_codex_goal');
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.code, 'goal-action-outcome-unknown');
  assert.equal(result.result.structuredContent.requestId, h.requests[1].body.requestId);
  assert.ok(h.requests[1].body.requestId);
  assert.equal(h.requests.length, 2);
  const old = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  const failed = await old.invoke({ tabId: 'target', operationId: 'op', action: 'resume' }, 'resolve_codex_goal');
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /requires an update/);
  assert.deepEqual(old.requests.map(x => x.method + ' ' + x.url), ['GET /api/me']);
});

test('System Prompts tools route editor fields and revisions through the dedicated API', async t => {
  const harness = await createHarness(t, (body, _index, req) => {
    if (req.url === '/api/me') return { status: 200, body: { capabilities: { systemPrompts: { version: 1 } } } };
    return { status: 200, body: { prompt: { id: 'tab-title', revision: 'current', ...body } } };
  });
  await harness.invoke({}, 'list_system_prompts');
  await harness.invoke({ promptId: 'tab-title' }, 'get_system_prompt');
  const fields = { name: 'Заголовок', content: 'короткая тема', model: 'gemini-3.8-flash', thinkingLevel: 'NONE',
    color: '#22c55e', showInContextMenu: false, position: 5, filePaths: ['/tmp/title.md'] };
  await harness.invoke({ promptId: 'tab-title', revision: 'before', ...fields }, 'update_system_prompt');
  await harness.invoke({ promptId: 'my-custom', name: 'Custom', content: 'body' }, 'create_system_prompt');
  await harness.invoke({}, 'get_system_prompt_settings');
  await harness.invoke({ revision: 'settings-before', rewindPromptId: 'my-custom' }, 'update_system_prompt_settings');
  await harness.invoke({ promptId: 'my-custom', revision: 'delete-before' }, 'delete_system_prompt');
  const calls = harness.requests.filter(req => req.url !== '/api/me');
  assert.deepEqual(calls.map(req => [req.method, req.url]), [
    ['GET', '/api/system-prompts'], ['GET', '/api/system-prompts/tab-title'], ['PATCH', '/api/system-prompts/tab-title'],
    ['POST', '/api/system-prompts'], ['GET', '/api/system-prompts/settings'], ['PATCH', '/api/system-prompts/settings'],
    ['DELETE', '/api/system-prompts/my-custom'],
  ]);
  assert.deepEqual(calls[2].body, { ...fields, revision: 'before' });
  assert.deepEqual(calls[3].body, { id: 'my-custom', name: 'Custom', content: 'body' });
});

test('System Prompts on an older app fail before any mutation or saved-library fallback', async t => {
  const harness = await createHarness(t, () => ({ status: 200, body: { capabilities: {} } }));
  const response = await harness.invoke({ promptId: 'tab-title', revision: 'old', content: 'new' }, 'update_system_prompt');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /requires an update.*System Prompts/);
  assert.deepEqual(harness.requests.map(req => [req.method, req.url]), [['GET', '/api/me']]);
});

function readJsonLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Terminal MCP response'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => onError(new Error('Terminal MCP closed before responding'));
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('end', onEnd);
  });
}

async function createHarness(t, respond, { historyApi = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'terminal-mcp-delegate-'));
  const discoveryDir = join(home, '.noted-terminal');
  const projectId = 'test-project';
  const projectPath = '/tmp/terminal-mcp-test-project';
  const sourceTabId = 'test-source-tab';
  const requests = [];
  await mkdir(discoveryDir, { recursive: true });

  const webServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body });
    const response = await respond(body, requests.length, req);
    if (response.disconnect) { req.socket.destroy(); return; }
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  webServer.listen(0, '127.0.0.1');
  await once(webServer, 'listening');
  const webPort = webServer.address().port;
  const ownerPid = process.pid;

  await writeFile(join(discoveryDir, 'web-token.txt'), 'test-token', 'utf8');
  await writeFile(join(discoveryDir, `web-server-${ownerPid}.json`), JSON.stringify({
    port: webPort,
    updatedAt: Date.now(),
  }), 'utf8');
  await writeFile(join(discoveryDir, `mcp-port-${ownerPid}`), JSON.stringify({
    port: historyApi ? webPort : 1,
    openProjectPaths: [projectPath],
    openProjects: [{ id: projectId, path: projectPath, name: 'test-project' }],
    updatedAt: Date.now(),
  }), 'utf8');

  const spawnChild = () => spawn(process.execPath, [terminalServerPath, '--project', projectPath], {
    env: {
      ...process.env,
      NOTED_DISCOVERY_DIR: discoveryDir,
      NOTED_MAIN_PID: String(ownerPid),
      NOTED_PARENT_PROJECT_ID: projectId,
      NOTED_PARENT_TAB_ID: sourceTabId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let child = spawnChild();
  const stopChild = async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  };

  t.after(async () => {
    await stopChild();
    await new Promise((resolve) => webServer.close(resolve));
    await rm(home, { recursive: true, force: true });
  });

  let requestId = 0;
  const rpc = async (method, params) => {
    const response = readJsonLine(child.stdout);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) + '\n');
    return response;
  };
  return {
    requests,
    rpc,
    async restart() { await stopChild(); child = spawnChild(); },
    async invoke(args, name = 'delegate_to_session') {
      return rpc('tools/call', { name, arguments: args });
    },
  };
}

const savedHistoryCapability = { version: 1, providers: ['codex', 'claude'],
  operations: ['rewind', 'delete'], receipts: true, structuredDraft: true, codexPhysicalSuffix: true, repairOfOperationId: true };
const rewindArgs = { tabId: 'target', operationId: 'rewind-exact-v1',
  expectedSessionId: 'saved-source', targetUuid: 'exact-user' };

function savedHistoryFixture() {
  const rows = new Map(), dispatches = [];
  const db = { getAppState: key => rows.get(key), setAppState: (key, value) => rows.set(key, value) };
  const options = { db, runtime: {}, claude: { loadOperationSource: () => {} },
    inspectRepair: () => {}, hashRecords: () => {},
    dispatch: async (name, args) => { dispatches.push({ name, args }); } };
  let operations = new SavedHistoryOperations(options);
  return {
    dispatches,
    restart() { operations = new SavedHistoryOperations(options); },
    complete(id = rewindArgs.operationId) {
      const lease = operations.leases.get(operations.key('target', id));
      operations.save(lease, { state: 'completed', phase: 'completed', pending: false,
        success: true, historyMutated: true, bindingCommitted: true, newSessionId: 'child',
        binding: { applied: true, sessionId: 'child' }, draft: { text: 'original prompt', promptChips: [] },
        resume: { success: false, inputReady: false, error: 'resume-still-pending' } });
    },
    respond(body, _i, req) {
      if (req.url === '/api/me') return { status: 200, body: { capabilities: { savedHistory: savedHistoryCapability } } };
      if (req.url === '/api/terminal-tabs/target/status') return { status: 200,
        body: { inputReady: false, lifecycle: 'starting', sessionId: null } };
      try {
        const base = '/api/terminal-tabs/target/history-operations';
        const operation = req.method === 'POST' && req.url === base
          ? operations.accept('target', body)
          : req.method === 'GET' && req.url.startsWith(base + '/')
            ? operations.read('target', decodeURIComponent(req.url.slice(base.length + 1))) : null;
        if (!operation) return { status: 404, body: { ok: false, error: 'history_operation_not_found' } };
        return { status: operation.pending ? 202 : operation.success ? 200 : 409, body: { ok: true, operation } };
      } catch (error) { return { status: error.statusCode || 500, body: { ok: false, error: error.code || error.message } }; }
    },
  };
}

test('MCP exposes saved-history Rewind and its receipt reader, not native/AI-summary Rewind', async t => {
  const h = await createHarness(t, () => { throw new Error('tools/list must not use HTTP'); });
  const tools = (await h.rpc('tools/list')).result.tools;
  assert.equal(tools.some(tool => tool.name === 'rewind_ai'), false);
  const rewind = tools.find(tool => tool.name === 'rewind_history');
  assert.ok(rewind);
  assert.deepEqual(rewind.inputSchema.required, ['tabId', 'operationId', 'expectedSessionId', 'targetUuid']);
  assert.equal(rewind.inputSchema.additionalProperties, false);
  assert.equal(rewind.inputSchema.properties.mode, undefined);
  assert.match(rewind.description, /saved.history/i);
  assert.ok(tools.find(tool => tool.name === 'get_history_operation'));
  assert.deepEqual(h.requests, []);
});

test('saved-history dispatcher preserves exact identity and an accepted operation without asserting readiness', async t => {
  const fixture = savedHistoryFixture();
  const h = await createHarness(t, fixture.respond);
  const args = { ...rewindArgs, toolType: 'codex', targetSourceIdentity: 'physical-source-offset',
    expectedContentRevision: 'composite-token', targetEntryRef: { physicalSessionId: 'ancestor', rawUuid: 'raw-user',
      viewOwnerSessionId: 'saved-source', segmentId: 'frozen-segment', sourceIdentity: 'physical-source-offset' } };
  const response = await h.invoke(args, 'rewind_history');
  assert.equal(response.result.isError, undefined);
  const result = response.result.structuredContent;
  assert.equal(result.operationId, args.operationId);
  assert.equal(result.operation.pending, true);
  assert.equal(result.operation.historyMutated, false);
  assert.equal(result.inputReady, undefined);
  assert.match(result.guidance, /not.*inputReady/i);
  assert.deepEqual(h.requests, [
    { method: 'GET', url: '/api/me', body: {} },
    { method: 'POST', url: '/api/terminal-tabs/target/history-operations', body: {
      operationId: args.operationId, kind: 'rewind', toolType: 'codex', expectedSessionId: args.expectedSessionId,
      targetUuid: args.targetUuid, targetSourceIdentity: args.targetSourceIdentity,
      targetEntryRef: args.targetEntryRef, expectedContentRevision: args.expectedContentRevision,
    } },
  ]);
  assert.equal(fixture.dispatches.length, 1);
});

test('actual public Timeline entryRef round-trips through MCP without stripping its nested revision', async t => {
  const [entry] = SessionTranscriptService.prototype._decorateCodexContentRevision.call({}, [{
    uuid: 'public-user', entryRef: { physicalSessionId: 'ancestor', rawUuid: 'raw-user',
      viewOwnerSessionId: 'saved-source', sourceIdentity: 'physical-source-offset', segmentId: 'frozen-segment' },
  }], { token: 'exact-composite-revision' });
  const fixture = savedHistoryFixture();
  const h = await createHarness(t, fixture.respond);
  const args = { ...rewindArgs, targetUuid: entry.uuid, targetEntryRef: entry.entryRef,
    expectedContentRevision: entry.contentRevision };
  const response = await h.invoke(args, 'rewind_history');
  assert.equal(response.result.isError, undefined);
  assert.equal(fixture.dispatches.length, 1);
  assert.deepEqual(h.requests.at(-1).body.targetEntryRef, entry.entryRef);
  assert.equal(h.requests.at(-1).body.expectedContentRevision, entry.contentRevision);
});

test('MCP forwards an exact completed-COW repair selector only to an app advertising repair and physical suffix', async t => {
  const fixture = savedHistoryFixture();
  const h = await createHarness(t, fixture.respond);
  await h.invoke(rewindArgs, 'rewind_history');
  fixture.complete();
  const args = { ...rewindArgs, operationId: 'repair-exact-v1', expectedSessionId: 'child',
    repairOfOperationId: rewindArgs.operationId };
  const result = await h.invoke(args, 'rewind_history');
  assert.equal(result.result.isError, undefined);
  assert.equal(h.requests.at(-1).body.repairOfOperationId, rewindArgs.operationId);
  for (const patch of [{ codexPhysicalSuffix: false }, { repairOfOperationId: false }]) {
    const old = await createHarness(t, () => ({ status: 200,
      body: { capabilities: { savedHistory: { ...savedHistoryCapability, ...patch } } } }));
    const rejected = await old.invoke(args, 'rewind_history');
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.structuredContent.code, 'app_update_required');
    assert.deepEqual(old.requests.map(request => request.method), ['GET']);
  }
});

test('legacy Rewind, invalid identities and partial composite arguments refuse before any HTTP mutation', async t => {
  const h = await createHarness(t, () => { throw new Error('invalid arguments must not use HTTP'); });
  for (const args of [{}, { ...rewindArgs, mode: 'native' }, { ...rewindArgs, mode: 'ai' }]) {
    const result = await h.invoke(args, 'rewind_ai');
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.code, 'rewind_ai_removed');
  }
  for (const args of [
    { tabId: 'target', operationId: 'op', targetUuid: 'user' },
    { ...rewindArgs, operationId: undefined }, { ...rewindArgs, expectedSessionId: '' },
    { ...rewindArgs, targetUuid: '' }, { ...rewindArgs, operationId: '../old' },
    { ...rewindArgs, operationId: 'x'.repeat(161) }, { ...rewindArgs, toolType: 'unknown' },
    { ...rewindArgs, expectedContentRevision: '' }, { ...rewindArgs, toolType: 'claude' },
    { ...rewindArgs, targetEntryRef: { physicalSessionId: 'p', rawUuid: 'r' } },
    { ...rewindArgs, targetEntryRef: { physicalSessionId: 'p' }, expectedContentRevision: 'rev' },
    { ...rewindArgs, targetEntryRef: { physicalSessionId: 'p', rawUuid: 'r', viewOwnerSessionId: 'foreign' }, expectedContentRevision: 'rev' },
    { ...rewindArgs, targetEntryRef: { physicalSessionId: 'p', rawUuid: 'r', contentRevision: 'stale' }, expectedContentRevision: 'rev' },
    { ...rewindArgs, targetEntryRef: { physicalSessionId: 'p', rawUuid: 'r', contentRevision: '' }, expectedContentRevision: 'rev' },
    ...['mode', 'targetIndex', 'targetText', 'targetFullText', 'rewindableCount', 'skipDuplicates',
      'startUuid', 'endUuid', 'additionalPrompt', 'kind', 'provider', 'sourceTabId'].map(key => ({ ...rewindArgs, [key]: 'legacy' })),
  ]) {
    const result = await h.invoke(args, 'rewind_history');
    assert.equal(result.result.isError, true, JSON.stringify(args));
    assert.equal(result.result.structuredContent.code, 'invalid_history_operation_arguments');
  }
  for (const args of [{ tabId: 'target' }, { tabId: 'target', operationId: '../old' },
    { tabId: 'target', operationId: 'old', includeStatus: 'yes' },
    { tabId: 'target', operationId: 'old', mode: 'native' }]) {
    assert.equal((await h.invoke(args, 'get_history_operation')).result.isError, true);
  }
  assert.deepEqual(h.requests, []);
});

test('public nullable metadata remains valid for physical and composite saved-history identities', async t => {
  const fixture = savedHistoryFixture(), h = await createHarness(t, fixture.respond);
  for (const args of [
    { ...rewindArgs, operationId: 'nullable-physical', targetEntryRef: null, targetSourceIdentity: null, expectedContentRevision: null },
    { ...rewindArgs, operationId: 'nullable-composite', expectedContentRevision: 'exact-public-token',
      targetEntryRef: { viewOwnerSessionId: 'saved-source', physicalSessionId: 'ancestor', rawUuid: 'raw-user',
        segmentId: 'frozen', sourceIdentity: null } },
    { ...rewindArgs, operationId: 'claude-exact', toolType: 'claude', expectedContentRevision: 'claude-revision' },
  ]) {
    const response = await h.invoke(args, 'rewind_history');
    assert.equal(response.result.isError, undefined);
    const body = h.requests.at(-1).body;
    if (args.targetEntryRef !== undefined) assert.deepEqual(body.targetEntryRef, args.targetEntryRef);
    assert.equal(body.expectedContentRevision, args.expectedContentRevision);
    fixture.complete(args.operationId);
  }
});

test('older or unsupported saved-history capability never falls back to native, AI or raw history', async t => {
  for (const capability of [undefined, { ...savedHistoryCapability, version: 0 },
    { ...savedHistoryCapability, receipts: false }, { ...savedHistoryCapability, structuredDraft: false },
    { ...savedHistoryCapability, operations: ['delete'] }, { ...savedHistoryCapability, providers: ['claude'] }]) {
    const h = await createHarness(t, () => ({ status: 200, body: { capabilities: { savedHistory: capability } } }));
    const result = await h.invoke(rewindArgs, 'rewind_history');
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.code, 'app_update_required');
    assert.equal(result.result.structuredContent.operationId, rewindArgs.operationId);
    assert.equal(result.result.structuredContent.mutationAttempted, false);
    assert.deepEqual(h.requests.map(r => r.method + ' ' + r.url), ['GET /api/me']);
  }
});

test('same saved-history operation is idempotent; changed payload retains app conflict and original receipt', async t => {
  const fixture = savedHistoryFixture(), h = await createHarness(t, fixture.respond);
  const first = await h.invoke(rewindArgs, 'rewind_history');
  const second = await h.invoke(rewindArgs, 'rewind_history');
  assert.equal(first.result.structuredContent.operation.operationId, rewindArgs.operationId);
  assert.equal(second.result.structuredContent.operation.idempotent, true);
  assert.equal(fixture.dispatches.length, 1);
  const conflict = await h.invoke({ ...rewindArgs, targetUuid: 'different' }, 'rewind_history');
  assert.equal(conflict.result.isError, true);
  assert.equal(conflict.result.structuredContent.code, 'history_operation_request_mismatch');
  assert.equal(conflict.result.structuredContent.operationId, rewindArgs.operationId);
  const receipt = await h.invoke({ tabId: 'target', operationId: rewindArgs.operationId }, 'get_history_operation');
  assert.equal(receipt.result.structuredContent.operation.targetUuid, rewindArgs.targetUuid);
  assert.equal(fixture.dispatches.length, 1);
});

test('lost HTTP ACK retains caller-known operation identity; MCP/app restart reads only the original receipt', async t => {
  const fixture = savedHistoryFixture();
  const h = await createHarness(t, (body, i, req) => {
    const response = fixture.respond(body, i, req);
    return req.method === 'POST' ? { disconnect: true } : response;
  });
  const lost = await h.invoke(rewindArgs, 'rewind_history');
  assert.equal(lost.result.isError, true);
  assert.equal(lost.result.structuredContent.code, 'history_operation_outcome_unknown');
  assert.equal(lost.result.structuredContent.operationId, rewindArgs.operationId);
  assert.deepEqual(lost.result.structuredContent.receiptRead, { tabId: 'target', operationId: rewindArgs.operationId });
  assert.match(lost.result.structuredContent.recovery, /get_history_operation/);
  assert.equal(fixture.dispatches.length, 1);
  await h.restart();
  fixture.restart();
  const read = await h.invoke(lost.result.structuredContent.receiptRead, 'get_history_operation');
  assert.equal(read.result.structuredContent.operation.state, 'outcome-unknown');
  assert.equal(read.result.structuredContent.operation.pending, true);
  assert.equal(read.result.structuredContent.operation.historyMutated, false);
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(fixture.dispatches.length, 1);
});

test('losing the whole MCP ACK still leaves the caller-known ID for a GET-only recovery', async t => {
  const fixture = savedHistoryFixture();
  let accepted;
  const onAccepted = new Promise(resolve => { accepted = resolve; });
  const h = await createHarness(t, (body, i, req) => {
    const response = fixture.respond(body, i, req);
    if (req.method === 'POST') { accepted(); return { disconnect: true }; }
    return response;
  });
  // Deliberately ignore the MCP response itself, not just the HTTP response.
  const ignored = h.invoke(rewindArgs, 'rewind_history').catch(() => {});
  await onAccepted;
  await h.restart();
  fixture.restart();
  const read = await h.invoke({ tabId: rewindArgs.tabId, operationId: rewindArgs.operationId }, 'get_history_operation');
  assert.equal(read.result.structuredContent.operation.operationId, rewindArgs.operationId);
  assert.equal(read.result.structuredContent.operation.state, 'outcome-unknown');
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(fixture.dispatches.length, 1);
  await ignored;
});

test('completed receipt, new binding/draft/resume and live status remain separate', async t => {
  const fixture = savedHistoryFixture(), h = await createHarness(t, fixture.respond);
  await h.invoke(rewindArgs, 'rewind_history');
  fixture.complete();
  const read = await h.invoke({ tabId: 'target', operationId: rewindArgs.operationId, includeStatus: true }, 'get_history_operation');
  const result = read.result.structuredContent;
  assert.equal(result.operation.state, 'completed');
  assert.equal(result.operation.newSessionId, 'child');
  assert.equal(result.operation.binding.applied, true);
  assert.equal(result.operation.draft.text, 'original prompt');
  assert.equal(result.operation.resume.inputReady, false);
  assert.equal(result.currentStatus.inputReady, false);
  assert.equal(result.currentStatus.sessionId, null);
  assert.equal(result.inputReady, undefined);
  assert.equal(result.prefixVerified, undefined);
  assert.equal(fixture.dispatches.length, 1);
  assert.equal(h.requests.at(-1).url, '/api/terminal-tabs/target/status');
});

test('failed mutation receipt and failed current status preserve receipt evidence without a retry', async t => {
  const operation = { ...rewindArgs, kind: 'rewind', state: 'failed', phase: 'adopting', pending: false,
    success: false, historyMutated: true, bindingCommitted: false, newSessionId: 'orphan-child',
    draft: { text: 'original' }, error: 'binding-conflict' };
  const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { savedHistory: savedHistoryCapability } } }
    : { status: 409, body: { ok: true, operation } });
  const failed = await h.invoke({ tabId: 'target', operationId: rewindArgs.operationId }, 'get_history_operation');
  assert.equal(failed.result.isError, undefined);
  assert.equal(failed.result.structuredContent.ok, true);
  assert.equal(failed.result.structuredContent.operation.success, false);
  assert.deepEqual(failed.result.structuredContent.operation, operation);
  const other = await createHarness(t, (_body, _i, req) => req.url.endsWith('/status')
    ? { status: 503, body: { error: 'status-reader-unavailable' } }
    : req.url === '/api/me' ? { status: 200, body: { capabilities: { savedHistory: savedHistoryCapability } } }
      : { status: 200, body: { ok: true, operation: { ...operation, state: 'completed', success: true } } });
  const receipt = await other.invoke({ tabId: 'target', operationId: rewindArgs.operationId, includeStatus: true }, 'get_history_operation');
  assert.equal(receipt.result.structuredContent.operation.success, true);
  assert.match(receipt.result.structuredContent.currentStatusError, /status-reader-unavailable/);
  assert.equal(receipt.result.structuredContent.currentStatus, null);
  assert.equal(other.requests.every(req => req.method === 'GET'), true);
});

test('stale revision, absent receipt and foreign/malformed responses never become an accepted rewind', async t => {
  for (const reply of [
    { status: 409, body: { error: 'stale_transcript_revision' } },
    { status: 200, body: { ok: true } },
    { status: 202, body: { ok: true, operation: { ...rewindArgs, kind: 'rewind', operationId: 'foreign' } } },
    { status: 202, body: { ok: true, operation: { ...rewindArgs, kind: 'rewind', toolType: 'codex', expectedSessionId: 'foreign-session' } } },
    { status: 202, body: { ok: true, operation: { ...rewindArgs, kind: 'rewind', toolType: 'codex', targetUuid: 'foreign-user' } } },
  ]) {
    const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
      ? { status: 200, body: { capabilities: { savedHistory: savedHistoryCapability } } } : reply);
    const result = await h.invoke(rewindArgs, 'rewind_history');
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.operationId, rewindArgs.operationId);
    assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
    assert.equal(h.requests.some(req => req.url.endsWith('/rewind')), false);
  }
  const h = await createHarness(t, (_body, _i, req) => req.url === '/api/me'
    ? { status: 200, body: { capabilities: { savedHistory: savedHistoryCapability } } }
    : { status: 404, body: { error: 'history_operation_not_found' } });
  const missing = await h.invoke({ tabId: 'target', operationId: rewindArgs.operationId }, 'get_history_operation');
  assert.equal(missing.result.structuredContent.code, 'history_operation_not_found');
  assert.equal(h.requests.every(req => req.method === 'GET'), true);
});

test('read_draft preserves full transferred authoring data and its outcome', async (t) => {
  const draft = {
    success: false,
    error: 'editor-return-unconfirmed',
    text: 'Notes [Image #1]',
    imagePaths: [{ id: 1, filePath: '/fixture/first.png' }],
    draftTransfer: { id: 'transfer-1', tabId: 'draft-tab', text: 'Notes [Image #1]', imagePaths: [{ id: 1, filePath: '/fixture/first.png' }] },
  };
  const harness = await createHarness(t, () => ({ status: 200, body: draft }));
  const response = await harness.invoke({ tabId: 'draft-tab', projectId: 'test-project' }, 'read_draft');
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.text, draft.text);
  assert.deepEqual(body.imagePaths, draft.imagePaths);
  assert.deepEqual(body.draftTransfer, draft.draftTransfer);
  assert.equal(body.success, false);
  assert.equal(body.error, draft.error);
});

test('filtered user history and batch body reads preserve exact filters, cursors and refs', async t => {
  const harness = await createHarness(t, (body, _index, req) => ({ status: 200, body:
    req.url === '/overseer/capabilities' ? { userMessageHistory: { version: 1 } } : { messages: [], body } }), { historyApi: true });
  const search = { sessionIds: ['sid-a', 'sid-b'], dateFrom: '2026-08-01', dateTo: '2026-10-05',
    promptName: 'Product review', query: 'actual request', kinds: ['user', 'context-only'], limit: 10, sessionLimit: 2, cursor: 'opaque' };
  const first = await harness.invoke(search, 'search_user_messages');
  assert.equal(first.result.isError, undefined);
  const url = new URL(harness.requests[1].url, 'http://fixture');
  assert.equal(url.pathname, '/overseer/user-messages');
  assert.equal(url.searchParams.get('sessionIds'), 'sid-a,sid-b');
  assert.equal(url.searchParams.get('kinds'), 'user,context-only');
  assert.equal(url.searchParams.get('dateFrom'), '2026-08-01');
  assert.equal(url.searchParams.get('promptName'), 'Product review');
  const read = { messages: [{ sessionId: 'sid-a', turnIndex: 2, userUuid: 'uuid', textHash: 'a'.repeat(64) }], maxChars: 2000, cursor: 'next-page' };
  await harness.invoke(read, 'get_user_messages');
  assert.deepEqual(harness.requests.at(-1), { method: 'POST', url: '/overseer/user-messages/read', body: read });
});

test('new history methods reject an old application before source reads', async t => {
  const harness = await createHarness(t, () => ({ status: 404, body: { error: 'Unknown overseer route' } }), { historyApi: true });
  for (const [name, args] of [['search_user_messages', { project: 'p' }], ['get_user_messages', { messages: [] }], ['session_stats', { sessionId: 's', diagnosticsOnly: true }]]) {
    const response = await harness.invoke(args, name);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /app update required/);
  }
  assert.deepEqual(harness.requests.map(row => row.url), Array(3).fill('/overseer/capabilities'));
});

test('history errors retain provider diagnostics and the precise lineage reason', async t => {
  const harness = await createHarness(t, () => ({ status: 409, body: { error: 'lineage_unresolved',
    code: 'history_lineage_unresolved', lineageReason: 'provider-history-base-absent', diagnostics: { expectedProvider: 'codex' } } }), { historyApi: true });
  const response = await harness.invoke({ sessionId: 'old-fork' }, 'session_stats');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /provider-history-base-absent/);
  assert.match(response.result.content[0].text, /expectedProvider/);
});

test('existing targets infer their provider while newly created targets keep the Claude default', async (t) => {
  const harness = await createHarness(t, (_body, index) => ({
    status: 202,
    body: {
      ok: true,
      accepted: true,
      run: { runId: `run-${index}` },
    },
  }));

  const existing = await harness.invoke({
    targetTabId: 'existing-codex-tab',
    prompt: 'audit existing Codex tab',
  });
  const created = await harness.invoke({
    targetProjectId: 'test-project',
    prompt: 'create a default target',
  });

  assert.equal('toolType' in harness.requests[0].body, false);
  assert.equal(harness.requests[1].body.toolType, 'claude');
  assert.equal(existing.result.structuredContent.runId, 'run-1');
  assert.equal(created.result.structuredContent.runId, 'run-2');
  assert.equal(JSON.parse(existing.result.content[0].text).runId, 'run-1');
});

test('create_tab followed by delegation to that existing tab stays a supported two-step flow', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => {
    if (req.url === '/api/agent-tabs') {
      return { status: 200, body: { ok: true, tabId: 'created-worker' } };
    }
    return {
      status: 202,
      body: { ok: true, accepted: true, run: { runId: 'separate-flow-run' } },
    };
  });

  await harness.invoke({ command: 'claude', name: 'worker' }, 'create_tab');
  const delegated = await harness.invoke({
    targetTabId: 'created-worker',
    prompt: 'start the assigned work',
  });

  assert.deepEqual(harness.requests.map((request) => request.url), [
    '/api/agent-tabs',
    '/api/orchestrations',
  ]);
  assert.equal(harness.requests[0].body.sourceTabId, 'test-source-tab');
  assert.equal(Object.hasOwn(harness.requests[0].body, 'cwd'), false);
  assert.equal(harness.requests[1].body.targetTabId, 'created-worker');
  assert.equal(Object.hasOwn(harness.requests[1].body, 'cwd'), false);
  assert.equal(delegated.result.structuredContent.runId, 'separate-flow-run');
});

test('external research tools preserve source identity, file descriptors, and separate follow-up ids', async (t) => {
  let mutation = 0;
  const harness = await createHarness(t, (_body, _index, req) => {
    if (req.url === '/api/me') {
      return {
        status: 200,
        body: { ok: true, capabilities: { externalResearchOrchestration: { version: 1 } } },
      };
    }
    mutation += 1;
    return {
      status: 202,
      body: {
        ok: true,
        accepted: true,
        runId: `browser-run-${mutation}`,
        jobId: `noted_browser-run-${mutation}`,
        run: { runId: `browser-run-${mutation}`, externalResearchJobId: `noted_browser-run-${mutation}` },
      },
    };
  });

  const first = await harness.invoke({
    runId: 'browser-run-1',
    provider: 'chatgpt',
    prompt: 'review version one',
    options: { mode: 'chat', model: '5.6-sol', effort: 'medium', temporaryChat: false, autoClose: false },
    files: [{ path: 'version-one.md', lines: '1-8' }],
    label: 'Browser review',
  }, 'start_external_research');
  const second = await harness.invoke({
    runId: 'browser-run-2',
    previousRunId: 'browser-run-1',
    prompt: 'review version two',
    files: [{ path: '/tmp/version-two.md', startLine: 4, endLine: 12 }],
  }, 'continue_external_research');

  const posts = harness.requests.filter((request) => request.url === '/api/external-research/orchestrations');
  assert.equal(first.result.structuredContent.runId, 'browser-run-1');
  assert.equal(first.result.structuredContent.jobId, 'noted_browser-run-1');
  assert.equal(second.result.structuredContent.runId, 'browser-run-2');
  assert.deepEqual(posts[0].body.files, [{
    path: '/tmp/terminal-mcp-test-project/version-one.md', lines: '1-8',
  }]);
  assert.equal(posts[0].body.sourceTabId, 'test-source-tab');
  assert.equal(posts[0].body.options.temporaryChat, false);
  assert.equal(posts[0].body.options.autoClose, false);
  assert.equal(posts[0].body.sourceMeta.mode, 'internal');
  assert.equal(posts[1].body.continueFromRunId, 'browser-run-1');
  assert.equal(Object.hasOwn(posts[1].body, 'provider'), false);
  assert.deepEqual(posts[1].body.files, [{
    path: '/tmp/version-two.md', startLine: 4, endLine: 12,
  }]);
});

test('existing ChatGPT conversation import creates a tracked read-only run without a model prompt', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => {
    if (req.url === '/api/me') {
      return {
        status: 200,
        body: { ok: true, capabilities: { externalResearchOrchestration: { version: 1 } } },
      };
    }
    return {
      status: 202,
      body: {
        ok: true,
        accepted: true,
        runId: 'import-run-1',
        jobId: 'noted_import-run-1',
        run: { runId: 'import-run-1', externalResearchJobId: 'noted_import-run-1' },
      },
    };
  });

  const response = await harness.invoke({
    runId: 'import-run-1',
    url: 'https://chatgpt.com/c/6aa82f55-3204-83eb-81a3-2d34f2150242',
    waitForFinal: true,
    sources: true,
  }, 'import_external_conversation');

  const post = harness.requests.find(request => request.url === '/api/external-research/orchestrations');
  assert.equal(response.result.structuredContent.runId, 'import-run-1');
  assert.equal(response.result.structuredContent.jobId, 'noted_import-run-1');
  assert.equal(post.body.provider, 'chatgpt');
  assert.equal(post.body.conversationUrl, 'https://chatgpt.com/c/6aa82f55-3204-83eb-81a3-2d34f2150242');
  assert.equal(post.body.options.readOnlyImport, true);
  assert.equal(post.body.options.importWaitForFinal, true);
  assert.equal(post.body.options.sources, true);
  assert.equal(post.body.options.importIncludeActivity, false);
  assert.equal(post.body.options.autoClose, true);
  assert.match(post.body.prompt, /read-only conversation import/i);
  assert.equal(Object.hasOwn(post.body, 'files'), false);
  assert.equal(post.body.sourceTabId, 'test-source-tab');
  assert.equal(post.body.notifySource, true);
});

test('conversation import rejects non-ChatGPT and malformed links before Project API mutation', async (t) => {
  const harness = await createHarness(t, () => ({ status: 500, body: { error: 'must not call API' } }));
  for (const url of [
    'https://example.com/c/not-chatgpt',
    'https://chatgpt.com/share/not-a-conversation',
    'not a url',
  ]) {
    const response = await harness.invoke({ url }, 'import_external_conversation');
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /ChatGPT conversation URL/);
  }
  assert.equal(harness.requests.length, 0);
});

test('external research fails before mutation against an older Noted Terminal app', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => ({
    status: 200,
    body: req.url === '/api/me' ? { ok: true, capabilities: {} } : { ok: true },
  }));
  const response = await harness.invoke({
    prompt: 'must not start',
    provider: 'chatgpt',
  }, 'start_external_research');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /does not support tracked external research orchestration/);
  assert.deepEqual(harness.requests.map((request) => request.url), ['/api/me']);
});

test('follow-up cannot reuse the completed run id', async (t) => {
  const harness = await createHarness(t, () => ({ status: 500, body: { error: 'must not call API' } }));
  const response = await harness.invoke({
    runId: 'same-run',
    previousRunId: 'same-run',
    prompt: 'new review',
  }, 'continue_external_research');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /needs a new runId/);
  assert.equal(harness.requests.length, 0);
});

test('model calls forward typed catalog/custom selections after capability proof', async (t) => {
  const catalog = {
    success: true,
    claude: [{
      id: 'opus',
      label: 'Opus 5 (1M context)',
      runtimeId: 'claude-opus-5[1m]',
      aliases: ['opus', 'claude-opus-5[1m]'],
    }],
    codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
  };
  const harness = await createHarness(t, (_body, _index, req) => {
    if (req.url === '/api/agent-models') return { status: 200, body: catalog };
    if (req.url === '/api/me') {
      return {
        status: 200,
        body: { ok: true, capabilities: { agentModelSelection: { version: 1 } } },
      };
    }
    return {
      status: 202,
      body: { ok: true, accepted: true, run: { runId: 'model-run' } },
    };
  });

  const listed = await harness.invoke({}, 'list_agent_models');
  assert.equal(listed.result.structuredContent.claude[0].id, 'opus');

  await harness.invoke({
    targetProjectId: 'test-project',
    toolType: 'claude',
    modelSelection: { kind: 'catalog', id: 'opus' },
    prompt: 'catalog model',
  });
  const catalogPost = harness.requests.find((request) => request.url === '/api/orchestrations');
  assert.deepEqual(catalogPost.body.modelSelection, { kind: 'catalog', id: 'opus' });
  assert.equal(Object.hasOwn(catalogPost.body, 'model'), false);

  await harness.invoke({
    targetProjectId: 'test-project',
    toolType: 'claude',
    modelSelection: { kind: 'custom', id: 'private-router-model' },
    prompt: 'intentional custom model',
  });
  const posts = harness.requests.filter((request) => request.url === '/api/orchestrations');
  assert.deepEqual(posts[1].body.modelSelection, { kind: 'custom', id: 'private-router-model' });
});

test('typed model selection fails before mutation against an older app', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => ({
    status: 200,
    body: req.url === '/api/me' ? { ok: true, capabilities: {} } : { ok: true },
  }));

  const result = await harness.invoke({
    targetProjectId: 'test-project',
    toolType: 'claude',
    modelSelection: { kind: 'catalog', id: 'opus' },
    prompt: 'must not downgrade',
  });

  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /does not support typed agent model selection/);
  assert.deepEqual(harness.requests.map((request) => request.url), ['/api/me']);
});

test('delegation failure remains an explicit structured MCP error', async (t) => {
  const harness = await createHarness(t, () => ({
    status: 400,
    body: { error: 'Requested claude cannot target an existing codex tab.' },
  }));

  const response = await harness.invoke({
    targetTabId: 'existing-codex-tab',
    toolType: 'claude',
    prompt: 'contradict the target provider',
  });

  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.structuredContent, {
    ok: false,
    error: 'HTTP 400: Requested claude cannot target an existing codex tab.',
  });
  assert.match(response.result.content[0].text, /^Error: HTTP 400:/);
});

test('window-targeted delegation lets Project API resolve the destination project', async (t) => {
  const harness = await createHarness(t, () => ({
    status: 202,
    body: { ok: true, accepted: true, run: { runId: 'window-run' } },
  }));

  await harness.invoke({
    prompt: 'work beside me',
    cwd: '/repo/context',
    windowTarget: { anchor: 'source', mode: 'same-window' },
  });

  const body = harness.requests[0].body;
  assert.equal('targetProjectId' in body, false);
  assert.equal(body.sourceTabId, 'test-source-tab');
  assert.equal(body.cwd, '/repo/context');
  assert.deepEqual(body.windowTarget, { anchor: 'source', mode: 'same-window' });
  assert.equal(body.toolType, 'claude');
});

test('send and delegation forward canonical context-file descriptors without reading bodies', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => {
    if (req.url === '/api/me') {
      return {
        status: 200,
        body: { ok: true, capabilities: { contextFiles: { version: 1 } } },
      };
    }
    if (req.url.startsWith('/api/terminal-tabs/')) {
      return { status: 200, body: { ok: true, success: true, status: 'sent' } };
    }
    return {
      status: 202,
      body: { ok: true, accepted: true, run: { runId: 'files-run' } },
    };
  });

  await harness.invoke({
    targetTabId: 'worker',
    prompt: 'Use the attached context',
    files: [
      { path: 'rules.md', role: 'instructions', label: 'Rules' },
      { path: '/tmp/raw.md', role: 'source' },
    ],
  });
  await harness.invoke({
    tabId: 'worker',
    prompt: 'Continue',
    files: [{ path: 'source.md' }],
  }, 'send_prompt');

  const mutations = harness.requests.filter((request) => request.url !== '/api/me');
  assert.deepEqual(mutations[0].body.files, [
    {
      path: '/tmp/terminal-mcp-test-project/rules.md',
      role: 'instructions',
      label: 'Rules',
    },
    { path: '/tmp/raw.md', role: 'source' },
  ]);
  assert.deepEqual(mutations[1].body.files, [
    { path: '/tmp/terminal-mcp-test-project/source.md', role: 'source' },
  ]);
  assert.equal(Object.hasOwn(mutations[1].body, 'cwd'), false,
    'project discovery cwd must not override the target tab subdirectory on resume');
  assert.equal(JSON.stringify(harness.requests).includes('file body'), false);
});

test('an old backend is rejected before a context-file prompt can cross POST', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => ({
    status: 200,
    body: req.url === '/api/me'
      ? { ok: true }
      : { ok: true, status: 'sent' },
  }));

  const response = await harness.invoke({
    tabId: 'worker',
    prompt: 'must not send without the capability',
    files: [{ path: '/tmp/rules.md', role: 'instructions' }],
  }, 'send_prompt');

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /does not support server-resolved context files/i);
  assert.deepEqual(harness.requests.map((request) => request.url), ['/api/me']);
});

test('create and placement tools carry one source-owned window contract', async (t) => {
  const harness = await createHarness(t, (_body, index, req) => {
    if (req.url === '/api/agent-tabs') {
      return { status: 200, body: { ok: true, tabId: 'new-agent', placement: { spaceId: 'main' } } };
    }
    if (req.url === '/api/workspace/windows') {
      return { status: 200, body: { ok: true, spaceId: 'main', paneIndex: 2 } };
    }
    if (req.url === '/api/workspace/place-tabs') {
      return { status: 200, body: { ok: true, spaceId: 'main', insertedAt: 1 } };
    }
    return { status: 500, body: { error: `unexpected request ${index}` } };
  });

  const created = await harness.invoke({
    command: 'codex',
    name: 'worker',
    windowTarget: { anchor: 'source', mode: 'same-window' },
  }, 'create_tab');
  await harness.invoke({
    side: 'below',
    windowTarget: { anchor: 'source' },
  }, 'create_window');
  await harness.invoke({
    tabs: ['existing-tab'],
    windowTarget: { anchor: 'source', mode: 'same-window' },
  }, 'open_tabs_in_window');

  assert.equal(created.result.structuredContent.tabId, 'new-agent');
  assert.deepEqual(harness.requests.map((request) => request.url), [
    '/api/agent-tabs',
    '/api/workspace/windows',
    '/api/workspace/place-tabs',
  ]);
  assert.equal(harness.requests[0].body.sourceTabId, 'test-source-tab');
  assert.equal(harness.requests[0].body.fallbackProjectId, 'test-project');
  assert.equal(Object.hasOwn(harness.requests[0].body, 'cwd'), false);
  assert.deepEqual(harness.requests[1].body.windowTarget, {
    anchor: 'source',
    mode: 'new-window',
    side: 'below',
    reveal: false,
  });
  assert.deepEqual(harness.requests[2].body.entries, ['existing-tab']);
});

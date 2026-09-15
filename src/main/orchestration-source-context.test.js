'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const http = require('node:http');
const Database = require('better-sqlite3');
const { TabWorkContext } = require('./tab-work-context');
const { sourceCompletionFacts } = require('./orchestration-source-context');
const { OrchestrationRunStore, classifyAgentSendReceipt, mergeActiveLoadersWithOrchestrations,
  isActiveStatus, isExternalResearchRun } = require('./orchestration-runs');
const { createAgentSendReceiptRegistry, fingerprintAgentSendRequest, RECEIPT_STATES,
  isAgentSendProviderQueueAccepted } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation } = require('./structured-authoring');
const { withPromptOriginPresentation } = require('./history-prompt-presentations');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');

const scope = { tabId: 'T', sessionId: 'S', toolType: 'codex' };
const fixtureCompletedAt = Date.now();
const completed = (runId = 'ce8-fixture') => ({ runId, sourceTabId: 'T', sourceToolType: 'codex',
  sourceExecutionContext: { provider: 'codex', sessionId: 'S' },
  sourceAttentionDismissedAt: 200, notificationSuppressed: true, notificationStatus: 'suppressed',
  status: 'completed', outcome: 'success', resultComplete: true, completedAt: fixtureCompletedAt,
  sourceFollowupStartedAt: null, sourceFollowupPending: false, targetTabId: 'executor',
  targetProjectId: 'P', sourceProjectId: 'P', promptHash: 'fixture',
  externalResearchJobId: 'noted_fixture', runKind: 'external-research' });

test('only exact source conversation receives a terminal fact; ack/dismiss never means answer read', () => {
  const base = completed();
  assert.equal(sourceCompletionFacts([base], scope).length, 1);
  for (const patch of [
    { status: 'running' }, { status: 'waiting_descendants' }, { resultComplete: false },
    { sourceAttentionDismissedAt: null, sourceAcknowledgedAt: 200 },
    { sourceFollowupStartedAt: 180 }, { notifySource: false },
    { sourceTabId: 'other' }, { notificationSourceSessionId: 'other' }, { sourceToolType: 'claude' },
  ]) assert.equal(sourceCompletionFacts([{ ...base, ...patch }], scope).length, 0, JSON.stringify(patch));
  assert.equal(sourceCompletionFacts([base], { ...scope, sessionId: null }).length, 0);
  assert.equal(sourceCompletionFacts([base], { ...scope, toolType: 'claude' }).length, 0);
  assert.equal(sourceCompletionFacts([{ ...base, sourceToolType: 'claude' }], { ...scope, toolType: 'claude' }).length, 1);
  assert.equal(mergeActiveLoadersWithOrchestrations({ loaders: [] }, [base]).idle, true);
  assert.equal(mergeActiveLoadersWithOrchestrations({ loaders: [] }, [{ ...base, status: 'running' }]).idle, false);
});

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-source-facts-'));
  const dbPath = path.join(dir, 'fixture-context.sqlite');
  let db;
  try { db = new Database(dbPath); }
  catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Run with Electron Node ABI'); return null; }
    throw error;
  }
  const file = path.join(dir, 'fixture-runs.json');
  let store = new OrchestrationRunStore(file);
  await store.create(completed());
  await store.patch('ce8-fixture', { ...completed(), notificationStatus: 'unconfirmed',
    notificationSuppressed: false, sourceAttentionDismissedAt: null,
    notificationError: 'bridge_timeout_delivery_unknown', notificationAttempt: 1 });
  const owner = { tabId: 'T', tabType: 'terminal', commandType: 'codex', codexSessionId: 'S' };
  let currentScope = { ...scope };
  const makeContext = () => {
    const instance = new TabWorkContext({ db, listTabs: () => [owner], onChanged() {} });
    instance.resolveAttributionSource = () => currentScope;
    instance.readContinuationFacts = value => store.sourceCompletionFacts(value);
    instance.resolveContinuationWriteTarget = () => currentScope;
    return instance;
  };
  let context = makeContext();
  const h = { get db() { return db; }, get context() { return context; }, owner, get store() { return store; },
    setScope: value => { currentScope = value; },
    restartStore: async () => { await store.persistStrict(); store = new OrchestrationRunStore(file); await store.initialize(); },
    reopenContext: () => { db.close(); db = new Database(dbPath); context = makeContext(); },
    dismiss: () => store.dismissAttention('ce8-fixture', 'T'),
  };
  t.after(async () => { await store.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return h;
}

test('quiet dismiss -> restart -> next ordinary prompt; no UI chip, no changed notification receipt', async t => {
  const h = await harness(t); if (!h) return;
  await h.dismiss();
  const before = await h.store.get('ce8-fixture');
  await h.restartStore();
  const sent = await h.context.prepare('T', 'one', 'Какая стадия ce8?');
  assert.match(sent.prompt, /"status":"completed"/);
  assert.match(sent.prompt, /не running/);
  assert.match(sent.prompt, /Если результат уже прочитан, повторно его не запрашивай/);
  assert.ok(sent.prompt.endsWith('Какая стадия ce8?'));
  assert.equal(h.context.get('T').pendingCount, 0);
  h.reopenContext();
  assert.equal((await h.context.prepare('T', 'one', 'Какая стадия ce8?')).prompt, sent.prompt);
  assert.equal((await h.context.prepare('T', 'two', 'Ещё вопрос')).prompt, 'Ещё вопрос');
  assert.deepEqual(await h.store.get('ce8-fixture'), before);
  assert.equal((await h.store.listActive()).length, 0);
});

test('confirmed carrier keeps fact consumed after context reopen; later facts do not change old payload', async t => {
  const h = await harness(t); if (!h) return;
  await h.dismiss();
  const prepared = await h.context.prepare('T', 'one', 'question');
  h.context.confirm('T', 'one', promptAuditFingerprint(prepared.prompt));
  h.reopenContext();
  await h.store.create(completed('later'));
  await h.store.patch('later', completed('later'));
  assert.equal((await h.context.prepare('T', 'one', 'question')).prompt, prepared.prompt);
  const next = await h.context.prepare('T', 'two', 'next');
  assert.doesNotMatch(next.prompt, /ce8-fixture/);
  assert.match(next.prompt, /"runId":"later"/);
});

test('unknown send does not duplicate facts; proven pre-submit failure makes them available to next prompt', async t => {
  const h = await harness(t); if (!h) return;
  await h.dismiss();
  await h.context.prepare('T', 'one', 'question');
  h.context.settle('T', 'one', { status: 'delivery-unknown', submitted: null });
  h.reopenContext();
  h.context.configure({ readReceipts: () => [{ handoffId: 'one', state: 'delivery-unknown' }],
    resolveAttributionSource: () => scope, readContinuationFacts: value => h.store.sourceCompletionFacts(value) });
  assert.equal((await h.context.prepare('T', 'two', 'next')).prefix, '');
  h.context.settle('T', 'one', { submitted: false, success: false });
  assert.match((await h.context.prepare('T', 'three', 'next')).prompt, /"status":"completed"/);
});

test('no insertion into slash or notification; changed conversation during async read gets no stale fact', async t => {
  const h = await harness(t); if (!h) return;
  await h.dismiss();
  assert.equal((await h.context.prepare('T', 'slash', '/usage')).prompt, '/usage');
  assert.equal((await h.context.prepare('T', 'orchestration-complete:other', 'notice')).prompt, 'notice');
  const read = h.context.readContinuationFacts;
  h.context.readContinuationFacts = async value => { const facts = await read(value); h.setScope({ ...scope, sessionId: 'B' }); return facts; };
  assert.equal((await h.context.prepare('T', 'new-session', 'new')).prompt, 'new');
});

test('concurrent prepares claim once; old handoff is frozen before completion; new handoff takes at most eight', async t => {
  const h = await harness(t); if (!h) return;
  const old = await h.context.prepare('T', 'old', 'old');
  await h.dismiss();
  assert.equal((await h.context.prepare('T', 'old', 'old')).prompt, old.prompt);
  for (let i = 0; i < 10; i++) { await h.store.create(completed('extra-' + i)); await h.store.patch('extra-' + i, completed('extra-' + i)); }
  const pair = await Promise.all([h.context.prepare('T', 'a', 'A'), h.context.prepare('T', 'b', 'B')]);
  const ids = pair.map(p => Array.from(p.prompt.matchAll(/"runId":"([^"]+)"/g), match => match[1]));
  assert.deepEqual(ids.map(a => a.length), [8, 3]);
  assert.equal(new Set(ids.flat()).size, 11);
});

const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
const actual = name => { const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(ast); };

test('actual main configure callback -> actual web read -> same durable run; no provider fetch or notification', async t => {
  const h = await harness(t); if (!h) return;
  await h.dismiss();
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  let configuration;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'tabWorkContext.configure') configuration = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(configuration);
  const field = name => configuration.properties.find(p => p.name?.text === name).initializer.getText(tree);
  const serverRead = vm.runInNewContext(actual('readOrchestrationSourceCompletionFacts') + ';readOrchestrationSourceCompletionFacts', {
    getOrchestrationRunStore: () => h.store,
  });
  const read = vm.runInNewContext('(' + field('readContinuationFacts') + ')', {
    path, srcMainDir: '/fixture', require: file => { assert.equal(file, '/fixture/web-server'); return { readOrchestrationSourceCompletionFacts: serverRead }; },
  });
  const binding = vm.runInNewContext('(' + field('resolveAttributionSource') + ')', {
    getCodexWriterProofSnapshot: tabId => tabId === 'T' ? { sessionId: 'S' } : null,
    bridgeKnownSessions: new Map([['C', 'CS']]),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(binding(h.owner))), { toolType: 'codex', sessionId: 'S' });
  assert.equal(binding({ tabId: 'unknown', commandType: 'codex' }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(binding({ tabId: 'C', commandType: 'claude' }))), { toolType: 'claude', sessionId: 'CS' });
  h.context.readContinuationFacts = read;
  h.context.resolveAttributionSource = binding;
  assert.match((await h.context.prepare('T', 'main-config', 'next')).prompt, /ce8-fixture/);
});

test('actual HTTP Send + registry carries done fact once; GET status stays done and result is fetched only explicitly once', async t => {
  const h = await harness(t); if (!h) return;
  const sent = [], transportResults = []; let resultReads = 0;
  const sendJson = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const target = { tabId: 'T', sessionId: 'S', toolType: 'codex', projectId: 'P', tabType: 'terminal' };
  const env = vm.createContext({ crypto, console, tabWorkContext: h.context,
    promptAuditFingerprint, fingerprintAgentSendRequest, withPromptOriginPresentation,
    prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation, agentSendTargetPreconditionFailure,
    classifyAgentSendReceipt, isAgentSendProviderQueueAccepted, AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES,
    agentSendReceiptRegistry: createAgentSendReceiptRegistry(), agentSendReceiptStore: null,
    agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000, projectManager: {},
    shortId: x => x, decId: decodeURIComponent,
    cleanOptionalString: (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback,
    findOrchestrationTabDescriptor: () => target,
    ensureExplicitAgentTabOpen: async () => ({ descriptor: target }),
    resolveProjectAgentModelRequest: async () => ({}),
    resolveSendPromptPresentation: async (_manager, _body, prompt) => ({ prompt, promptChips: [], contextFiles: [] }),
    normalizeSendAttachments: () => [], sendJson,
    readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); },
    sendSendFailure: (res, data) => sendJson(res, 409, data),
    sendDeliveryUnknown: (res, data) => sendJson(res, 202, data), sendAuditPending: (res, data) => sendJson(res, 202, data),
    bridgeRequest: async (_action, payload) => { sent.push(payload); if (transportResults.length) return transportResults.shift(); return { success: true, submitted: true,
      exactAuditConfirmed: true, codexAudit: { success: true, actualHash: promptAuditFingerprint(payload.prompt) } }; },
    getOrchestrationRunStore: () => h.store, isActiveStatus, isExternalResearchRun,
    reconcileExternalResearchRun: id => h.store.get(id), withOrchestrationUrls: run => run,
    getScExternalResearchClient: () => ({ status: async () => { resultReads++; return { status: 'done', result: { text: 'final answer' } }; } }),
    isScResearchTerminalStatus: status => ['done', 'error'].includes(status),
    externalResearchAnswerText: snapshot => snapshot?.result?.text || '',
  });
  vm.runInContext(['appendAttachmentsToPrompt', 'runAgentSendScenario', 'runPreparedAgentSendScenario',
    'boundedExternalResearchResult', 'readExternalResearchResult'].map(actual).join('\n'), env);
  const sendRoute = web.slice(web.indexOf('  // Send prompt to a project terminal tab.'),
    web.indexOf("  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/completion-notification"));
  const statusRoute = web.slice(web.indexOf('  const orchestrationStatusMatch ='), web.indexOf('  const orchestrationStatusMatch =') +
    web.slice(web.indexOf('  const orchestrationStatusMatch =')).indexOf('\n  }') + 4);
  const route = vm.runInContext('(async(req,res,parsed)=>{let m; ' + sendRoute + statusRoute + '})', env);
  const server = http.createServer(async (req, res) => {
    try {
      // Same actual external result reader; transport is a counted SC fixture.
      if (req.url.endsWith('/result')) { const r = await env.readExternalResearchResult('ce8-fixture', 1000); return sendJson(res, r.statusCode, r.body); }
      await route(req, res, { pathname: req.url });
    } catch (error) { sendJson(res, 500, { error: error.stack }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  await h.dismiss();
  const status = await (await fetch(url + '/api/orchestrations/ce8-fixture')).json();
  assert.equal(status.run.status, 'completed'); assert.equal(status.run.notificationStatus, 'suppressed');
  assert.equal(resultReads, 0); assert.equal(sent.length, 0);
  const body = { handoffId: 'genuine-prompt', prompt: 'ce8 ещё выполняется?', expectedSessionId: 'S', expectedToolType: 'codex' };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url + '/api/terminal-tabs/T/send', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal(sent.length, 1); assert.match(sent[0].prompt, /"status":"completed"/);
  assert.equal(resultReads, 0, 'preparation and replay never read the answer');
  const result = await (await fetch(url + '/api/orchestrations/ce8-fixture/result')).json();
  assert.equal(result.assistantText, 'final answer'); assert.equal(resultReads, 1);
  const next = await h.context.prepare('T', 'follow-on', 'Продолжай');
  assert.equal(next.prompt, 'Продолжай'); assert.equal(resultReads, 1);
  assert.equal((await h.store.get('ce8-fixture')).notificationAttempt, 1);
  assert.equal((await h.store.get('ce8-fixture')).sourceFollowupStartedAt, null);

  // A prepared-but-never-submitted handoff has no registry receipt to stop it.
  // Legacy null-SID send must not paste its A-owned quiet context into B.
  await h.store.create(completed('stale-fact'));
  await h.store.patch('stale-fact', completed('stale-fact'));
  const frozen = await h.context.prepare('T', 'stale-context', 'old-unsent');
  assert.match(frozen.prompt, /stale-fact/);
  target.sessionId = 'B'; h.setScope({ ...scope, sessionId: 'B' });
  const stale = await fetch(url + '/api/terminal-tabs/T/send', { method: 'POST',
    body: JSON.stringify({ handoffId: 'stale-context', prompt: 'old-unsent', expectedToolType: 'codex' }) });
  assert.equal(stale.status, 409, await stale.text());
  assert.equal(sent.length, 1, 'old A context cannot cross the physical bridge to B');
  assert.equal((await h.context.prepare('T', 'stale-context', 'old-unsent')).prompt, frozen.prompt,
    'the refusal must not rewrite the old payload');
  const receiptReplay = await fetch(url + '/api/terminal-tabs/T/send', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(receiptReplay.status, 200, await receiptReplay.text());
  assert.equal(sent.length, 1, 'old confirmed receipt remains readable after a new owner, no send');
  const fresh = await fetch(url + '/api/terminal-tabs/T/send', { method: 'POST',
    body: JSON.stringify({ handoffId: 'fresh-B', prompt: 'new question', expectedSessionId: 'B', expectedToolType: 'codex' }) });
  assert.equal(fresh.status, 200, await fresh.text());
  assert.equal(sent.length, 2); assert.equal(sent[1].prompt, 'new question');

  // Approved15.09: two different authored prompts have independent receipts.
  // The short fact is repeatable data, not a command/result/notification lease.
  target.sessionId = 'S'; h.setScope(scope);
  await h.store.create(completed('retry-fact'));
  await h.store.patch('retry-fact', completed('retry-fact'));
  const runBeforeRetry = await h.store.get('retry-fact');
  const postRetry = async (handoffId, prompt) => {
    const r = await fetch(url + '/api/terminal-tabs/T/send', { method: 'POST',
      body: JSON.stringify({ handoffId, prompt, expectedToolType: 'codex' }) });
    return { status: r.status, data: await r.json() };
  };
  transportResults.push({ success: false, accepted: false, submitted: false, status: 'not-submitted' });
  assert.equal((await postRetry('retry-H1', 'first unsent command')).status, 409);
  const originalH1 = sent.at(-1).prompt;
  assert.match(originalH1, /"runId":"retry-fact"/);
  transportResults.push({ success: null, accepted: true, submitted: null, status: 'delivery-unknown', deliveryUnknown: true });
  assert.equal((await postRetry('retry-H2', 'second command')).status, 202);
  const afterH2 = sent.length;
  assert.equal((await postRetry('retry-H2', 'second command')).status, 202);
  assert.equal(sent.length, afterH2, 'unknown H2 itself never sends twice');
  assert.equal((await postRetry('retry-H3', 'a new command')).status, 200);
  assert.doesNotMatch(sent.at(-1).prompt, /"runId":"retry-fact"/, 'ordinary new preparation still deduplicates facts');
  assert.equal((await postRetry('retry-H1', 'first unsent command')).status, 200);
  assert.equal(sent.at(-1).prompt, originalH1, 'explicit H1 Retry preserves the original complete payload');
  assert.match(sent.at(-1).prompt, /Повтор этой справки с тем же runId/);
  assert.equal(resultReads, 1, 'retrying user input did not refetch its unrelated completed research');
  assert.deepEqual(await h.store.get('retry-fact'), runBeforeRetry, 'no new delegation or notification from a repeated fact');
});

test('actual main PTY queue and paste/Enter destination guard reject late context-owner change without altering plain Send', async t => {
  const h = await harness(t); if (!h) return;
  await h.dismiss();
  const prepared = await h.context.prepare('T', 'one', 'question');
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const mainFn = name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree);
  let destination; const physicalChecks = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'destinationFailure') destination = node.initializer.getText(tree);
    if (ts.isIfStatement(node) && node.expression.getText(tree).startsWith('knownEmptyDestination || handoffId')) physicalChecks.push(node.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(destination); assert.equal(physicalChecks.length, 2);
  let writes = 0, inputReservations = 0;
  const env = vm.createContext({ console, tabWorkContext: h.context,
    expectedKnownEmptySend: () => null, conversationOwners: { noteInput() {} },
    findTabIdForTerm: () => 'T', getTerminalInputRevision: () => 0,
    withPtyWriteLock: async (_term, work) => { h.setScope({ ...scope, sessionId: 'B' }); return work(); },
    bumpTerminalInputRevision: () => { inputReservations++; return 1; },
    _safePasteAndSubmitInner: async () => { writes++; },
  });
  vm.runInContext(['assertKnownEmptySend', 'safePasteAndSubmit', 'finishSafePasteAfterWrite'].map(mainFn).join('\n'), env);
  const result = await env.safePasteAndSubmit({ write: () => writes++ }, prepared.prompt, { handoffId: 'one' });
  assert.equal(result.code, 'agent_context_source_changed');
  assert.equal(result.submitted, false); assert.equal(writes, 0); assert.equal(inputReservations, 0);
  const gateEnv = vm.createContext({ assertKnownEmptySend: env.assertKnownEmptySend, broadcastTabId: 'T',
    handoffId: 'one', expectedDestination: null, expectedTarget: null, sendOperationKey: null, sendAttemptId: null, options: {} });
  const gate = vm.runInContext(destination, gateEnv);
  assert.equal(gate().code, 'agent_context_source_changed', 'runs even without legacy expectedTarget');
  gateEnv.destinationFailure = gate; gateEnv.knownEmptyDestination = false;
  for (let i = 0; i < physicalChecks.length; i++) {
    gateEnv.pasteWritten = i === 1;
    const check = vm.runInContext('(()=>{' + physicalChecks[i] + ';return {written:true}})', gateEnv);
    const refused = check(); assert.equal(refused.submitted, false); assert.equal(refused.written, undefined);
    assert.equal(refused.pasteWritten, i === 1, 'late refusal preserves already written paste truth');
  }
  h.setScope(scope); assert.equal(gate(), null, 'same conversation remains allowed');
  h.setScope({ ...scope, sessionId: null }); assert.equal(gate().submitted, false);
  gateEnv.handoffId = 'plain-no-context'; assert.equal(gate(), null, 'unrelated plain Send semantics unchanged');
  gateEnv.handoffId = 'one';
  h.setScope(null);
  assert.doesNotThrow(() => h.context.assertContinuationScope('T', 'one'), 'saved A allows normal Resume preparation');
  assert.equal(gate().submitted, false, 'saved A alone never proves physical write');
  h.setScope({ ...scope, sessionId: 'own-child', acceptedResumeSourceSessionId: 'S' });
  assert.equal(gate(), null, 'exact current own Resume uses the existing source-destination contract');
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const registryModule = require('./agent-send-receipt-registry');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const webAst = ts.createSourceFile('web-server.js', webSource, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };

function actualDeclaration(name) {
  const declaration = webAst.statements.find(node => (
    ts.isFunctionDeclaration(node) && node.name?.text === name
  ));
  assert.ok(declaration, 'actual server declaration: ' + name);
  return declaration.getText(webAst);
}

function pendingReceipt() {
  return {
    success: null, accepted: true, submitted: true,
    status: 'audit-pending', auditPending: true,
  };
}

function queuedReceipt() {
  return {
    success: true, accepted: true, submitted: true,
    status: 'queued', queued: true, providerQueueAccepted: true,
    canonicalPending: true, auditPending: true, receiptState: 'audit-pending',
  };
}

function exactProviderRefusal() {
  return {
    success: false, accepted: false, submitted: true,
    pasteWritten: true, enterWritten: true, semanticStatus: 'not-submitted',
    providerAccepted: false, providerTurnCreated: false,
    composerDraftState: 'exact-original', exactDraftRemained: true,
    draftPreserved: true, lateReconciliationPending: false,
    code: 'claude_prompt_not_accepted_exact_draft_remained',
  };
}

// Actual Project API scenario, receipt registry and SQLite receipt store. Only
// the renderer/provider boundary is a fixture; no app, PTY, network or live DB.
function harness(t, { outcome = 'queued', provider = 'codex' } = {}) {
  let db;
  try {
    db = new Database(':memory:');
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
  t.after(() => db.close());
  let attempts = 0;
  const store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt-' + ++attempts });
  const registry = registryModule.createAgentSendReceiptRegistry();
  const bridgeCalls = [];
  const settlements = [];
  const request = {
    tabId: 'queue-tab', handoffId: 'queue-handoff',
    sendOperationKey: 'project:queue-tab:queue-handoff',
    prompt: 'Text accepted in the provider queue', provider,
    sessionId: 'queue-session', source: 'project-api',
  };
  function record() { return store.get(request.sendOperationKey); }
  function exactAudit() {
    return {
      success: true, operationKey: request.sendOperationKey, attemptId: record().attemptId,
      provider, sessionId: request.sessionId,
      promptHash: promptAuditFingerprint(request.prompt),
      expectedHash: promptAuditFingerprint(request.prompt),
      entryUuid: 'exact-user-entry', sourceIdentity: 'codex-user-source-queue-session-4242',
      auditTimestamp: '2026-09-09T08:00:00.000Z',
      transcriptBoundary: { byteOffset: 42, line: 7 },
    };
  }
  const context = vm.createContext({
    ...registryModule,
    AGENT_SEND_RECEIPT_STATES: registryModule.RECEIPT_STATES,
    agentSendReceiptRegistry: registry,
    agentSendReceiptStore: store,
    agentSendReceiptStartupReady: Promise.resolve(),
    agentSendBridgeTimeoutMs: 1000,
    promptAuditFingerprint, classifyAgentSendReceipt,
    crypto: require('node:crypto'), console: quiet, shortId: value => value,
    withPromptOriginPresentation: value => value,
    tabWorkContext: {
      prepare: async (_tabId, _handoffId, prompt) => ({ prompt }),
      activate() {},
      settle: (_tabId, _handoffId, receipt) => settlements.push(receipt),
    },
    findOrchestrationTabDescriptor: () => ({ toolType: provider, sessionId: request.sessionId }),
    bridgeRequest: async (action, payload) => {
      assert.equal(action, 'sendAgentPromptScenario');
      bridgeCalls.push(payload);
      const attemptId = payload.sendAttemptId;
      assert.equal(store.markAttemptState(request.sendOperationKey, attemptId,
        STORE_STATES.ENTER_ARMED).ok, true);
      if (outcome === 'unknown') {
        const receipt = {
          success: null, accepted: true, submitted: null,
          status: 'delivery-unknown', deliveryUnknown: true,
        };
        store.settleAttempt(request.sendOperationKey, attemptId, receipt);
        return receipt;
      }
      store.settleAttempt(request.sendOperationKey, attemptId, pendingReceipt());
      if (outcome === 'refused') {
        const receipt = exactProviderRefusal();
        store.settleAttempt(request.sendOperationKey, attemptId, receipt);
        return receipt;
      }
      if (outcome === 'pending') return pendingReceipt();
      if (outcome === 'confirmed') {
        assert.equal(store.promoteFromAudit(exactAudit()).promoted, true);
        return pendingReceipt(); // The exact durable audit wins a stale callback.
      }
      const queued = store.markProviderQueueAccepted(request.sendOperationKey, attemptId, {
        provider, sessionId: request.sessionId,
        sourceIdentity: provider === 'codex'
          ? 'codex-tui-queue:committed-frame-occurrence'
          : 'claude-queue:exact-operation',
      });
      assert.equal(queued.applied, true);
      assert.equal(queued.record.state, STORE_STATES.AUDIT_PENDING);
      return queuedReceipt();
    },
  });
  vm.runInContext([
    'durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
    'publicAgentSendReceipt', 'durableAgentSendFailure',
    'runPreparedAgentSendScenario', 'runAgentSendScenario',
    'applyOrchestrationTargetSendReceipt',
  ].map(actualDeclaration).join('\n'), context);

  // Execute the actual /terminal-tabs/:id/send response branches without an
  // HTTP server or unrelated route setup. This catches a queued -> 202 downgrade.
  const route = webSource.indexOf('// Send prompt to a project terminal tab.');
  const responseStart = webSource.indexOf('      const sendReceipt = classifyAgentSendReceipt(data);', route);
  const responseEnd = webSource.indexOf('\n    } catch (e)', responseStart);
  assert.ok(route > 0 && responseStart > route && responseEnd > responseStart);
  context.sendJson = (_res, statusCode, body) => ({ statusCode, body });
  context.sendAuditPending = (_res, data, extra) => ({ statusCode: 202, body: { ...data, ...extra } });
  context.sendDeliveryUnknown = context.sendAuditPending;
  context.sendSendFailure = (_res, data, extra) => ({ statusCode: 409, body: { ...data, ...extra } });
  vm.runInContext(`function actualSendHttpResponse(data) {
    const res = null, tabId = 'queue-tab', operationHandoffId = 'queue-handoff';
    const sendPayload = { attachments: [] }, promptPresentation = { contextFiles: [] };
    ${webSource.slice(responseStart, responseEnd)}
  }`, context);

  return {
    request, context, store, registry, bridgeCalls, settlements, record, exactAudit,
    attempts: () => attempts,
    send: () => context.runAgentSendScenario(request),
    http: receipt => context.actualSendHttpResponse(receipt),
    publicReceipt: () => context.publicAgentSendReceipt(record()),
  };
}

for (const provider of ['codex', 'claude']) {
  test(provider + ' queued first response and replay preserve pending canonical receipt without another send', async t => {
    const h = harness(t, { provider });
    if (!h) return;
    const first = await h.send();
    const replay = await h.send();
    h.registry.clear();
    const afterRegistryReset = await h.send();
    assert.equal(h.record().state, STORE_STATES.AUDIT_PENDING);
    for (const receipt of [first, replay, afterRegistryReset, h.publicReceipt(), ...h.settlements]) {
      assert.equal(receipt.success, true, 'provider acceptance remains successful');
      assert.equal(receipt.submitted, true);
      assert.equal(receipt.providerQueueAccepted, true);
      assert.equal(receipt.status, 'queued');
      assert.equal(receipt.receiptState, STORE_STATES.AUDIT_PENDING,
        'queue acceptance is not exact canonical confirmation');
      assert.equal(receipt.auditPending, true);
      assert.notEqual(receipt.exactAuditConfirmed, true);
      const response = h.http(receipt);
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, 'queued');
      assert.equal(response.body.receiptState, STORE_STATES.AUDIT_PENDING);
    }
    assert.equal(replay.replayed, true);
    assert.equal(h.bridgeCalls.length, 1);
    assert.equal(h.attempts(), 1);
  });
}

for (const outcome of ['pending', 'unknown', 'refused', 'confirmed']) {
  test('first response and replay retain exact ' + outcome + ' state without another send', async t => {
    const h = harness(t, { outcome, provider: outcome === 'refused' ? 'claude' : 'codex' });
    if (!h) return;
    const expected = {
      pending: { state: 'audit-pending', statusCode: 202, submitted: true },
      unknown: { state: 'delivery-unknown', statusCode: 202, submitted: null },
      refused: { state: 'provider-not-accepted', statusCode: 409, submitted: true },
      confirmed: { state: 'confirmed', statusCode: 200, submitted: true },
    }[outcome];
    for (const receipt of [await h.send(), await h.send(), h.publicReceipt()]) {
      assert.equal(receipt.receiptState, expected.state);
      assert.equal(receipt.submitted, expected.submitted);
      assert.equal(h.http(receipt).statusCode, expected.statusCode);
      assert.equal(receipt.exactAuditConfirmed === true, outcome === 'confirmed');
    }
    assert.equal(h.record().state, expected.state);
    assert.equal(h.bridgeCalls.length, 1);
    assert.equal(h.attempts(), 1);
  });
}

test('only exact durable audit promotes an accepted queue receipt to sent', async t => {
  const h = harness(t);
  if (!h) return;
  const queued = await h.send();
  assert.equal(queued.status, 'queued');
  assert.equal(h.record().state, STORE_STATES.AUDIT_PENDING);
  const wrong = h.store.promoteFromAudit({ ...h.exactAudit(), attemptId: 'other-attempt' });
  assert.equal(wrong.promoted, false);
  assert.equal(h.record().state, STORE_STATES.AUDIT_PENDING);
  assert.equal(h.store.promoteFromAudit(h.exactAudit()).promoted, true);
  const sent = await h.send();
  assert.equal(sent.receiptState, STORE_STATES.CONFIRMED);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.exactAuditConfirmed, true);
  assert.equal(sent.auditPending, false);
  assert.equal(h.bridgeCalls.length, 1);
  assert.equal(h.attempts(), 1);
});

test('queued pending audit still accepts orchestration delivery immediately', async t => {
  const h = harness(t);
  if (!h) return;
  const receipt = await h.send();
  let current = { status: 'sending', targetTabId: h.request.tabId };
  const deliveries = [];
  Object.assign(h.context, {
    getOrchestrationRunStore: () => ({
      getInternal: async () => current,
      get: async () => current,
      markDelivery: async (_runId, input) => {
        deliveries.push(input);
        current = { ...current, status: 'sent', ...input };
        return current;
      },
    }),
    isTerminalStatus: () => false,
    resolveAgentSessionInfo: async () => ({ sessionId: h.request.sessionId }),
    emitOrchestrationRun() {},
    reconcileOrchestrationRun: async () => current,
  });
  const applied = await h.context.applyOrchestrationTargetSendReceipt('run', receipt);
  assert.equal(applied.kind, 'accepted');
  assert.equal(applied.receiptState, 'queued');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].baselineBusy, true);
  assert.equal(deliveries[0].auditPending, false,
    'orchestration acceptance does not wait for canonical history');
  assert.equal(h.record().state, STORE_STATES.AUDIT_PENDING);
  assert.equal(h.bridgeCalls.length, 1);
});

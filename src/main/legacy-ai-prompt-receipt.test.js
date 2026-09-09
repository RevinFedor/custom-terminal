'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
let route;
function visit(node) {
  if (ts.isIfStatement(node)
    && node.expression.getText(ast) === "req.method === 'POST' && req.url === '/terminal/ai-prompt'") route = node;
  if (!route) ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(route, 'actual legacy HTTP route');

function request(receipt, { bridgeError = null, submit = true, engine = 'codex' } = {}) {
  const activity = [];
  const calls = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    nodePerformance: { now: Date.now },
    terminals: new Map([['tab', {}]]),
    routeRejectsPinnedProject: () => null,
    detectAiEngineForTab: async () => engine,
    hasLiveClaudeInTab: () => true,
    ensureCodexInputReadyForExternalPrompt: async () => ({ success: true }),
    CODEX_EXTERNAL_PROMPT_READY_TIMEOUT_MS: 30_000,
    CODEX_PASTE_AUDIT_TIMEOUT_MS: 8000,
    resolveProjectForTab: () => 'project',
    captureClaudeDraftPasteTarget: () => ({}),
    findAiDescendantProcessesByTab: async () => [{ pid: 1 }],
    geminiActiveTabs: new Set(['tab']),
    emitTerminalMcpActivity: (_action, event) => { activity.push(event); return 'activity-a'; },
    rendererBridgeRequestForMcp: async (_action, payload) => {
      calls.push(payload);
      if (bridgeError) throw bridgeError;
      return receipt;
    },
    safePasteAndSubmit: async () => { calls.push({ direct: true }); return receipt; },
  });
  const helper = path.join(__dirname, 'legacy-ai-prompt-receipt.js');
  if (fs.existsSync(helper)) Object.assign(context, require(helper));
  vm.runInContext('function handleLegacy(req, res) ' + route.thenStatement.getText(ast), context);
  return new Promise(resolve => {
    const req = new EventEmitter();
    let statusCode;
    context.handleLegacy(req, {
      writeHead: code => { statusCode = code; },
      end: data => resolve({ statusCode, body: JSON.parse(data), activity, calls }),
    });
    req.emit('data', JSON.stringify({ tabId: 'tab', prompt: 'original prompt', submit }));
    req.emit('end');
  });
}

for (const submitted of [true, null]) {
  test('legacy route keeps delivery unknown with submitted=' + submitted, async () => {
    const receipt = { success: null, accepted: true, submitted, status: 'delivery-unknown',
      deliveryUnknown: true, handoffId: 'handoff-a', operationKey: 'operation-a', attemptId: 'attempt-a' };
    const response = await request(receipt);
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.status, 'delivery-unknown');
    assert.equal(response.activity.at(-1).status, 'delivery-unknown');
    assert.deepEqual(response.body.result, receipt, 'the same exact receipt is returned, not reconstructed as success');
    assert.equal(response.calls.length, 1, 'projection never re-sends the prompt');
  });
}

test('legacy route reports audit pending rather than sent', async () => {
  const response = await request({ success: true, submitted: true, auditPending: true, status: 'audit-pending' });
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.status, 'audit-pending');
  assert.equal(response.activity.at(-1).status, 'audit-pending');
});

test('native queued acceptance stays successful without pretending its transcript audit is confirmed', async () => {
  const response = await request({ success: true, submitted: true, queued: true, status: 'queued',
    receiptState: 'audit-pending', auditPending: true, providerQueueAccepted: true });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'queued');
  assert.equal(response.body.result.auditPending, true);
  assert.equal(response.activity.at(-1).status, 'queued');
});

test('exact success remains sent and exact pre-Enter refusal remains failure', async () => {
  const sent = await request({ success: true, submitted: true, status: 'sent', exactAuditConfirmed: true });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.activity.at(-1).status, 'sent');
  const failure = await request({ success: false, submitted: false, error: 'no-input-owner' });
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.body.status, 'failed');
  assert.equal(failure.activity.at(-1).status, 'error');
});

test('bridge timeout is unknown both publicly and in activity, never a second bridge invocation', async () => {
  const response = await request(null, { bridgeError: new Error('renderer bridge timeout') });
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.status, 'delivery-unknown');
  assert.equal(response.activity.at(-1).status, 'delivery-unknown');
  assert.equal(response.calls.length, 1);
});

test('draft-only paste retains its distinct pasted receipt', async () => {
  const response = await request({ success: true, submitted: false, pasteWritten: true }, { submit: false, engine: 'gemini' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'pasted');
  assert.equal(response.activity.at(-1).status, 'pasted');
  assert.equal(response.calls.length, 1);
});

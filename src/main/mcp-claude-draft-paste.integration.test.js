'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
function findNode(predicate) {
  let found;
  function visit(node) {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}
function declaration(name, optional = false) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!optional) assert.ok(node, 'actual function: ' + name);
  return node?.getText(ast) || '';
}
const route = findNode(node => ts.isIfStatement(node)
  && node.expression.getText(ast) === "req.method === 'POST' && req.url === '/terminal/ai-prompt'");
assert.ok(route, 'actual MCP ai-prompt route');
const turn = () => new Promise(resolve => setImmediate(resolve));

// Execute the actual route, serializer, full safe-paste inner function and
// result conversion. Only terminal/process I/O and render wake-ups are fixtures.
// No Electron app, real process lookup, PTY, network or persistent storage.
function harness({ busy = false, firstTurn = false, onDetect = null, onLookup = null, onDrain = null, onRender = null } = {}) {
  const tabId = 'draft-tab';
  const writes = [];
  const activity = [];
  let lookupCount = 0;
  const makeTerm = label => ({ pid: 501, write: text => writes.push({ label, text }) });
  const term = makeTerm('original');
  const terminals = new Map([[tabId, term]]);
  const terminalCommandState = new Map([[tabId, { isRunning: true, runSeq: 7 }]]);
  const launch = new Map([[tabId, { generation: 'claude-launch-a', pid: 101 }]]);
  const pidCache = new Map([[101, tabId]]);
  const alivePids = new Set([101]);
  const stopping = new Map();
  const context = vm.createContext({
    historyMutationInput: require('./history-mutation-input').createHistoryMutationInputGate(),
    ...require('./prompt-queue-source'),
    ...require('./claude-prompt-audit'),
    ...require('./agent-history-send-receipt'),
    ...require('./history-prompt-presentations'),
    ...require('./claude-prompt-transport'),
    ...require('./claude-composer-proof'),
    ...require('./legacy-ai-prompt-receipt'),
    ...require('./agent-send-target-precondition'),
    conversationOwners: { noteInput() {} },
    tabWorkContext: { assertContinuationScope() {} }, // this fixture has no continuation or known-empty binding
    Buffer, Date, Promise, console: { log() {}, warn() {}, error() {} },
    crypto: require('node:crypto'),
    process: { kill(pid, signal) {
      assert.equal(signal, 0, 'only read-only liveness probes are allowed');
      if (!alivePids.has(pid)) throw Object.assign(new Error('process absent'), { code: 'ESRCH' });
    } },
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 8000, CODEX_PASTE_AUDIT_TIMEOUT_MS: 8000,
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~',
    terminals, terminalCommandState, terminalInputRevisions: new Map([[tabId, 1]]),
    terminalLifecycleEpochs: new WeakMap([[term, 'epoch-a']]),
    terminalStopRevisions: new WeakMap(),
    claudeLaunchGenerationByTab: launch, bridgePidCache: pidCache,
    bridgeKnownSessions: firstTurn ? new Map() : new Map([[tabId, 'session-a']]),
    claudeCliActive: new Map([[tabId, true]]), claudePromptReady: new Set(),
    claudeTurnBusy: new Map([[tabId, busy]]), claudeLocalCommandWatchers: new Map(),
    aiStoppingTabs: stopping, mainWindow: null,
    getActiveAgentExecutionContext: () => null,
    getHeadlessTerminalMirror: () => null,
    nodePerformance: { now: Date.now },
    routeRejectsPinnedProject: () => null, resolveProjectForTab: () => 'project',
    detectAiEngineForTab: async () => { if (onDetect) onDetect(h); return 'claude'; },
    findAiDescendantProcessesByTab: async () => {
      lookupCount++;
      if (onLookup) onLookup(h);
      return [...alivePids].map(pid => ({ pid, depth: 1, processName: 'claude' }));
    },
    emitTerminalMcpActivity: (_name, payload) => { activity.push(payload); return 'activity'; },
    drainPtyData: async () => { if (onDrain) onDrain(h); },
    waitForRender: () => {
      if (onRender) onRender(h);
      const promise = Promise.resolve({ timedOut: false, elapsedMs: 1 });
      promise.markWriteTime = () => {};
      return promise;
    },
    recordComposerForensicPtyInput() {},
  });
  const helperPath = path.join(__dirname, 'claude-draft-paste-admission.js');
  if (fs.existsSync(helperPath)) Object.assign(context, require(helperPath));
  const lockStart = mainSource.indexOf('const pasteInflight = new WeakMap();');
  const lockEnd = mainSource.indexOf('\nfunction markActivePtySubmit(', lockStart);
  vm.runInContext(mainSource.slice(lockStart, lockEnd), context);
  for (const name of ['findClaudePidByTab', 'hasLiveClaudeInTab', 'getTerminalLifecycleGeneration',
    'getTerminalStopRevision', 'captureAgentInputIdentity', 'agentSendExecutionFailure',
    'getTerminalInputRevision', 'bumpTerminalInputRevision', 'findTabIdForTerm',
    'agentSendRequestExpectedTargets', 'expectedKnownEmptySend', 'assertKnownEmptySend',
    'resolveSafePasteFailureAfterWrite', 'safePasteAndSubmit', '_safePasteAndSubmitInner', 'finishSafePasteAfterWrite']) {
    vm.runInContext(declaration(name), context);
  }
  for (const name of ['captureClaudeDraftPasteTarget', 'validateClaudeDraftPasteAtBoundary']) {
    vm.runInContext(declaration(name, true), context);
  }
  vm.runInContext('function handleDraftRequest(req, res) ' + route.thenStatement.getText(ast), context);
  const h = {
    context, term, writes, activity, terminals, terminalCommandState, launch, pidCache, alivePids, stopping,
    lookupCount: () => lookupCount,
    request: (prompt = 'secret draft') => new Promise(resolve => {
      const req = new EventEmitter();
      let statusCode;
      const res = { writeHead: status => { statusCode = status; },
        end: text => resolve({ statusCode, body: JSON.parse(text) }) };
      context.handleDraftRequest(req, res);
      req.emit('data', JSON.stringify({ tabId, prompt, submit: false, parentProjectId: 'project' }));
      req.emit('end');
    }),
    change: fault => {
      if (fault === 'stopping') stopping.set(tabId, { toolType: 'claude' });
      if (fault === 'exited') { terminalCommandState.get(tabId).isRunning = false; alivePids.delete(101); }
      if (fault === 'terminal') terminals.set(tabId, makeTerm('replacement'));
      if (fault === 'run') terminalCommandState.get(tabId).runSeq++;
      if (fault === 'lifecycle') context.terminalLifecycleEpochs.set(term, 'epoch-b');
      if (fault === 'launch') launch.set(tabId, { generation: 'claude-launch-b', pid: 101 });
      if (fault === 'pid') { pidCache.clear(); pidCache.set(202, tabId); alivePids.delete(101); alivePids.add(202); launch.get(tabId).pid = 202; }
      if (fault === 'input') context.bumpTerminalInputRevision(tabId);
      if (fault === 'pid-dead-stale-bridge') alivePids.delete(101);
    },
  };
  return h;
}

for (const fault of ['stopping', 'exited', 'terminal', 'run', 'lifecycle', 'launch', 'pid', 'pid-dead-stale-bridge']) {
  test('queued actual MCP draft cannot paste into a changed target: ' + fault, async () => {
    const h = harness();
    let release;
    const blocker = h.context.withPtyWriteLock(h.term,
      () => new Promise(resolve => { release = resolve; }), { kind: 'previous-write' });
    await turn();
    const request = h.request();
    await turn();
    assert.equal(vm.runInContext('ptyLastQueuedWriteOperation.get(terminals.get("draft-tab"))?.kind', h.context),
      'safe-paste', 'request reached the real serializer behind another owner');
    h.change(fault);
    release();
    await blocker;
    const result = await request;
    assert.equal(h.writes.length, 0, 'old admission must never authorize a replacement shell/process write');
    assert.notEqual(result.body.status, 'pasted');
    assert.equal(result.body.result?.submitted, false);
    assert.equal(result.body.result?.pasteWritten, false);
  });
}

for (const [phase, fault] of [['detect', 'run'], ['drain', 'exited'], ['drain', 'input']]) {
  test('actual async ' + phase + ' boundary revalidates draft target after ' + fault, async () => {
    const hook = h => h.change(fault);
    const h = harness(phase === 'detect' ? { onDetect: hook } : { onDrain: hook });
    const result = await h.request();
    assert.equal(h.writes.length, 0);
    assert.notEqual(result.body.status, 'pasted');
  });
}

test('a replaced process during render acknowledgement does not get a false pasted receipt', async () => {
  const h = harness({ onRender: h => h.change('run') });
  const result = await h.request();
  assert.equal(h.writes.length, 1, 'the single bracketed write already went to the original process');
  assert.notEqual(result.body.status, 'pasted');
  assert.equal(result.body.result?.pasteWritten, true);
  assert.equal(result.body.result?.submitted, false);
});

for (const options of [{}, { busy: true }, { firstTurn: true }]) {
  test('unchanged live Claude accepts one draft without idle/readiness or Enter: ' + JSON.stringify(options), async () => {
    const h = harness(options);
    const result = await h.request('long\nplain draft');
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'pasted');
    assert.equal(result.body.result?.success, true);
    assert.equal(result.body.result?.submitted, false);
    assert.deepEqual(h.writes, [{ label: 'original', text: '\x1b[200~long\nplain draft\x1b[201~' }]);
    assert.equal(h.lookupCount(), 0, 'known exact PID does not trigger global process lookup');
  });
}

test('first-turn draft can bind one discovered PID without requiring a ready composer', async () => {
  const h = harness({ firstTurn: true });
  h.pidCache.clear();
  h.launch.get('draft-tab').pid = null;
  const result = await h.request();
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'pasted');
  assert.equal(h.lookupCount(), 1, 'reuse the entry lookup rather than probing processes at each write');
  assert.equal(h.writes.length, 1);
  assert.equal(result.body.result.submitted, false);
});

test('process discovery cannot bind a PID from a changed generation', async () => {
  const h = harness({ firstTurn: true, onLookup: h => h.change('run') });
  h.pidCache.clear();
  h.launch.get('draft-tab').pid = null;
  const result = await h.request();
  assert.equal(result.statusCode, 409);
  assert.notEqual(result.body.status, 'pasted');
  assert.equal(h.writes.length, 0);
});

test('ambiguous first-turn process identity is not replaced by stale bridge liveness', async () => {
  const h = harness();
  h.pidCache.clear();
  h.launch.get('draft-tab').pid = null;
  h.alivePids.add(202);
  const result = await h.request();
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.result.error, 'claude_process_identity_unknown');
  assert.equal(h.writes.length, 0);
});

test('a request received while stopping does not become valid if the flag later disappears', async () => {
  const h = harness({ onDetect: h => h.stopping.clear() });
  h.change('stopping');
  const result = await h.request();
  assert.equal(result.statusCode, 409);
  assert.equal(h.writes.length, 0);
});

test('earlier queued input does not block an append intent for the unchanged live process', async () => {
  const h = harness({ busy: true });
  let release;
  const blocker = h.context.withPtyWriteLock(h.term,
    () => new Promise(resolve => { release = resolve; }), { kind: 'previous-write' });
  await turn();
  const request = h.request();
  await turn();
  h.change('input');
  release();
  await blocker;
  const result = await request;
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'pasted');
  assert.equal(h.writes.length, 1);
});

test('new manual input after the completed paste does not erase the truthful paste receipt', async () => {
  const h = harness({ onRender: h => h.change('input') });
  const result = await h.request();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'pasted');
  assert.equal(result.body.result.pasteWritten, true);
  assert.equal(h.writes.length, 1);
});

async function callActualMcpSendPrompt(h) {
  const mcpSource = fs.readFileSync(path.join(__dirname, '../../mcp/terminal-server.mjs'), 'utf8');
  const mcpAst = ts.createSourceFile('terminal-server.mjs', mcpSource, ts.ScriptTarget.Latest, true);
  const context = vm.createContext({
    projectHint: () => ({ port: 1234, projectId: 'project' }),
    buildSourceMeta: () => ({}),
    fetch: async (_url, request) => {
      const response = await h.request(JSON.parse(request.body).prompt);
      return { ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode, text: async () => JSON.stringify(response.body) };
    },
  });
  for (const name of ['historyHttpError', 'httpPostOnPort', 'callTool']) {
    const node = mcpAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, 'actual MCP client function ' + name);
    vm.runInContext(node.getText(mcpAst), context);
  }
  return context.callTool('send_prompt', { tabId: 'draft-tab', prompt: 'secret draft', submit: false });
}

test('actual MCP client does not claim pasted when the physical boundary refused a stopped target', async () => {
  const h = harness({ onDrain: h => h.change('exited') });
  await assert.rejects(callActualMcpSendPrompt(h), /HTTP 409/);
  assert.equal(h.writes.length, 0);
});

test('actual MCP client still reports one editable draft for an unchanged busy target', async () => {
  const h = harness({ busy: true });
  const result = await callActualMcpSendPrompt(h);
  assert.match(result, /Prompt pasted as editable draft into tab draft-tab\. Status: pasted/);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].text, '\x1b[200~secret draft\x1b[201~');
});

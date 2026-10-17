'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { inspectTabs, normalizeInspectionRequest } = require('./tab-inspection');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { TaskCompletionIntentRegistry } = require('./task-completion-intent');
const { createAgentResponseObservationReader } = require('./agent-response-observation-reader');
const main = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = names => names.map(name => {
  const node = main.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(main);
}).join('\n');
const plain = x => JSON.parse(JSON.stringify(x));
const forbidden = () => assert.fail('inspection must not start/reconcile/read full history');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-tabs-'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE tabs(tab_id TEXT, name TEXT, execution_archived INTEGER)');
  db.prepare('INSERT INTO tabs VALUES(?,?,0)').run('T', 'Private tab');
  const registry = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  await registry.initialize();
  const owner = { known: true, provider: 'claude', sessionId: 'S', cwd: dir };
  const state = { live: true, generation: 'G', input: 0, processUnknown: false, responseReads: 0 };
  const agents = [], tasks = [];
  const ctx = vm.createContext({ require, path, srcMainDir: __dirname,
    projectManager: { db: { db } }, captureConversationOwner: () => ({ ...owner }),
    conversationOwners: { stored: () => ({ epoch: 'E', revision: 1 }) },
    sdkSessions: new Map(), terminals: new Map([['T', {}]]),
    ptyActiveWriteOperation: new Map(), claudePendingPrompt: new Map(), codexPromptInFlight: new Map(),
    taskCompletionIntents: new TaskCompletionIntentRegistry(), aiStoppingTabs: new Map(),
    claudeTurnBusy: new Map([['T', false]]), claudeLocalCommandWatchers: new Map(), claudeHookLastEvent: new Map(),
    codexTurnWatchers: new Map(), codexProviderSemanticSources: new Map(), bridgeKnownSessions: new Map([['T', 'S']]),
    terminalCommandState: new Map([['T', { isRunning: true }]]),
    getClaudePtyRuntimePresence: () => ({ status: state.processUnknown ? 'unknown' : state.live ? 'active' : 'inactive' }),
    getCodexPublicRuntimeProjection: forbidden, getCodexRuntimeSessionId: forbidden,
    getTerminalLifecycleGeneration: () => state.generation, getTerminalInputRevision: () => state.input,
    getTerminalStopRevision: () => 0, getCombinedTabBackgroundWorkCount: () => agents.length,
    tabBackgroundWorkRevisionByTab: new Map(), getTabBackgroundWorkAgents: () => agents,
    getTabBackgroundWorkTasks: () => tasks,
  });
  vm.runInContext(declarations(['getActiveAgentExecutionContext', 'captureAgentResponseReadState',
    'captureTabInspection', 'readTabInspectionResponse']), ctx);
  const reader = createAgentResponseObservationReader({ captureState: forbidden, readLifecycle: forbidden,
    loadSessionTurns: forbidden, readTurnResult: forbidden });
  ctx.agentResponseObservationReader = reader;
  const begin = id => {
    const turn = ctx.taskCompletionIntents.beginTurn({ tabId: 'T', provider: 'claude', sessionId: 'S',
      processId: 42, providerPromptId: id });
    ctx.claudeTurnBusy.set('T', true);
    reader.observeClaudeHook({ tabId: 'T', admitted: true, turn,
      message: { event: 'UserPromptSubmit', session_id: 'S', ppid: 42, prompt_id: id } });
    return turn;
  };
  const finish = (turn, failure = false) => {
    ctx.taskCompletionIntents.finishTurn({ tabId: 'T', success: !failure });
    ctx.claudeTurnBusy.set('T', false);
    ctx.claudeHookLastEvent.set('T', { event: failure ? 'StopFailure' : 'Stop', turnId: 'claude:' + turn.generation });
    reader.observeClaudeHook({ tabId: 'T', admitted: true, matched: true, turn,
      message: { event: failure ? 'StopFailure' : 'Stop', session_id: 'S', ppid: 42,
        prompt_id: turn.providerPromptId, last_assistant_message: 'final-' + turn.providerPromptId + 'x'.repeat(2500) } });
  };
  const deps = { capture: id => ctx.captureTabInspection(id),
    readResponse: (id, captured) => { state.responseReads++; return ctx.readTabInspectionResponse(id, captured); },
    readTracked: id => registry.readTabInspection(id) };
  t.after(async () => { await registry.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ctx, state, owner, registry, agents, tasks, deps, begin, finish,
    inspect: args => inspectTabs({ tabIds: ['T'], ...args }, deps) };
}

test('actual Main idle exact hook final: bounded preview/ref, no lifecycle lookup or model turn', async t => {
  const h = await fixture(t); h.finish(h.begin('A'));
  const row = (await h.inspect({ includeLastResponse: true, maxPreviewChars: 21 })).tabs[0];
  assert.equal(row.known, true); assert.equal(row.runtime.busy, false);
  assert.equal(row.lastResponse.status, 'current'); assert.equal(row.lastResponse.preview.length, 21);
  assert.equal(row.lastResponse.truncated, true); assert.equal(row.lastResponse.ref.providerPromptId, 'A');
  assert.equal(h.ctx.taskCompletionIntents.getTurn('T'), null);
  assert.equal((await h.inspect({ includeLastResponse: true })).tabs[0].revision, row.revision);
});

test('running and aborted successors never publish the old final as current success', async t => {
  const h = await fixture(t); h.finish(h.begin('A')); const b = h.begin('B');
  let row = (await h.inspect({ includeLastResponse: true })).tabs[0];
  assert.equal(row.turn.status, 'running'); assert.equal(row.lastResponse.status, 'historical');
  h.finish(b, true); row = (await h.inspect({ includeLastResponse: true })).tabs[0];
  assert.equal(row.turn.status, 'ended'); assert.equal(row.lastResponse.status, 'historical');
  assert.equal(row.lastResponse.ref.providerPromptId, 'A');
});

test('turn done plus native background and inherited job stay separate; notify=false still tracks work', async t => {
  const h = await fixture(t); h.finish(h.begin('A'));
  h.agents.push({ toolUseId: 'native-agent', provider: 'claude', generation: 1 });
  h.tasks.push({ toolUseId: 'native-bash', taskId: 'bash-1', kind: 'bash', provider: 'claude' });
  h.registry.runs.set('child', { runId: 'child', runKind: 'agent', sourceTabId: 'T', targetTabId: 'U',
    status: 'running', notifySource: false, notificationStatus: 'pending' });
  h.registry.runs.set('notify', { runId: 'notify', runKind: 'agent', sourceTabId: 'T', targetTabId: 'V',
    status: 'completed', resultComplete: true, notifySource: true, sourceFollowupPending: true, notificationStatus: 'queued' });
  const row = (await h.inspect({ includeLastResponse: true })).tabs[0];
  assert.equal(row.runtime.busy, false); assert.equal(row.ownBackground.count, 2);
  assert.equal(row.ownBackground.taskCount, 1); assert.equal(row.tracked.count, 2);
  assert.equal(row.tracked.pendingDeliveryCount, 1);
  assert.equal(row.tracked.jobs.find(job => job.runId === 'child').notifySource, false);
  assert.equal(row.tracked.jobs.find(job => job.runId === 'child').pendingDelivery, false);
  assert.equal(row.lastResponse.scope, 'turn');
  assert.equal(h.registry.runs.get('child').status, 'running');
});

test('current run requires exact execution identity; queued delivery is not a running provider', async t => {
  const h = await fixture(t); h.begin('A');
  const execution = plain(h.ctx.getActiveAgentExecutionContext('T'));
  h.registry.runs.set('own', { runId: 'own', sourceTabId: 'parent', targetTabId: 'T', status: 'running', targetExecutionContext: execution });
  h.registry.runs.set('old', { runId: 'old', sourceTabId: 'parent', targetTabId: 'T', status: 'running',
    targetExecutionContext: { ...execution, generation: execution.generation + 1 } });
  h.registry.runs.set('waiting', { runId: 'waiting', sourceTabId: 'T', targetTabId: 'U', status: 'queued' });
  const row = (await h.inspect()).tabs[0];
  assert.deepEqual(row.currentRuns.runIds, ['own']);
  assert.equal(row.tracked.pendingTargetDeliveryCount, 1);
  assert.equal(row.tracked.pendingResultDeliveryCount, 0);
});

test('unknown and stopped runtime never promote the retained final to current', async t => {
  const h = await fixture(t); h.finish(h.begin('A')); h.state.processUnknown = true;
  let row = (await h.inspect({ includeLastResponse: true })).tabs[0];
  assert.equal(row.runtime.known, false); assert.equal(row.lastResponse.status, 'historical');
  h.state.processUnknown = false; h.state.live = false; h.ctx.terminalCommandState.get('T').isRunning = false;
  row = (await h.inspect({ includeLastResponse: true })).tabs[0];
  assert.equal(row.runtime.status, 'inactive'); assert.equal(row.lastResponse.status, 'historical');
});

test('replaced owner during response read removes body and stale success', async t => {
  const h = await fixture(t); h.finish(h.begin('A'));
  const original = h.deps.readResponse;
  h.deps.readResponse = async (...args) => { const value = await original(...args); h.owner.sessionId = 'OTHER'; return value; };
  const row = (await h.inspect({ includeLastResponse: true })).tabs[0];
  assert.equal(row.known, false); assert.equal(row.reason, 'tab_state_changed');
  assert.equal(row.lastResponse.preview, undefined);
});

test('default read has no answer I/O; missing tab/registry explicitly unknown, no initialization', async t => {
  const h = await fixture(t); h.registry.initialized = false; h.registry.initialize = forbidden;
  const result = await h.inspect({ tabIds: ['T', 'missing'] });
  assert.equal(h.state.responseReads, 0); assert.equal(result.tabs[0].tracked.known, false);
  assert.equal(result.tabs[1].exists, false); assert.equal(result.tabs[1].lastResponse.status, 'not-requested');
});

test('maximum batch and large tracked/native sets remain bounded, partial failures do not lose neighbors', async t => {
  const h = await fixture(t);
  for (let index = 0; index < 40; index++) {
    h.agents.push({ toolUseId: 'agent-' + index, provider: 'claude' });
    h.registry.runs.set('job-' + index, { runId: 'job-' + index, sourceTabId: 'T', targetTabId: 'U', status: 'running' });
  }
  const rows = (await h.inspect({ tabIds: ['T', '1', '2', '3', '4', '5', '6', '7'] })).tabs;
  assert.equal(rows.length, 8); assert.equal(rows[0].ownBackground.count, 40);
  assert.equal(rows[0].ownBackground.items.length, 24); assert.equal(rows[0].ownBackground.truncated, true);
  assert.equal(rows[0].tracked.count, 40); assert.equal(rows[0].tracked.jobs.length, 24);
  h.deps.capture = id => { if (id === 'T') throw new Error('private owner failed'); return { known: false, revision: 'unknown' }; };
  const failed = await h.inspect({ tabIds: ['T', 'other'] });
  assert.equal(failed.tabs[0].known, false); assert.equal(failed.tabs[1].known, false);
  assert.equal(JSON.stringify(failed).includes('private owner failed'), false);
});

test('batch and preview arguments are strictly bounded before any reads', () => {
  for (const input of [{}, { tabIds: [] }, { tabIds: Array.from({ length: 9 }, (_, i) => '' + i) },
    { tabIds: ['T', 'T'] }, { tabIds: [''] }, { tabIds: ['T'], maxPreviewChars: 2001 },
    { tabIds: ['T'], maxPreviewChars: -1 }, { tabIds: ['T'], includeLastResponse: 'false' },
    { tabIds: ['T'], send: true }]) assert.throws(() => normalizeInspectionRequest(input), { statusCode: 400 });
});

test('actual HTTP inspect route is read-only and uses bounded request shape', async t => {
  const h = await fixture(t); h.finish(h.begin('A'));
  const web = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const start = web.indexOf("  if (parsed.pathname === '/api/terminal-tabs/inspect'");
  const end = web.indexOf('  // Status snapshot for a PTY+Claude tab:', start);
  assert.ok(start > 0 && end > start);
  const ctx = vm.createContext({ require, JSON, Number,
    captureTabInspection: h.deps.capture, readTabInspectionResponse: h.deps.readResponse,
    orchestrationRunStore: h.registry,
    sendJson: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } });
  vm.runInContext('async function route(req,res,parsed){' + web.slice(start, end) + '}', ctx);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://private');
    ctx.route(req, res, { pathname: url.pathname, query: Object.fromEntries(url.searchParams) });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/terminal-tabs/inspect?';
  const response = await fetch(url + new URLSearchParams({ tabIds: '["T"]', includeLastResponse: 'true', maxPreviewChars: '0' }));
  assert.equal(response.status, 200);
  const row = (await response.json()).tabs[0];
  assert.equal(row.lastResponse.ref.providerPromptId, 'A'); assert.equal(row.lastResponse.preview, undefined);
  assert.equal((await fetch(url + 'tabIds=bad')).status, 400);
  assert.equal((await fetch(url + 'tabIds=%5B%22T%22%5D&send=true')).status, 400);
});

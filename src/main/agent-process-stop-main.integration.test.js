'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const url = require('node:url');
const contract = require('./project-api-runtime-contract');
const { runKeyedExclusive } = require('./codex-writer-ownership');
const { spawn } = require('node:child_process');
const quiet = { log() {}, warn() {}, error() {} };
function functions(file, names) {
  const tree = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); return node.getText(tree);
  }).join('\n');
}
const mainCode = functions('main.js', ['stopAgentProcessScenarioInMain', 'stopAiProcessInTabSerialized', 'stopAiProcessInTab']);
const webCode = functions('web-server.js', ['checkAuth', 'handleApi', 'runAgentStopScenario']);

function fixture({ residual = false, guarded = false } = {}) {
  const events = [], writes = [], waits = [], signals = [];
  let release, calls = 0;
  const exitProof = new Promise(resolve => release = resolve);
  const term = { pid: 10, write: bytes => writes.push(bytes) };
  const ctx = vm.createContext({ console: quiet, path, srcMainDir: __dirname, clearTimeout,
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { isRunning: true, runSeq: 2 }]]),
    aiLifecycleActionInflight: new Map(), runKeyedExclusive,
    cancelCodexManualCompactPending() {}, resolveAiToolTypeForTab: (_tab, tool) => tool || 'claude',
    markAiStopping: () => events.push('stopping'),
    clearAiStopping: (_tab, _reason, flags) => events.push(flags.broadcastInactive ? 'inactive' : 'clear-stopping'),
    restoreAiRuntimeStatusAfterFailedStop: () => events.push('restore-status'),
    inspectAiDescendantProcessesByTab: async (_tab, _tool, options) => {
      calls++; options.onSnapshot({ children: new Map() });
      return { status: 'found', matches: [{ pid: 11, ppid: 10, processName: 'claude', depth: 1, cmd: 'claude' }] };
    },
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    selectAiProcessForStop: matches => matches[0],
    buildAiStopScope: () => ({ rootPid: 11, processGroups: [11], signalPids: [], trackedPids: [11, 12] }),
    resolveActivityIdentity: () => ({ sessionId: 'S' }),
    waitForAiStopScopeExit: async (_scope, timeout) => {
      waits.push(timeout);
      if (waits.length === 3) { await exitProof; return { exited: !residual, residual: { aliveGroups: [11], alivePids: [12] } }; }
      return { exited: false, residual: { aliveGroups: [11], alivePids: [12] }, elapsedMs: timeout };
    },
    signalAiStopScope: (_scope, signal) => { signals.push(signal); return { errors: [], signaledGroups: [11], signaledPids: [] }; },
    isAiStopSignalTargetAlive: () => true,
    retireAgentInputCaptureForProcess: () => events.push('capture-retired'),
    invalidateProcessTreeSnapshot: () => events.push('process-cache-invalidated'),
    finalizeStoppedAiCommandState: () => events.push('scope-exited'),
    stopClaudeLocalCommandWatcher() {},
    terminalHistoryPreviewController: { finish: () => events.push('final-audit') },
    clearClaudeProviderFatalTurnWatch() {}, emitClaudeAbnormalTurnEnd: () => events.push('turn-aborted'),
    wakeClaudePostEnterResolutionWaitersForTurnIdle() {}, taskCompletionIntents: { abortTurn() {} },
    recordActivity: () => events.push('activity-idle'), stopInterruptWatcher() {}, clearBridgeTab: () => events.push('live-binding-retired'),
    mainWindow: null, currentAiLifecycleIdentity: () => ({}),
    getCodexWriterProofSnapshot: () => null, getCodexProvisionalSettingsSnapshot: () => null,
    validateOrchestrationAutoStopGuard: () => ({ allowed: !guarded, reason: guarded ? 'owner-changed' : null }),
  });
  for (const name of ['bridgeKnownSessions', 'codexKnownSessions', 'codexTurnWatchers', 'claudeSpinnerBusy',
    'claudeTurnBusy', 'claudeSpinnerIdleTimer', 'claudeTurnWatchdog', 'claudeSpinnerLastSeenAt',
    'claudeLocalCommandWatchers', 'claudeHookLastEvent']) ctx[name] = new Map();
  ctx.bridgeKnownSessions.set('T', 'S'); ctx.claudeTurnBusy.set('T', true); ctx.claudeCliActive = new Set(['T']);
  vm.runInContext(mainCode, ctx);
  const web = vm.createContext({ console: quiet, url, require: () => ({}), token: 'fixture', ...contract,
    decId: decodeURIComponent,
    stopAgentProcess: request => ctx.stopAgentProcessScenarioInMain(request),
    bridgeRequest: () => { throw Error('renderer must not be involved in paired main Stop'); },
    sendJson: (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
  });
  vm.runInContext(webCode, web);
  return { ctx, web, events, writes, signals, waits, release, calls: () => calls };
}

test('actual HTTP→shared main Stop waits past renderer timeout for exact exit/audit; no duplicate Stop or Enter', async t => {
  const h = fixture();
  const server = http.createServer((req, res) => h.web.handleApi(req, res, url.parse(req.url, true), new Map())
    .catch(e => h.web.sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let response = null;
  const stopping = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port,
      path: '/api/terminal-tabs/T/stop', method: 'POST', headers: { authorization: 'Bearer fixture' } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { response = { status: res.statusCode, body: JSON.parse(data) }; resolve(response); });
    }); req.on('error', reject); req.end();
  });
  for (let n = 0; n < 50 && h.waits.length < 3; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(h.waits, [300, 800, 300], JSON.stringify(response));
  assert.equal(response, null); assert.equal(h.events.includes('scope-exited'), false);
  h.release();
  const result = await stopping;
  assert.equal(result.status, 200); assert.equal(result.body.success, true); assert.equal(result.body.stopped, true);
  assert.equal(result.body.escalated, true); assert.equal(result.body.runtimeStateUnknown, undefined);
  assert.deepEqual(h.writes, ['\x03']); assert.deepEqual(h.signals, ['SIGTERM', 'SIGKILL']); assert.equal(h.calls(), 1);
  assert.ok(h.events.indexOf('scope-exited') < h.events.indexOf('final-audit'));
  assert.ok(h.events.includes('inactive')); assert.ok(h.events.includes('live-binding-retired'));
});

test('channel deadline is not a semantic deadline; main Stop reports only the scenario settlement', async () => {
  const h = fixture(); let settled = false;
  const result = h.web.runAgentStopScenario('T', 1).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false); assert.equal(h.events.includes('scope-exited'), false);
  h.release();
  assert.equal((await result).stopped, true); assert.equal(h.calls(), 1);
});

test('a later Play uses the same lifecycle queue; old Stop settles/audits before the successor launch', async () => {
  const h = fixture();
  const stop = h.web.runAgentStopScenario('T', 1);
  const play = runKeyedExclusive(h.ctx.aiLifecycleActionInflight, 'T', () => h.events.push('successor-launch'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.events.includes('successor-launch'), false);
  h.release(); assert.equal((await stop).stopped, true); await play;
  assert.ok(h.events.indexOf('inactive') < h.events.indexOf('successor-launch'));
  assert.ok(h.events.indexOf('final-audit') < h.events.indexOf('successor-launch'));
  assert.equal(h.calls(), 1);
});

test('HTTP response loss does not cancel or repeat main Stop; late authoritative exit/audit still settle', async t => {
  const h = fixture();
  const server = http.createServer((req, res) => h.web.handleApi(req, res, url.parse(req.url, true), new Map())
    .catch(e => h.web.sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
    path: '/api/terminal-tabs/T/stop', headers: { authorization: 'Bearer fixture' } });
  request.on('error', () => {}); request.end();
  for (let n = 0; n < 50 && h.waits.length < 3; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.waits.length, 3); request.destroy(); h.release();
  for (let n = 0; n < 50 && !h.events.includes('inactive'); n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(h.events.includes('inactive')); assert.ok(h.events.includes('final-audit'));
  assert.equal(h.calls(), 1); assert.deepEqual(h.writes, ['\x03']);
});

test('residual owned tool/process scope does not become successful stopped/absent', async () => {
  const h = fixture({ residual: true }); h.release();
  const result = contract.classifyAgentActionResult('stop', await h.web.runAgentStopScenario('T', 1));
  assert.equal(result.statusCode, 409); assert.equal(result.body.stopped, false); assert.equal(result.body.error, 'ai_process_tree_residual');
  assert.equal(h.events.includes('scope-exited'), false); assert.equal(h.events.includes('final-audit'), false);
});

test('shared main authority refuses a foreign owner before any process signal or queued prompt', async () => {
  const h = fixture({ guarded: true }); h.release();
  const result = await h.web.runAgentStopScenario('T', 1, { authority: { kind: 'orchestration-auto-stop' } });
  assert.equal(result.success, false); assert.equal(result.guardRejected, true);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.signals, []); assert.deepEqual(h.waits, []);
});

test('legacy isolated transport still returns unknown on timeout, never guesses success from a later SID', async () => {
  const h = fixture(); h.web.stopAgentProcess = null;
  h.web.bridgeRequest = async () => { throw Object.assign(new Error('Bridge timeout: stopAgentProcessScenario'), { code: 'bridge_timeout' }); };
  await assert.rejects(h.web.runAgentStopScenario('T', 1), { code: 'bridge_timeout' });
  assert.equal(h.calls(), 0); assert.equal(h.events.length, 0);
});

test('kernel fixture: actual main Stop signals ONLY its owned dummy child, waits for ESRCH and audits before success', async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready');"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  const h = fixture(), signals = [];
  h.ctx.setTimeout = setTimeout;
  h.ctx.process = { kill: (pid, signal) => {
    assert.equal(pid, child.pid, 'never signal a group, broad target or unrelated process');
    if (signal !== 0) signals.push(signal);
    return process.kill(pid, signal);
  } };
  h.ctx.inspectAiDescendantProcessesByTab = async (_tab, _tool, options) => {
    options.onSnapshot({ children: new Map() });
    return { status: 'found', matches: [{ pid: child.pid, ppid: process.pid, processName: 'claude', depth: 1, cmd: 'OWNED_DUMMY_FIXTURE' }] };
  };
  h.ctx.buildAiStopScope = () => ({ rootPid: child.pid, processGroups: [], signalPids: [child.pid], trackedPids: [child.pid] });
  vm.runInContext(functions('main.js', ['isAiStopSignalTargetAlive', 'inspectAiStopScopeAlive',
    'signalAiStopScope', 'waitForAiStopScopeExit']), h.ctx);
  const result = contract.classifyAgentActionResult('stop', await h.web.runAgentStopScenario('T', 1));
  assert.equal(result.statusCode, 200); assert.equal(result.body.stopped, true); assert.equal(result.body.escalated, true);
  await exited; assert.equal(child.signalCode, 'SIGKILL');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(h.writes, ['\x03']);
  assert.ok(h.events.includes('scope-exited')); assert.ok(h.events.includes('final-audit')); assert.ok(h.events.includes('inactive'));
});

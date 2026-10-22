'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const readiness = require('./agent-ready-wait');
const { validateFreshAgentRuntimeStatus } = require('./project-api-runtime-contract');
const source = fs.readFileSync(process.env.IOS35_CANDIDATE_WEB || require.resolve('./web-server'), 'utf8');
const tree = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const fn = name => tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(tree);
const owned = launchId => ({ toolType: 'claude', commandType: 'claude', launchId, launchGeneration: launchId,
  lifecycleGeneration: 'G-' + launchId, status: 'active', sessionStatus: 'active', inputReady: true,
  startupDefaultsReady: true, writerSessionId: 'S-' + launchId, processPid: launchId === 'L1' ? 1 : 2 });

test('actual public stamp preserves exact null/current owner in coherent reads and keeps legacy partial semantics', () => {
  const ctx = vm.createContext({ publicRuntimeSnapshots: new Map(), conversationOwners: null,
    fingerprintAgentSendRequest: JSON.stringify });
  vm.runInContext(['normalizePublicRuntimeStatus', 'stampPublicRuntimeSnapshot'].map(fn).join('\n'), ctx);
  const stamp = value => ctx.stampPublicRuntimeSnapshot('T', value);
  stamp({ ...owned('L1'), sessionId: 'S1', readSessionId: 'S1', inputRevision: 8, processStatus: 'found' });
  assert.equal(stamp({ sessionId: null }).sessionId, 'S1', 'legacy partial null remains compatible');
  const cleared = stamp({ coherent: true, ...owned('L2'), status: 'inactive', sessionId: null,
    readSessionId: null, writerSessionId: null, processPid: null, processStatus: 'absent',
    inputRevision: 9, conversationOwner: { ownerToken: 'O2', currentBinding: { state: 'none' } } });
  assert.equal(cleared.sessionId, null); assert.equal(cleared.writerSessionId, null);
  assert.equal(cleared.readSessionId, null); assert.equal(cleared.processPid, null);
  assert.equal(cleared.launchId, 'L2'); assert.equal(cleared.conversationOwner.ownerToken, 'O2');
  const revision = cleared.runtimeRevision;
  const next = stamp({ ...cleared, processStatus: 'found', processPid: 2 });
  assert.notEqual(next.runtimeRevision, revision, 'process proof change is observable');
  const replacement = stamp({ type: 'busy', busy: true, launchId: 'L3', lifecycleGeneration: 'G3' });
  assert.equal(replacement.processPid, null); assert.equal(replacement.writerSessionId, null);
  assert.equal(replacement.inputReady, false, 'a partial new-owner event never carries prior ready proof');
  assert.equal(stamp({ readSessionId: null, codexReadSessionId: 'legacy-alias' }).readSessionId,
    'legacy-alias', 'partial legacy aliases retain their existing compatibility semantics');
  assert.equal(stamp({ coherent: true, toolType: 'codex', launchId: 'L3', codexReadSessionId: 'alias-only' }).readSessionId,
    'alias-only', 'coherent alias-only older producers remain supported');
  assert.equal(stamp({ toolType: 'codex', launchId: 'L4', readSessionId: null,
    codexReadSessionId: 'stale-owner-alias' }).readSessionId, null,
    'an explicit new-owner revoke also outranks its old alias');
});
function webHarness() {
  let current = owned('L2');
  const context = vm.createContext({ ...readiness, console: { log() {}, warn() {} }, ipcMain: new EventEmitter(),
    readAgentReadyStatus: async () => current, validateFreshAgentRuntimeStatus, shortId: x => x,
    readAgentLifecycleIdentity: async () => ({ ...current, sessionId: current.writerSessionId, terminalRunSeq: 2, inputRevision: 2 }),
    readAgentRuntimeSnapshot: async () => ({ ...current, coherent: true }),
    stampPublicRuntimeSnapshot: (_tab, data) => data,
  });
  vm.runInContext(['waitForAgentReady', 'readFreshReadyRuntimeStatus', 'coherentPublicRuntimeSnapshot'].map(fn).join('\n'), context);
  return { context, set: value => { current = value; } };
}
test('actual coherent Codex status explicit read revoke clears the older compatibility alias', async () => {
  const ctx = vm.createContext({ ...readiness, validateFreshAgentRuntimeStatus,
    publicRuntimeSnapshots: new Map(), conversationOwners: null,
    fingerprintAgentSendRequest: require('./agent-send-receipt-registry').fingerprintAgentSendRequest,
    readAgentRuntimeSnapshot: async () => ({ coherent: true, toolType: 'codex', commandType: 'codex',
      status: 'starting', readSessionId: null, sessionId: null, writerSessionId: null,
      writerConfirmed: false, writerUsableForMutation: false, canCopySessionId: false,
      inputReady: false, lifecycleGeneration: 'G:8', terminalRunSeq: 8 }),
  });
  vm.runInContext(['normalizePublicRuntimeStatus','stampPublicRuntimeSnapshot','coherentPublicRuntimeSnapshot'].map(fn).join('\n'), ctx);
  const status = await ctx.coherentPublicRuntimeSnapshot('T', { toolType: 'codex', commandType: 'codex',
    status: 'starting', readSessionId: 'same-source', codexReadSessionId: 'same-source',
    sessionId: null, writerConfirmed: false, canCopySessionId: true, lifecycleGeneration: 'G:7' });
  assert.equal(status.readSessionId, null, 'explicit current Main revoke must outrank the pre-await alias');
  assert.equal(status.codexReadSessionId, null); assert.equal(status.canCopySessionId, false);
  assert.equal(status.writerConfirmed, false); assert.equal(status.writerUsableForMutation, false);
  assert.equal(status.lifecycleGeneration, 'G:8');
});
test('actual web waiter must pin the admitted L1, not the first observed L2', async () => {
  const h = webHarness();
  await assert.rejects(() => h.context.waitForAgentReady('T', 1000, owned('L1')), e => e.code === 'agent_ready_owner_changed');
});
test('actual fresh read rejects L2 after the wait has accepted L1', async () => {
  const h = webHarness();
  await assert.rejects(() => h.context.readFreshReadyRuntimeStatus('T', 'fixture', owned('L1')), e => e.code === 'agent_ready_owner_changed');
});
test('actual final runtime assembly cannot combine admitted L1 with L2 PID/writer', async () => {
  const h = webHarness();
  await assert.rejects(() => h.context.coherentPublicRuntimeSnapshot('T', { ...owned('L1'), ready: true }, owned('L1')),
    e => e.code === 'agent_ready_owner_changed');
});
test('same admitted Claude launch survives its own first OSC generation change', async () => {
  const h = webHarness(); h.set({ ...owned('L1'), lifecycleGeneration: 'first-OSC' });
  assert.equal((await h.context.waitForAgentReady('T', 1000, owned('L1'))).launchId, 'L1');
});

test('unpaired web transport never builds a false coherent PTY status from older base and new PID', async () => {
  const h = webHarness(); h.context.readAgentRuntimeSnapshot = null;
  await assert.rejects(() => h.context.coherentPublicRuntimeSnapshot('T', owned('L1')),
    e => e.code === 'runtime_snapshot_unavailable' && e.runtimeStateUnknown === true);
  const sdk = { commandType: 'claude-sdk', sessionId: 'SDK', status: 'busy' };
  assert.equal(await h.context.coherentPublicRuntimeSnapshot('T', sdk), sdk);
});

test('actual create-tab failure branch retains a successor after the admitted launch was replaced', async () => {
  const app = fs.readFileSync(require.resolve('../renderer/App.tsx'), 'utf8');
  const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let branch;
  function visit(n) { if (ts.isIfStatement(n) && n.expression.getText(ast) === '!launchAccepted?.accepted'
    && n.getText(ast).includes('state.closeTab')) branch = n.getText(ast); ts.forEachChild(n, visit); }
  visit(ast); assert.ok(branch);
  let closed = 0;
  const code = ts.transpileModule('(async()=>{' + branch + '})', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = vm.runInNewContext(code, { launchAccepted: { accepted: false, error: 'agent_ready_owner_changed', launchId: 'L1' },
    state: { closeTab: async () => { closed++; } }, projectId: 'P', tabId: 'T', reply: (_ok, data) => data });
  await run(); assert.equal(closed, 0);
});

for (const action of ['start', 'resume']) for (const phase of ['wait', 'fresh', 'final', 'same']) {
  test('actual HTTP ' + action + ' checks admission through ' + phase, async t => {
    const start = source.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/' + action + '$/);');
    const end = source.indexOf('\n  //', start + 5); assert.ok(start > 0 && end > start);
    let reads = 0;
    const ctx = vm.createContext({ ...readiness, validateFreshAgentRuntimeStatus, console: { log() {}, warn() {} },
      ipcMain: new EventEmitter(), shortId: x => x, decId: decodeURIComponent, readBody: async () => ({}),
      readAgentLaunchFence: null,
      resolveAgentSessionInfo: async () => ({ toolType: 'claude', status: 'inactive', canResume: false }),
      readAgentReadyStatus: async () => { reads++; return owned(phase === 'wait' || phase === 'fresh' && reads > 1 ? 'L2' : 'L1'); },
      bridgeRequest: async () => ({ ...owned('L1'), success: true, launchAccepted: true }),
      readAgentRuntimeSnapshot: async () => ({ ...owned(phase === 'final' ? 'L3' : 'L1'), coherent: true }),
      stampPublicRuntimeSnapshot: (_tab, value) => value,
      sendJson: (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
    });
    vm.runInContext(['waitForAgentReady', 'readFreshReadyRuntimeStatus', 'coherentPublicRuntimeSnapshot'].map(fn).join('\n'), ctx);
    const handler = vm.runInContext('(async(req,res,parsed)=>{let m;' + source.slice(start, end) + '})', ctx);
    const server = http.createServer((req, res) => handler(req, res, { pathname: req.url }).catch(error => {
      res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/terminal-tabs/T/' + action, method: 'POST' }, res => {
        let data = ''; res.on('data', x => { data += x; }); res.on('end', () => resolve({ code: res.statusCode, value: JSON.parse(data) }));
      }); req.on('error', reject); req.end('{}');
    });
    assert.equal(result.code, phase === 'same' ? 200 : 409, JSON.stringify(result));
    assert.equal(result.value.ready, phase === 'same');
    if (phase === 'same') { assert.equal(result.value.launchId, 'L1'); assert.equal(result.value.processPid, 1); }
    else assert.match(result.value.code || result.value.error, /owner_changed/);
  });
}

test('actual main public selector re-observes changed process/gate/owner as one tuple; continual churn is bounded', async () => {
  const mainSource = fs.readFileSync(require.resolve('./main'), 'utf8');
  const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'readMainPublicRuntimeSnapshot');
  assert.ok(node);
  for (const continual of [false, true]) {
    let version = 1, reads = 0;
    const ctx = vm.createContext({ sdkSessions: new Map(), resolveAiToolTypeForTab: () => 'claude',
      codexRuntimePolicies: null, codexLiveSettingsObserver: null,
      captureAiProcessLookupScope: () => ({ generation: 'G' + version, cwd: '/fixture' }),
      aiProcessLookupScopeCurrent: (_tab, scope) => scope.generation === 'G' + version,
      conversationOwners: { current: () => ({ ownerToken: 'O' + version, ownerOrder: { epoch: 'E', revision: version } }) },
      getTerminalInputRevision: () => version, bridgeKnownSessions: new Map(), codexKnownSessions: new Map(),
      claudeStartupGateRevisions: { get: () => version }, getActiveAgentExecutionContext: () => ({ turnId: 'turn' + version }), claudeTurnBusy: new Map(),
      readMainAgentStartReadiness: async () => { reads++; return { ...owned('L' + version), sessionId: 'S' + version }; },
      readAgentSendDestinationAtWriteBoundary: (_tab, toolType) => ({ toolType, sessionId: 'S' + version, launchId: 'L' + version }),
      readAiLifecycleIdentityForTab: async () => { if (continual || version === 1) version++; return { processStatus: 'found', processPid: version, terminalRunSeq: version, inputRevision: version }; },
      getPersistedAiSessionBindingForShutdown: () => ({ claude_session_id: 'S' + version }),
      getSessionMaterialization: () => ({ materialized: true, timelineCount: 7 }),
      currentClaudeStartupDefaultsGate: () => ({ attemptId: 'A' + version }),
    });
    const run = vm.runInContext(node.getText(ast) + ';readMainPublicRuntimeSnapshot', ctx);
    if (continual) await assert.rejects(() => run('T'), e => e.code === 'runtime_snapshot_unstable');
    else {
      const result = await run('T');
      assert.equal(result.launchId, 'L2'); assert.equal(result.processPid, 2); assert.equal(result.sessionId, 'S2');
      assert.equal(result.conversationOwner.ownerToken, 'O2'); assert.equal(result.startupDefaultsAttemptId, 'A2');
      assert.equal(result.sessionStatus, 'active'); assert.equal(result.busy, false);
      assert.equal(result.starting, false); assert.equal(result.stopping, false);
    }
    assert.equal(reads, 2);
  }
});

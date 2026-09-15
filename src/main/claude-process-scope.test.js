'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const liveness = require('./ai-process-liveness');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a stale scoped query cannot publish or poison the new owner cache', async () => {
  const cache = new Map(), wait = deferred(); let owner = 'A', reads = 0;
  const options = () => ({ cache, key: 'T:claude', maxAgeMs: 2000, now: () => 100,
    scope: owner, isScopeCurrent: scope => scope === owner });
  const old = liveness.inspectProcessLookupCached({ ...options(), query: () => { reads++; return wait.promise; } });
  owner = 'B'; cache.clear();
  const fresh = await liveness.inspectProcessLookupCached({ ...options(), query: async () => { reads++; return [{ pid: 22 }]; } });
  wait.resolve([{ pid: 11 }]);
  assert.equal((await old).status, 'unknown');
  assert.equal(fresh.matches[0].pid, 22);
  const cached = await liveness.inspectProcessLookupCached({ ...options(), query: () => assert.fail('fresh owner should hit cache') });
  assert.equal(cached.matches[0].pid, 22); assert.equal(reads, 2);
});

test('cached proof from another scope is not reused even if caller forgot explicit invalidation', async () => {
  const cache = new Map(); let owner = 'A';
  const read = pid => liveness.inspectProcessLookupCached({ cache, key: 'T:any', maxAgeMs: 2000, now: () => 100,
    scope: owner, isScopeCurrent: scope => scope === owner, query: async () => [{ pid }] });
  await read(11); owner = 'B'; assert.equal((await read(22)).matches[0].pid, 22);
});

test('older same-scope asynchronous query cannot replace a newer completed cache entry', async () => {
  const cache = new Map(), gate = deferred();
  const options = { cache, key: 'T:any', maxAgeMs: 2000, now: () => 100 };
  const old = liveness.inspectProcessLookupCached({ ...options, query: () => gate.promise });
  await liveness.inspectProcessLookupCached({ ...options, query: async () => [{ pid: 22 }] });
  gate.resolve([{ pid: 11 }]); await old;
  assert.equal((await liveness.inspectProcessLookupCached({ ...options, query: () => assert.fail('cache expected') })).matches[0].pid, 22);
});

const text = fs.readFileSync(require.resolve('./main'), 'utf8');
const tree = ts.createSourceFile('main.js', text, ts.ScriptTarget.Latest, true);
test('actual Claude presence → command state → finder/cache retires old PTY proof, rechecks B and keeps its cache', async () => {
  const gate = deferred(), A = { pid: 10 }, B = { pid: 20 }; let calls = 0, getter;
  const ctx = vm.createContext({ ...liveness, console: { log() {}, warn() {}, error() {} },
    nodePerformance: { now: () => 100, timeOrigin: 0 }, beginPerfOp() {}, endPerfOp() {},
    terminals: new Map([['T', A]]), terminalCommandState: new Map([['T', { runSeq: 1, isRunning: false }]]),
    claudeLaunchGenerationByTab: new Map([['T', { generation: 'L1' }]]), codexLastRunCommandPayload: new Map(),
    terminalProjects: new Map([['T', '/fixture']]), terminalProjectIds: new Map([['T', 'P']]),
    bridgeKnownSessions: new Map(), codexManualActionRequired: new Map(),
    aiProcessLookupCache: new Map(), AI_PROCESS_LOOKUP_CACHE_MS: 2000,
    resolveAiToolTypeForTab: () => 'claude', getTerminalLifecycleGeneration: () => ctx.terminals.get('T') === A ? 'G1' : 'G2',
    getProcessTreeSnapshot: async () => { calls++; return calls === 1 ? gate.promise : { children: new Map(), psMs: 0 }; },
    commandLooksLikeAiProcess: cmd => cmd === 'claude',
    getClaudePtyRuntimePresence: (_tab, evidence) => ({ ...evidence, launchId: ctx.claudeLaunchGenerationByTab.get('T').generation,
      status: evidence.providerProcessAlive ? 'starting' : 'unknown' }),
    getSessionMaterialization: null, projectManager: null, readAgentSendDestinationAtWriteBoundary: () => ({}),
    historyPresenceTestGate: { waitIfArmed: async () => {} },
    ipcMain: { handle: (_name, fn) => { getter = fn; } },
  });
  for (const name of ['captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent', 'findAiDescendantProcessesByTab',
    'aiProcessLookupCacheKey', 'inspectAiDescendantProcessesByTabCached', 'resolveTerminalCommandState', 'readClaudePresenceProcessProof']) {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (node) vm.runInContext(node.getText(tree), ctx);
  }
  const call = tree.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(tree) === 'ipcMain.handle' && n.expression.arguments[0]?.text === 'claude:get-presence');
  vm.runInContext(call.getText(tree), ctx);
  const pending = getter(null, 'T');
  await Promise.resolve();
  ctx.terminals.set('T', B); ctx.terminalCommandState.set('T', { runSeq: 2, isRunning: false });
  ctx.claudeLaunchGenerationByTab.set('T', { generation: 'L2' }); ctx.aiProcessLookupCache.clear();
  gate.resolve({ children: new Map([[10, [{ pid: 11, cmd: 'claude' }]]]), psMs: 0 });
  const result = await pending;
  assert.equal(result.launchId, 'L2'); assert.equal(result.providerProcessAlive, false);
  assert.equal(result.processLookupUnknown, false);
  assert.equal(calls, 2, 'same call should re-observe B instead of downgrading supported presence');
  const next = await getter(null, 'T'); assert.equal(next.providerProcessAlive, false); assert.equal(calls, 2);
});

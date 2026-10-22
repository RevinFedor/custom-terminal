'use strict';

// Source host controls: execute the actual Main declarations, global ps parser,
// single-flight, liveness, shutdown recovery and startup restore reducers.
// Only OS exec, monotonic clock, DB binding, runtime maps and descriptor/writer
// observation are controlled. No Electron/app/provider/storage is started.
// NOTED_SHUTDOWN_MAIN_SOURCE selects a guarded, unapplied candidate for a worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shutdown = require('./shutdown-ai-session-snapshot');
const liveness = require('./ai-process-liveness');
const { resolveCodexReadIdentity } = require('./codex-runtime-contract');
const { captureShutdownProcessProof } = require('./shutdown-process-proof');
const { createProcessTreeSnapshotSingleFlight } = require('./process-tree-snapshot-single-flight');
const { createShutdownInterruptedSnapshot, resolveStartupInterruptedSnapshot } = require('./build-install-continue');

const source = fs.readFileSync(process.env.NOTED_SHUTDOWN_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = [
  'augmentShutdownStateFromProcessProof', 'captureCodexShutdownScope', 'readCodexShutdownEvidence',
  'exactShutdownCandidatesForTab', 'getInterruptedAiSessionEntries', 'initialShutdownLiveTabIds',
  'captureProcessTreeSnapshot', 'getProcessTreeSnapshot', 'findAiDescendantProcessesByTab',
  'inspectAiDescendantProcessesByTab', 'captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent',
  'commandLooksLikeAiProcess', 'getAiProcessNameFromCommand',
];
const declarations = names.map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, 'missing actual declaration ' + name);
  return node.getText(ast);
}).join('\n');

function harness(count = 43) {
  const state = { time: 100, psCalls: 0, reconcileCalls: 0, providers: new Map(),
    proofs: new Map(), executions: new Map(), leases: new Map(), bindings: new Map(),
    generations: new Map(), runMutation: null, psFailure: null, reconcileMutation: null,
    inspection: 'provisional-source', events: [], psDelay: 10, writes: 0 };
  const ids = Array.from({ length: count }, (_, i) => 'saved-' + i);
  const terminals = new Map(ids.map((id, i) => [id, {
    pid: 1000 + i,
    write() { state.writes++; throw new Error('unexpected PTY write'); },
    kill() { throw new Error('unexpected PTY kill'); },
  }]));
  const context = {
    ...shutdown, ...liveness, captureShutdownProcessProof, resolveCodexReadIdentity,
    Map, Set, path, process: { pid: 77 }, Date: { now: () => state.time },
    console: { log: (...args) => state.events.push(args.join(' ')), warn: (...args) => state.events.push(args.join(' ')) },
    terminals, claudeStartupIntents: new Map(), claudeLaunchGenerationByTab: new Map(),
    terminalCommandState: new Map(ids.map(id => [id, { runSeq: 7, isRunning: true }])),
    terminalProjectIds: new Map(ids.map(id => [id, 'project-a'])),
    terminalProjects: new Map(ids.map(id => [id, '/project-a'])),
    bridgeKnownSessions: new Map(), codexKnownSessions: new Map(), aiStoppingTabs: new Map(),
    codexLastRunCommandPayload: new Map(), codexSessionDiscoveryIntents: new Map(),
    codexTurnWatchers: new Map(), codexWatchers: new Map(), codexReadIdentitySubmitPending: new Map(),
    nodePerformance: { now: () => state.time, timeOrigin: 100000 },
    PROCESS_TREE_SNAPSHOT_TTL_MS: 750, processTreeSnapshotCache: null,
    beginPerfOp: () => 'op', endPerfOp() {}, wakeClaudePresenceAfterProcessSnapshot() {},
    getTerminalLifecycleGeneration: id => state.generations.get(id) || 'terminal:7',
    resolveAuthoritativeTabProjectId: () => 'project-a',
    getTerminalInputRevision: () => 0, getCodexWriterObservationGeneration: () => 0,
    getCodexExitObserverGeneration: () => 0,
    getActiveAgentExecutionContext: id => state.executions.get(id) || null,
    getCodexWriterProofSnapshot: id => state.proofs.get(id) || null,
    getCodexResumeReadIdentityLeaseForTab: id => state.leases.get(id) || null,
    getCodexResumeSourceLeaseForTab: id => ({ tabId: id, sourceSessionId: 'source-' + id, launchId: 'launch-' + id }),
    codexSessionIdFromDb: id => state.bindings.get(id)?.codex_session_id || null,
    getPersistedAiSessionBindingForShutdown: id => state.bindings.get(id) || null,
    hasCodexPromptOrTurnInFlight: () => false,
    execAsync: async (command, timeout) => {
      assert.equal(command, 'ps -eo pid=,ppid=,pgid=,tpgid=,command=');
      assert.equal(timeout, 2000);
      state.psCalls++;
      state.time += state.psDelay;
      if (state.runMutation) await state.runMutation();
      if (state.psFailure) throw state.psFailure;
      const lines = [`${context.process.pid} 1 ${context.process.pid} -1 Electron`];
      for (const [id, term] of terminals) {
        lines.push(`${term.pid} 1 ${term.pid} ${term.pid} /bin/zsh`);
        for (const [index, provider] of (state.providers.get(id) || []).entries()) {
          const pid = term.pid * 10 + index;
          lines.push(`${pid} ${term.pid} ${pid} ${pid} /bin/${provider}`);
        }
      }
      return lines.join('\n');
    },
    reconcileCodexWriterFromProcess: async id => {
      state.reconcileCalls++;
      if (state.reconcileMutation) await state.reconcileMutation(id);
      if (state.inspection === 'adopted') state.proofs.set(id, { sessionId: 'source-' + id, launchId: 'launch-' + id });
      return { status: state.inspection, sessionId: 'source-' + id, pids: [terminals.get(id).pid * 10] };
    },
  };
  vm.createContext(context);
  vm.runInContext(declarations, context);
  context.processTreeSnapshotSingleFlight = createProcessTreeSnapshotSingleFlight({
    capture: args => context.captureProcessTreeSnapshot(args), now: () => state.time,
  });
  const run = (entries = context.getInterruptedAiSessionEntries(), live = context.initialShutdownLiveTabIds(entries)) =>
    context.augmentShutdownStateFromProcessProof(entries, live);
  function resume(id, provider = 'codex') {
    state.providers.set(id, [provider]);
    if (provider === 'claude') {
      context.claudeStartupIntents.set(id, { sessionId: 'source-' + id, at: state.time, terminalToken: terminals.get(id) });
      context.claudeLaunchGenerationByTab.set(id, { generation: 'launch-' + id, launchMode: 'resume', sessionIdHint: 'source-' + id });
      state.bindings.set(id, { claude_session_id: 'source-' + id });
      return;
    }
    state.bindings.set(id, { codex_session_id: 'source-' + id });
    state.leases.set(id, { command: 'codex-c', tabId: id, sessionId: 'source-' + id, launchId: 'launch-' + id,
      terminalToken: terminals.get(id), runSeq: 7, lifecycleGeneration: 'terminal:7', materializedFresh: false });
    context.codexSessionDiscoveryIntents.set(id, { sourceMode: 'resume', sourceSessionId: 'source-' + id,
      launchId: 'launch-' + id, sourceRunSeq: 7, sourceLifecycleGeneration: 'terminal:7' });
    context.codexTurnWatchers.set(id, { sessionId: 'source-' + id, sourceObservationLaunchId: 'launch-' + id, processGeneration: 'terminal:7' });
  }
  return { state, ids, context, run, resume };
}

test('43 unknown actual Main -> parser/singleflight/liveness requests cost ONE 2.5s observation, preserving every seed and restore target', async (t) => {
  const h = harness();
  h.state.psDelay = 2500;
  h.state.psFailure = Object.assign(new Error('ps timeout'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' });
  const seeds = new Map(h.ids.map((id, i) => [id, { engine: i % 2 ? 'claude' : 'codex', sessionId: 'seed-' + id }]));
  const result = await h.run(seeds, new Set(h.ids));
  assert.deepEqual([...result.recoverableEntries], [...seeds]);
  assert.deepEqual([...result.liveTabIds], h.ids);
  const persisted = createShutdownInterruptedSnapshot(result.recoverableEntries, { capturedAt: 123, shutdownPid: 456 });
  const restored = resolveStartupInterruptedSnapshot({ persistedSnapshot: persisted, projects: [{ id: 'project-a', tabs:
    h.ids.map(id => ({ tabId: id, wasInterrupted: true, cwd: '/project-a',
      [seeds.get(id).engine === 'codex' ? 'codexSessionId' : 'claudeSessionId']: seeds.get(id).sessionId })) }] });
  assert.equal(restored.source, 'exact-shutdown-snapshot');
  assert.equal(restored.targets.length, 43);
  assert.equal(restored.unresolved.length, 0);
  assert.equal(h.state.reconcileCalls, 0);
  assert.equal(h.state.writes, 0);
  t.diagnostic(JSON.stringify({ psCalls: h.state.psCalls, modeledElapsedMs: h.state.time - 100, restoredTargets: restored.targets.length }));
  assert.equal(h.state.psCalls, 1, 'old actual augmentation repeats the failed global ps 43 times');
  assert.equal(h.state.time - 100, 2500);
});

test('zero PTYs preserves exact seed without process reads', async () => {
  const h = harness(0), seeds = new Map([['known', { engine: 'codex', sessionId: 'S' }]]);
  const result = await h.run(seeds, new Set(['known']));
  assert.deepEqual([...result.recoverableEntries], [...seeds]);
  assert.equal(h.state.psCalls, 0);
});

test('mixed 43 inventory keeps seeds on absent, recovers accepted Claude and Codex idle source, rejects mismatched/dual identities', async () => {
  const h = harness();
  h.resume('saved-0', 'claude'); h.resume('saved-1');
  h.state.providers.set('saved-2', ['claude', 'codex']);
  h.state.providers.set('saved-3', ['claude']);
  h.state.providers.set('saved-4', ['codex']);
  h.state.proofs.set('saved-4', { sessionId: 'writer-child', launchId: 'writer-launch' });
  const seeds = new Map([
    ['saved-2', { engine: 'codex', sessionId: 'dual' }],
    ['saved-3', { engine: 'codex', sessionId: 'wrong-provider' }],
    ['saved-42', { engine: 'claude', sessionId: 'absent-seed' }],
  ]);
  const result = await h.run(seeds, new Set(['saved-42']));
  assert.equal(result.recoverableEntries.get('saved-0').sessionId, 'source-saved-0');
  assert.equal(result.recoverableEntries.get('saved-1').sessionId, 'source-saved-1');
  assert.equal(result.recoverableEntries.get('saved-4').sessionId, 'writer-child');
  assert.equal(result.recoverableEntries.get('saved-42').sessionId, 'absent-seed');
  assert.equal(result.recoverableEntries.has('saved-2'), false);
  assert.equal(result.recoverableEntries.has('saved-3'), false);
  assert.deepEqual([...result.liveTabIds].sort(), ['saved-0','saved-1','saved-2','saved-3','saved-4','saved-42']);
  assert.equal(h.state.psCalls, 1);
  assert.equal(h.state.proofs.has('saved-1'), false, 'idle recovery is not writer adoption');
});

test('initial replaced terminal/run/cwd while ps waits cannot promote provider or Resume identity', async () => {
  for (const boundary of ['terminal', 'run', 'cwd']) {
    const h = harness(1); h.resume('saved-0', 'claude');
    h.state.runMutation = () => {
      if (boundary === 'terminal') h.context.terminals.set('saved-0', { pid: 9999 });
      if (boundary === 'run') h.context.terminalCommandState.set('saved-0', { runSeq: 8, isRunning: true });
      if (boundary === 'cwd') h.context.terminalProjects.set('saved-0', '/other');
    };
    const seed = new Map([['saved-0', { engine: 'claude', sessionId: 'old-seed' }]]);
    const result = await h.run(seed, new Set());
    assert.equal(result.liveTabIds.size, 0, boundary);
    assert.deepEqual([...result.recoverableEntries], [...seed], 'unknown does not erase seed: ' + boundary);
  }
});

test('later row uses frozen pre-snapshot scope after earlier Codex descriptor IO replaces its owner', async () => {
  const h = harness(2); h.resume('saved-0'); h.resume('saved-1', 'claude');
  h.state.reconcileMutation = () => {
    h.context.terminals.set('saved-1', { pid: 3333 });
    h.resume('saved-1', 'claude');
  };
  const result = await h.run();
  assert.equal(result.recoverableEntries.get('saved-0').sessionId, 'source-saved-0');
  assert.equal(result.recoverableEntries.has('saved-1'), false);
  assert.equal(result.liveTabIds.has('saved-1'), false);
});

test('unknown fresh provider recheck after Codex descriptor IO keeps exact seed', async () => {
  const h = harness(1); h.resume('saved-0');
  h.state.executions.set('saved-0', { provider: 'codex', sessionId: 'source-saved-0' });
  h.state.reconcileMutation = () => {
    h.context.processTreeSnapshotCache = null;
    h.state.psFailure = new Error('ps failed after descriptors');
  };
  const result = await h.run();
  assert.equal(result.recoverableEntries.get('saved-0')?.sessionId, 'source-saved-0');
  assert.equal(h.state.psCalls, 2, 'recovery revalidation is an independent observation');
});

test('Codex adopted/idle recovery retains guards for fresh resume, unresolved submit, generation change and late dual owner', async () => {
  for (const mode of ['adopted', 'idle', 'fresh', 'submit', 'generation', 'late-dual', 'absent']) {
    const h = harness(1); h.resume('saved-0');
    if (mode === 'adopted') h.state.inspection = 'adopted';
    if (mode === 'fresh') h.state.leases.get('saved-0').materializedFresh = true;
    if (mode === 'submit') h.context.codexReadIdentitySubmitPending.set('saved-0', { enterWritten: true });
    h.state.reconcileMutation = () => {
      if (mode === 'generation') h.state.generations.set('saved-0', 'replacement');
      if (mode === 'late-dual' || mode === 'absent') {
        h.context.processTreeSnapshotCache = null;
        h.state.providers.set('saved-0', mode === 'late-dual' ? ['claude', 'codex'] : []);
      }
    };
    const result = await h.run();
    assert.equal(result.recoverableEntries.has('saved-0'), ['adopted', 'idle'].includes(mode), mode);
    assert.equal(result.liveTabIds.has('saved-0'), true, mode);
  }
});

test('stale snapshot keeps all exact seeds without declaring processes absent', async () => {
  const h = harness();
  h.context.getProcessTreeSnapshot = async () => ({ children: new Map(), processesByPid: new Map(), createdAt: 0 });
  const seeds = new Map(h.ids.map(id => [id, { engine: 'codex', sessionId: id }]));
  const result = await h.run(seeds, new Set(h.ids));
  assert.deepEqual([...result.recoverableEntries], [...seeds]);
  assert.equal(result.liveTabIds.size, 43);
  assert.equal(h.state.reconcileCalls, 0);
  assert.ok(h.state.events.some(event => event.includes('"unknown":43')), 'stale snapshot is explicitly unknown for the whole inventory');
});

test('a pre-existing normal capture settles then ONE fresh shutdown observation; ordinary lookups still retry unknown', async () => {
  const h = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  h.state.psFailure = new Error('ps unavailable');
  h.state.runMutation = async () => { if (first) { first = false; await gate; } };
  const preceding = h.context.getProcessTreeSnapshot().catch(() => null);
  await Promise.resolve();
  const shutdownRun = h.run();
  release();
  await preceding; await shutdownRun;
  assert.equal(h.state.psCalls, 2, 'one pre-existing normal + one fresh shutdown capture');
  await h.context.inspectAiDescendantProcessesByTab('saved-0', null);
  assert.equal(h.state.psCalls, 3, 'shutdown unknown is not installed in the ordinary cache');
});

// Global census validity: reuse the complete actual Main/shutdown harness.
{
const caller = '77 1 77 -1 Electron';
const shell = '1000 1 1000 1000 /bin/zsh';
const provider = '10000 1000 10000 10000 /bin/codex';
const secret = 'DO_NOT_LOG_SECRET_ARGV';
function make(rows, count = 1) {
  const h = harness(count);
  h.state.rows = rows;
  h.state.wakes = 0;
  h.context.wakeClaudePresenceAfterProcessSnapshot = () => h.state.wakes++;
  h.context.execAsync = async (command, timeout) => {
    assert.equal(command, 'ps -eo pid=,ppid=,pgid=,tpgid=,command=');
    assert.equal(timeout, 2000);
    h.state.psCalls++;
    h.state.time += 10;
    return h.state.rows;
  };
  return h;
}
const invalid = [
  ['empty', '', 'empty'],
  ['whitespace-only', ' \n\t\n', 'empty'],
  ['malformed', secret, 'malformed-row'],
  ['mixed-outside-provider-subtree', [caller, shell, provider, secret].join('\n'), 'malformed-row'],
  ['caller-missing', [shell, provider].join('\n'), 'caller-missing'],
  ['duplicate-caller-before-filter', [caller, caller, shell].join('\n'), 'duplicate-pid'],
  ['duplicate-other-electron-before-filter', [caller, shell, '88 1 88 -1 electron', '88 1 88 -1 electron'].join('\n'), 'duplicate-pid'],
  ['duplicate-provider', [caller, shell, provider, provider].join('\n'), 'duplicate-pid'],
  ['numeric-duplicate-padded-pid', [caller, shell, '01000 1 1000 1000 /bin/zsh'].join('\n'), 'duplicate-pid'],
  ['zero-pid', [caller, '0 0 0 -1 ' + secret].join('\n'), 'nonpositive-pid'],
  ['negative-pid', [caller, '-2 1 2 -1 ' + secret].join('\n'), 'malformed-row'],
  ['negative-ppid', [caller, '88 -1 88 -1 ' + secret].join('\n'), 'malformed-row'],
  ['negative-pgid', [caller, '88 1 -88 -1 ' + secret].join('\n'), 'malformed-row'],
  ['missing-command', [caller, '88 1 88 -1'].join('\n'), 'malformed-row'],
  ['fractional-field', [caller, '88 1.5 88 -1 ' + secret].join('\n'), 'malformed-row'],
  ['exponent-field', [caller, '88 1 88 1e3 ' + secret].join('\n'), 'malformed-row'],
];
for (let field = 0; field < 4; field++) {
  const fields = ['88', '1', '88', '-1'];
  fields[field] = '9007199254740992';
  invalid.push(['unsafe-integer-field-' + field, [caller, fields.join(' ') + ' ' + secret].join('\n'), 'unsafe-integer']);
}
invalid.push(['unsafe-negative-tpgid', [caller, '88 1 88 -9007199254740992 ' + secret].join('\n'), 'unsafe-integer']);
invalid.push(['unsafe-electron-caller-before-filter', '77 9007199254740992 77 -1 Electron ' + secret, 'unsafe-integer']);
for (const [name, rows, reason] of invalid) {
  test('actual census rejects ' + name + ' through typed unknown without cache/wake', async () => {
    const h = make(rows);
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = await h.context.inspectAiDescendantProcessesByTab('saved-0', 'codex');
      assert.equal(value.status, 'unknown');
      assert.equal(value.error.code, 'AI_PROCESS_LOOKUP_FAILED');
      assert.equal(value.error.cause.code, 'ERR_PROCESS_CENSUS_INVALID');
      assert.equal(value.error.cause.reason, reason);
      assert.equal(value.error.cause.rowCount, rows.split('\n').filter(line => line.trim()).length);
      assert.ok(value.error.message.length < 120);
      assert.equal(value.matches.length, 0);
      assert.equal(h.context.processTreeSnapshotCache, null);
    }
    assert.equal(h.state.psCalls, 2);
    assert.equal(h.state.wakes, 0);
    assert.ok(h.state.events.some(event => event.includes('ERR_PROCESS_CENSUS_INVALID')));
    const failure = h.state.events.find(event => event.startsWith('[Perf:ProcessTreeSnapshotFailure] '));
    const diagnostic = JSON.parse(failure.slice(failure.indexOf('{')));
    assert.equal(diagnostic.censusReason, reason);
    assert.equal(diagnostic.censusRows, rows.split('\n').filter(line => line.trim()).length);
    assert.ok(h.state.events.every(event => !event.includes(secret)));
    await assert.rejects(h.context.getProcessTreeSnapshot({ forceFresh: true }), error =>
      error.code === 'ERR_PROCESS_CENSUS_INVALID' && error.reason === reason);
  });
}
test('actual valid full census filters Electron exactly as before and caches an empty provider subtree', async () => {
  const rows = [caller, shell, '10001 1000 10001 -1 Electron /bin/codex', '10002 1000 10002 -1 electron /bin/codex'];
  const h = make(rows.join('\n'));
  const snap = await h.context.getProcessTreeSnapshot();
  assert.equal(snap.source, 'spawn');
  assert.equal(snap.linesCount, 4);
  assert.deepEqual([...snap.processesByPid.keys()], [1000]);
  assert.equal((await h.context.inspectAiDescendantProcessesByTab('saved-0', 'codex')).status, 'absent');
  assert.equal(h.state.psCalls, 1);
  assert.equal(h.state.wakes, 1);
});
test('actual caller-only full census validates before Electron filtering and yields a valid empty snapshot', async () => {
  const h = make(caller);
  const snap = await h.context.getProcessTreeSnapshot();
  assert.equal(snap.processesByPid.size, 0);
  assert.equal(snap.linesCount, 1);
  assert.equal((await h.context.inspectAiDescendantProcessesByTab('saved-0', null)).status, 'absent');
  assert.equal(h.state.psCalls, 1);
});
test('actual valid full census keeps found provider, raw line count, whitespace, signed tpgid and safe integer bounds', async () => {
  const rows = ['  ' + caller, '', '  \t', shell + '  ', provider, '9007199254740991 0 0 -9007199254740991 /bin/other'];
  const h = make(rows.join('\n'));
  const result = await h.context.inspectAiDescendantProcessesByTab('saved-0', 'codex');
  assert.equal(result.status, 'found');
  assert.equal(result.matches[0].pid, 10000);
  assert.equal(h.context.processTreeSnapshotCache.linesCount, 4);
  assert.equal(h.context.processTreeSnapshotCache.processesByPid.get(Number.MAX_SAFE_INTEGER).tpgid, -Number.MAX_SAFE_INTEGER);
  h.state.time += 750;
  assert.equal((await h.context.getProcessTreeSnapshot()).source, 'spawn');
  assert.equal(h.state.psCalls, 2, 'existing TTL remains 750 ms');
});
test('actual failed force-fresh census cannot overwrite prior valid cache or publish a wake; ordinary retry after TTL succeeds', async () => {
  const h = make([caller, shell, provider].join('\n'));
  const prior = await h.context.getProcessTreeSnapshot();
  const cache = h.context.processTreeSnapshotCache;
  h.state.rows = secret;
  await assert.rejects(h.context.getProcessTreeSnapshot({ forceFresh: true }), { code: 'ERR_PROCESS_CENSUS_INVALID' });
  assert.equal(h.context.processTreeSnapshotCache, cache);
  assert.equal(h.state.wakes, 1);
  assert.equal((await h.context.getProcessTreeSnapshot()).source, 'cache', 'existing valid-cache policy is unchanged');
  h.state.time = prior.createdAt + 750;
  h.state.rows = [caller, shell].join('\n');
  assert.equal((await h.context.inspectAiDescendantProcessesByTab('saved-0', 'codex')).status, 'absent');
  assert.equal(h.state.psCalls, 3);
});
test('actual concurrent invalid census is one rejected flight; next ordinary caller gets a fresh attempt', async () => {
  const h = make(secret);
  const results = await Promise.all(Array.from({ length: 43 }, () => h.context.inspectAiDescendantProcessesByTab('saved-0', null)));
  assert.ok(results.every(result => result.status === 'unknown'));
  assert.equal(h.state.psCalls, 1);
  h.state.rows = [caller, shell, provider].join('\n');
  assert.equal((await h.context.inspectAiDescendantProcessesByTab('saved-0', 'codex')).status, 'found');
  assert.equal(h.state.psCalls, 2);
});
test('actual malformed/empty/mixed/caller-missing/duplicate census preserves all 43 shutdown recovery seeds and marks unknown', async () => {
  for (const rows of ['', secret, [caller, shell, secret].join('\n'), shell, [caller, caller, shell].join('\n')]) {
    const h = make(rows, 43);
    const seeds = new Map(h.ids.map((id, i) => [id, { engine: i % 2 ? 'claude' : 'codex', sessionId: 'seed-' + id }]));
    const result = await h.run(seeds, new Set(h.ids));
    assert.deepEqual(JSON.parse(JSON.stringify([...result.recoverableEntries])), [...seeds]);
    assert.deepEqual([...result.liveTabIds], [...h.ids]);
    assert.equal(h.state.psCalls, 1);
    assert.equal(h.state.reconcileCalls, 0);
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.wakes, 0);
    assert.ok(h.state.events.some(event => event.includes('"unknown":43') && event.includes('"absent":0')));
    assert.equal(h.context.processTreeSnapshotCache, null);
  }
});

}

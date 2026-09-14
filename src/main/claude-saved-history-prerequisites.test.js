'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');
const { SavedHistoryOperations } = require('./saved-history-operation');
const mainSource = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const decl = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
const quiet = { log() {}, warn() {}, error() {} };

function launchHarness(changeDuringProof = () => {}) {
  const written = [], phases = [], saved = new Map();
  const term = { write: input => written.push(input) };
  const ctx = vm.createContext({ console: quiet, path, srcMainDir: __dirname,
    assertKnownEmptySend: () => null,
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { runSeq: 3, isRunning: false }]]),
    claudeLaunchGenerationByTab: new Map(), claudePreclaimedCommandGenerations: new Map(),
    claudeState: new Map(), markClaudePendingJsonlOwner: () => true,
    terminalInputLineBuffers: new Map(), terminalInputEscapeStates: new Map(),
    inputRevision: 2, getTerminalInputRevision: () => ctx.inputRevision,
    getTerminalLifecycleGeneration: () => 'G:' + ctx.terminalCommandState.get('T').runSeq,
    buildAgentShellLaunchInput: command => command + '\r',
    withPtyWriteLock: async (_term, action) => action(),
    proveIdleShellForAgentLaunch: async () => {
      const proof = { terminalToken: term, runSeq: 3, lifecycleGeneration: 'G:3', inputRevision: 2 };
      changeDuringProof(ctx);
      return { allowed: true, shellWriteProof: proof };
    },
    beginClaudeLaunchGeneration: () => { ctx.claudeLaunchGenerationByTab.set('T', { generation: 'L' }); return 'L'; },
    clearClaudeLaunchGeneration: () => { ctx.claudeLaunchGenerationByTab.delete('T'); ctx.claudePreclaimedCommandGenerations.delete('T'); },
    rollbackClaudeShellLaunchClaims() {}, markClaudeShellLaunchStarted: (_tab, _sid, _reason, options) => {
      assert.equal(options.preclaimedLaunchId, 'L'); assert.equal(written.length, 1); return 'L';
    }, agentShellLaunchError: () => 'not-idle',
  });
  const capture = () => ({ terminalToken: ctx.terminals.get('T'), projectId: 'P', cwd: '/fixture',
    sessionId: 'S', toolType: 'claude', inputRevision: ctx.inputRevision,
    runSeq: ctx.terminalCommandState.get('T').runSeq, lifecycleGeneration: ctx.getTerminalLifecycleGeneration(),
    launchId: ctx.claudeLaunchGenerationByTab.get('T')?.generation || null,
    isRunning: ctx.terminalCommandState.get('T').isRunning });
  const registry = new SavedHistoryOperations({ db: { getAppState: key => saved.get(key), setAppState: (key, val) => saved.set(key, val) },
    runtime: { capture, inspectDraft: () => ({ hasDraft: false }) } });
  const key = registry.key('T', 'OP');
  const lease = { key, record: { tabId: 'T', operationId: 'OP', expectedSessionId: 'S',
    phase: 'resuming', state: 'running', revision: 1 }, scope: capture() };
  registry.leases.set(key, lease);
  ctx.require = () => ({ validateSavedHistoryResume: (req, phase, detail) => {
    phases.push(phase);
    assert.equal(req.tabId, 'T', 'caller cannot substitute a different tab');
    return registry.validateResume(req, phase, detail);
  } });
  vm.runInContext(['validateClaudeSavedHistoryLaunch', 'writeAgentLaunchCommandToIdleShell',
    'writeClaudeSavedHistoryResume'].map(decl).join('\n'), ctx);
  const run = () => ctx.writeClaudeSavedHistoryResume(term, { tabId: 'T', command: 'claude-c', sessionId: 'S',
    historyOperation: { tabId: 'forged', operationId: 'OP' } }, 'claude --resume S', 3);
  return { ctx, registry, lease, run, written, phases, term };
}

test('actual Claude write runs claim→claimed→durable write gate before one command; receipt names that launch', async () => {
  const h = launchHarness();
  const result = await h.run();
  assert.equal(result.launchWritten, true);
  assert.equal(result.launchId, 'L');
  assert.equal(h.lease.record.resume.launchId, 'L');
  assert.equal(h.lease.record.resume.status, 'write-pending');
  assert.deepEqual(h.phases, ['claim', 'claimed', 'write']);
  assert.deepEqual(h.written, ['claude --resume S\r']);
  assert.equal(h.ctx.terminalCommandState.get('T').runSeq, 4);
});

test('the actual claude-c branch routes historyOperation through the guarded writer, ordinary Resume stays supported', async () => {
  const h = launchHarness();
  Object.assign(h.ctx, { terminalProjects: new Map([['T', '/fixture']]), claudeState: new Map(),
    claudePendingPrompt: new Map(), getClaudeJsonlLiveOwner: () => null,
    getClaudeJsonlExternalOwner: async () => null, markClaudePendingJsonlOwner: () => true });
  vm.runInContext(decl('runClaudeCommandFromPayload'), h.ctx);
  const result = await h.ctx.runClaudeCommandFromPayload({}, { tabId: 'T', command: 'claude-c', sessionId: 'S',
    historyOperation: { operationId: 'OP' } }, { resumeJsonlPrepared: true });
  assert.equal(result.launchWritten, true); assert.equal(result.launchId, 'L');
  assert.equal(h.written.length, 1); assert.match(h.written[0], /claude.*--resume S/);
  assert.deepEqual(h.phases, ['claim', 'claimed', 'write']);
});

test('serialized Claude launch rejects an invalid operation before history preparation or launch admission', async () => {
  const h = launchHarness();
  h.lease.record.phase = 'completed';
  Object.assign(h.ctx, { aiLifecycleActionInflight: new Map(),
    runKeyedExclusive: async (_map, _key, action) => action(),
    admitAiLifecycleLaunch: () => assert.fail('cannot enter admission with a stale history lease'),
  });
  vm.runInContext(decl('runClaudeCommandSerialized'), h.ctx);
  await assert.rejects(() => h.ctx.runClaudeCommandSerialized({}, { tabId: 'T', command: 'claude-c', sessionId: 'S',
    historyOperation: { operationId: 'OP' } }), /history_operation_phase_mismatch/);
  assert.equal(h.written.length, 0);
});

for (const change of ['input', 'terminal', 'run', 'operation']) {
  test('actual Claude launch refuses changed ' + change + ' across awaited shell proof without bytes', async () => {
    const h = launchHarness(ctx => {
      if (change === 'input') ctx.inputRevision++;
      if (change === 'terminal') ctx.terminals.set('T', {});
      if (change === 'run') ctx.terminalCommandState.set('T', { runSeq: 9, isRunning: false });
    });
    if (change === 'operation') h.lease.record.phase = 'completed';
    await assert.rejects(h.run, /history_operation/);
    assert.deepEqual(h.written, []);
  });
}

test('actual guarded write failure rolls back only its unwritten launch and preserves monotonic run generation', async () => {
  const h = launchHarness();
  h.term.write = () => { throw Error('write refused'); };
  await assert.rejects(h.run, /write refused/);
  assert.equal(h.ctx.terminalCommandState.get('T').isRunning, false);
  assert.equal(h.ctx.terminalCommandState.get('T').runSeq, 4);
  assert.equal(h.ctx.claudeLaunchGenerationByTab.has('T'), false);
});

test('a failure after written Resume never reports launchWritten=false or deletes the live claim', async () => {
  const h = launchHarness();
  h.ctx.markClaudeShellLaunchStarted = () => { throw Error('publication failed'); };
  const result = await h.run();
  assert.equal(result.launchWritten, true); assert.equal(result.accepted, null);
  assert.equal(result.launchId, 'L'); assert.equal(h.written.length, 1);
  assert.equal(h.ctx.claudeLaunchGenerationByTab.has('T'), true);
});

test('first real OSC B consumes the Claude preclaim once, later B still advances', () => {
  const start = mainSource.indexOf('const claudePreclaim =');
  const end = mainSource.indexOf('applyTerminalCommandStartMeta(tabId, state);', start);
  const h = launchHarness();
  const helpers = require('./codex-runtime-contract');
  const ctx = h.ctx;
  ctx.advanceOscCommandGeneration = helpers.advanceOscCommandGeneration;
  ctx.tabId = 'T'; ctx.state = { runSeq: 4 };
  ctx.codexPreclaimedCommandGenerations = new Map(); ctx.codexLastRunCommandPayload = new Map();
  ctx.clearCodexServiceTierLaunchCandidate = () => {};
  ctx.claudePreclaimedCommandGenerations.set('T', { terminalToken: h.term, launchId: 'L', runSeq: 4 });
  ctx.claudeLaunchGenerationByTab.set('T', { generation: 'L' });
  const run = vm.runInContext('(function(){' + mainSource.slice(start, end) + '})', ctx);
  run(); assert.equal(ctx.state.runSeq, 4);
  run(); assert.equal(ctx.state.runSeq, 5);
});

test('saved-history Stop uses the actual Claude composer parser, not a Codex interpretation or stale committed screen', () => {
  const parse = require('./claude-composer-proof').parseClaudeComposerCurrentFrame;
  const ctx = vm.createContext({ resolveAiToolTypeForTab: () => 'claude',
    getHeadlessCodexDraftState: () => assert.fail('wrong provider'),
    claudeMissingPromptControlSurfaceActive: () => false,
    parseClaudeDraftFromVisibleSnapshot: parse,
    getHeadlessVisibleBufferSnapshot: () => ctx.snapshot,
    snapshot: { success: true, authoritativeFrameCommitted: true, writeSeq: 1, flushedSeq: 1,
      source: 'headless-main', baseY: 100, cursorY: 2, cursorX: 3,
      lines: [{ row: 100, text: 'answer' }, { row: 101, text: '────────────' },
        { row: 102, text: '❯ Try "write a test"', wrapped: false, promptSuffixAllDim: true },
        { row: 103, text: '' }] } });
  vm.runInContext(decl('inspectSavedHistoryDraft'), ctx);
  assert.equal(ctx.inspectSavedHistoryDraft('T').hasDraft, false);
  ctx.snapshot.lines[2] = { row: 102, text: '❯ hello', occupiedEndX: 7, wrapped: false };
  ctx.snapshot.cursorX = 7;
  assert.equal(ctx.inspectSavedHistoryDraft('T').hasDraft, true);
  ctx.snapshot.liveSynchronizedOutputOpen = true;
  assert.equal(ctx.inspectSavedHistoryDraft('T').hasDraft, null);
});

function filesHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-claude-prerequisites-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'private-claude');
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true }); });
  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const parents = new Map();
  const previousLoad = Module._load;
  delete require.cache[require.resolve('./ipc/claude-data')];
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle() {} } };
    return previousLoad.call(this, request, parent, isMain);
  };
  let data;
  try { data = require('./ipc/claude-data'); } finally { Module._load = previousLoad; }
  data.register({ projectManager: { db: { getSessionParent: id => parents.get(id) || null,
    saveForkMarker: () => ({ eventKey: 'fork' }), getParentSession: () => null,
    copyTimelineMetadataForFork: () => ({ notes: 0, rewindMarkers: 0 }),
    db: { transaction: fn => fn, prepare: () => ({ run() {} }) } } } });
  const filePath = path.join(projectDir, 'S.jsonl');
  const rows = [
    { uuid: 'U1', type: 'user', parentUuid: null, sessionId: 'S', cwd: '/fixture', message: { role: 'user', content: 'one' } },
    { uuid: 'A1', type: 'assistant', parentUuid: 'U1', sessionId: 'S', message: { role: 'assistant', content: [{ type: 'text', text: 'answer one' }] } },
    { uuid: 'U2', type: 'user', parentUuid: 'A1', sessionId: 'S', message: { role: 'user', content: 'two' } },
    { uuid: 'A2', type: 'assistant', parentUuid: 'U2', sessionId: 'S', message: { role: 'assistant', content: [{ type: 'text', text: 'answer two' }] } },
  ];
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const remove = extra => data._api.deleteRange({ sessionId: 'S', cwd: '/fixture', startUuid: 'U2', endUuid: 'U2', ...extra });
  return { dir, data, projectDir, filePath, rows, remove, parents };
}

for (const all of [false, true]) {
  test('actual Claude deleteRange commits exact revision and preserves same SID/fileDeleted contract all=' + all, async t => {
    const h = filesHarness(t);
    const loaded = await h.data._api.loadOperationSource({ sessionId: 'S', cwd: '/fixture' });
    let checked = 0;
    const result = await h.remove({ expectedRevision: loaded.revision, beforeCommit: source => {
      checked++; assert.equal(source.revision.token, loaded.revision.token);
    }, ...(all ? { startUuid: 'U1', endUuid: 'U2' } : {}) });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.committed, true); assert.equal(result.fileDeleted, all); assert.equal(checked, 1);
    if (!all) assert.deepEqual(fs.readFileSync(h.filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line).uuid), ['U1', 'A1']);
    else assert.equal(fs.existsSync(h.filePath), false);
  });
}

for (const kind of ['append', 'replace', 'owner', 'async-guard', 'topology']) {
  test('actual writer refuses ' + kind + ' at commit and leaves foreign changes intact', async t => {
    const h = filesHarness(t);
    const before = fs.readFileSync(h.filePath, 'utf8');
    let expected = before;
    const result = await h.remove({ beforeCommit: () => {
      if (kind === 'append') { expected += JSON.stringify({ type: 'custom-title', title: 'new' }) + '\n'; fs.writeFileSync(h.filePath, expected); }
      if (kind === 'replace') { const other = h.filePath + '.new'; fs.writeFileSync(other, before); fs.renameSync(other, h.filePath); }
      if (kind === 'owner') return { allowed: false, reason: 'owner_changed' };
      if (kind === 'async-guard') return Promise.resolve();
      if (kind === 'topology') { fs.writeFileSync(path.join(h.projectDir, 'P.jsonl'), before); h.parents.set('S', 'P'); }
    } });
    assert.equal(result.success, false); assert.equal(result.committed, false);
    assert.equal(fs.readFileSync(h.filePath, 'utf8'), expected);
    assert.equal(fs.readdirSync(h.projectDir).some(name => name.includes('.delete-')), false);
  });
}

test('expected revision detects edits before the writer starts and concurrent delete uses exclusive staging', async t => {
  const h = filesHarness(t);
  const loaded = await h.data._api.loadOperationSource({ sessionId: 'S', cwd: '/fixture' });
  fs.appendFileSync(h.filePath, JSON.stringify({ type: 'custom-title', title: 'new' }) + '\n');
  const stale = await h.remove({ expectedRevision: loaded.revision });
  assert.equal(stale.code, 'stale_transcript_revision');
  const pair = await Promise.all([h.remove({}), h.remove({})]);
  assert.equal(pair.filter(result => result.success).length, 1);
});

test('private roots select the correct same-ID file, fork only there and never follow a foreign symlink', async t => {
  const h = filesHarness(t);
  const paths = require('./claude-paths');
  const fakeDefault = path.join(h.dir, 'default-user', '.claude', 'projects', '-fixture');
  fs.mkdirSync(fakeDefault, { recursive: true });
  fs.writeFileSync(path.join(fakeDefault, 'S.jsonl'), 'different session under the same ID');
  fs.writeFileSync(path.join(fakeDefault, 'global-only.jsonl'), 'global only');
  const realHomedir = os.homedir;
  os.homedir = () => path.join(h.dir, 'default-user');
  try {
    assert.equal(h.data.findSessionFile('S', '/fixture').filePath, h.filePath);
    assert.equal(h.data.findSessionFile('global-only', '/fixture'), null);
  } finally { os.homedir = realHomedir; }
  const other = path.join(h.dir, 'foreign-projects');
  fs.mkdirSync(other);
  const foreignPath = path.join(other, 'foreign.jsonl');
  fs.writeFileSync(foreignPath, 'must stay unchanged');
  fs.symlinkSync(foreignPath, path.join(h.projectDir, 'foreign.jsonl'));
  assert.equal(h.data.findSessionFile('foreign', '/fixture'), null);
  assert.equal(h.data.findSessionFile('../../foreign-projects/foreign', '/fixture'), null);
  assert.equal(h.data.findSessionFile('S', '/fixture').filePath, h.filePath);
  const fork = await h.data._api.forkSessionFile({ sourceSessionId: 'S', cwd: '/fixture', skipChainResolve: true });
  assert.equal(fork.success, true, JSON.stringify(fork));
  assert.equal(fs.existsSync(path.join(h.projectDir, fork.newSessionId + '.jsonl')), true);
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), 'must stay unchanged');
  assert.equal(fs.readFileSync(path.join(fakeDefault, 'S.jsonl'), 'utf8'), 'different session under the same ID');
  assert.equal(paths.claudeConfigDir({}, '/fixture-user'), '/fixture-user/.claude');
  assert.throws(() => paths.claudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative' }), /absolute/);
  assert.equal(paths.claudeBridgeDir(), path.join(process.env.CLAUDE_CONFIG_DIR, 'bridge'));
  assert.equal(h.data.findSessionFile('not-in-private-scope', '/fixture'), null);
});

test('linked parent mutation is checked even when the selected physical child is unchanged', async t => {
  const h = filesHarness(t);
  const parentPath = path.join(h.projectDir, 'P.jsonl');
  fs.writeFileSync(parentPath, JSON.stringify({ uuid: 'parent-user', sessionId: 'P', type: 'user',
    message: { role: 'user', content: 'parent' } }) + '\n');
  h.parents.set('S', 'P');
  const source = await h.data._api.loadOperationSource({ sessionId: 'S', cwd: '/fixture' });
  assert.equal(source.sources.length, 2);
  const childBefore = fs.readFileSync(h.filePath, 'utf8');
  const result = await h.remove({ expectedRevision: source.revision, beforeCommit: () => {
    fs.appendFileSync(parentPath, JSON.stringify({ type: 'custom-title', title: 'new parent' }) + '\n');
  } });
  assert.equal(result.success, false); assert.equal(result.code, 'stale_transcript_revision');
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), childBefore);
});

test('unlink branch is guarded too: whole history cannot delete a file changed at commit', async t => {
  const h = filesHarness(t);
  let after;
  const result = await h.remove({ startUuid: 'U1', endUuid: 'U2', beforeCommit: () => {
    fs.appendFileSync(h.filePath, JSON.stringify({ type: 'custom-title', title: 'late edit' }) + '\n');
    after = fs.readFileSync(h.filePath, 'utf8');
  } });
  assert.equal(result.success, false); assert.equal(result.fileDeleted, undefined);
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), after);
});

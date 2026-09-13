'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { createClaudeBridgeTranscriptRecheck } = require('./claude-bridge-transcript-recheck');
const { createClaudeStartupProofSession } = require('./claude-startup-proof-session');
const { scanClaudeStartupSlashRecords } = require('./claude-startup-slash-proof');
const { createClaudeBridgeProcessStartTracker } = require('./ai-shell-launch');

const source = process.env.NOTED_TEST_BRIDGE_BASELINE === '1'
  ? require('node:child_process').execFileSync('git', ['show', 'HEAD:src/main/main.js'], { maxBuffer: 5000000 }).toString()
  : fs.readFileSync(require.resolve('./main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const sid = '419dc50c-8456-40dd-9176-a34a64e0c201';
const oldSid = 'c3032607-f08f-4e6f-b81d-9672d0817e91';
const next = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

async function harness(t, { duringWatch = false, fileAlreadyExists = false, stale = false, foreignCwd = false } = {}) {
  const now = Date.now();
  const filename = sid + '.json';
  const transcript = '/fixture/projects/project/' + sid + '.jsonl';
  const bridgePath = '/fixture/bridge/' + filename;
  const records = [
    { type: 'user', uuid: 'wrapper', sessionId: sid, timestamp: new Date(now).toISOString(),
      message: { content: '<command-name>/model</command-name><command-args>claude-opus-5[1m]</command-args>' } },
    { type: 'user', uuid: 'output', parentUuid: 'wrapper', sessionId: sid, timestamp: new Date(now).toISOString(),
      message: { content: '<local-command-stdout>Set model to `Opus 5 (1M context)` and saved as your default for new sessions</local-command-stdout>' } },
  ];
  const data = { session_id: sid, ppid: 42, transcript_path: transcript, cwd: foreignCwd ? '/foreign' : '/fixture',
    updated_at: Math.floor((now - (stale ? 700000 : 0)) / 1000), model: 'Opus 5 (1M context)' };
  const files = new Map([[bridgePath, JSON.stringify(data)]]);
  if (fileAlreadyExists) files.set(transcript, JSON.stringify(records));
  const watches = new Map();
  const events = [], subscriptions = [], logs = [];
  let bridgeMtime = 1, processFound = true;
  const fsImpl = {
    mkdirSync() {},
    readdirSync: () => [filename],
    statSync: target => { if (!files.has(target)) throw Error('ENOENT'); return { mtimeMs: bridgeMtime }; },
    readFileSync: target => files.get(target),
    existsSync: target => files.has(target),
    watch: (directory, options, callback) => {
      if (typeof options === 'function') callback = options;
      const watcher = new EventEmitter();
      watcher.close = () => watches.get(directory)?.delete(callback);
      if (!watches.has(directory)) watches.set(directory, new Set());
      watches.get(directory).add(callback);
      if (duringWatch && directory === path.dirname(transcript)) files.set(transcript, JSON.stringify(records));
      return watcher;
    },
  };
  const term = { pid: 20, write: () => assert.fail('discovery must not write to PTY') };
  const launch = { generation: 'launch-2', launchMode: 'fresh', at: now - 1000, pid: null };
  const context = vm.createContext({
    fs: fsImpl, path, bridgeDir: '/fixture/bridge',
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')), error() {} },
    bridgeFileMtimes: new Map(), bridgeStaleLogged: new Set(), BRIDGE_STALE_SECONDS: 600,
    bridgePidCache: new Map([[42, 'T']]), bridgeKnownSessions: new Map(), bridgeMetadata: new Map(),
    terminals: new Map([['T', term]]), terminalProjects: new Map([['T', '/fixture']]),
    terminalCommandState: new Map([['T', { runSeq: 1, isRunning: true }]]),
    claudeLaunchGenerationByTab: new Map([['T', launch]]), aiStoppingTabs: new Map(),
    getTerminalLifecycleGeneration: () => 'terminal:1',
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found' },
    inspectAiDescendantProcessesByTabCached: async () => ({ status: processFound ? 'found' : 'absent', matches: processFound ? [{ pid: 42 }] : [] }),
    resolveDirectoryRelation: async (a, b) => ({ related: a === b }),
    claudeBridgeProcessStarts: createClaudeBridgeProcessStartTracker(),
    ensureClaudeLaunchGeneration: () => launch.generation,
    ensureClaudeStartupSettingsInMain: () => {},
    captureClaudeFirstAcceptedBridge: () => null, pinClaudeFirstAcceptedBridge: () => false,
    normalizeAuthoritativeContextPct: () => null, commitAgentContextUsage: () => null,
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } },
    _webBroadcast() {}, tabWorkContext: { syncLinks: async () => {} },
    ensureClaudeBackgroundActivityObserver: async () => {}, claudeStartupIntents: new Map(),
    clearClaudePendingJsonlOwner() {}, emitClaudeTuiReadyFromVisibleBuffer: async () => {},
    projectManager: { db: { saveSessionLink() {} } },
    bridgeWatcher: null, bridgePollInterval: null, bridgeTranscriptRechecks: null,
    setInterval: () => 1, clearInterval() {},
    createClaudeBridgeTranscriptRecheck: options => createClaudeBridgeTranscriptRecheck({ ...options, fsImpl, log: { log() {}, warn() {} } }),
  });
  const proof = createClaudeStartupProofSession({
    subscribe: async payload => { subscriptions.push(payload); return { success: true }; },
    unsubscribe: async () => ({ success: true }),
    resolveBinding: () => ({ sessionId: context.bridgeKnownSessions.get('T') || oldSid, cwd: '/fixture' }),
    currentGeneration: () => context.claudeLaunchGenerationByTab.get('T')?.generation,
    readProof: request => {
      const result = scanClaudeStartupSlashRecords(request.sessionId === sid && files.has(transcript) ? records : [], request.command, request);
      return { ...result, outcome: result.success ? 'found' : 'unresolved' };
    }, log: { log() {}, warn() {} },
  });
  context._notifyClaudeSession = (_tab, sessionId) => proof.handleBindingChanged('T', { sessionId, cwd: '/fixture' });
  let result = null;
  proof.wait({ tabId: 'T', generation: launch.generation, command: '/model claude-opus-5[1m]', afterMs: now - 500 })
    .then(value => { result = value; });
  vm.runInContext(declaration('startSessionBridge') + '\n' + declaration('stopSessionBridge'), context);
  context.startSessionBridge();
  await next();
  t.after(() => { context.stopSessionBridge(); proof.cancel('T', null, 'test-end'); });
  const emit = (directory, basename) => { for (const callback of [...(watches.get(directory) || [])]) callback('rename', basename); };
  return { context, events, subscriptions, watches, launch, logs, result: () => result,
    materialize: async () => { files.set(transcript, JSON.stringify(records)); emit(path.dirname(transcript), path.basename(transcript)); await next(); },
    rewriteBridge: () => { bridgeMtime++; },
    retireProcess: () => { processFound = false; },
  };
}

test('new bridge before JSONL rebinds the exact pending startup proof without a second command', async t => {
  const h = await harness(t);
  assert.equal(h.context.bridgeKnownSessions.has('T'), false, 'no writer invented from a missing file');
  assert.equal(h.result(), null);
  await h.materialize();
  assert.equal(h.context.bridgeKnownSessions.get('T'), sid);
  assert.equal(h.result()?.outcome, 'found', 'read the actual wrapper/stdout in the new session');
  assert.equal(h.result()?.stdoutUuid, 'output');
  assert.equal(h.events.filter(event => event.channel === 'claude:session-detected').length, 1);
  assert.deepEqual(h.subscriptions.map(item => item.sessionId), [oldSid, sid]);
  await h.materialize();
  assert.equal(h.events.filter(event => event.channel === 'claude:session-detected').length, 1);
});

test('file appearance between the original stat and watch admission is not lost', async t => {
  const h = await harness(t, { duringWatch: true });
  assert.equal(h.context.bridgeKnownSessions.get('T'), sid);
  assert.equal(h.result()?.outcome, 'found');
});

for (const [name, mutate] of [
  ['replacement terminal', h => h.context.terminals.set('T', {})],
  ['replacement launch', h => h.context.claudeLaunchGenerationByTab.set('T', { generation: 'new' })],
  ['new run', h => h.context.terminalCommandState.get('T').runSeq++],
  ['changed cwd', h => h.context.terminalProjects.set('T', '/other-project')],
  ['Stop', h => h.context.aiStoppingTabs.set('T', {})],
  ['exited process', h => h.retireProcess()],
  ['rewritten bridge', h => h.rewriteBridge()],
]) test('late file appearance cannot adopt after ' + name, async t => {
  const h = await harness(t); mutate(h); await h.materialize();
  assert.equal(h.context.bridgeKnownSessions.has('T'), false);
  assert.equal(h.events.some(event => event.channel === 'claude:session-detected'), false);
});

for (const options of [{ stale: true }, { foreignCwd: true }]) test('stale or foreign candidate is not promoted: ' + JSON.stringify(options), async t => {
  const h = await harness(t, options); await h.materialize();
  assert.equal(h.context.bridgeKnownSessions.has('T'), false);
});

test('ordinary bridge with an existing transcript keeps its existing path', async t => {
  const h = await harness(t, { fileAlreadyExists: true });
  assert.equal(h.context.bridgeKnownSessions.get('T'), sid);
  assert.equal(h.result()?.outcome, 'found');
});

test('real filesystem creation wakes once without rewriting the bridge or polling', async t => {
  const root = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'noted-bridge-appearance-'));
  const transcriptPath = path.join(root, 'new-session.jsonl');
  let count = 0, complete;
  const appeared = new Promise(resolve => { complete = resolve; });
  const watcher = createClaudeBridgeTranscriptRecheck({
    onReady: entry => { count++; complete(entry); }, log: { log() {}, warn() {} },
  });
  t.after(async () => { watcher.dispose(); await fs.promises.rm(root, { recursive: true, force: true }); });
  watcher.defer({ filename: 'bridge.json', transcriptPath, tabId: 'T', sessionId: 'new-session', isCurrent: () => true });
  await fs.promises.writeFile(transcriptPath, '{"type":"mode"}\n');
  const deadline = setTimeout(() => complete(null), 2000);
  t.after(() => clearTimeout(deadline));
  const entry = await appeared;
  assert.equal(entry?.transcriptPath, transcriptPath);
  await fs.promises.appendFile(transcriptPath, '{"type":"user"}\n');
  await next();
  assert.equal(count, 1);
});

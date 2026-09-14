'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const esbuild = require('esbuild');
const http = require('node:http');
const { SavedHistoryOperations, selectSavedHistoryTarget } = require('./saved-history-operation');
const { ConversationOwners } = require('./conversation-owner');
const { InboxSavedHistoryOperations } = require('./inbox-saved-history-operation');

// No provider process or user session: the real writer sees only this test home.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-history-api-'));
process.env.CODEX_HOME = fixtureHome;
const { _api: codex } = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');
const { hashFileSegment } = require('./codex-virtual-transcript');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { createCodexLaunchPendingResult } = require('./codex-runtime-contract');
codex.setCodexUsageStateStoreForTests({ db: { transaction: fn => fn }, saveSessionForkEvent: () => ({ eventKey: 'fixture-event' }) });
test.after(() => fs.promises.rm(fixtureHome, { recursive: true, force: true }));
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

const richText = '<saved_prompt name="Rules" context-update-id="update-exact">Keep exact</saved_prompt>\n'
  + '<context_file name="Design" path="/fixture/design.md" role="source" sha256="' + 'a'.repeat(64) + '" bytes="4">plan</context_file>\n'
  + '<pasted_content>' + 'pasted text '.repeat(100) + '</pasted_content>\nordinary [Image #1]';

async function makeSource({ busy = false, onlyTurn = false } = {}) {
  const sessionId = crypto.randomUUID();
  const dir = path.join(fixtureHome, 'sessions', '2026', '09', '13');
  await fs.promises.mkdir(dir, { recursive: true });
  const imagePath = path.join(fixtureHome, sessionId + '.png');
  await fs.promises.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cV+8AAAAASUVORK5CYII=', 'base64'));
  const records = [{ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: '/fixture' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-luna', effort: 'medium' } }];
  for (const text of onlyTurn ? [richText] : ['keep', richText, 'later']) {
    records.push({ type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: text,
        ...(text === richText ? { local_images: [imagePath] } : {}) } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } },
      { type: 'event_msg', payload: { type: 'task_complete' } });
  }
  if (busy) records.pop(); // Last task_started has no task_complete at Stop.
  records.forEach((record, index) => { record.timestamp = new Date(1789257600000 + index * 1000).toISOString(); });
  const filePath = path.join(dir, 'rollout-2026-09-13T00-00-00-' + sessionId + '.jsonl');
  await fs.promises.writeFile(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const loaded = await codex.loadSessionRecords(sessionId, '/fixture');
  return { sessionId, filePath, imagePath, bytes: await fs.promises.readFile(filePath),
    targetUuid: codex.buildCodexTimeline(loaded.records, sessionId).find(e => e.content === richText).uuid };
}

function extractIf(file, condition) {
  const source = read(file);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(tree) === condition) found = node.getText(tree);
    if (!found) ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, condition);
  return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

let scenarioBundle;
test.before(async () => {
  const stubs = {
    '../store/useUIStore': 'export const useUIStore = {getState:()=>fixture.ui};',
    '../store/useWorkspaceStore': 'export const useWorkspaceStore = {getState:()=>fixture.workspace};',
    './codexLaunch': 'export const getCodexHistoryMutationSettingsProof=()=>null; export const buildCodexRunPayload=x=>x; export const buildCodexHistoryMutationResumePayload=x=>x;',
    './claudePtyActions': 'export const stopClaudePtyProcess=()=>{throw Error("unexpected Claude");};',
  };
  const output = await esbuild.build({ entryPoints: [path.join(root, 'src/renderer/utils/historyRewriteRewind.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', plugins: [{ name: 'fixture-boundaries', setup(build) {
      build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : null);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path] }));
    } }] });
  scenarioBundle = output.outputFiles[0].text;
});

async function harness(options = {}) {
  let source = await makeSource(options);
  let lineageEvent = null;
  if (options.composite) {
    const parent = source;
    const childId = crypto.randomUUID();
    const filePath = path.join(path.dirname(parent.filePath), 'rollout-2026-09-13T00-01-00-' + childId + '.jsonl');
    const records = [{ type: 'session_meta', timestamp: '2026-09-13T00:01:00Z', payload: {
      id: childId, cwd: '/fixture', forked_from_id: parent.sessionId, history_mode: 'paginated',
    } }];
    await fs.promises.writeFile(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const childStat = await fs.promises.stat(filePath);
    lineageEvent = { eventKey: 'fixture-fork', eventType: 'fork', provider: 'codex',
      sessionId: childId, childSessionId: childId, sourceSessionId: parent.sessionId, snapshotComplete: true,
      isDirect: true, origin: 'app', lineageManifest: buildCodexForkLineageManifest({
        sourceSessionId: parent.sessionId, childSessionId: childId,
        sourceSegments: [{ physicalSessionId: parent.sessionId, fromByte: 0, toByte: parent.bytes.length,
          startLine: 0, endLine: 17, prefixDigest: (await hashFileSegment(parent.filePath, 0, parent.bytes.length)).sha256 }],
        childTailStart: { byteOffset: childStat.size, line: 1,
          prefixDigest: (await hashFileSegment(filePath, 0, childStat.size)).sha256 },
      }) };
    source = { ...parent, parent, sessionId: childId, filePath, bytes: await fs.promises.readFile(filePath) };
  }
  const forkEvents = new Map();
  codex.setCodexUsageStateStoreForTests({ db: { transaction: fn => fn }, saveSessionForkEvent: input => {
    if (options.failMetadata) throw Error('fixture metadata commit failure');
    const event = { ...clone(input), eventKey: 'fixture-event:' + input.childSessionId,
      eventType: 'fork', sessionId: input.childSessionId };
    forkEvents.set(input.childSessionId, event);
    return event;
  } });
  const events = [];
  const rows = new Map();
  const db = { getAppState: key => rows.has(key) ? clone(rows.get(key)) : null,
    setAppState: (key, value) => rows.set(key, clone(value)), db: { transaction: fn => fn } };
  const state = { terminalToken: {}, projectId: 'project', cwd: '/fixture', lifecycleGeneration: 'life-1',
    runSeq: 3, inputRevision: 7, launchId: options.stopped ? null : 'old-launch',
    sessionId: source.sessionId, toolType: 'codex', isRunning: !options.stopped, stopping: false };
  const tab = { id: 'tab-A', cwd: '/fixture' };
  let registry, settled;
  const done = new Promise(resolve => { settled = resolve; });
  const actualTranscript = new SessionTranscriptService({ getMainWindow: () => null,
    webBroadcast: () => {}, codexData: { _api: codex }, claudeData: null,
    sessionHistoryStore: { getSessionHistoryEvents: sid => [
      ...(sid === source.sessionId && lineageEvent ? [lineageEvent] : []),
      ...(forkEvents.has(sid) ? [clone(forkEvents.get(sid))] : []),
    ] },
  });
  codex.setCodexOperationSourceResolver(args => actualTranscript.loadCodexOperationSource(args));
  const transcript = {
    loadCodexOperationSource: args => actualTranscript.loadCodexOperationSource(args),
    getHistory: args => actualTranscript.getHistory(args),
    getTimeline: async ({ sessionId }) => {
      const result = await actualTranscript.getTimeline({ sessionId, toolType: 'codex', cwd: '/fixture', tabId: 'tab-A' });
      if (options.afterTimeline) await options.afterTimeline(state, result.entries);
      return result;
    },
  };
  const ui = { historyPromptDrafts: { 'tab-A': 'unrelated desktop draft' }, historyPromptDraftChips: {}, historyPromptDraftImages: {},
    setHistoryPromptDraft: (...args) => events.push(['desktop-draft-write', ...args]) };
  const workspace = { setCodexSessionId: async (_tab, sessionId, _reason, settings) => {
    events.push(['adopt', sessionId, settings]);
    if (options.failAdopt) throw Error('binding transaction failed');
    if (settings.historyOperation) registry.commitCodexBinding({ ...settings.historyOperation, sessionId }, () => { state.sessionId = sessionId; });
    else state.sessionId = sessionId;
    return true;
  } };
  const ipc = { invoke: async (channel, args) => {
    events.push([channel, args]);
    if (channel === 'saved-history:get') return registry.read(args.tabId, args.operationId);
    if (channel === 'saved-history:step') return registry.step(args);
    if (channel === 'agent-transcript:get-timeline') return transcript.getTimeline(args);
    if (channel === 'codex:delete-range') return codex.deleteCodexRange(args);
    if (channel === 'terminal:getCommandState') return { isRunning: state.isRunning, processLookupUnknown: !!options.lookupUnknown };
    if (channel === 'terminal:stop-ai-process') {
      if (options.beforeStop) await options.beforeStop(state, source);
      registry.validateStop(args.authority);
      state.isRunning = false; state.launchId = null;
      events.push(['signal', 'SIGTERM']);
      return { success: true };
    }
    if (channel === 'codex:reconcile-native-rewind-before-history-rewrite') return { success: !options.pendingNative, error: 'native unresolved' };
    if (channel === 'codex:run-command') {
      if (options.beforeResume) options.beforeResume(state);
      registry.validateResume(args.historyOperation, 'claim', { sessionId: args.sessionId });
      state.runSeq++; state.lifecycleGeneration = 'life-' + state.runSeq; state.isRunning = true; state.launchId = 'resume-exact';
      registry.validateResume(args.historyOperation, 'claimed', { sessionId: args.sessionId, launchId: state.launchId });
      if (options.beforeLaunchWrite) options.beforeLaunchWrite(state);
      registry.validateResume(args.historyOperation, 'write', { sessionId: args.sessionId, launchId: state.launchId });
      events.push(['launch-write', args.sessionId]);
      return { ...createCodexLaunchPendingResult({ tabId: 'tab-A', launchId: state.launchId,
        command: 'codex-c', resumeSourceSessionId: args.sessionId }), lifecycleGeneration: state.lifecycleGeneration };
    }
    throw Error('unexpected channel ' + channel);
  } };
  const context = vm.createContext({ console: { log() {}, warn() {} }, fixture: { ui, workspace },
    window: { require: () => ({ ipcRenderer: ipc }), dispatchEvent: event => events.push(['event', event.type]) },
    CustomEvent: class { constructor(type) { this.type = type; } }, module: { exports: {} }, exports: {},
    setTimeout, clearTimeout, crypto: crypto.webcrypto });
  vm.runInContext(scenarioBundle, context);
  context.executeHistoryRewriteRewindScenario = context.module.exports.executeHistoryRewriteRewindScenario;
  context.executeHistoryDeleteIterationScenario = context.module.exports.executeHistoryDeleteIterationScenario;
  context.ipcRenderer = ipc;
  context.describeAgentTab = () => ({ tab, toolType: 'codex', sessionId: state.sessionId });
  context.ensureProjectWorkspace = async () => {};
  context.reply = (_ok, data) => data;
  const bridgeBody = extractIf('src/renderer/App.tsx', "action === 'savedHistoryOperationScenario'");
  const bridge = vm.runInContext('(async (action, payload) => {' + bridgeBody + '})', context);
  const owner = new ConversationOwners({ db, instanceId: 'fixture', capture: () => ({ known: true, provider: 'codex',
    sessionId: state.sessionId, projectId: state.projectId, cwd: state.cwd, instanceId: 'fixture', terminalId: 'pty', launchId: state.launchId }) });
  registry = new SavedHistoryOperations({ db, transcript, runtime: { owner,
    capture: () => ({ ...state }), inspectDraft: () => ({ hasDraft: options.foreignDraft ?? false }),
  }, resolveSession: async () => ({ sessionId: state.sessionId, toolType: 'codex', cwd: '/fixture' }),
  dispatch: async (action, payload) => {
    events.push(['dispatch', action]);
    const execution = bridge(action, payload).finally(settled);
    if (options.bridgeTimeout) {
      execution.catch(() => {});
      throw Object.assign(Error('simulated network reply lost'), { code: 'bridge_timeout' });
    }
    return execution;
  }, deleteRange: async args => {
    if (options.beforeMutation) await options.beforeMutation(state, source);
    return codex.deleteCodexRange(args);
  }, buildTimeline: codex.buildCodexTimeline, broadcast: (_tab, data) => events.push(['receipt', data.operation.phase]) });

  // The real HTTP route, readBody and sendJson, without starting Electron/API.
  const web = read('src/main/web-server.js');
  const inboxOptions = { db, executor: registry, transcript, reservedTabId: () => 'tab-A',
    getReceipt: () => options.expiredAudit ? null : { surface: 'inbox', runId: 'run-A', operationKey: 'inbox:run-A',
      provider: 'codex', state: options.unconfirmedAudit ? 'audit-pending' : 'confirmed', handoffId: 'external-run:run-A',
      tabId: 'tab-A', attemptId: 'attempt-A', auditIdentity: { provider: 'codex', attemptId: 'attempt-A',
        sessionId: source.parent?.sessionId || source.sessionId, entryUuid: source.targetUuid } },
    readNativeState: () => ({ pending: !!options.pendingNative }),
    ensureOpen: async () => { events.push(['restore-only']); return { descriptor: {} }; },
    resolveSession: async () => ({ toolType: 'codex', sessionId: state.sessionId, cwd: '/fixture' }),
    cleanup: { claim: () => ({ runId: 'run-A', validate: () => { if(options.inboxOwnerChanged)throw Error('inbox_history_owner_changed'); },
      release: operation => events.push(['cleanup-release', operation?.success]) }) } };
  const inbox = new InboxSavedHistoryOperations(inboxOptions);
  const routeSource = options.inbox
    ? web.slice(web.indexOf('  // Additive saved-history ingress.'), web.indexOf("  m = parsed.pathname.match(/^\\/api\\/inbox\\/runs\\/([^/]+)\\/rewind$/)"))
    : web.slice(web.indexOf('  // Additive saved-history scenario.'), web.indexOf('  // Native timeline rewind/backtrack'));
  const routeContext = vm.createContext({ savedHistoryOperations: registry, inboxSavedHistoryOperations: inbox,
    agentSendReceiptStartupReady: Promise.resolve(),
    decId: decodeURIComponent,
    readBody: req => new Promise((resolve, reject) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    }),
    sendJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
  });
  const route = vm.runInContext('(async (req, res, parsed) => {let m; ' + routeSource + '})', routeContext);
  const server = http.createServer((req, res) => route(req, res, { pathname: new URL(req.url, 'http://fixture').pathname }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + (options.inbox
    ? '/api/inbox/runs/run-A/history-operations' : '/api/terminal-tabs/tab-A/history-operations');
  const request = { operationId: crypto.randomUUID(), kind: options.kind || 'rewind', expectedSessionId: source.sessionId, targetUuid: source.targetUuid };
  if (options.inbox) { request.targetEntryUuid = request.targetUuid; request.conversationKey = 'conversation-A'; delete request.targetUuid; }
  if (options.composite) {
    const timeline = await transcript.getTimeline({ sessionId: source.sessionId });
    assert.equal(timeline.success, true, JSON.stringify(timeline));
    request.targetEntryRef = timeline.entries.find(e => e.uuid === source.targetUuid).entryRef;
    request.expectedContentRevision = timeline.contentRevision;
  }
  const post = async (body = request) => {
    const r = await fetch(base, { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  const close = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  return { source, events, state, registry, request, post, done, close, db, transcript, forkEvents, inbox, inboxOptions,
    get: async () => { const r = await fetch(base + '/' + request.operationId); return { status: r.status, ...(await r.json()) }; } };
}

for (const extra of [{}, {kind:'delete'}, {stopped:true}, {busy:true}, {composite:true}]) {
  test('Inbox HTTP -> exact audit -> SAME actual App/executor/JSONL '+JSON.stringify(extra),async()=>{
    const options={inbox:true,...extra}; const h=await harness(options);
    try {
      assert.equal((await h.post()).status,202);await h.done;
      const result=await h.get();assert.equal(result.status,200,JSON.stringify(result));
      assert.equal(result.operation.operationId,h.request.operationId);
      assert.equal(result.operation.origin.audit.attemptId,'attempt-A');
      assert.equal(result.cleanup.state,'released');
      assert.equal(h.events.filter(e=>e[0]==='dispatch').length,1);
      assert.equal(h.events.filter(e=>e[0]==='launch-write').length,1);
      options.expiredAudit=true;
      assert.equal((await h.post()).idempotent,true,'replay survives send receipt TTL without dispatch');
      const reopened=new InboxSavedHistoryOperations({...h.inboxOptions,executor:new SavedHistoryOperations({db:h.db})});
      assert.equal(reopened.read('run-A',h.request.operationId).operation.bindingCommitted,true);
      assert.equal((await reopened.accept('run-A',h.request)).idempotent,true);
      assert.equal((await h.post({...h.request,kind:extra.kind==='delete'?'rewind':'delete'})).status,409);
    }finally{await h.close();}
  });
}

for(const negative of ['unconfirmedAudit','pendingNative','wrongTarget','ownerBeforeWrite'])test('Inbox exact guard '+negative,async()=>{
  const options={inbox:true,[negative]:true};
  if(negative==='ownerBeforeWrite')options.beforeLaunchWrite=()=>{options.inboxOwnerChanged=true;};
  const h=await harness(options);
  try{
    const r=await h.post(negative==='wrongTarget'?{...h.request,targetEntryUuid:'wrong'}:h.request);
    if(negative==='ownerBeforeWrite'){await h.done;assert.equal((await h.get()).status,409);}
    else{assert.equal(r.status,409);assert.equal(h.events.some(e=>e[0]==='dispatch'),false);}
    assert.equal(h.events.some(e=>e[0]==='launch-write'),false);
  }finally{await h.close();}
});

for (const initial of ['idle', 'busy', 'stopped']) {
  test('HTTP -> actual App bridge -> shared Rewind -> real JSONL writer: ' + initial, async () => {
    const h = await harness({ stopped: initial === 'stopped', busy: initial === 'busy' });
    try {
      const accepted = await h.post();
      assert.equal(accepted.status, 202);
      await h.done;
      const reply = await h.get();
      assert.equal(reply.status, 200, JSON.stringify(reply));
      assert.equal(reply.operation.bindingCommitted, true);
      assert.equal(reply.operation.resume.status, 'starting', 'launch is not falsely called writer ready');
      assert.equal(reply.operation.resume.accepted, null);
      assert.equal(reply.operation.resume.launchWritten, true);
      assert.ok(reply.operation.draft.chips.some(chip => chip.contextUpdateId === 'update-exact'));
      assert.ok(reply.operation.draft.chips.some(chip => chip.filePath === '/fixture/design.md'));
      assert.equal(reply.operation.draft.chips.find(chip => chip.filePath === '/fixture/design.md').sha256, 'a'.repeat(64));
      assert.ok(reply.operation.draft.chips.some(chip => chip.kind === 'paste'));
      assert.equal(reply.operation.draft.imagePaths[0]?.path, h.source.imagePath);
      assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 1);
      assert.equal(h.events.some(e => e[0] === 'desktop-draft-write'), false);
      assert.equal(h.events.some(e => /paste|send-prompt|rewind-native/.test(e[0])), false);
      assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
      const child = await codex.loadSessionRecords(reply.operation.newSessionId, '/fixture');
      assert.deepEqual(codex.buildCodexTimeline(child.records, reply.operation.newSessionId).filter(e => e.type === 'user').map(e => e.content), ['keep']);
      const replay = await h.post();
      assert.equal(replay.operation.idempotent, true);
      assert.equal(h.events.filter(e => e[0] === 'dispatch').length, 1);
    } finally { await h.close(); }
  });
}

test('actual saved Rewind of the ONLY turn completes and reopens as a valid empty materialized conversation', async () => {
  const h = await harness({ onlyTurn: true });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, true, JSON.stringify(operation));
    assert.equal(operation.removedUsers, 1);
    const event = h.forkEvents.get(operation.newSessionId);
    assert.equal(event.forkMode, 'history_delete'); assert.deepEqual(event.entryUuids, []);
    assert.equal(event.snapshotComplete, true);
    const persisted = clone(event);
    const reopened = new SessionTranscriptService({ getMainWindow: () => null,
      codexData: { _api: codex }, sessionHistoryStore: { getSessionHistoryEvents: () => [persisted] } });
    const target = { tabId: 'tab-A', toolType: 'codex', sessionId: operation.newSessionId, cwd: '/fixture' };
    const timeline = await reopened.getTimeline(target);
    assert.equal(timeline.success, true, JSON.stringify(timeline)); assert.deepEqual(timeline.entries, []);
    for (const dehydrate of [false, true]) {
      const history = await reopened.getHistory({ ...target, dehydrate });
      assert.equal(history.success, true, JSON.stringify(history));
      assert.equal(history.entries.some(e => e.role === 'user' || e.role === 'assistant'), false);
    }
    const search = await reopened.searchHistory({ ...target, query: 'pas-' });
    assert.equal(search.success, true, JSON.stringify(search)); assert.equal(search.total, 0);
    assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
    assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 1);
    assert.equal(operation.draft.authoring.version, 1);
  } finally { await h.close(); }
});

test('Delete uses the same executor but removes one semantic user iteration, not the tail', async () => {
  const h = await harness({ kind: 'delete' });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, true, JSON.stringify(operation));
    assert.equal(operation.draft, null);
    const child = await codex.loadSessionRecords(operation.newSessionId, '/fixture');
    assert.deepEqual(codex.buildCodexTimeline(child.records, operation.newSessionId).filter(e => e.type === 'user').map(e => e.content), ['keep', 'later']);
  } finally { await h.close(); }
});

for (const [name, options] of Object.entries({
  foreignDraft: { foreignDraft: true },
  inputChanged: { beforeStop: state => { state.inputRevision++; } },
  sessionChanged: { beforeStop: state => { state.sessionId = 'other'; } },
  generationChanged: { beforeMutation: state => { state.runSeq++; } },
  unknownProcess: { stopped: true, lookupUnknown: true },
  pendingNative: { pendingNative: true },
  metadataFailure: { failMetadata: true },
})) {
  test('no mutation or unintended launch on ' + name, async () => {
    const h = await harness(options);
    try {
      await h.post(); await h.done;
      const reply = await h.get();
      assert.equal(reply.status, 409, JSON.stringify(reply));
      assert.equal(reply.operation.historyMutated, false);
      assert.equal(reply.operation.bindingCommitted, false);
      assert.equal(h.state.sessionId, name === 'sessionChanged' ? 'other' : h.source.sessionId);
      assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
      if (!['pendingNative', 'metadataFailure'].includes(name)) assert.equal(h.events.some(e => e[0] === 'launch-write'), false);
    } finally { await h.close(); }
  });
}

test('adoption failure reports preserved child evidence, keeps source binding and restores source once', async () => {
  const h = await harness({ failAdopt: true });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, false);
    assert.equal(operation.historyMutated, true);
    assert.equal(operation.bindingCommitted, false);
    assert.equal(h.state.sessionId, h.source.sessionId);
    assert.ok(operation.draft);
    assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 1);
  } finally { await h.close(); }
});

test('late input before Resume write preserves committed history but prevents launch', async () => {
  const h = await harness({ beforeLaunchWrite: state => { state.inputRevision++; } });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, false);
    assert.equal(operation.bindingCommitted, true);
    assert.ok(operation.draft);
    assert.equal(h.events.some(e => e[0] === 'launch-write'), false);
  } finally { await h.close(); }
});

test('composite target requires the exact physical tuple and revision, never text/index', () => {
  const entry = { uuid: 'u1', type: 'user', sessionId: 'physical', sourceIdentity: 'offset-1', content: 'same' };
  const timeline = { success: true, composite: true, contentRevision: 'revision-1', entries: [entry] };
  const good = { targetUuid: 'u1', targetEntryRef: { rawUuid: 'u1', physicalSessionId: 'physical', sourceIdentity: 'offset-1' }, expectedContentRevision: 'revision-1' };
  assert.equal(selectSavedHistoryTarget(timeline, good), entry);
  for (const bad of [{ ...good, expectedContentRevision: 'old' }, { ...good, targetEntryRef: null },
    { ...good, targetEntryRef: { ...good.targetEntryRef, physicalSessionId: 'other' } },
    { ...good, targetSourceIdentity: 'offset-2' }]) assert.throws(() => selectSavedHistoryTarget(timeline, bad));
});

test('receipt reopen and request mismatch never dispatch a second destructive operation', async () => {
  const h = await harness();
  try {
    await h.post(); await h.done;
    const reopened = new SavedHistoryOperations({ db: h.db });
    assert.equal(reopened.read('tab-A', h.request.operationId).success, true);
    assert.equal(reopened.accept('tab-A', h.request).idempotent, true);
    assert.throws(() => reopened.accept('tab-A', { ...h.request, kind: 'delete' }), /request_mismatch/);
  } finally { await h.close(); }
});

test('bridge timeout retains the same receipt; late completion does not execute Rewind again', async () => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const atStop = new Promise(resolve => { entered = resolve; });
  const h = await harness({ bridgeTimeout: true, beforeStop: async () => { entered(); await held; } });
  try {
    await h.post(); await atStop;
    const pending = await h.get();
    assert.equal(pending.status, 202);
    assert.equal((await h.post()).operation.idempotent, true);
    const reopened = new SavedHistoryOperations({ db: h.db });
    assert.equal(reopened.read('tab-A', h.request.operationId).state, 'outcome-unknown');
    assert.throws(() => reopened.accept('tab-A', { ...h.request, operationId: 'new-request' }), /history_operation_pending/);
    release(); await h.done;
    assert.equal((await h.get()).operation.success, true);
    assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 1);
  } finally { release(); await h.close(); }
});

test('changed physical target after Stop is not silently rewritten from a newer snapshot', async () => {
  const h = await harness({ beforeMutation: async (_state, source) => {
    const bytes = await fs.promises.readFile(source.filePath, 'utf8');
    await fs.promises.writeFile(source.filePath, bytes.replaceAll('ordinary', 'changed!'));
    codex.invalidateJsonlCache(source.filePath);
  } });
  try {
    await h.post(); await h.done;
    const result = await h.get();
    assert.equal(result.status, 409);
    assert.equal(result.operation.historyMutated, false);
    assert.equal(result.operation.error, 'history_target_changed');
  } finally { await h.close(); }
});

test('inherited composite user uses the physical target and materializes one prefix, without provider hints', async () => {
  const h = await harness({ composite: true });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, true, JSON.stringify(operation));
    const child = await codex.loadSessionRecords(operation.newSessionId, '/fixture');
    assert.deepEqual(codex.buildCodexTimeline(child.records, operation.newSessionId).filter(e => e.type === 'user').map(e => e.content), ['keep']);
    assert.equal(child.records[0].payload.history_mode, 'legacy');
    assert.deepEqual(await fs.promises.readFile(h.source.parent.filePath), h.source.parent.bytes);
  } finally { await h.close(); }
});

test('changed frozen ancestor fails before child write or adoption', async () => {
  const h = await harness({ composite: true, beforeMutation: async (_state, source) => {
    await fs.promises.writeFile(source.parent.filePath, source.parent.bytes.toString().replaceAll('Keep exact', 'Keep other'));
    codex.invalidateJsonlCache(source.parent.filePath);
  } });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, false);
    assert.equal(operation.historyMutated, false);
    assert.equal(operation.bindingCommitted, false);
  } finally { await h.close(); }
});

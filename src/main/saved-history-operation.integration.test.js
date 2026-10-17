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

async function makeSource({ busy = false, onlyTurn = false, afterCompactTail = false } = {}) {
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
  if (afterCompactTail) records.push({ type: 'compacted', payload: { summary: 'old future' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'orphan-future-final' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'future-tool', call_id: 'orphan-call', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'orphan-call', output: 'orphan-output' } });
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
  const executions = [];
  const rows = new Map();
  let receiptWriteFailed = false;
  const db = { getAppState: key => rows.has(key) ? clone(rows.get(key)) : null,
    setAppState: (key, value) => {
      if (options.failRewrittenReceipt && value.phase === 'rewritten' && !receiptWriteFailed) {
        receiptWriteFailed = true;
        throw Error('fixture receipt persistence failure AFTER commit');
      }
      rows.set(key, clone(value));
    }, db: { transaction: fn => fn } };
  const state = { terminalToken: {}, projectId: 'project', cwd: '/fixture', lifecycleGeneration: 'life-1',
    runSeq: 3, inputRevision: 7, launchId: options.stopped ? null : 'old-launch',
    sessionId: source.sessionId, toolType: 'codex', isRunning: !options.stopped, stopping: false,
    inputReady: !options.stopped, inputOwnerLaunchId: options.stopped ? null : 'old-launch' };
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
  const launchTab = {};
  const inputGate = require('./history-mutation-input').createHistoryMutationInputGate({
    capture: () => ({ ...state }), readSendBusy: () => options.sendBusy?.() ?? false,
    wake: tabId => options.inputWake?.(tabId), log: { log() {} },
    readInputBoundary: async () => {
      const version = JSON.stringify([state.sessionId, state.launchId, state.runSeq, state.inputRevision, state.inputReady, state.isRunning]);
      return { known: true, ownerStable: true,
        isCurrent: () => version === JSON.stringify([state.sessionId, state.launchId, state.runSeq, state.inputRevision, state.inputReady, state.isRunning]),
        processStatus: state.isRunning ? 'found' : 'absent', inputReady: state.inputReady,
        status: !state.isRunning ? 'inactive' : state.inputReady ? 'active' : 'starting' };
    },
  });
  const workspace = { openProjects: new Map([['project', { tabs: new Map([['tab-A', launchTab]]) }]]),
    setCodexSessionId: async (_tab, sessionId, _reason, settings) => {
    events.push(['adopt', sessionId, settings]);
    if (options.failAdopt) throw Error('binding transaction failed');
    if (settings.historyOperation) registry.commitCodexBinding({ ...settings.historyOperation, sessionId }, () => { state.sessionId = sessionId; });
    else state.sessionId = sessionId;
    if (settings.historyInput) inputGate.bound(settings.historyInput, sessionId);
    if (settings.codexSettingsProof) Object.assign(launchTab, {
      codexModel: settings.codexSettingsProof.model, codexEffort: settings.codexSettingsProof.effort,
      codexSettingsProofAt: settings.codexSettingsProof.proofAt,
      codexSettingsProofSessionId: sessionId,
    });
    return true;
  } };
  const ipc = { invoke: async (channel, args) => {
    events.push([channel, args]);
    if (channel === 'history-mutation:begin') return inputGate.reserve(args);
    if (channel === 'history-mutation:finish') return inputGate.finish(args);
    if (channel === 'saved-history:get') return registry.read(args.tabId, args.operationId);
    if (channel === 'saved-history:step') return registry.step(args);
    if (channel === 'agent-transcript:get-timeline') return transcript.getTimeline(args);
    if (channel === 'codex:delete-range') return codex.deleteCodexRange(args);
    if (channel === 'terminal:getCommandState') return { isRunning: state.isRunning, processLookupUnknown: !!options.lookupUnknown };
    if (channel === 'terminal:stop-ai-process') {
      if (options.beforeStop) await options.beforeStop(state, source);
      registry.validateStop(args.authority);
      state.isRunning = false; state.launchId = null; state.inputOwnerLaunchId = null; state.inputReady = false;
      events.push(['signal', 'SIGTERM']);
      return { success: true };
    }
    if (channel === 'codex:reconcile-native-rewind-before-history-rewrite') return { success: !options.pendingNative, error: 'native unresolved' };
    if (channel === 'codex:run-command') {
      if (options.beforeResume) options.beforeResume(state);
      inputGate.authorizeResume(args.historyInput, args);
      return inputGate.run(args.historyInput, async () => {
        registry.validateResume(args.historyOperation, 'claim', { sessionId: args.sessionId });
        state.runSeq++; state.lifecycleGeneration = 'life-' + state.runSeq; state.isRunning = true;
        state.launchId = 'resume-exact'; state.inputOwnerLaunchId = state.launchId;
        registry.validateResume(args.historyOperation, 'claimed', { sessionId: args.sessionId, launchId: state.launchId });
        if (options.beforeLaunchWrite) options.beforeLaunchWrite(state);
        registry.validateResume(args.historyOperation, 'write', { sessionId: args.sessionId, launchId: state.launchId });
        inputGate.claimLaunch(args.historyInput, state.launchId, state.runSeq);
        events.push(['launch-write', args.sessionId]);
        state.inputReady = options.deferReady !== true;
        return { ...createCodexLaunchPendingResult({ tabId: 'tab-A', launchId: state.launchId,
          command: 'codex-c', resumeSourceSessionId: args.sessionId }), lifecycleGeneration: state.lifecycleGeneration };
      });
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
    reserveInput: request => inputGate.reserve(request), finishInput: proof => inputGate.finish(proof),
    assertInput: proof => inputGate.assert(proof.tabId, proof, { action: 'mutation' }),
    bindInput: (proof, sid) => inputGate.bound(proof, sid), runInput: (proof, fn) => inputGate.run(proof, fn),
    capture: () => ({ ...state }), inspectDraft: () => ({ hasDraft: options.foreignDraft ?? false }),
  }, resolveSession: async () => ({ sessionId: state.sessionId, toolType: 'codex', cwd: '/fixture' }),
  dispatch: async (action, payload) => {
    events.push(['dispatch', action]);
    const execution = bridge(action, payload).finally(settled);
    executions.push(execution);
    if (options.bridgeTimeout) {
      execution.catch(() => {});
      throw Object.assign(Error('simulated network reply lost'), { code: 'bridge_timeout' });
    }
    return execution;
  }, deleteRange: async args => {
    if (options.beforeMutation) await options.beforeMutation(state, source, inputGate);
    if (options.failRewrite) throw Error('controlled rewrite failure');
    return codex.deleteCodexRange(options.legacySuffix ? { ...args, toPhysicalEnd: false } : args);
  }, inspectRepair: codex.inspectCodexSavedRewindRepair, hashRecords: codex.codexRepairRecordsHash,
    buildTimeline: codex.buildCodexTimeline, broadcast: (_tab, data) => events.push(['receipt', data.operation.phase]) });

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
  return { source, events, state, registry, request, post, done, close, db, transcript, forkEvents, inbox, inboxOptions, launchTab, ui, inputGate,
    finish: () => executions.at(-1),
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

test('actual HTTP/executor/COW removes orphan future after compact and retains the full draft without submitting it', async () => {
  const h = await harness({ afterCompactTail: true });
  try {
    assert.equal((await h.post()).status, 202);
    await h.done;
    const reply = await h.get();
    assert.equal(reply.status, 200, JSON.stringify(reply));
    assert.equal(reply.operation.suffixProof.kind, 'physical-suffix');
    assert.equal(reply.operation.bindingCommitted, true);
    assert.equal(reply.operation.resume.status, 'starting');
    const bytes = await fs.promises.readFile((await codex.findCodexSessionFile(reply.operation.newSessionId, '/fixture')).filePath, 'utf8');
    assert.equal(bytes.includes('orphan-future-final'), false);
    assert.equal(bytes.includes('orphan-call'), false);
    const child = await codex.loadSessionRecords(reply.operation.newSessionId, '/fixture');
    assert.deepEqual(codex.buildCodexTimeline(child.records, reply.operation.newSessionId)
      .filter(entry => entry.type === 'user').map(entry => entry.content), ['keep']);
    assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
    assert.equal(h.events.some(event => /paste|send-prompt|rewind-native/.test(event[0])), false);
    assert.equal((await h.post()).operation.idempotent, true);
    assert.equal(h.events.filter(event => event[0] === 'dispatch').length, 1);
  } finally { await h.close(); }
});

test('repairOfOperationId repairs one legacy-shaped completed COW through the same executor without rewriting its receipt/source/child', async () => {
  const options = { afterCompactTail: true, legacySuffix: true };
  const h = await harness(options);
  try {
    assert.equal((await h.post()).status, 202);
    await h.done;
    const previous = h.registry.read('tab-A', h.request.operationId);
    assert.equal(previous.state, 'completed');
    const badChild = await codex.findCodexSessionFile(previous.newSessionId, '/fixture');
    const badBytes = await fs.promises.readFile(badChild.filePath);
    assert.equal(badBytes.toString().includes('orphan-future-final'), true);
    const previousJson = JSON.stringify(previous);
    options.legacySuffix = false;
    h.state.isRunning = false;
    h.state.launchId = null;
    const repair = { ...h.request, operationId: 'repair-legacy-cow-v1', expectedSessionId: previous.newSessionId,
      repairOfOperationId: previous.operationId };
    const accepted = await h.post(repair);
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    await h.finish();
    const result = h.registry.read('tab-A', repair.operationId);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.repair.repairOfOperationId, previous.operationId);
    const child = await codex.findCodexSessionFile(result.newSessionId, '/fixture');
    const bytes = await fs.promises.readFile(child.filePath, 'utf8');
    assert.equal(bytes.includes('orphan-future-final'), false);
    assert.equal(bytes.includes('orphan-call'), false);
    assert.deepEqual(await fs.promises.readFile(badChild.filePath), badBytes);
    assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
    assert.equal(JSON.stringify(h.registry.read('tab-A', previous.operationId)), previousJson);
    assert.equal((await h.post(repair)).operation.idempotent, true);
    assert.equal(h.events.filter(event => event[0] === 'dispatch').length, 2);
    assert.equal(h.events.some(event => /paste|send-prompt|rewind-native/.test(event[0])), false);
  } finally { await h.close(); }
});

test('failed repair after Stop resumes the incumbent child, not its mutation parent', async () => {
  const options = { afterCompactTail: true, legacySuffix: true };
  const h = await harness(options);
  try {
    await h.post(); await h.done;
    const previous = h.registry.read('tab-A', h.request.operationId);
    const oldChild = await codex.findCodexSessionFile(previous.newSessionId, '/fixture');
    const bytes = await fs.promises.readFile(oldChild.filePath);
    const priorReceipt = JSON.stringify(previous);
    options.legacySuffix = false;
    options.failRewrite = true;
    h.state.isRunning = true;
    h.state.launchId = 'incumbent-child-launch';
    const begin = h.events.length;
    const repair = { ...h.request, operationId: 'repair-write-failure',
      expectedSessionId: previous.newSessionId, repairOfOperationId: previous.operationId };
    assert.equal((await h.post(repair)).status, 202);
    await h.finish();
    const failed = h.registry.read('tab-A', repair.operationId);
    assert.equal(failed.state, 'failed');
    assert.equal(h.state.sessionId, previous.newSessionId);
    assert.equal(h.state.isRunning, true);
    assert.deepEqual(h.events.slice(begin).filter(e => e[0] === 'launch-write').map(e => e[1]), [previous.newSessionId]);
    assert.deepEqual(await fs.promises.readFile(oldChild.filePath), bytes);
    assert.equal(JSON.stringify(h.registry.read('tab-A', previous.operationId)), priorReceipt);
    assert.equal(h.events.slice(begin).some(e => /paste|send-prompt/.test(e[0])), false);
  } finally { await h.close(); }
});

for (const failRewrite of [false, true]) test('actual HTTP repair accepts equivalent native Resume append; child pair survives ' + (failRewrite ? 'failure Resume with stale UI' : 'COW/adoption'), async () => {
  const options = { afterCompactTail: true, legacySuffix: true };
  const h = await harness(options);
  try {
    await h.post(); await h.done;
    const previous = h.registry.read('tab-A', h.request.operationId);
    assert.equal(previous.resume.launchWritten, true);
    const child = await codex.findCodexSessionFile(previous.newSessionId, '/fixture');
    const snapshot = await fs.promises.readFile(child.filePath);
    const priorReceipt = JSON.stringify(previous);
    // Native provider bootstrap appends this fact without a user prompt.
    const record = { type: 'event_msg', timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: { type: 'thread_settings_applied', thread_settings: {
        model: 'gpt-5.6-luna', reasoning_effort: 'medium', cwd: '/fixture', thread_id: previous.newSessionId,
      } } };
    await fs.promises.appendFile(child.filePath, JSON.stringify(record) + '\n');
    const childBytes = await fs.promises.readFile(child.filePath);
    assert.equal(childBytes.length > snapshot.length, true);
    options.legacySuffix = false; options.failRewrite = failRewrite;
    h.state.isRunning = true; h.state.launchId = 'resume-bootstrap-child';
    // Exercise the REAL codexLaunch helpers, with a stale/missing renderer
    // proof and an unrelated global pair. Main's exact child proof wins.
    delete h.launchTab.codexSettingsProofAt;
    delete h.launchTab.codexModel; delete h.launchTab.codexEffort;
    h.ui.defaultCodexModel = 'gpt-5.6-sol'; h.ui.defaultCodexEffort = 'high';
    if (failRewrite) Object.assign(h.launchTab, {
      codexModel: 'gpt-5.6-sol', codexEffort: 'high',
      codexSettingsProofSessionId: previous.newSessionId, codexSettingsProofAt: previous.createdAt,
    }); // A stale same-SID renderer proof is not stronger than the exact file.
    const start = h.events.length;
    const repair = { ...h.request, operationId: 'resume-settings-' + failRewrite,
      expectedSessionId: previous.newSessionId, repairOfOperationId: previous.operationId };
    assert.equal((await h.post(repair)).status, 202);
    await h.finish();
    const result = h.registry.read('tab-A', repair.operationId);
    assert.equal(result.state, failRewrite ? 'failed' : 'completed', JSON.stringify(result));
    const launches = h.events.slice(start).filter(e => e[0] === 'codex:run-command');
    assert.equal(launches.length, 1);
    assert.equal(launches[0][1].sessionId, failRewrite ? previous.newSessionId : result.newSessionId);
    assert.equal(launches[0][1].model, 'gpt-5.6-luna');
    assert.equal(launches[0][1].effort, 'medium');
    if (!failRewrite) {
      assert.equal(result.repair.resumeSettingsRecords, 1);
      const fresh = await codex.loadSessionRecords(result.newSessionId, '/fixture');
      assert.equal(fresh.records.some(r => JSON.stringify(r).includes('orphan-future-final')), false);
      const pair = require('./codex-source-settings').resolveCodexSourceSettingsProof(fresh.records, result.newSessionId);
      assert.equal(pair.model, 'gpt-5.6-luna'); assert.equal(pair.effort, 'medium');
    }
    assert.deepEqual(await fs.promises.readFile(child.filePath), childBytes);
    assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
    assert.equal(JSON.stringify(h.registry.read('tab-A', previous.operationId)), priorReceipt);
    assert.equal(h.events.slice(start).some(e => /paste|send-prompt|rewind-native/.test(e[0])), false);
  } finally { await h.close(); }
});

test('direct HTTP rejects a public ref with a conflicting nested revision before persistence or dispatch', async () => {
  const h = await harness({ composite: true });
  try {
    const rejected = await h.post({ ...h.request,
      targetEntryRef: { ...h.request.targetEntryRef, contentRevision: 'stale-nested-revision' } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.error, 'history_revision_invalid');
    assert.equal(h.events.some(e => e[0] === 'dispatch'), false);
    assert.equal(h.registry.read('tab-A', h.request.operationId), null);
    assert.equal(h.state.isRunning, true);
  } finally { await h.close(); }
});

for (const variant of ['foreign-receipt', 'child-new-user', 'source-prefix-edited', 'child-before-write', 'composite-missing-revision']) {
  test('repairOfOperationId refuses unsafe state without losing source/child/draft: ' + variant, async () => {
    const options = { afterCompactTail: true, legacySuffix: true };
    const h = await harness(options);
    try {
      await h.post(); await h.done;
      const previous = h.registry.read('tab-A', h.request.operationId);
      const badChild = await codex.findCodexSessionFile(previous.newSessionId, '/fixture');
      options.legacySuffix = false;
      h.state.isRunning = false; h.state.launchId = null;
      if (variant === 'composite-missing-revision') {
        const read = h.transcript.getTimeline.bind(h.transcript);
        h.transcript.getTimeline = async (...args) => ({ ...await read(...args), composite: true });
      }
      if (variant === 'child-new-user') await fs.promises.appendFile(badChild.filePath,
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new work must survive' } }) + '\n');
      if (variant === 'source-prefix-edited') await fs.promises.writeFile(h.source.filePath,
        (await fs.promises.readFile(h.source.filePath, 'utf8')).replace('"message":"keep"', '"message":"changed"'));
      if (variant === 'child-before-write') options.beforeMutation = async () => {
        await fs.promises.appendFile(badChild.filePath, JSON.stringify({ type: 'event_msg',
          payload: { type: 'user_message', message: 'late work must survive' } }) + '\n');
      };
      const sourceBefore = await fs.promises.readFile(h.source.filePath);
      const receiptBefore = JSON.stringify(previous);
      const eventsBefore = h.events.length;
      const repair = { ...h.request, operationId: 'unsafe-repair-' + variant, expectedSessionId: previous.newSessionId,
        repairOfOperationId: variant === 'foreign-receipt' ? 'foreign-operation' : previous.operationId };
      const response = await h.post(repair);
      if (variant === 'foreign-receipt') assert.equal(response.status, 409);
      else {
        assert.equal(response.status, 202);
        await h.finish();
        const failed = h.registry.read('tab-A', repair.operationId);
        assert.equal(failed.state, 'failed', JSON.stringify(failed));
        assert.equal(failed.historyMutated, false);
        assert.equal(failed.bindingCommitted, false);
        if (variant === 'composite-missing-revision') assert.equal(failed.error, 'history_target_partial_identity');
      }
      assert.equal(h.state.sessionId, previous.newSessionId);
      assert.deepEqual(await fs.promises.readFile(h.source.filePath), sourceBefore);
      assert.equal(JSON.stringify(h.registry.read('tab-A', previous.operationId)), receiptBefore);
      assert.deepEqual(h.events.slice(eventsBefore).filter(event => event[0] === 'launch-write').map(event => event[1]),
        variant === 'child-before-write' ? [previous.newSessionId] : []);
      if (variant === 'child-new-user' || variant === 'child-before-write') {
        assert.equal((await fs.promises.readFile(badChild.filePath, 'utf8')).includes('work must survive'), true);
      }
    } finally { await h.close(); }
  });
}

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

test('adoption failure preserves committed child/draft and never auto-resumes the incumbent', async () => {
  const h = await harness({ failAdopt: true });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, false);
    assert.equal(operation.historyMutated, true);
    assert.equal(operation.bindingCommitted, false);
    assert.equal(h.state.sessionId, h.source.sessionId);
    assert.ok(operation.draft);
    assert.ok(operation.newSessionId);
    assert.equal(h.state.isRunning, false);
    assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 0);
  } finally { await h.close(); }
});

test('actual COW commit survives a receipt-write exception as data through HTTP/App/executor, without source Resume', async () => {
  const h = await harness({ failRewrittenReceipt: true });
  try {
    await h.post(); await h.done;
    const { operation } = await h.get();
    assert.equal(operation.success, false);
    assert.match(operation.error, /receipt persistence failure AFTER commit/);
    assert.equal(operation.historyMutated, true);
    assert.equal(operation.bindingCommitted, false);
    assert.ok(operation.newSessionId);
    assert.ok(operation.draft?.text);
    assert.equal(h.forkEvents.has(operation.newSessionId), true, 'lineage was actually committed');
    const child = await codex.loadSessionRecords(operation.newSessionId, '/fixture');
    assert.deepEqual(codex.buildCodexTimeline(child.records, operation.newSessionId).filter(e => e.type === 'user').map(e => e.content), ['keep']);
    assert.equal(h.state.sessionId, h.source.sessionId);
    assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 0);
    assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
    assert.equal((await h.post()).operation.idempotent, true);
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

for (const deferReady of [false, true]) test('actual HTTP/App/Rewind/COW + SQLite FIFO retains concurrent Send until input-ready, deferReady=' + deferReady, async () => {
  const Database = require('better-sqlite3');
  const { AgentSendQueue } = require('./agent-send-queue');
  const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
  const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
  const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  let queue, h;
  const attempts = [];
  h = await harness({ afterCompactTail: true, deferReady,
    sendBusy: () => queue?.hasUnsettledInput('tab-A') ?? false,
    inputWake: tabId => queue?.wake(tabId),
    beforeMutation: async state => {
      assert.equal(state.isRunning, false, 'real executor already passed Stop');
      for (const surface of ['desktop-history', 'tab-message']) {
        const request = { tabId: 'tab-A', provider: 'codex', handoffId: surface,
          prompt: 'do not silently retarget ' + surface, sendOperationKey: 'history:tab-A:' + surface,
          expectedTarget: { toolType: 'codex', sessionId: h.source.sessionId } };
        const identity = { operationKey: request.sendOperationKey, tabId: 'tab-A', provider: 'codex', surface,
          handoffId: surface, sessionId: h.source.sessionId, requestFingerprint: fingerprintAgentSendRequest(request),
          promptHash: fingerprintAgentSendRequest(request.prompt), promptLength: request.prompt.length };
        assert.equal(queue.enqueue({ request, identity }).receipt.applicationQueued, true);
      }
      await tick(); await tick();
      assert.equal(attempts.length, 0, 'neither concurrent Send can launch Resume into the stopped incumbent');
      assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 0);
    },
  });
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  queue = new AgentSendQueue({ store, admit: request => !h.inputGate.held(request.tabId),
    claimDispatch: request => h.inputGate.claimSend(request.tabId), execute: request => {
      const failure = agentSendTargetPreconditionFailure(request.expectedTarget,
        { toolType: 'codex', sessionId: h.state.sessionId });
      attempts.push({ request, failure });
      return failure || { submitted: false, code: 'unexpected-input-admission' };
    } });
  try {
    assert.equal((await h.post()).status, 202);
    await h.done; await tick(); await tick(); await tick();
    const { operation } = await h.get();
    assert.equal(operation.success, true, JSON.stringify(operation));
    assert.equal(operation.bindingCommitted, true);
    assert.equal(h.events.filter(e => e[0] === 'launch-write').length, 1, 'only owned child Resume');
    assert.deepEqual(h.events.filter(e => e[0] === 'launch-write').map(e => e[1]), [operation.newSessionId]);
    if (deferReady) {
      assert.equal(h.inputGate.read('tab-A').phase, 'awaiting-input');
      assert.equal(attempts.length, 0, 'launch-written and completed are not input-ready');
      for (const id of ['desktop-history', 'tab-message']) {
        assert.equal(queue.item('history:tab-A:' + id).state, 'waiting');
        assert.equal(store.get('history:tab-A:' + id).attemptId, null);
      }
      h.state.inputReady = true;
      await h.inputGate.notify('tab-A');
      await tick(); await tick(); await tick();
    }
    assert.equal(attempts.length, 2);
    for (const { request, failure } of attempts) {
      assert.equal(failure?.code, 'agent_send_target_changed');
      assert.equal(store.get(request.sendOperationKey).attemptId, null);
      assert.equal(JSON.parse(queue.item(request.sendOperationKey).request_json).expectedTarget.sessionId, h.source.sessionId);
    }
    const history = await h.transcript.getHistory({ sessionId: operation.newSessionId, toolType: 'codex', cwd: '/fixture' });
    assert.equal(history.success, true);
    assert.equal(JSON.stringify(history.entries).includes('orphan-future-final'), false);
    assert.deepEqual(await fs.promises.readFile(h.source.filePath), h.source.bytes);
    assert.equal(h.inputGate.held('tab-A'), false);
    assert.equal((await h.post()).operation.idempotent, true, 'same operation re-read cannot allocate/rewrite again');
  } finally { queue.dispose(); await tick(); db.close(); await h.close(); }
});

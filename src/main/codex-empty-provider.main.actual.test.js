'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const codexData = require('./ipc/codex-data');
const { createCodexAuthProfileRoute, PROVIDER } = require('./codex-auth-profile-route');

// Never register ipc/codex-data: register starts storage/account services.
// Real: AST-extracted Main callback/launch checks, auth-route selection,
// materializeEmptySession, JSONL writer and reads of our own files.
// Replaced: DB/CAS state, terminal/process snapshots, lifecycle locks,
// launch-intent/history authority dependencies, adoption and auth reader.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function nodesUnder(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root); return found;
}
function handlerNode(channel) {
  const registrations = nodesUnder(tree, node => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ipcMain'
    && node.expression.name.text === 'handle'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel);
  assert.equal(registrations.length, 1, 'one actual registration for ' + channel);
  const callback = registrations[0].arguments[1];
  assert.ok(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback));
  return callback;
}
function functionSource(name) {
  const matches = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0].getText(tree);
}
const materializeCallback = handlerNode('codex:materialize-empty-session');
const launchChecks = ['withAgentLaunchFence', 'assertAgentSendLaunchCurrent',
  'returnAgentSendLaunchRefusal', 'agentLaunchIntentRefusal', 'agentLaunchMaterializationResult']
  .map(functionSource).join('\n');

async function fixture(t, configured = false) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-empty-main-provider-'));
  const cwd = path.join(root, 'fixture'), sessionsDir = path.join(root, 'sessions');
  await fs.promises.mkdir(cwd);
  const tabId = 'test-tab', projectId = 'test-project', senderId = 7;
  const terminal = { write: () => assert.fail('PTY input forbidden') };
  const terminals = new Map([[tabId, terminal]]), knownFiles = new Map();
  const state = { bound: null, stopRevision: 1, terminalInstanceId: 'test-terminal',
    projectId, command: { isRunning: false, processLookupUnknown: false },
    intent: null, adoption: true, afterLookup: null, afterWrite: null, onLock: null };
  const calls = { materialize: [], created: [], cas: [], unlinks: [], invalidations: [],
    find: [], load: [], adopt: [], locks: [], process: [], guard: [], options: [], auth: 0 };
  const cache = new Map(), launchLock = new Map(), lifecycleLock = new Map();
  const route = configured ? createCodexAuthProfileRoute({
    configuration: { homePath: path.join(root, 'unused-auth-source'),
      accountKey: 'aaaaaaaaaaaaaaaa', fixtureCwd: cwd },
    // Pure fixture values: this function does not read a credential file.
    readAuth: () => { calls.auth++; return { accountKey: 'aaaaaaaaaaaaaaaa',
      accessToken: 'fixture-only-token', accountId: 'fixture-only-account', accessExpiresAtMs: 9e15 }; },
    captureTab: () => ({ terminal: terminals.get(tabId), cwd, launchId: 'fixture-launch',
      lifecycleGeneration: 'fixture-generation', runSeq: 1, commandRunning: true }),
    randomBytes: n => Buffer.alloc(n, 1),
  }) : null;
  const configuredRoute = route && { ...route, newSessionOptions: value => {
    calls.options.push(value); return route.newSessionOptions(value);
  } };
  function fileFor(sessionId) {
    assert.ok(knownFiles.has(sessionId), 'lookup may only address an owned fixture');
    return knownFiles.get(sessionId);
  }
  async function readRecords(filePath) {
    assert.ok(filePath.startsWith(root + path.sep));
    return (await fs.promises.readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  }
  const api = {
    materializeEmptySession: async options => {
      calls.materialize.push({ ...options });
      // An explicit sessionsDir is mandatory here, regardless of CODEX_HOME.
      const created = await codexData._api.materializeEmptySession({ ...options, sessionsDir });
      calls.created.push(created); knownFiles.set(created.sessionId, created.filePath);
      if (state.afterWrite) await state.afterWrite(created);
      return created;
    },
    findCodexSessionFile: async (sessionId, exactCwd) => {
      calls.find.push([sessionId, exactCwd]); return { filePath: fileFor(sessionId) };
    },
    loadSessionRecords: async (sessionId, exactCwd) => {
      calls.load.push([sessionId, exactCwd]); return { success: true, records: await readRecords(fileFor(sessionId)) };
    },
    inspectConversationMaterialization: codexData._api.inspectConversationMaterialization,
    invalidateJsonlCache: filePath => {
      calls.invalidations.push(filePath); codexData._api.invalidateJsonlCache(filePath);
    },
  };
  const context = vm.createContext({ path,
    fs: { promises: { unlink: async filePath => {
      calls.unlinks.push(filePath);
      assert.ok(calls.created.some(created => created.filePath === filePath), 'only this handler-created file may be removed');
      return fs.promises.unlink(filePath);
    } } },
    console: { log() {}, warn() {} }, terminals, terminalProjects: new Map([[tabId, cwd]]),
    codexLaunchInflight: launchLock, aiLifecycleActionInflight: lifecycleLock,
    runKeyedExclusive: async (lock, key, work) => {
      assert.equal(key, tabId); calls.locks.push(lock === launchLock ? 'launch' : 'lifecycle');
      assert.ok(lock === launchLock || lock === lifecycleLock);
      if (state.onLock) state.onLock(lock);
      return work();
    },
    captureAgentLaunchFence: key => {
      assert.equal(key, tabId); return { terminalInstanceId: state.terminalInstanceId, stopRevision: state.stopRevision };
    },
    historyMutationInput: { assert: (key, input, options) => calls.guard.push({ key, input, ...options }) },
    agentLaunchPreparations: { getIntent: () => state.intent },
    agentLaunchIntentTrace: () => ({}), agentLaunchIntentSourceCurrent: () => true,
    agentSendRequestTargetFailure: () => null,
    resolveAuthoritativeTabProjectId: () => state.projectId,
    resolveTerminalCommandState: async options => {
      calls.process.push({ ...options });
      if (state.afterLookup) await state.afterLookup();
      return state.command;
    },
    projectManager: { db: {
      getTabCodexSessionId: (project, tab) => {
        assert.equal(project, projectId); assert.equal(tab, tabId); return state.bound;
      },
      compareAndSetTabCodexSessionId: (project, tab, expected, next) => {
        calls.cas.push({ project, tab, expected, next });
        assert.equal(project, projectId); assert.equal(tab, tabId);
        if (state.bound !== expected) return false;
        state.bound = next; return true;
      },
    } },
    adoptAgentLaunchMaterializedSource: (_request, sessionId) => { calls.adopt.push(sessionId); return state.adoption; },
    codexConversationMaterializationCache: cache,
    codexDataModule: { _api: api }, codexAuthProfileRoute: configuredRoute,
  });
  // Evaluate the callback, not the registration and not Main's startup code.
  vm.runInContext(launchChecks, context);
  const handler = vm.runInContext('(' + materializeCallback.getText(tree) + ')', context);
  t.after(async () => {
    for (const filePath of knownFiles.values()) codexData._api.invalidateJsonlCache(filePath);
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, cwd, sessionsDir, tabId, projectId, senderId, state, calls, cache, route, terminals,
    context, readRecords,
    run: request => handler({ sender: { id: senderId } }, { projectId, tabId, cwd, ...request }),
    seed: async (modelProvider = 'openai') => {
      const existing = await codexData._api.materializeEmptySession({ cwd, sessionsDir, modelProvider });
      knownFiles.set(existing.sessionId, existing.filePath); return existing;
    },
  };
}

test('ordinary actual Main materialization writes one openai header and commits the same session', async t => {
  const h = await fixture(t), result = await h.run({});
  assert.equal(result.success, true); assert.equal(result.created, true); assert.equal(result.metadataOnly, true);
  const records = await h.readRecords(result.filePath);
  assert.equal(records.length, 1); assert.equal(records[0].type, 'session_meta');
  assert.equal(records[0].payload.model_provider, 'openai'); assert.equal(records[0].payload.cwd, h.cwd);
  assert.equal(records[0].payload.id, result.sessionId); assert.equal(h.state.bound, result.sessionId);
  assert.deepEqual(h.calls.materialize, [{ cwd: h.cwd }]);
  assert.deepEqual(h.calls.locks, ['launch', 'lifecycle']); assert.equal(h.calls.cas.length, 1);
  assert.equal(h.cache.get(result.sessionId).metadataOnly, true);
});

test('configured exact fixture header matches the actual auth-route launch provider selection', async t => {
  const h = await fixture(t, true), result = await h.run({});
  assert.equal(result.success, true); assert.equal(h.calls.auth, 0, 'materialization needs no credential read');
  const header = (await h.readRecords(result.filePath))[0].payload;
  const overrides = h.route.launchOverrides(h.tabId, 'http://127.0.0.1:9/codex/t/' + h.tabId);
  const selection = JSON.parse(overrides.find(x => x.startsWith('model_provider=')).slice('model_provider='.length));
  assert.equal(selection, PROVIDER); assert.equal(header.model_provider, selection);
  assert.deepEqual(h.calls.options, [h.cwd]);
  assert.deepEqual(h.calls.materialize, [{ cwd: h.cwd, modelProvider: PROVIDER }]);
  assert.equal(h.calls.auth, 1, 'only the explicitly substituted auth reader was used for launch overrides');
});

for (const configured of [false, true]) test('renderer modelProvider cannot override ' + (configured ? 'configured' : 'ordinary') + ' selection', async t => {
  const h = await fixture(t, configured);
  const result = await h.run({ modelProvider: configured ? 'openai' : 'renderer-chosen-provider' });
  assert.equal(result.success, true);
  const provider = (await h.readRecords(result.filePath))[0].payload.model_provider;
  assert.equal(provider, configured ? PROVIDER : 'openai');
  assert.equal(h.calls.materialize[0].modelProvider, configured ? PROVIDER : undefined);
});

test('configured foreign cwd is refused before materialization IO', async t => {
  const h = await fixture(t, true), result = await h.run({ cwd: path.join(h.root, 'other-project') });
  assert.equal(result.success, false); assert.equal(result.error, 'codex_auth_route_scope_mismatch');
  assert.equal(h.calls.materialize.length, 0); assert.equal(h.calls.cas.length, 0); assert.equal(h.calls.auth, 0);
  assert.equal(fs.existsSync(h.sessionsDir), false);
});

test('already-bound source keeps its original provider and bytes without new materialization or route options', async t => {
  const h = await fixture(t, true), old = await h.seed(); h.state.bound = old.sessionId;
  const before = await fs.promises.readFile(old.filePath);
  const result = await h.run({ modelProvider: PROVIDER });
  assert.equal(result.success, true); assert.equal(result.created, false); assert.equal(result.sessionId, old.sessionId);
  assert.equal(result.metadataOnly, true); assert.equal(h.state.bound, old.sessionId);
  assert.equal(h.calls.materialize.length, 0); assert.equal(h.calls.options.length, 0);
  assert.equal(h.calls.cas.length, 0); assert.deepEqual(h.calls.adopt, [old.sessionId]);
  assert.deepEqual(h.calls.find, [[old.sessionId, h.cwd]]); assert.deepEqual(h.calls.load, [[old.sessionId, h.cwd]]);
  assert.deepEqual(await fs.promises.readFile(old.filePath), before); assert.equal(h.calls.unlinks.length, 0);
});

test('CAS conflict removes only the own new file and preserves the competing old binding', async t => {
  const h = await fixture(t, true), old = await h.seed();
  const before = await fs.promises.readFile(old.filePath);
  h.state.afterWrite = () => { h.state.bound = old.sessionId; };
  const result = await h.run({}), created = h.calls.created[0];
  assert.equal(result.success, false); assert.equal(result.error, 'codex_session_compare_and_set_conflict');
  assert.equal(result.currentSessionId, old.sessionId); assert.equal(h.state.bound, old.sessionId);
  assert.notEqual(created.filePath, old.filePath); assert.equal(fs.existsSync(created.filePath), false);
  assert.deepEqual(h.calls.unlinks, [created.filePath]); assert.deepEqual(h.calls.invalidations, [created.filePath]);
  assert.deepEqual(await fs.promises.readFile(old.filePath), before);
  assert.equal(h.calls.adopt.length, 0); assert.equal(h.cache.size, 0);
});

test('a Stop fence changing while queued rejects before materialization', async t => {
  const h = await fixture(t, true);
  h.state.onLock = () => { h.state.stopRevision++; };
  const result = await h.run({});
  assert.equal(result.success, false); assert.equal(result.error, 'agent_launch_cancelled');
  assert.equal(h.calls.materialize.length, 0); assert.equal(h.calls.cas.length, 0);
  assert.equal(fs.existsSync(h.sessionsDir), false);
});

test('terminal replacement during process lookup rejects before filesystem work', async t => {
  const h = await fixture(t, true);
  h.state.afterLookup = () => h.terminals.set(h.tabId, { write: () => assert.fail('no PTY') });
  const result = await h.run({});
  assert.equal(result.success, false); assert.equal(result.error, 'agent_send_launch_owner_changed');
  assert.equal(h.calls.materialize.length, 0); assert.equal(h.calls.cas.length, 0);
  assert.equal(h.calls.guard.length, 2, 'actual guard is called on both sides of the await');
});

test('stale owner after the real file write removes that file before CAS, preserving other source bytes', async t => {
  const h = await fixture(t, true), old = await h.seed(), before = await fs.promises.readFile(old.filePath);
  h.state.afterWrite = () => { h.state.stopRevision++; };
  const result = await h.run({}), created = h.calls.created[0];
  assert.equal(result.success, false); assert.equal(result.error, 'agent_launch_cancelled');
  assert.equal(h.state.bound, null); assert.equal(h.calls.cas.length, 0);
  assert.equal(fs.existsSync(created.filePath), false); assert.deepEqual(h.calls.unlinks, [created.filePath]);
  assert.deepEqual(await fs.promises.readFile(old.filePath), before);
});

for (const [name, command, error] of [
  ['unknown process lookup', { isRunning: false, processLookupUnknown: true }, 'codex_process_state_unknown'],
  ['foreign running process', { isRunning: true, expectedProcess: 'claude', providerProcessAlive: true }, 'codex_already_running'],
]) test(name + ' does not create or bind a session', async t => {
  const h = await fixture(t, true); h.state.command = command;
  const result = await h.run({}); assert.equal(result.success, false); assert.equal(result.error, error);
  assert.equal(h.calls.process[0].expectedProcess, 'codex'); assert.equal(h.calls.process[0].allowProcessTreeLookup, true);
  assert.equal(h.calls.materialize.length, 0); assert.equal(h.calls.cas.length, 0); assert.equal(h.calls.options.length, 0);
});

test('foreign renderer launch intent is rejected before locks or IO', async t => {
  const h = await fixture(t, true); h.state.intent = { senderId: h.senderId + 1 };
  const result = await h.run({ launchIntent: { token: 'foreign-token' } });
  assert.equal(result.success, false); assert.equal(result.error, 'agent_launch_intent_missing');
  assert.equal(h.calls.locks.length, 0); assert.equal(h.calls.materialize.length, 0);
});

test('post-CAS adoption refusal cannot delete an already-bound new session', async t => {
  const h = await fixture(t, true); h.state.adoption = false;
  const result = await h.run({}), created = h.calls.created[0];
  assert.equal(result.success, false); assert.equal(result.error, 'agent_launch_materialization_adoption_lost');
  assert.equal(h.state.bound, created.sessionId); assert.equal(fs.existsSync(created.filePath), true);
  assert.equal(h.calls.unlinks.length, 0);
  assert.equal((await h.readRecords(created.filePath))[0].payload.model_provider, PROVIDER);
});

test('adjacent context handler projects provider only for fresh Codex; this is not a full writer-flow test', async t => {
  const h = await fixture(t, true), callback = handlerNode('agent:record-history-context');
  const calls = nodesUnder(callback, node => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'providerApi');
  assert.equal(calls.length, 1); assert.ok(ts.isObjectLiteralExpression(calls[0].arguments[0]));
  const project = (toolType, targetSessionId, route = h.route, cwd = h.cwd) => vm.runInNewContext(
    '(' + calls[0].arguments[0].getText(tree) + ')', {
      toolType, targetSessionId, codexAuthProfileRoute: route, cwd,
      sessionAuthority: { source: 'fixture' }, prompt: 'fixture context', normalizedPresentationSnapshot: null,
      input: { model: 'fixture-model', effort: 'low', modelProvider: 'renderer-choice' }, armMutation() {},
    });
  const fresh = project('codex', null);
  assert.equal(fresh.modelProvider, PROVIDER); assert.equal(fresh.cwd, h.cwd);
  const neverSelect = { newSessionOptions: () => assert.fail('existing/Claude must not select a new-session provider') };
  for (const args of [project('codex', 'existing-session', neverSelect), project('claude', null, neverSelect),
    project('claude', 'existing-session', neverSelect), project('codex', null, null)]) {
    assert.equal(Object.hasOwn(args, 'modelProvider'), false);
    assert.equal(args.model, 'fixture-model'); assert.equal(args.effort, 'low');
  }
  assert.throws(() => project('codex', null, h.route, path.join(h.root, 'foreign')), /codex_auth_route_scope_mismatch/);
  assert.equal(h.calls.auth, 0);
});

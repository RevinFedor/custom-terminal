'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { historyReadSession } = require('./history-read-session');
const { resolveInboxRewindTarget } = require('./inbox-rewind-identity');
const { runSingleFlight } = require('./agent-tab-restore');

const read = (relative, kind) => ts.createSourceFile(relative,
  fs.readFileSync(path.resolve(__dirname, relative), 'utf8'), ts.ScriptTarget.Latest, true, kind);
const app = read('../renderer/App.tsx', ts.ScriptKind.TSX);
const web = read('web-server.js', ts.ScriptKind.JS);
const plain = (value) => JSON.parse(JSON.stringify(value));

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function appBranch(action) {
  const node = find(app, (candidate) => ts.isIfStatement(candidate)
    && ts.isBinaryExpression(candidate.expression)
    && candidate.expression.left.getText(app) === 'action'
    && ts.isStringLiteral(candidate.expression.right) && candidate.expression.right.text === action);
  assert.ok(node, `real App bridge ${action} branch exists`);
  return node.thenStatement.getText(app);
}
function functionText(name) {
  const node = web.statements.find((candidate) => ts.isFunctionDeclaration(candidate) && candidate.name?.text === name);
  assert.ok(node, `real web function ${name} exists`);
  return node.getText(web);
}
function inboxRewindRoute() {
  const assignment = find(web, (node) => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
    && node.expression.left.getText(web) === 'm'
    && ts.isCallExpression(node.expression.right)
    && node.expression.right.arguments[0]?.kind === ts.SyntaxKind.RegularExpressionLiteral
    && ['inbox', 'runs', 'rewind'].every((part) => node.expression.right.arguments[0].getText(web).includes(part)));
  assert.ok(assignment, 'real Inbox rewind route exists');
  const statements = assignment.parent.statements;
  const route = statements[statements.indexOf(assignment) + 1];
  assert.ok(ts.isIfStatement(route), 'the matched route owns its following request handler');
  return route.getText(web);
}

function appHarness({ mutateNeverGuard = false } = {}) {
  const calls = [];
  const workspace = { projectPath: '/test/project', tabs: new Map() };
  const create = async (projectId, name, cwd, options) => {
    calls.push(['create', { projectId, name, cwd, options: plain(options) }]);
    const tabId = options.restoreId || 'created-tab';
    workspace.tabs.set(tabId, { ...options, id: tabId, tabId, projectId, name, cwd, toolType: options.commandType });
    return tabId;
  };
  const state = {
    openProjects: new Map([['inbox-project', workspace]]), createTab: create, createTabAfterCurrent: create,
    setTabCommandType(...args) { calls.push(['set-command', ...args]); },
    markAiLaunchAutoTitle(...args) { calls.push(['mark-title', ...args]); },
    closeTab: async () => true,
    restoreTabHistoryEntry: async (projectId, historyId, options) => {
      calls.push(['restore', { projectId, historyId, options: plain(options) }]);
      workspace.tabs.set(options.expectedTabId, { tabId: options.expectedTabId, projectId, toolType: 'codex', cwd: '/test/project', sessionId: 'saved-source' });
      return { tabId: options.expectedTabId };
    },
  };
  const context = vm.createContext({
    state, useWorkspaceStore: { getState: () => state },
    resolveBridgeCreationTarget: async () => ({ ok: true, creation: { projectId: 'inbox-project', cwd: '/test/project' }, windowTarget: null }),
    ensureProjectWorkspace: async () => workspace,
    placeCreatedTab: async (options) => { calls.push(['place', plain(options)]); return { ok: true }; },
    getHistoryAgentRuntime: () => ({ resume: async (options) => { calls.push(['resumeNow', plain(options)]); return { success: true, accepted: true }; } }),
    startFreshCodexSession: async (options) => { calls.push(['startNow', plain(options)]); return { success: true, accepted: true }; },
    reply: (ok, data, error) => { if (!ok) throw new Error(error); return data; },
  });
  let createBranch = appBranch('createAgentTab');
  if (mutateNeverGuard) {
    const declaration = find(app, (node) => ts.isVariableDeclaration(node) && node.name.getText(app) === 'restoreWithoutLaunch');
    assert.ok(declaration?.initializer, 'restore guard initializer exists');
    const original = createBranch;
    createBranch = createBranch.replace(declaration.initializer.getText(app), 'false');
    assert.notEqual(createBranch, original);
  }
  for (const [name, branch] of [['createAgentTab', createBranch], ['restoreClosedAgentTab', appBranch('restoreClosedAgentTab')]]) {
    const code = ts.transpileModule(`globalThis.${name} = async (payload) => ${branch}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInContext(code, context);
  }
  return { context, calls, workspace };
}

function assertRestoredWithoutLaunch(harness) {
  const options = harness.calls.find(([kind]) => kind === 'create')[1].options;
  assert.equal(options.pendingAction, undefined, 'a recovery-only tab must not launch later when it mounts');
  assert.equal(harness.calls.some(([kind]) => kind === 'resumeNow' || kind === 'startNow'), false);
}

function routeHarness({ archived = false, readSessionId = 'explicit-read-source' } = {}) {
  const renderer = appHarness();
  const calls = [];
  const targetTabId = 'reserved-inbox-tab';
  const liveInfo = { toolType: 'codex', sessionId: null, readSessionId, savedSessionId: 'saved-source',
    writerSessionId: null, writerConfirmed: false, writerUsableForMutation: false, cwd: '/test/project' };
  const body = { conversationKey: 'chat-A', sessionId: 'saved-source', targetEntryUuid: 'audited-uuid', sourceIdentity: 'exact-source-A' };
  const target = { type: 'user', uuid: 'projected-user-A', sourceIdentity: 'exact-source-A', sourceIdentityAliases: ['audited-uuid'],
    content: 'original question', contentRevision: 'content-revision', entryRef: { entryId: 'projected-user-A', sourceIdentity: 'exact-source-A' } };
  const descriptor = () => renderer.workspace.tabs.get(targetTabId) || null;
  const context = vm.createContext({
    m: ['route', 'run-A'], req: { method: 'POST' }, res: {}, Date,
    externalRuns: new Map(), externalRunByTabId: new Map(), externalRunByConversationKey: new Map(), closedAgentRestoreInflight: new Map(),
    INBOX_PROJECT_ID: 'inbox-project', historyReadSession, resolveInboxRewindTarget, runSingleFlight,
    decId: (value) => value, readBody: async () => body,
    cleanOptionalString: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    reservedInboxTabId: () => targetTabId,
    agentSendReceiptStore: { list: () => [{ state: 'confirmed', provider: 'codex', tabId: targetTabId,
      auditIdentity: { entryUuid: 'audited-uuid', sourceIdentity: 'exact-source-A', sessionId: 'saved-source' } }] },
    findOrchestrationTabDescriptor: descriptor,
    findRestorableAgentTabDescriptor: () => archived ? { ok: true, projectId: 'inbox-project', historyId: 42 } : null,
    explicitAgentTargetError: (value) => new Error(value?.error || 'restore unavailable'),
    resolveAgentSessionInfo: async () => { calls.push(['read-live-status']); return liveInfo; },
    transcriptService: { getTimeline: async (options) => { calls.push(['read-history', plain(options)]); return { success: true, entries: [target], contentRevision: 'timeline-revision' }; } },
    bridgeRequest: async (action, payload) => {
      calls.push([action, plain(payload)]);
      if (action === 'ensureInboxProject') return {};
      if (action === 'createAgentTab' || action === 'restoreClosedAgentTab') return renderer.context[action](payload);
      if (action === 'rewindAgentHistoryScenario' || action === 'rewindAgentTimelineScenario') return { success: true, activeSessionId: 'rewound-session' };
      throw new Error(`unexpected pre-scenario bridge action: ${action}`);
    },
    clampAutoStopMs: () => 0, clampAutoCloseMs: () => 0, clearExternalRunTimer() {},
    setExternalRunMeta() {}, cleanupExternalRun() {}, scheduleExternalRunCompletionTimers() {},
    sendJson: (_res, status, payload) => ({ status, payload }),
    sendTerminalBridgeError: (_res, error) => ({ status: 500, error: error.message }),
  });
  vm.runInContext(functionText('ensureExplicitAgentTabOpen') + '\n' + functionText('resolveHistorySessionInfo'), context);
  vm.runInContext(`globalThis.route = async () => { ${inboxRewindRoute()} };`, context);
  return { context, renderer, calls, liveInfo, target };
}

test('recovery-only createAgentTab never starts or leaves a pending mount action', async () => {
  for (const startNow of [false, true]) {
    const harness = appHarness();
    const result = await harness.context.createAgentTab({ toolType: 'codex', resumeSessionId: 'saved-source', resumePolicy: 'never', startNow, background: true });
    assertRestoredWithoutLaunch(harness);
    const options = harness.calls.find(([kind]) => kind === 'create')[1].options;
    assert.equal(options.codexSessionId, 'saved-source');
    assert.equal(options.background, true);
    assert.equal(result.sessionStatus, 'inactive');
    assert.equal(result.starting, false);
  }
});

test('ordinary deferred creation retains its pending action and explicit immediate creation still resumes', async () => {
  const deferred = appHarness();
  await deferred.context.createAgentTab({ toolType: 'codex', resumeSessionId: 'saved-source', startNow: false });
  assert.deepEqual(deferred.calls.find(([kind]) => kind === 'create')[1].options.pendingAction, { type: 'codex-continue', sessionId: 'saved-source' });
  assert.equal(deferred.calls.some(([kind]) => kind === 'resumeNow'), false);
  const immediate = appHarness();
  await immediate.context.createAgentTab({ toolType: 'codex', resumeSessionId: 'saved-source', startNow: true });
  assert.equal(immediate.calls.filter(([kind]) => kind === 'resumeNow').length, 1);
});

test('closed Inbox fallback restores a tab and reaches shared Rewind using read identity without writer proof', async () => {
  const { context, renderer, calls, liveInfo } = routeHarness();
  const before = plain(liveInfo);
  const result = await context.route();
  assert.equal(result.status, 200);
  assertRestoredWithoutLaunch(renderer);
  const creation = calls.find(([kind]) => kind === 'createAgentTab')[1];
  assert.equal(creation.resumePolicy, 'never');
  assert.equal(creation.startNow, false);
  assert.equal(creation.background, true);
  assert.equal(calls.find(([kind]) => kind === 'read-history')[1].sessionId, 'explicit-read-source');
  const action = calls.find(([kind]) => kind === 'rewindAgentHistoryScenario')[1];
  assert.equal(action.targetUuid, 'projected-user-A');
  assert.equal(action.targetSourceIdentity, 'exact-source-A');
  assert.equal(action.expectedContentRevision, 'content-revision');
  assert.equal(action.restoreDraft, false);
  assert.deepEqual(calls.map(([kind]) => kind), ['ensureInboxProject', 'createAgentTab', 'read-live-status', 'read-history', 'rewindAgentHistoryScenario']);
  assert.deepEqual(liveInfo, before, 'history projection cannot upgrade or replace the live writer verdict');
});

test('archived Inbox target uses existing exact restore with resumePolicy never instead of fallback creation', async () => {
  const { context, renderer, calls } = routeHarness({ archived: true });
  const result = await context.route();
  assert.equal(result.status, 200);
  assert.equal(calls.some(([kind]) => kind === 'createAgentTab'), false);
  const restore = renderer.calls.find(([kind]) => kind === 'restore')[1];
  assert.equal(restore.options.resumePolicy, 'never');
  assert.equal(restore.options.expectedTabId, 'reserved-inbox-tab');
  assert.equal(restore.options.background, true);
  assert.equal(renderer.calls.some(([kind]) => kind === 'resumeNow' || kind === 'startNow'), false);
  assert.deepEqual(calls.map(([kind]) => kind), ['ensureInboxProject', 'restoreClosedAgentTab', 'read-live-status', 'read-history', 'rewindAgentHistoryScenario']);
});

test('missing explicit read identity never falls back to saved SID or manufactures writer confirmation', async () => {
  const { context, calls, liveInfo } = routeHarness({ readSessionId: null });
  const result = await context.route();
  assert.equal(result.status, 409);
  assert.equal(result.payload.code, 'external_run_rewind_target_unavailable');
  assert.equal(calls.some(([kind]) => kind === 'read-history' || kind === 'rewindAgentHistoryScenario'), false);
  assert.equal(liveInfo.writerConfirmed, false);
  assert.equal(liveInfo.writerUsableForMutation, false);
  assert.equal(liveInfo.sessionId, null);
});

test('removing the never guard fails the deferred-launch invariant and exposes immediate resume', async () => {
  const deferred = appHarness({ mutateNeverGuard: true });
  await deferred.context.createAgentTab({ toolType: 'codex', resumeSessionId: 'saved-source', resumePolicy: 'never', startNow: false });
  assert.throws(() => assertRestoredWithoutLaunch(deferred), /must not launch later/);
  const immediate = appHarness({ mutateNeverGuard: true });
  await immediate.context.createAgentTab({ toolType: 'codex', resumeSessionId: 'saved-source', resumePolicy: 'never', startNow: true });
  assert.equal(immediate.calls.filter(([kind]) => kind === 'resumeNow').length, 1);
});

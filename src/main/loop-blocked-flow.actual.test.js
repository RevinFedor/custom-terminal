const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { TaskCompletionIntentRegistry, taskCompletionOutcomeMeta, findTaskCompletionBlockers } = require('./task-completion-intent');

const main = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const web = fs.readFileSync(require.resolve('./web-server.js'), 'utf8');
const mcp = fs.readFileSync(require.resolve('../../mcp/terminal-server.mjs'), 'utf8');
const runner = fs.readFileSync(require.resolve('../renderer/hooks/usePromptQueueRunner.ts'), 'utf8');
const registration = main.slice(main.indexOf('function registerTaskCompletionIntent('), main.indexOf('function getActiveAgentExecutionContext('));
const routeStart = web.indexOf("m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/complete-task$/);");
assert.ok(routeStart > 0, 'canonical completion route exists');
const route = web.slice(routeStart, web.indexOf('\n  //', routeStart + 120));
const stopStart = runner.indexOf('      const tabId = data.tabId;\n      const explicitTaskComplete');
assert.ok(stopStart > 0, 'actual Loop stop branch exists');
const stopBranch = runner.slice(stopStart, runner.indexOf('      const ownersAtOutcome', stopStart));

function requestHarness({ children = [], eligible = true } = {}) {
  const registry = new TaskCompletionIntentRegistry();
  registry.beginTurn({ tabId: 'T', provider: 'codex', sessionId: 'S', turnId: 'turn1', completionEligible: eligible });
  const context = vm.createContext({ taskCompletionIntents: registry,
    codexTurnWatchers: new Map([['T', { busy: true }]]), claudeTurnBusy: new Map(), console: { log() {} } });
  vm.runInContext(registration, context);
  return { registry, async call(body) {
    const response = {};
    Object.assign(context, { parsed: { pathname: '/api/terminal-tabs/T/complete-task' }, req: { method: 'POST' }, res: {},
      decId: decodeURIComponent, readBody: async () => body,
      cleanOptionalString: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      findTaskCompletionBlockers, getOrchestrationRunStore: () => ({ listActive: async () => children }),
      sendJson: (_res, status, value) => { Object.assign(response, { status, value }); return response; } });
    await vm.runInContext('(async () => { let m; ' + route + ' })()', context);
    return response;
  } };
}

test('actual HTTP→main registry→natural end→renderer stops blocked Loop without completing task or deleting queue', async () => {
  const h = requestHarness();
  const response = await h.call({ sourceMeta: { tabId: 'T' }, status: 'blocked', reason: 'Разблокируйте Mac и оставьте Yandex открытым' });
  assert.equal(response.status, 200);
  assert.equal(h.registry.getTurn('T').completionStatus, 'blocked');
  const data = { tabId: 'T', ...taskCompletionOutcomeMeta(h.registry.finishTurn({ tabId: 'T', provider: 'codex', sessionId: 'S', turnId: 'turn1', success: true })) };
  assert.equal(data.explicitTaskComplete, false);
  assert.equal(data.explicitTaskBlocked, true);
  const queue = { loopPromptEnabled: true, items: [{ id: 'keep' }], autoRun: true };
  const toasts = [];
  vm.runInNewContext(stopBranch, { data, usePromptQueueStore: { getState: () => ({
    getQueue: () => queue, setLoopPromptEnabled: (_id, value) => { queue.loopPromptEnabled = value; },
  }) }, getTabName: () => 'target', useUIStore: { getState: () => ({ showToast: (text) => toasts.push(text) }) }, console: { log() {} } });
  assert.equal(queue.loopPromptEnabled, false);
  assert.equal(queue.autoRun, true);
  assert.deepEqual(queue.items, [{ id: 'keep' }]);
  assert.match(toasts[0], /Разблокируйте Mac/);
});

test('actual endpoint refuses manual turns, missing reason, foreign caller and active children', async () => {
  const body = { status: 'blocked', reason: 'locked', sourceMeta: { tabId: 'T' } };
  assert.equal((await requestHarness({ eligible: false }).call(body)).value.code, 'completion_protocol_not_active');
  assert.equal((await requestHarness().call({ ...body, reason: ' ' })).value.code, 'blocked_reason_required');
  assert.equal((await requestHarness().call({ ...body, sourceMeta: { tabId: 'foreign' } })).status, 403);
  assert.equal((await requestHarness({ children: [{ sourceTabId: 'T', runId: 'child', status: 'running' }] }).call(body)).value.code, 'active_child_delegations');
});

test('natural turn without a stop signal does not disable useful read-only Loop work', () => {
  const queue = { loopPromptEnabled: true };
  vm.runInNewContext(stopBranch, { data: { tabId: 'T' },
    usePromptQueueStore: { getState: () => ({ getQueue: () => queue, setLoopPromptEnabled() { assert.fail('read-only work is not blocked'); } }) } });
  assert.equal(queue.loopPromptEnabled, true);
});

test('actual MCP wrapper forwards blocked status and reason with self-only identity', async () => {
  const start = mcp.indexOf("    case 'complete_task': {");
  const body = mcp.slice(start, mcp.indexOf("    case 'rename_tab':", start));
  let request;
  const result = await vm.runInNewContext('(async () => { switch ("complete_task") {' + body + '} })()', {
    args: { status: 'blocked', reason: 'locked' }, EXTERNAL_MODE: false,
    PARENT_TAB_ID: () => 'T', PARENT_PROJECT_ID: () => 'P', PROJECT_CWD_: () => '/project',
    projectHint: () => 'instance', buildSourceMeta: () => ({ tabId: 'T' }),
    httpApiGet: async () => ({ capabilities: { loopTaskCompletion: { version: 2, statuses: ['completed', 'blocked'] } } }),
    httpApiPost: async (_target, pathname, payload) => { request = { pathname, payload }; return { ok: true }; },
  });
  assert.equal(request.pathname, '/api/terminal-tabs/T/complete-task');
  assert.equal(request.payload.status, 'blocked');
  assert.equal(request.payload.reason, 'locked');
  assert.match(JSON.parse(result).message, /not completed/);
});

test('updated MCP refuses blocked before POST to an old app that could misread it as success', async () => {
  const start = mcp.indexOf("    case 'complete_task': {");
  const body = mcp.slice(start, mcp.indexOf("    case 'rename_tab':", start));
  let posts = 0;
  await assert.rejects(vm.runInNewContext('(async () => { switch ("complete_task") {' + body + '} })()', {
    args: { status: 'blocked', reason: 'locked' }, EXTERNAL_MODE: false,
    PARENT_TAB_ID: () => 'T', PARENT_PROJECT_ID: () => 'P', PROJECT_CWD_: () => '/project',
    projectHint: () => 'old', httpApiGet: async () => ({ capabilities: {} }),
    httpApiPost: async () => { posts++; },
  }), /Nothing was marked complete/);
  assert.equal(posts, 0);
});

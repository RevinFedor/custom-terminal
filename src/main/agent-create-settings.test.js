'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { normalizeClaudeStartupIntent, applyClaudeStartupIntent } = require('./claude-startup-main-runtime');

async function runClaudeCreate(payload = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  const start = source.indexOf("if (action === 'createAgentTab')");
  const end = source.indexOf("if (action === 'setExternalRunMeta')", start);
  assert.ok(start > 0 && end > start);
  const tabs = new Map();
  const events = [];
  let provider = { type: 'anthropic' };
  let launchedSettings = null;
  const state = {
    async createTab(projectId, name, cwd, options) {
      tabs.set('created-tab', { name, cwd, ...options });
      return 'created-tab';
    },
    setTabCommandType() {}, markAiLaunchAutoTitle() {},
  };
  const context = vm.createContext({
    action: 'createAgentTab', payload: { toolType: 'claude', startNow: true, ...payload },
    state, console: { log() {} },
    resolveBridgeCreationTarget: async () => ({ ok: true, creation: { projectId: 'p', cwd: '/fixture' } }),
    ensureProjectWorkspace: async () => ({ tabs }),
    placeCreatedTab: async () => ({ ok: true }),
    useWorkspaceStore: { getState: () => ({ openProjects: new Map([['p', { tabs }]]) }) },
    waitForAgentLaunchAccepted: async () => ({ accepted: true }),
    reply: (ok, result) => ({ ok, result }),
    ipcRenderer: {
      async invoke(channel, args) {
        events.push(channel);
        if (channel === 'provider:set-options') {
          provider = { ...provider, ...args };
          return provider;
        }
        assert.equal(channel, 'claude:run-command');
        launchedSettings = applyClaudeStartupIntent(
          { model: 'opus', effort: 'high' }, normalizeClaudeStartupIntent(provider),
        );
        return { success: true, accepted: true };
      },
    },
  });
  const js = ts.transpileModule('async function create(){' + source.slice(start, end) + '}', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInContext(js, context);
  const result = await context.create();
  return { result, events, launchedSettings, createdTab: tabs.get('created-tab') };
}

test('real createAgentTab caller saves Fable/max before the Claude launch transaction starts', async () => {
  const r = await runClaudeCreate({ codexModel: 'claude-fable-5-1', codexEffort: 'max' });
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.events, ['provider:set-options', 'claude:run-command']);
  assert.equal(r.launchedSettings.model, 'claude-fable-5-1');
  assert.equal(r.launchedSettings.effort, 'max');
});

test('model-only create preserves effort defaults and absent overrides do not write intent', async () => {
  const modelOnly = await runClaudeCreate({ codexModel: 'claude-fable-5-1' });
  assert.equal(modelOnly.launchedSettings.model, 'claude-fable-5-1');
  assert.equal(modelOnly.launchedSettings.effort, 'high');
  const defaults = await runClaudeCreate();
  assert.deepEqual(defaults.events, ['claude:run-command']);
  assert.deepEqual(defaults.launchedSettings, { model: 'opus', effort: 'high' });
});

test('createAgentTab can keep a readable provisional name under auto-title ownership', async () => {
  const provisional = await runClaudeCreate({ name: 'Codex · abc12345', nameSetManually: false });
  assert.equal(provisional.createdTab.name, 'Codex · abc12345');
  assert.equal(provisional.createdTab.nameSetManually, false);

  const explicit = await runClaudeCreate({ name: 'User title' });
  assert.equal(explicit.createdTab.name, 'User title');
  assert.equal(explicit.createdTab.nameSetManually, true, 'existing explicit-name callers remain manual by default');
});

test('Terminal MCP start_ai preserves explicit Claude model/effort in the same startup intent', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('const requestedStartupIntent = normalizeClaudeStartupIntent(');
  const end = source.indexOf('const runResult = await runClaudeCommandSerialized(', start);
  assert.ok(start > 0 && end > start);
  for (const requested of [{ model: 'claude-fable-5-1[1m]', effort: 'max' },
    { model: 'claude-haiku-4-5-20251001' }, { effort: 'low' }, {}]) {
    const calls = [];
    vm.runInNewContext(source.slice(start, end), {
      tabId: 'test-tab', model: requested.model, effort: requested.effort,
      normalizeClaudeStartupIntent,
      updateProviderOptionsForTab: (tabId, options) => calls.push({ tabId, options }),
    });
    const expected = Object.keys(requested).length ? [{
      tabId: 'test-tab', options: {
        ...(requested.model ? { startupModel: requested.model } : {}),
        ...(requested.effort ? { startupEffort: requested.effort } : {}),
      },
    }] : [];
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), expected);
  }
});

test('shared startup options mutate only the requested tab, preserving provider/global defaults', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('function updateProviderOptionsForTab(');
  const end = source.indexOf("ipcMain.handle('provider:set-options'", start);
  assert.ok(start > 0 && end > start);
  const states = new Map([['T', { type: 'anthropic', effort: 'high', untouched: 42 }],
    [null, { type: 'anthropic', effort: 'max', startupModel: 'global-model' }]]);
  const persisted = [];
  const context = vm.createContext({
    getProviderState: id => states.get(id),
    setProviderState: (id, value) => states.set(id, value),
    projectManager: { db: { updateTabProviderState: id => persisted.push(id) } },
    broadcastProviderState() {}, console: { log() {} },
  });
  vm.runInContext(source.slice(start, end), context);
  context.updateProviderOptionsForTab('T', { startupModel: 'haiku', startupEffort: 'low' });
  assert.equal(states.get('T').type, 'anthropic');
  assert.equal(states.get('T').effort, 'high');
  assert.equal(states.get('T').untouched, 42);
  assert.equal(states.get('T').startupModel, 'haiku');
  assert.equal(states.get(null).startupModel, 'global-model');
  assert.deepEqual(persisted, ['T']);
});

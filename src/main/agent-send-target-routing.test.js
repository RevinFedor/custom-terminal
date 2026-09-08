'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test('bridge tab lookup observes a restored workspace rather than its pre-await snapshot', () => {
  const start = source.indexOf('const findTab = (tabId?: string, projectId?: string | null)');
  const end = source.indexOf('const toolForTab =', start);
  assert.ok(start > 0 && end > start);
  const tab = { tabId: 'target' };
  const context = vm.createContext({
    state: { openProjects: new Map() },
    useWorkspaceStore: { getState: () => ({
      openProjects: new Map([['project', { tabs: new Map([['target', tab]]) }]]),
    }) },
  });
  vm.runInContext(compile(source.slice(start, end) + '\nglobalThis.lookup = findTab;'), context);
  assert.equal(context.lookup('target', 'project'), tab);
});

async function route({ initial = null, restored = null, restoreError = null, expectedToolType = 'codex', expectedTabType = 'terminal', expectedSessionId = null } = {}) {
  const start = source.indexOf("if (action === 'sendMessageAuto' || action === 'sendAgentPromptScenario')");
  const end = source.indexOf("if (action === 'sendClaudeMessage')", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  let current = initial;
  const context = vm.createContext({
    action: 'sendAgentPromptScenario',
    payload: { tabId: 'target', targetProjectId: 'project', prompt: 'user prompt',
      handoffId: 'handoff', source: 'terminal-mcp', expectedToolType, expectedTabType, expectedSessionId },
    describeAgentTab: () => ({ tab: current, toolType: current?.tabType === 'claude-sdk'
      ? null : current?.commandType || null, runtime: current?.tabType === 'claude-sdk' ? null : current,
      sessionId: 'S' }),
    ensureProjectWorkspace: async project => {
      calls.push('restore:' + project);
      if (restoreError) throw restoreError;
      current = restored;
    },
    runHistoryPromptHandoff: async args => args.send(args.handoffId),
    createAgentSettingsIntent: () => ({}),
    sendAgentPromptScenario: async args => { calls.push('pty:' + args.toolType); return { success: true, submitted: true }; },
    maybeAutoTitleAfterMobileSend() {},
    reply: (ok, data) => ({ ok, data }),
    window: { dispatchEvent() {} }, CustomEvent: function () {},
    ipcRenderer: { invoke: async channel => { calls.push(channel); return { success: true }; } },
  });
  vm.runInContext(compile('async function run(){' + source.slice(start, end) + '}'), context);
  return { result: await context.run(), calls };
}

test('a closed Codex project restores in background and keeps its PTY provider', async () => {
  const r = await route({ restored: { commandType: 'codex', cwd: '/project/sub' } });
  assert.equal(r.result.data.submitted, true);
  assert.deepEqual(r.calls, ['restore:project', 'pty:codex']);
});

test('missing or mismatched PTY targets never fall through to a hidden Claude SDK request', async () => {
  for (const args of [{}, { initial: { commandType: 'claude' } },
    { initial: { tabType: 'claude-sdk' } }]) {
    const r = await route(args);
    assert.equal(r.result.data.submitted, false);
    assert.equal(r.result.data.code, 'agent_target_not_resolved');
    assert.equal(r.calls.some(call => call.startsWith('pty:') || call.startsWith('claude-sdk:')), false);
  }
});

test('an explicitly identified SDK tab retains its existing send path', async () => {
  const r = await route({ initial: { tabType: 'claude-sdk' }, expectedToolType: 'claude', expectedTabType: 'claude-sdk' });
  assert.equal(r.result.data.success, true);
  assert.deepEqual(r.calls, ['claude-sdk:send-message']);
});

test('a failed project restore is a pre-Enter refusal, not a missing transport receipt', async () => {
  const r = await route({ restoreError: new Error('project unavailable') });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.data.submitted, false);
  assert.equal(r.result.data.code, 'agent_target_restore_failed');
  assert.deepEqual(r.calls, ['restore:project']);
});

test('an expected SDK tab cannot silently become a Claude PTY target either', async () => {
  const r = await route({ initial: { commandType: 'claude' },
    expectedToolType: 'claude', expectedTabType: 'claude-sdk' });
  assert.equal(r.result.data.submitted, false);
  assert.equal(r.result.data.code, 'agent_target_not_resolved');
  assert.deepEqual(r.calls, []);
});

test('a delayed callback cannot submit into another session now occupying the same tab', async () => {
  const r = await route({ initial: { commandType: 'codex' }, expectedSessionId: 'old-source' });
  assert.equal(r.result.data.code, 'agent_send_target_changed');
  assert.equal(r.result.data.submitted, false);
  assert.deepEqual(r.calls, []);
  const same = await route({ initial: { commandType: 'codex' }, expectedSessionId: 'S' });
  assert.equal(same.result.data.submitted, true);
});

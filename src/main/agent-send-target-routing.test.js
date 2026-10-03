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

async function route({ initial = null, restored = null, restoreError = null, expectedToolType = 'codex',
  expectedTabType = 'terminal', expectedSessionId = null, expectedTarget = undefined,
  describedSessionId = 'S', scenarioResult = null } = {}) {
  const start = source.indexOf("if (action === 'sendMessageAuto' || action === 'sendAgentPromptScenario')");
  const end = source.indexOf("if (action === 'sendClaudeMessage')", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const scenarioCalls = [];
  let current = initial;
  const context = vm.createContext({
    action: 'sendAgentPromptScenario',
    payload: { tabId: 'target', targetProjectId: 'project', prompt: 'user prompt',
      handoffId: 'handoff', source: 'terminal-mcp', expectedToolType, expectedTabType, expectedSessionId, expectedTarget },
    describeAgentTab: () => ({ tab: current, toolType: current?.tabType === 'claude-sdk'
      ? null : current?.commandType || null, runtime: current?.tabType === 'claude-sdk' ? null : current,
      sessionId: describedSessionId }),
    ensureProjectWorkspace: async project => {
      calls.push('restore:' + project);
      if (restoreError) throw restoreError;
      current = restored;
    },
    runHistoryPromptHandoff: async args => args.send(args.handoffId),
    prepareTabWorkContext: async (_tabId, _handoffId, prompt) => ({ prompt }),
    createAgentSettingsIntent: () => ({}),
    sendAgentPromptScenario: async args => {
      calls.push('pty:' + args.toolType); scenarioCalls.push(args);
      return scenarioResult || { success: true, submitted: true };
    },
    maybeAutoTitleAfterMobileSend() {},
    reply: (ok, data) => ({ ok, data }),
    window: { dispatchEvent() {} }, CustomEvent: function () {},
    ipcRenderer: { invoke: async channel => { calls.push(channel); return { success: true }; } },
  });
  vm.runInContext(compile('async function run(){' + source.slice(start, end) + '}'), context);
  return { result: await context.run(), calls, scenarioCalls };
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

for (const toolType of ['claude', 'codex']) {
  test(toolType + ' App passes a full provisional pin unchanged when the launch has materialized', async () => {
    const expectedTarget = Object.freeze({ toolType, terminalInstanceId: 'terminal-A', launchId: 'launch-A', runSeq: 7 });
    const r = await route({ initial: { commandType: toolType }, expectedToolType: toolType,
      expectedTarget, describedSessionId: 'materialized-A' });
    assert.equal(r.result.data.submitted, true);
    assert.equal(r.scenarioCalls.length, 1);
    assert.equal(r.scenarioCalls[0].expectedTarget, expectedTarget, 'App must not reconstruct the pin from its current session');
    assert.equal(r.scenarioCalls[0].sessionId, 'materialized-A');
    assert.deepEqual({ ...r.scenarioCalls[0].expectedTarget },
      { toolType, terminalInstanceId: 'terminal-A', launchId: 'launch-A', runSeq: 7 });
  });

  test(toolType + ' App defers accepted Resume SID differences to authoritative scenario proof', async () => {
    const expectedTarget = Object.freeze({ toolType, sessionId: 'original-A' });
    const r = await route({ initial: { commandType: toolType }, expectedToolType: toolType,
      expectedSessionId: 'original-A', describedSessionId: 'resumed-writer-B', expectedTarget });
    assert.equal(r.result.data.submitted, true, 'App SID equality must not preempt the exact Resume proof');
    assert.equal(r.scenarioCalls[0].expectedTarget, expectedTarget);
    assert.equal(r.scenarioCalls[0].sessionId, 'resumed-writer-B');
    assert.deepEqual(r.calls, ['pty:' + toolType]);
  });

  test(toolType + ' App preserves the original pin and returns the scenario refusal after target replacement', async () => {
    const expectedTarget = Object.freeze({ toolType, terminalInstanceId: 'terminal-A', launchId: 'launch-A', runSeq: 7 });
    const r = await route({ initial: { commandType: toolType }, expectedToolType: toolType,
      expectedTarget, describedSessionId: 'replacement-B', scenarioResult: {
        success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
        code: 'agent_send_target_changed',
      } });
    assert.equal(r.scenarioCalls[0].expectedTarget, expectedTarget);
    assert.equal(r.result.data.code, 'agent_send_target_changed');
    assert.equal(r.result.data.submitted, false);
    assert.equal(r.result.data.pasteWritten, false);
    assert.equal(r.result.data.enterWritten, false);
  });
}

test('SDK keeps direct SID equality even when the bridge carries a full expectedTarget', async () => {
  const expectedTarget = Object.freeze({ toolType: 'claude', sessionId: 'sdk-A' });
  const mismatch = await route({ initial: { tabType: 'claude-sdk' }, expectedToolType: 'claude',
    expectedTabType: 'claude-sdk', expectedSessionId: 'sdk-A', describedSessionId: 'sdk-B', expectedTarget });
  assert.equal(mismatch.result.data.code, 'agent_send_target_changed');
  assert.equal(mismatch.result.data.submitted, false);
  assert.deepEqual(mismatch.calls, []);
  assert.equal(mismatch.scenarioCalls.length, 0);
  const same = await route({ initial: { tabType: 'claude-sdk' }, expectedToolType: 'claude',
    expectedTabType: 'claude-sdk', expectedSessionId: 'sdk-A', describedSessionId: 'sdk-A', expectedTarget });
  assert.equal(same.result.data.success, true);
  assert.deepEqual(same.calls, ['claude-sdk:send-message']);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Claude, Codex, and Stop share the same main-owned per-tab lifecycle queue', () => {
  const main = read('src/main/main.js');
  assert.match(main, /const aiLifecycleActionInflight = new Map\(\)/);
  assert.match(main, /runCodexCommandFromPayload[\s\S]*?runKeyedExclusive\(aiLifecycleActionInflight, tabId/);
  assert.match(main, /runClaudeCommandSerialized[\s\S]*?runKeyedExclusive\(aiLifecycleActionInflight, tabId/);
  assert.match(main, /stopAiProcessInTabSerialized[\s\S]*?runKeyedExclusive\(aiLifecycleActionInflight, tabId/);
  assert.doesNotMatch(main, /aiShellLaunchInflight/);
});

test('automatic restore is typed and orchestration Stop carries exact authority end to end', () => {
  const app = read('src/renderer/App.tsx');
  const scenarios = read('src/renderer/utils/agentScenarios.ts');
  const runtimes = read('src/renderer/utils/historyAgentRuntimes.ts');
  const claude = read('src/renderer/utils/claudePtyActions.ts');
  const web = read('src/main/web-server.js');
  const main = read('src/main/main.js');

  assert.match(app, /launchSource: 'auto-resume'/);
  assert.match(app, /stopAgentProcessScenario\([\s\S]*?reason:[\s\S]*?authority:/);
  assert.match(scenarios, /runtime\.stopProcess\(tabId, \{ reason, authority \}\)/);
  assert.match(runtimes, /terminal:stop-ai-process[\s\S]*?authority/);
  assert.match(claude, /terminal:stop-ai-process[\s\S]*?authority/);
  assert.match(web, /claimDueAutoStop[\s\S]*?kind: 'orchestration-auto-stop'[\s\S]*?claimId/);
  assert.match(main, /validateOrchestrationAutoStopGuard[\s\S]*?compareAiLifecycleIdentity/);
});

test('Codex MCP recovery keeps Stop and replacement in one lifecycle transaction', () => {
  const main = read('src/main/main.js');
  const recovery = main.slice(
    main.indexOf('async function restartCodexAfterMcpStartupWatchdog'),
    main.indexOf('function clearCodexMcpStartupWatchdog'),
  );
  assert.match(recovery, /runKeyedExclusive\(codexLaunchInflight, tabId/);
  assert.match(recovery, /runKeyedExclusive\(aiLifecycleActionInflight, tabId/);
  assert.match(recovery, /stopAiProcessInTab\(tabId/);
  assert.match(recovery, /retainStoppingState: true/);
  assert.match(recovery, /handoff\.stopAbsenceProven = true/);
  assert.match(recovery, /runCodexCommandWithinLifecycle/);
  assert.match(recovery, /launchId: undefined/);
  assert.doesNotMatch(recovery, /stopAiProcessInTabSerialized/);
  assert.doesNotMatch(recovery, /runCodexCommandFromPayload\(sender/);

  const launchBoundary = main.slice(
    main.indexOf('const boundary = await withPtyWriteLock(term'),
    main.indexOf("rollbackLaunchSetup('shell-launch-boundary-rejected'"),
  );
  assert.match(launchBoundary, /validateClaimedCodexMcpStartupReplacementHandoff/);
  assert.match(
    launchBoundary,
    /releaseCodexMcpStartupReplacementHandoff\([\s\S]*?writeAgentLaunchCommandToIdleShell/,
  );
  assert.doesNotMatch(
    launchBoundary.slice(
      launchBoundary.indexOf('releaseCodexMcpStartupReplacementHandoff'),
      launchBoundary.indexOf('writeAgentLaunchCommandToIdleShell'),
    ),
    /await\s/,
  );
  assert.match(recovery, /getHeadlessVisibleBufferSnapshot\([\s\S]*?mcp-watchdog-pre-signal-current-frame/);
  assert.match(recovery, /expectedCommittedFrameGeneration: currentScreen\.committedFrameGeneration/);
  assert.match(recovery, /currentCommittedFrameGeneration: currentCommittedFrame\?\.committedFrameGeneration/);
  assert.match(main, /destructiveProofAvailable:[\s\S]*?authoritativeFrameCommitted === true[\s\S]*?committedFrameGeneration/);
  assert.match(main, /onFlushed:[\s\S]*?commitHeadlessVisibleBufferSnapshot/);
  assert.match(main, /synchronizedOutputOpen === true[\s\S]*?lastCommittedVisibleSnapshot[\s\S]*?committedFrameReplay: true/);
});

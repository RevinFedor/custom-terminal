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

test('Claude spinner remains diagnostic and cannot mutate public busy state', () => {
  const main = read('src/main/main.js');
  const app = read('src/renderer/App.tsx');
  const tabBar = read('src/renderer/components/Workspace/TabBar.tsx');
  const terminalArea = read('src/renderer/components/Workspace/TerminalArea.tsx');
  const controlBar = read('src/renderer/components/Workspace/ClaudeControlBar.tsx');
  const runAfterPicker = read('src/renderer/components/Workspace/RunAfterTabPicker.tsx');

  const spinnerStart = main.lastIndexOf('// ========== CLAUDE BUSY DETECTION (Content Spinner) ==========');
  const spinnerEnd = main.indexOf('// ========== END CLAUDE BUSY DETECTION ==========', spinnerStart);
  assert.ok(spinnerStart > 0 && spinnerEnd > spinnerStart, 'Claude spinner detector must remain bounded');
  const spinnerBlock = main.slice(spinnerStart, spinnerEnd);
  assert.doesNotMatch(spinnerBlock, /recordActivity\(/,
    'a visual glyph must not open or close response timing');
  assert.doesNotMatch(spinnerBlock, /webContents\.send\('claude:busy-state'/,
    'a visual glyph must not publish a lifecycle edge');

  const activeLoaders = main.slice(
    main.indexOf('function computeActiveLoaders'),
    main.indexOf('// 2) SDK Claude', main.indexOf('function computeActiveLoaders')),
  );
  const claudeLoaderProjection = activeLoaders.slice(
    activeLoaders.indexOf('for (const tabId of bridgeKnownSessions.keys())'),
  );
  assert.doesNotMatch(claudeLoaderProjection, /claudeSpinnerBusy\.get\(tabId\)/,
    'Build Install blockers must use exact turn/local-command state');

  const sessionProjection = main.slice(
    main.indexOf('const claudeTurn = !isCodex'),
    main.indexOf('const sessionStatus = isCodex', main.indexOf('const claudeTurn = !isCodex')),
  );
  assert.doesNotMatch(sessionProjection, /busySources\.push\('claude-spinner'\)/,
    'Terminal MCP session status must not treat the glyph as a turn');
  assert.match(main, /spinnerVisible:\s*claudeSpinner/,
    'spinner observability may remain separate from the public busy verdict');

  assert.match(app, /handleClaudeBusyState[\s\S]{0,500}if \(data\.reason === 'spinner'\) return/);
  assert.match(tabBar, /handleClaudeBusy[\s\S]{0,500}if \(reason === 'spinner'\) return/);
  assert.match(terminalArea, /onClaudeBusy[\s\S]{0,300}data\.reason === 'spinner'/);
  assert.match(controlBar, /onAgentBusy[\s\S]{0,400}data\.reason === 'spinner'/);
  assert.match(runAfterPicker, /handleClaudeBusy[\s\S]{0,300}if \(reason === 'spinner'\) return/);
});

test('a typed Claude fatal frame closes the same turn consumed by loader and orchestration', () => {
  const main = read('src/main/main.js');
  const classifier = read('src/main/claude-provider-fatal-state.js');
  const commit = main.slice(
    main.indexOf('function commitHeadlessVisibleBufferSnapshot'),
    main.indexOf('function parseClaudeDraftFromVisibleSnapshot'),
  );
  const observer = main.slice(
    main.indexOf('function claudeProviderFatalWatchStillOwnsTurn'),
    main.indexOf('let claudeHookServer = null'),
  );

  assert.match(classifier, /authoritativeFrameCommitted !== true/);
  assert.match(classifier, /liveSynchronizedOutputOpen === true/);
  assert.match(classifier, /Context limit reached/);
  assert.match(classifier, /compact or/);
  assert.match(classifier, /hasNonDefaultFg !== true/);
  assert.doesNotMatch(classifier, /startsWith\(['"]API Error/,
    'arbitrary red provider prose must not become a lifecycle result');
  assert.match(commit, /observeClaudeProviderFatalCommittedFrame/);
  assert.match(observer, /getActiveAgentExecutionContext\(tabId\)/);
  assert.match(observer, /active\.turnId !== watch\.turnId/);
  assert.match(observer, /taskCompletionIntents\.finishTurn\(\{/);
  assert.match(observer, /claudeTurnBusy\.set\(tabId, false\)/);
  assert.match(observer, /const outcome = \{[\s\S]{0,120}reason: 'provider_error'/);
  assert.match(observer, /_webBroadcast\(tabId, \{ type: 'done', \.\.\.outcome \}\)/);
  assert.match(observer, /providerErrorCode: fatal\.code/);
});

test('automatic restore is typed and orchestration Stop carries exact authority end to end', () => {
  const app = read('src/renderer/App.tsx');
  const scenarios = read('src/renderer/utils/agentScenarios.ts');
  const runtimes = read('src/renderer/utils/historyAgentRuntimes.ts');
  const claude = read('src/renderer/utils/claudePtyActions.ts');
  const web = read('src/main/web-server.js');
  const main = read('src/main/main.js');
  const stopHandlerStart = app.indexOf("if (action === 'stopClaudeTab' || action === 'stopAgentProcessScenario')");
  const stopHandlerEnd = app.indexOf("if (action === 'interruptClaudeTurn'", stopHandlerStart);
  assert.ok(stopHandlerStart >= 0 && stopHandlerEnd > stopHandlerStart, 'stop bridge handler must be addressable');
  const stopHandler = app.slice(stopHandlerStart, stopHandlerEnd);

  assert.match(app, /launchSource: 'auto-resume'/);
  assert.match(stopHandler, /const \{ tabId, reason, authority \} = payload \|\| \{\}/);
  assert.match(stopHandler, /stopAgentProcessScenario\(\{[\s\S]*?reason:[\s\S]*?authority:/);
  assert.match(scenarios, /runtime\.stopProcess\(tabId, \{ reason, authority \}\)/);
  assert.match(runtimes, /terminal:stop-ai-process[\s\S]*?authority/);
  assert.match(claude, /terminal:stop-ai-process[\s\S]*?authority/);
  assert.match(web, /claimDueAutoStop[\s\S]*?kind: 'orchestration-auto-stop'[\s\S]*?claimId/);
  assert.match(main, /validateOrchestrationAutoStopGuard[\s\S]*?compareAiLifecycleIdentity/);
});

test('bottom control-bar Start and Continue retire Interrupted only after launch acceptance', () => {
  const controlBar = read('src/renderer/components/Workspace/ClaudeControlBar.tsx');
  const start = controlBar.slice(
    controlBar.indexOf('const onStart = async () =>'),
    controlBar.indexOf('const onContinue = async () =>'),
  );
  const continued = controlBar.slice(
    controlBar.indexOf('const onContinue = async () =>'),
    controlBar.indexOf('const onStop = async () =>'),
  );

  assert.match(
    controlBar,
    /const clearInterruptedAfterAcceptedControlLaunch = \(\) => \{[\s\S]*?clearInterruptedState\(tabId\)/,
  );
  assert.equal(
    start.match(/clearInterruptedAfterAcceptedControlLaunch\(\);/g)?.length,
    3,
    'Start must retire stale recovery state for Claude, Codex, and Gemini',
  );
  assert.equal(
    continued.match(/clearInterruptedAfterAcceptedControlLaunch\(\);/g)?.length,
    3,
    'Continue must retire stale recovery state for Claude, Codex, and Gemini',
  );
  assert.match(
    continued,
    /runCodexCommand\([\s\S]*?if \(runResult\?\.success === false \|\| runResult\?\.accepted === false\)[\s\S]*?else \{\s*clearInterruptedAfterAcceptedControlLaunch\(\)/,
    'Codex rejection must keep the interrupted recovery action available',
  );
  assert.match(
    continued,
    /claude:run-command[\s\S]*?if \(runResult\?\.success === false \|\| runResult\?\.accepted === false\)[\s\S]*?return;\s*\}\s*clearInterruptedAfterAcceptedControlLaunch\(\)/,
    'Claude rejection must keep the interrupted recovery action available',
  );
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
  assert.match(main, /mcpStartupRecoveryHandoff\.newTerminalLifecycleGeneration = getTerminalLifecycleGeneration\(tabId\)/);

  const claimedHandoff = main.slice(
    main.indexOf('function validateClaimedCodexMcpStartupReplacementHandoff'),
    main.indexOf('function releaseCodexMcpStartupReplacementHandoff'),
  );
  assert.match(claimedHandoff, /expectedTerminalGeneration: handoff\.newTerminalLifecycleGeneration/);
  assert.doesNotMatch(claimedHandoff, /currentTerminalGeneration\) !== handoff\.terminalLifecycleGeneration/);

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

  const armWatchdog = main.slice(
    main.indexOf('function maybeArmCodexMcpStartupWatchdog'),
    main.indexOf('function inspectCodexInputReadyVisibleText'),
  );
  assert.match(armWatchdog, /codexMcpStartupReplacementHandoffs\.get\(tabId\)/);
  assert.match(armWatchdog, /shouldSuppressCodexMcpWatchdogArmForReplacementHandoff/);
  assert.ok(
    armWatchdog.indexOf('shouldSuppressCodexMcpWatchdogArmForReplacementHandoff')
      < armWatchdog.indexOf('getCodexMcpStartupWatchdogState'),
    'a residual stopped frame must be rejected before it can create a new watchdog generation',
  );
});

test('late Codex MCP output is gated until the same headless frame commits', () => {
  const main = read('src/main/main.js');
  const identity = main.slice(
    main.indexOf('function getCodexLateMcpRecoveryIdentity'),
    main.indexOf('function clearCodexLateMcpProofPending'),
  );
  assert.match(identity, /validateCodexLateMcpRecoveryIdentity/);
  assert.match(identity, /terminalLifecycleGeneration/);
  assert.match(identity, /terminalRunSeq/);
  assert.match(identity, /inputRevision/);
  assert.match(identity, /launchId/);
  assert.match(identity, /currentProcessRunning/);
  assert.match(identity, /currentStopping/);
  const headlessCreate = main.slice(
    main.indexOf('function createHeadlessTerminalMirror'),
    main.indexOf('function waitForHeadlessSynchronizedOutputClose'),
  );
  assert.match(
    headlessCreate,
    /commitHeadlessVisibleBufferSnapshot[\s\S]*observeCodexLateMcpProofAfterHeadlessFlush/,
  );

  const arm = main.slice(
    main.indexOf('function armCodexLateMcpProofPending'),
    main.indexOf('function observeCodexLateMcpProofAfterHeadlessFlush'),
  );
  assert.match(arm, /getCodexLateMcpRecoveryIdentity/);
  assert.match(arm, /candidateWriteSeq: Number\(writeIdentity\.writeSeq\)/);
  assert.match(arm, /mirrorGeneration: writeIdentity\.generation/);
  assert.match(arm, /emitAgentReadinessChanged/);

  const observer = main.slice(
    main.indexOf('function observeCodexLateMcpProofAfterHeadlessFlush'),
    main.indexOf('function clearCodexTuiReady'),
  );
  assert.match(observer, /decideCodexLateMcpCommittedFrame/);
  assert.match(observer, /committedSnapshot\?\.committedWriteSeq/);
  assert.match(observer, /invalidateCodexTuiReadyForStartupBlocker/);
  assert.match(observer, /maybeArmCodexMcpStartupWatchdog/);

  const dataHandler = main.slice(
    main.indexOf('ptyProcess.onData((data) =>'),
    main.indexOf('ptyProcess.onExit', main.indexOf('ptyProcess.onData((data) =>')),
  );
  assert.match(dataHandler, /prepareCodexTuiReadyFrame\(tabId, data\)/);
  assert.match(dataHandler, /onHeadlessWriteReserved:[\s\S]*armCodexLateMcpProofPending/);
  assert.match(dataHandler, /headlessPresentationWrite[\s\S]*mcp-startup-proof-unavailable/);

  const streamObserver = main.slice(
    main.indexOf('async function tryEmitCodexTuiReady'),
    main.indexOf('function closeCodexWatcher'),
  );
  assert.match(streamObserver, /shouldDeferCodexLateMcpCandidateToCommittedFrame/);
  assert.ok(
    streamObserver.indexOf('shouldDeferCodexLateMcpCandidateToCommittedFrame')
      < streamObserver.indexOf('invalidateCodexTuiReadyForStartupBlocker'),
    'the raw candidate must defer before any readiness invalidation',
  );

  const readyCommit = main.slice(
    main.indexOf('async function markCodexTuiReadyAfterVerifiedComposer'),
    main.indexOf('async function pokeCodexStartupPromptFromVisibleBuffer'),
  );
  assert.match(
    readyCommit,
    /finishCodexStartupLifecycle\(tabId, reason, \{[\s\S]*preserveLateMcpRecovery: true/,
  );
  const taskStarted = main.slice(
    main.indexOf("clearCodexPromptInFlight(state.tabId, 'task_started')"),
    main.indexOf("clearCodexPromptInFlight(state.tabId, 'task_started')") + 300,
  );
  assert.match(taskStarted, /finishCodexStartupLifecycle\(state\.tabId, 'task_started'\)/);
  assert.doesNotMatch(taskStarted, /preserveLateMcpRecovery/);

  const submitRevalidation = main.slice(
    main.indexOf('function revalidateCodexPtySubmitAdmission'),
    main.indexOf('function captureClaudePromptQueuePtyAdmission'),
  );
  assert.match(
    submitRevalidation,
    /inputReadinessProofPending: codexLateMcpProofPending\.has\(token\.tabId\)/,
  );

  const getState = main.slice(
    main.indexOf('async function getCodexTuiReadyState'),
    main.indexOf('async function markCodexTuiReadyAfterVerifiedComposer'),
  );
  assert.match(
    getState,
    /if \(codexTuiReadyTabs\.has\(tabId\)\) \{[\s\S]*inspectAiDescendantProcessesByTabCached/,
  );
  assert.match(getState, /inputReady: textReady && processReady/);

  const publicRuntime = main.slice(
    main.indexOf('function getCodexPublicRuntimeProjection'),
    main.indexOf('function broadcastCodexPublicRuntimeSnapshot'),
  );
  assert.match(publicRuntime, /tuiInputReady: isCodexTuiEffectivelyReady\(tabId\)/);
  assert.match(publicRuntime, /tuiLifecycleEstablished: codexTuiReadyTabs\.has\(tabId\)/);
  assert.match(publicRuntime, /inputProofPending: proofPending/);

  const reset = main.slice(
    main.indexOf('function resetCodexTuiReadyDetection'),
    main.indexOf('function inspectCodexStartupBlockersText'),
  );
  assert.match(reset, /clearCodexLateMcpProofPending[\s\S]*notifyReady: false/);
});

test('Codex draft authority rejects the xterm reflow until a newer PTY frame commits', () => {
  const main = read('src/main/main.js');
  const resize = main.slice(
    main.indexOf('function resizeHeadlessTerminalMirror'),
    main.indexOf('function disposeHeadlessTerminalMirror'),
  );
  assert.match(resize, /pendingResizeWriteSeq = Number\(state\.writeSeq \|\| 0\)/);
  assert.doesNotMatch(resize, /commitHeadlessVisibleBufferSnapshot/);

  const draftRead = main.slice(
    main.indexOf('function getHeadlessCodexDraftState'),
    main.indexOf('async function waitForHeadlessCodexDraftState'),
  );
  assert.match(draftRead, /getCodexDraftFrameBlocker\(\{/);
  assert.match(draftRead, /pendingResizeWriteSeq: state\.pendingResizeWriteSeq/);
  assert.ok(
    draftRead.indexOf('getCodexDraftFrameBlocker') < draftRead.indexOf('const buf = terminal.buffer.active'),
    'live xterm cells must not be parsed before the frame boundary is admitted',
  );

  const commit = main.slice(
    main.indexOf('function commitHeadlessVisibleBufferSnapshot'),
    main.indexOf('function parseClaudeDraftFromVisibleSnapshot'),
  );
  assert.match(commit, /frameBlocker !== null/);
  assert.match(commit, /state\.pendingResizeWriteSeq = null/);
});

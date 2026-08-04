'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoDir = path.join(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(repoDir, 'src/main/main.js'), 'utf8');
const historyRuntimeSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/utils/historyAgentRuntimes.ts'),
  'utf8',
);
const webServerSource = fs.readFileSync(path.join(repoDir, 'src/main/web-server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(repoDir, 'src/renderer/App.tsx'), 'utf8');
const codexIdentitySource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/utils/codexWriterIdentity.ts'),
  'utf8',
);
const codexPresenceSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/utils/codexPtyPresence.mjs'),
  'utf8',
);
const controlBarSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/ClaudeControlBar.tsx'),
  'utf8',
);
const copySessionSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/CopySessionButton.tsx'),
  'utf8',
);
const historyPanelSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const timelineSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/Timeline.tsx'),
  'utf8',
);
const workspaceSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/Workspace.tsx'),
  'utf8',
);

test('provisional Resume authorization is the same Rewind lease consumed by arm and write boundary', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('codex:open-history-menu'");
  const handlerEnd = mainSource.indexOf("ipcMain.on('claude:prompt-boundary-ack'", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /sourceContext: writeAuthorization\.sourceContext,[\s\S]{0,120}actionAuthority: rewindActionAuthority/);
  assert.match(handler, /transitionMainCodexActionAuthority\([\s\S]{0,120}'consumed',[\s\S]{0,120}'first-rewind-control-write'/);
  assert.match(handler, /markCodexWriterHandoffActionBoundary\([\s\S]{0,360}actionAuthority: rewindActionAuthority/);
  assert.ok(
    handler.indexOf("'first-rewind-control-write'") < handler.indexOf("sendCodexKeyAndCapture(\n          term,\n          '\\x1b'"),
    'the exact lease must be consumed before the first programmatic Escape',
  );
});

test('confirmed Rewind authority is main-owned even after transient launch proof is gone', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('codex:open-history-menu'");
  const handlerEnd = mainSource.indexOf("ipcMain.on('claude:prompt-boundary-ack'", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  const adoptedStart = handler.indexOf("if (authorizedWriter?.status === 'adopted')");
  const unprovenStart = handler.indexOf("} else if (!provisional)", adoptedStart);
  assert.ok(adoptedStart >= 0 && unprovenStart > adoptedStart);
  const adopted = handler.slice(adoptedStart, unprovenStart);
  assert.match(adopted, /resolveCodexNativeRewindActionGeneration\(\{/);
  assert.match(adopted, /allowLiveRunFallback: true/);
  assert.doesNotMatch(adopted, /writerLaunchId\s*\|\|/,
    'renderer launch data must not mint destructive authority');
});

test('manual native Rewind may use one exact provisional Resume source without publishing it', () => {
  const sourceStart = mainSource.indexOf('function resolveCodexNativeRewindSourceContext');
  const sourceEnd = mainSource.indexOf('function promoteCodexManualWriterBindingAfterUserMessage', sourceStart);
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
  const source = mainSource.slice(sourceStart, sourceEnd);
  assert.match(source, /discovery\?\.provisionalSourceObservation/);
  assert.match(source, /observation\.terminalToken === terminalToken/);
  assert.match(source, /Number\(observation\.runSeq\) === runSeq/);
  assert.match(source, /observation\.lifecycleGeneration === lifecycleGeneration/);
  assert.match(source, /resolveCodexReadIdentity\(\{/);
  assert.match(source, /readIdentity\.source === 'resume-source'/);
  assert.match(source, /mode: 'provisional-resume-source'/);
  assert.doesNotMatch(source, /setCodexKnownSession|persistCodexWriterBinding|compareAndSetTabCodexSessionId/);

  const watcherStart = mainSource.indexOf('function startCodexSessionWatcher');
  const watcherEnd = mainSource.indexOf('async function beginCodexLaunchObservation', watcherStart);
  assert.ok(watcherStart >= 0 && watcherEnd > watcherStart);
  const watcher = mainSource.slice(watcherStart, watcherEnd);
  assert.match(watcher, /provisionalSourceObservation: null/);
  assert.match(watcher, /adoption\?\.status === 'provisional-source'/);
  assert.match(watcher, /observerState\.provisionalSourceObservation = \{/);
  assert.match(watcher, /terminalToken: terminals\.get\(tabId\) \|\| null/);
  assert.match(watcher, /lifecycleGeneration: getTerminalLifecycleGeneration\(tabId\)/);
});

test('native Rewind controls keep one authority without admitting unrelated manual input', () => {
  const trackerStart = mainSource.indexOf('function trackManualCodexRewindNavigationInput');
  const trackerEnd = mainSource.indexOf('async function handleManualCodexRewindConfirmationEnter', trackerStart);
  assert.ok(trackerStart >= 0 && trackerEnd > trackerStart);
  const tracker = mainSource.slice(trackerStart, trackerEnd);
  assert.match(tracker, /classifyManualCodexRewindControlInput\(\{/);
  assert.match(tracker, /if \(isTerminalProtocolResponse\) return/);
  assert.match(tracker, /escapePrimeAllowed = commandState\?\.isRunning === true[\s\S]{0,180}codexTurnState\?\.busy !== true[\s\S]{0,180}!hasCodexPromptOrTurnInFlight\(tabId\)/);
  assert.match(tracker, /advanceManualCodexRewindOwnedInputRevision\(\{/);
  assert.match(tracker, /cancelCodexWriterHandoffBeforeAction\(tabId, 'manual-rewind-input-gap'\)/);
  assert.match(tracker, /state\.ownedInputRevision = ownershipAdvance\.ownedInputRevision/);
  assert.match(tracker, /control\.kind === 'cancel'/);
  assert.match(tracker, /manual-rewind-protocol-left/);

  const boundaryStart = mainSource.indexOf('function markCodexWriterHandoffActionBoundary');
  const boundaryEnd = mainSource.indexOf('function notifyCodexWriterHandoffWaiters', boundaryStart);
  assert.ok(boundaryStart >= 0 && boundaryEnd > boundaryStart);
  const boundary = mainSource.slice(boundaryStart, boundaryEnd);
  assert.match(boundary, /manualOwnedInputRevision/);
  assert.match(boundary, /getTerminalInputRevision\(tabId\) === manualOwnedInputRevision/);
  assert.match(boundary, /observedAuthorityIdentity\.inputRevision = actionAuthority\.identity\.inputRevision/);
  assert.match(boundary, /!manualInputScopeCurrent/);
});

test('manual native Rewind binds its exact target before the journal and Enter', () => {
  const boundaryStart = mainSource.indexOf('function markCodexWriterHandoffActionBoundary');
  const boundaryEnd = mainSource.indexOf('function markCodexWriterHandoffRollbackApplied', boundaryStart);
  const boundary = mainSource.slice(boundaryStart, boundaryEnd);
  assert.match(boundary, /bindCodexActionAuthorityTarget\(actionAuthority, actionTarget\)/);
  assert.match(boundary, /phases: \['armed', 'consumed'\]/);
  assert.ok(
    boundary.indexOf("'rewind-confirm-boundary'") < boundary.indexOf('persistPendingCodexNativeRewindHandoff'),
    'manual confirmation must consume authority before creating a mutation journal',
  );
});

test('resumed-active submit reserves one lease before paste and one causal audit before Enter', () => {
  const pasteStart = mainSource.indexOf('async function _safePasteAndSubmitInner');
  const pasteEnd = mainSource.indexOf('// Send input to terminal', pasteStart);
  const paste = mainSource.slice(pasteStart, pasteEnd);
  assert.ok(paste.indexOf('CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT') >= 0);
  const waitingValidation = paste.indexOf('const authorityVerdict = validateMainCodexActionAuthority');
  const devHold = paste.indexOf('await waitForCodexActionAuthorityTestRelease(codexSubmitAuthority)');
  const heldRevalidation = paste.indexOf('const authorityAfterHold = validateMainCodexActionAuthority');
  const authorityArm = paste.indexOf("'resume-submit-authority-armed'");
  assert.ok(
    waitingValidation >= 0
      && waitingValidation < devHold
      && devHold < heldRevalidation
      && heldRevalidation < authorityArm
      && authorityArm < paste.indexOf("'resume-submit-paste-boundary'"),
    'the exact waiting authority must be checked, held, rechecked, and only then armed',
  );
  assert.match(
    paste.slice(devHold, authorityArm),
    /holdResult\?\.released !== true[\s\S]{0,300}error: 'codex_submit_action_authority_revoked'[\s\S]{0,180}submitted: false/,
  );
  assert.match(
    paste.slice(Math.max(0, devHold - 180), devHold),
    /if \(codexActionAuthorityTestHoldEnabled\(codexSubmitAuthority\.profile\)\)/,
  );
  assert.ok(
    paste.indexOf("'resume-submit-paste-boundary'") < paste.indexOf('term.write(payload)'),
    'submit authority must be consumed before bracketed paste bytes',
  );
  assert.ok(
    paste.indexOf('reservation.enterWritten = false') < paste.indexOf('term.write(submitSequence)'),
    'the one-submit latch must exist before Enter can materialize a child',
  );
  assert.match(paste, /stagedCodexAudit\?\.actionAuthority !== codexSubmitAuthority/);
  assert.match(paste, /currentDiscovery\.provisionalSubmitReservation !== exactReservation/);
  assert.match(paste, /currentDiscovery\.launchId !== codexSubmissionWatcher\.launchId/);
  assert.match(mainSource, /function validateConsumedCodexResumedSubmitAuthority[\s\S]{0,1200}currentIdentity\.inputRevision = authority\.identity\.inputRevision/);
  assert.match(mainSource, /buildCodexResumedSubmitCandidateProof[\s\S]{0,9000}selectCodexPendingPromptAudit/);
  assert.match(mainSource, /compareAndSetTabCodexSessionId\([\s\S]{0,180}intent\.sourceSessionId,[\s\S]{0,80}owned\.sessionId/);
});

test('Stop, replacement, manual input, project moves and competing writer revoke pending authority', () => {
  const stopStart = mainSource.indexOf('function markAiStopping');
  const stopEnd = mainSource.indexOf('function clearAiStopping', stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  assert.match(
    mainSource.slice(stopStart, stopEnd),
    /revokeCodexActionAuthoritiesForTab\(tabId, 'stop-start:' \+ reason\)/,
  );
  assert.match(mainSource, /revokeCodexActionAuthoritiesForTab\(tabId, 'terminal-replaced'\)[\s\S]{0,100}terminals\.set\(tabId, ptyProcess\)/);
  assert.match(mainSource, /ipcMain\.on\('terminal:kill'[\s\S]{0,180}revokeCodexActionAuthoritiesForTab\(tabId, 'terminal-kill'\)/);
  assert.match(mainSource, /bumpTerminalInputRevision\(tabId\);[\s\S]{0,100}revokeCodexActionAuthoritiesForManualInput\(tabId\)/);
  assert.match(mainSource, /revokeCodexActionAuthoritiesForTab\(transferredTabId, 'project-owner-moved'\)/);
  assert.match(mainSource, /revokeCodexActionAuthoritiesForWriterAdoption\(tabId, sessionId\)[\s\S]{0,100}codexKnownSessions\.set\(tabId, sessionId\)/);
});

test('post-Enter timeout remains accepted but unknown, and orchestration waits for task context', () => {
  assert.match(historyRuntimeSource, /auditTimeoutAfterSubmit[\s\S]{0,800}success: null,[\s\S]{0,120}accepted: true,[\s\S]{0,120}status: 'audit-pending'/);
  assert.match(webServerSource, /function sendAuditPending[\s\S]{0,260}success: null,[\s\S]{0,100}accepted: true/);
  assert.match(mainSource, /routeAgentPromptAuditDetail\(detail, \{ renderer: true, web: false \}\)[\s\S]{0,120}deferCodexPromptAuditExecutionContext/);
  assert.match(mainSource, /executionContextSource: 'codex-task-started'[\s\S]{0,120}\{ renderer: false, web: true \}/);
});

test('the shared barrier does not gate settings, Fork, or stopped-send scenario entry', () => {
  const runtimeContract = fs.readFileSync(
    path.join(repoDir, 'src/main/codex-runtime-contract.js'),
    'utf8',
  );
  const requestPlan = fs.readFileSync(
    path.join(repoDir, 'src/main/orchestration-request-plan.js'),
    'utf8',
  );
  assert.doesNotMatch(runtimeContract, /codex-action-authority|resumed-active-submit/);
  assert.doesNotMatch(requestPlan, /codex-action-authority|resumed-active-submit/);
  const forkComposerIndex = mainSource.indexOf("'[CodexTurn] fork composer frame seen tab='");
  assert.ok(forkComposerIndex >= 0);
  const forkComposerBoundary = mainSource.slice(
    Math.max(0, forkComposerIndex - 500),
    forkComposerIndex + 500,
  );
  assert.match(forkComposerBoundary, /command === 'codex-f'/);
  assert.doesNotMatch(forkComposerBoundary, /CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT/);
});

test('main publishes one launch-scoped read identity without promoting it to writer authority', () => {
  const snapshotStart = mainSource.indexOf('async function getCodexRuntimeSessionSnapshot');
  const snapshotEnd = mainSource.indexOf('function getCodexSessionOwner', snapshotStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  const snapshot = mainSource.slice(snapshotStart, snapshotEnd);
  assert.match(snapshot, /const readIdentity = resolveCodexReadIdentity\(\{/);
  assert.match(snapshot, /const currentResumeReadLease = getCodexResumeReadIdentityLeaseForTab\(tabId\)/);
  assert.match(snapshot, /resumeReadLease: currentResumeReadLease/);
  assert.match(snapshot, /persistedSessionId: dbSessionId/);
  assert.match(snapshot, /const promptOrTurnInFlight = hasCodexPromptOrTurnInFlight\(tabId\)/);
  assert.match(snapshot, /promptOrTurnInFlight,/);
  assert.match(snapshot, /submitResolutionPending: codexReadIdentitySubmitPending\.get\(tabId\) \|\| null/);
  assert.match(snapshot, /readSessionId: readIdentity\.sessionId/);
  assert.match(snapshot, /canCopySessionId: readIdentity\.available === true/);
  assert.match(snapshot, /sessionId = liveLifecycle === false \? savedSessionId : provenWriterSessionId/);

  assert.match(mainSource, /launchPayload\.lifecycleGeneration = getTerminalLifecycleGeneration\(tabId\)/);
  assert.match(mainSource, /sourceTerminalToken: scopedSourceTerminalToken/);
  assert.match(mainSource, /sourceLifecycleGeneration: scopedSourceLifecycleGeneration/);
  assert.match(mainSource, /function beginCodexPromptInFlight[\s\S]{0,700}armCodexReadIdentitySubmitBarrier\(tabId, reason\)/);
  assert.match(mainSource, /function markCodexPromptSubmitted[\s\S]{0,500}markCodexReadIdentitySubmitWritten/);
  assert.match(mainSource, /codexWriterProofs\.set\(tabId, proofRecord\);[\s\S]{0,240}clearCodexReadIdentitySubmitBarrier/);
});

test('history mutation affordances consume one action-specific runtime verdict and paste-busy boundary', () => {
  const snapshotStart = mainSource.indexOf('async function getCodexRuntimeSessionSnapshot');
  const snapshotEnd = mainSource.indexOf('function getCodexSessionOwner', snapshotStart);
  const snapshot = mainSource.slice(snapshotStart, snapshotEnd);
  assert.match(snapshot, /projectCodexHistoryActionAvailability\(\{/);
  assert.match(snapshot, /provisionalResumeAvailable: readIdentity\.available === true[\s\S]{0,180}readIdentity\.source === 'resume-source'/);
  assert.match(snapshot, /canNativeRewind: historyActions\.canNativeRewind/);
  assert.match(snapshot, /canRewriteHistory: historyActions\.canRewriteHistory/);
  assert.match(snapshot, /canDeleteHistory: historyActions\.canDeleteHistory/);

  assert.match(workspaceSource, /ipcRenderer\.on\('claude:paste-busy', handlePasteBusy\)/);
  assert.match(workspaceSource, /isTurnBusy: effectiveAiBusy \|\| agentPasteBusyByTab\.get/);
  assert.match(workspaceSource, /inputBusy=\{agentPasteBusyByTab\.get\(deferredHistoryOwner\.tabId\) === true\}/);

  assert.match(historyPanelSource, /onRuntimeSnapshotChange\?\.\(presence\.runtimeSnapshot \|\| null\)/);
  assert.match(historyPanelSource, /codexHistoryActions\?\.canNativeRewind !== true/);
  assert.match(historyPanelSource, /rewindLocked=\{historyRewindLocked\}/);

  assert.match(timelineSource, /historyActionSnapshot\?\.canNativeRewind !== true/);
  assert.match(timelineSource, /historyActionSnapshot\?\.canRewriteHistory !== true/);
  assert.match(timelineSource, /historyActionSnapshot\?\.canDeleteHistory !== true/);
  assert.match(timelineSource, /isTabAiBusy \|\| isTurnBusy \|\| lifecycleBlocksHistoryAction/);
});

test('startup completion retains the Resume read lease and post-Enter barrier until adoption', () => {
  const launchClearStart = mainSource.indexOf('function clearCodexLaunchPayload');
  const launchClearEnd = mainSource.indexOf('function clearCodexManualActionRequired', launchClearStart);
  assert.ok(launchClearStart >= 0 && launchClearEnd > launchClearStart);
  const launchClear = mainSource.slice(launchClearStart, launchClearEnd);
  assert.doesNotMatch(launchClear, /clearCodexReadIdentitySubmitBarrier/);

  const finishStart = mainSource.indexOf('function finishCodexStartupLifecycle');
  const finishEnd = mainSource.indexOf('function markCodexTuiReadyFromTurnEnd', finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart);
  assert.match(mainSource.slice(finishStart, finishEnd), /clearCodexLaunchPayload\(tabId, reason, null, \{[\s\S]{0,120}preserveServiceTierLaunchCandidate: true/);

  const barrierStart = mainSource.indexOf('function armCodexReadIdentitySubmitBarrier');
  const barrierEnd = mainSource.indexOf('function hasCodexPromptOrTurnInFlight', barrierStart);
  assert.ok(barrierStart >= 0 && barrierEnd > barrierStart);
  const barrier = mainSource.slice(barrierStart, barrierEnd);
  assert.match(barrier, /getCodexResumeReadIdentityLeaseForTab\(tabId\)/);
  assert.match(barrier, /createCodexReadIdentitySubmitBarrier\(\{/);
  assert.match(barrier, /shouldClearCodexReadIdentitySubmitBarrier\(current, resolution\)/);

  const taskStartedIndex = mainSource.indexOf("clearCodexPromptInFlight(state.tabId, 'task_started')");
  const taskStartedBoundary = mainSource.slice(taskStartedIndex, taskStartedIndex + 260);
  assert.ok(taskStartedIndex >= 0);
  assert.match(taskStartedBoundary, /finishCodexStartupLifecycle\(state\.tabId, 'task_started'\)/);
  assert.doesNotMatch(taskStartedBoundary, /clearCodexReadIdentitySubmitBarrier/);
  assert.match(
    mainSource,
    /codexWriterProofs\.set\(tabId, proofRecord\);[\s\S]{0,260}resolution: 'writer-adopted'/,
  );
  assert.match(
    mainSource,
    /released\.includes\(pendingBarrier\.sourceSessionId\)[\s\S]{0,300}resolution: 'resume-lease-released'/,
  );
});

test('both copy buttons consume the main read contract while mutations keep writer guards', () => {
  const copyIdStart = controlBarSource.indexOf('const copySessionId = async () =>');
  const copyIdEnd = controlBarSource.indexOf('// Live bridge data', copyIdStart);
  assert.ok(copyIdStart >= 0 && copyIdEnd > copyIdStart);
  const copyId = controlBarSource.slice(copyIdStart, copyIdEnd);
  assert.match(copyId, /requireCodexActionSessionId\('скопировать ID сессии'\)/);
  assert.doesNotMatch(copyId, /requireMutationSafe|,\s*true\)/);
  assert.match(controlBarSource, /requireCodexActionSessionId\('продолжить Codex-сессию', true\)/);
  assert.match(controlBarSource, /requireCodexActionSessionId\('создать fork Codex-сессии', true\)/);

  const copySessionStart = copySessionSource.indexOf("if (kind === 'codex' && !overrideInput)");
  const copySessionEnd = copySessionSource.indexOf('if (!targetId) continue;', copySessionStart);
  assert.ok(copySessionStart >= 0 && copySessionEnd > copySessionStart);
  const copySession = copySessionSource.slice(copySessionStart, copySessionEnd);
  assert.match(copySession, /requireCodexSurfaceSessionId\(\{/);
  assert.doesNotMatch(copySession, /requireMutationSafe/);

  assert.match(codexPresenceSource, /getCodexRuntimeReadSessionId[\s\S]*canCopySessionId !== true[\s\S]*readSessionId/);
  assert.doesNotMatch(codexIdentitySource, /historicalSessionId/);
  assert.match(codexIdentitySource, /snapshot\.readIdentitySource === 'live-writer'[\s\S]*isCodexRuntimeWriterUsable/);
  assert.match(codexIdentitySource, /resolved\.source === 'live-writer'[\s\S]*isCodexRuntimeWriterUsable/);
  assert.match(codexIdentitySource, /resolveConfirmedCodexWriter[\s\S]*isCodexRuntimeWriterUsable\(snapshot\)/);

  const batchStatusStart = appSource.indexOf("if (action === 'getClaudeTabStatusBatch')");
  const batchStatusEnd = appSource.indexOf("if (action === 'getClaudeTabStatus')", batchStatusStart);
  assert.ok(batchStatusStart >= 0 && batchStatusEnd > batchStatusStart);
  const batchStatus = appSource.slice(batchStatusStart, batchStatusEnd);
  assert.match(batchStatus, /const readSessionId = getCodexRuntimeReadSessionId\(runtimeSession\)/);
  assert.match(batchStatus, /canCopySessionId\[tid\] = !!readSessionId/);
  assert.doesNotMatch(batchStatus, /canCopySessionId\[tid\] = statuses\[tid\] === 'inactive'/);

  assert.match(webServerSource, /const readSessionId = runtime\?\.canCopySessionId === true[\s\S]{0,240}runtime\.readSessionId\.trim\(\)/);
  assert.match(webServerSource, /codexReadSessionId: isCodex \? runtimeCodexReadSessionId : null/);
});

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

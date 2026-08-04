'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const compactSource = fs.readFileSync(path.join(__dirname, 'compact-operation-state.js'), 'utf8');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, 'missing start marker: ' + startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, 'missing end marker: ' + endNeedle);
  return source.slice(start, end);
}

test('AI boundary hooks are impossible in a packaged app or an ordinary DEV run', () => {
  assert.match(mainSource, /createE2eBoundaryTestGate\(\{[\s\S]{0,180}enabled: isDev && process\.env\.NOTED_E2E_TEST === 'true'/);
  const ipc = between(
    mainSource,
    "ipcMain.handle('__test:ai-boundary'",
    "ipcMain.handle('claude:get-presence'",
  );
  assert.match(ipc, /test_hook_disabled/);
  assert.match(ipc, /gateAction/);
  assert.match(ipc, /inject-residual-empty-frame/);
  assert.match(ipc, /inject-missing-prompt-empty-frame/);
  assert.match(ipc, /inject-provider-error/);
});

test('Resume restored-work hook creates the precondition before transcript ownership exists', () => {
  const restoredWork = between(
    mainSource,
    "kind: 'claude-resume-work-after-first-ready'",
    "stage=test-resumed-work",
  );
  assert.match(restoredWork, /awaitUserMessageAudit: false/);
  assert.match(restoredWork, /armPromptBoundaryOnSubmit: true/);
  assert.match(restoredWork, /verifyClaudeVisibleDraftBeforePaste: true/);
});

test('paste boundary holds after paste and before the only Enter write', () => {
  const send = between(
    mainSource,
    'async function _safePasteAndSubmitInner(',
    '\nasync function handleTerminalInput(',
  );
  const pasteAccepted = send.indexOf('pasteWritten = true');
  const gate = send.indexOf("kind: 'agent-before-enter'");
  const enter = send.indexOf('term.write(submitSequence)', gate);
  assert.ok(pasteAccepted >= 0 && pasteAccepted < gate, 'paste must precede the boundary');
  assert.ok(gate >= 0 && gate < enter, 'boundary must precede Enter');
  assert.match(send, /agent_send_boundary_identity_changed/);
  assert.match(send, /enterWritten: false/);
  assert.match(send, /enterWritten: true/);
});

test('successful post-Enter proof can be held before it becomes public', () => {
  const claudeFinish = between(
    mainSource,
    'function finishClaudePasteAudit(',
    '\nfunction waitForClaudePasteAudit(',
  );
  const codexFinish = between(
    mainSource,
    'function finishCodexPasteAudit(',
    '\nfunction waitForCodexPasteAudit(',
  );
  for (const finish of [claudeFinish, codexFinish]) {
    assert.ok(
      finish.indexOf('holdPasteAuditCompletionForTest(') < finish.indexOf('audit.finished = true'),
      'hold must precede publication',
    );
  }
  assert.match(mainSource, /kind: 'agent-post-enter-audit'/);
});

test('renderer receipt loss happens after the real request leaves main', () => {
  const bridge = between(webSource, 'function bridgeRequest(', '\nfunction registerBridgeReplyHandler');
  const send = bridge.indexOf("win.webContents.send('web:bridge-request'");
  const drop = bridge.indexOf("kind: 'renderer-bridge-receipt'");
  assert.ok(send >= 0 && send < drop);
  assert.match(bridge, /error\.code = 'bridge_timeout'/);
  assert.match(bridge, /pendingBridge\.delete\(requestId\)/);
});

test('orchestration boundaries preserve the normal store and lifecycle paths', () => {
  const finalize = between(
    webSource,
    'async function finalizeSettledOrchestration(',
    '\nasync function finalizeSettledOrchestrations(',
  );
  assert.ok(
    finalize.indexOf("kind: 'orchestration-result-proof'")
      < finalize.indexOf('probeOrchestrationResult(current'),
  );
  assert.match(finalize, /current = await store\.getInternal\(run\.runId\)/);

  const inject = between(
    webSource,
    'async function performE2eBoundaryAction(',
    '\nasync function reconcileOrchestrationRun(',
  );
  assert.match(inject, /run\.status !== 'running'/);
  assert.match(inject, /run\.targetBusySeen !== true/);
  assert.match(inject, /kind: 'orchestration-provider-error'/);
  assert.match(inject, /await processOrchestrationLifecycle\(run\.targetTabId/);
  assert.match(inject, /reason: 'provider_error'/);
  assert.doesNotMatch(inject, /store\.patch\(/, 'the hook must not manufacture store state');
});

test('compact settlement holds inside its exact registry owner and restart stays volatile', () => {
  const finish = between(compactSource, '  finish(input = {}) {', '\n  /**\n   * Consume Codex evidence');
  assert.match(finish, /sameOperationIdentity\(alreadyHeld\.active, active\)/);
  assert.match(finish, /this\.beforeFinish/);
  assert.ok(
    finish.indexOf('this.beforeFinish') < finish.indexOf('this.activeByTab.delete(tabId)'),
  );
  assert.match(finish, /this\.finish\(\{ \.\.\.held\.input, _e2eBypass: true \}\)/);
  assert.doesNotMatch(compactSource, /persist.*heldFinishByTab|heldFinishByTab.*persist/i);
});

test('terminal and launch replacement cancel only matching test ownership', () => {
  assert.match(mainSource, /aiBoundaryTestGate\.cancelMatching\(\{ tabId \}, 'terminal-replaced'\)/);
  assert.match(mainSource, /aiBoundaryTestGate\.cancelMatching\(\{ tabId \}, 'terminal-exited'\)/);
  assert.match(mainSource, /generation: previous\.generation,[\s\S]{0,80}'claude-launch-generation-superseded'/);
});

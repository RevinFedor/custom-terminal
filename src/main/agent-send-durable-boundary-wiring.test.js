'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainPath = path.join(__dirname, 'main.js');
const appPath = path.join(__dirname, '..', 'renderer', 'App.tsx');
const scenarioPath = path.join(__dirname, '..', 'renderer', 'utils', 'agentScenarios.ts');
const claudePath = path.join(__dirname, '..', 'renderer', 'utils', 'claudePtyActions.ts');
const runtimePath = path.join(__dirname, '..', 'renderer', 'utils', 'historyAgentRuntimes.ts');
const webServerPath = path.join(__dirname, 'web-server.js');

const read = (filePath) => fs.readFileSync(filePath, 'utf8');

test('durable send store is shared with web server and reconciled before serving requests', () => {
  const source = read(mainPath);
  const createIndex = source.indexOf('createAgentSendReceiptStore(projectManager.db.db)');
  const reconcileIndex = source.indexOf('agentSendReceiptStore.reconcileStartup()');
  const serverIndex = source.indexOf('webServer.start({');
  const injectionIndex = source.indexOf('agentSendReceiptStore,', serverIndex);
  const startupReadyIndex = source.indexOf('agentSendReceiptStartupReady,', serverIndex);

  assert.ok(createIndex >= 0, 'main must create the store from the application SQLite database');
  assert.ok(reconcileIndex > createIndex, 'startup reconciliation must use the created store');
  assert.ok(serverIndex > reconcileIndex, 'startup reconciliation must happen before the HTTP server starts');
  assert.ok(injectionIndex > serverIndex, 'the exact same store must be injected into web-server');
  assert.ok(startupReadyIndex > injectionIndex,
    'the bounded transcript reconcile promise must be shared with web-server');
});

test('startup transcript proof is bounded and gates desktop, Project API, and Inbox replay', () => {
  const mainSource = read(mainPath);
  const webSource = read(webServerPath);
  const start = mainSource.indexOf('const agentSendReceiptStartupReady = (async () => {');
  const reconcile = mainSource.indexOf('reconcileAgentSendStartupRecords(unresolved)', start);
  const promotion = mainSource.indexOf('agentSendReceiptStore.promoteFromAudit(result.audit)', reconcile);
  const ipc = mainSource.indexOf("ipcMain.handle('agent:list-send-receipts'", promotion);
  const ipcWait = mainSource.indexOf('await agentSendReceiptStartupReady', ipc);
  assert.ok(start > 0 && reconcile > start && promotion > reconcile,
    'startup must run one bounded transcript proof pass and promote only found evidence');
  assert.ok(ipcWait > ipc,
    'History hydration must wait for the bounded startup proof');

  const scenario = webSource.indexOf('async function runAgentSendScenario({');
  const scenarioWait = webSource.indexOf('await agentSendReceiptStartupReady', scenario);
  const scenarioReserve = webSource.indexOf('agentSendReceiptStore.reserveOrGet(durableIdentity)', scenarioWait);
  assert.ok(scenarioWait > scenario && scenarioReserve > scenarioWait,
    'Project API must not replay or reserve before startup proof settles');

  const inbox = webSource.indexOf("parsed.pathname === '/api/inbox/runs'");
  const inboxWait = webSource.indexOf('await agentSendReceiptStartupReady', inbox);
  const inboxReserve = webSource.indexOf('agentSendReceiptStore.reserveOrGet(durableInboxIdentity)', inboxWait);
  assert.ok(inboxWait > inbox && inboxReserve > inboxWait,
    'Inbox must share the same startup proof gate');
});

test('operation and attempt identity travel from bridge through both provider runtimes', () => {
  for (const filePath of [appPath, scenarioPath, claudePath, runtimePath]) {
    const source = read(filePath);
    assert.match(source, /sendOperationKey/, path.basename(filePath) + ' must carry operation identity');
    assert.match(source, /sendAttemptId/, path.basename(filePath) + ' must carry attempt identity');
  }
});

test('main atomically arms the exact attempt before Enter and records audit-pending immediately after Enter', () => {
  const source = read(mainPath);
  const incompleteIndex = source.indexOf('agent_send_durable_identity_incomplete');
  const armIndex = source.indexOf('AGENT_SEND_DURABLE_STATES.ENTER_ARMED');
  const enterIndex = source.indexOf('term.write(submitSequence);', armIndex);
  const settleIndex = source.indexOf('agentSendReceiptStore.settleAttempt(', enterIndex);
  const pendingIndex = source.indexOf('AGENT_SEND_DURABLE_STATES.AUDIT_PENDING', settleIndex);

  assert.ok(incompleteIndex >= 0, 'partial durable identity must fail before Enter');
  assert.ok(armIndex >= 0, 'exact attempt must be armed');
  assert.ok(enterIndex > armIndex, 'durable arm must happen before physical Enter');
  assert.ok(source.indexOf('agent_send_enter_write_outcome_unknown', armIndex) > enterIndex,
    'a thrown Enter write must remain delivery-unknown rather than become retryable');
  assert.ok(settleIndex > enterIndex, 'post-Enter receipt must be recorded only after physical Enter');
  assert.ok(pendingIndex > settleIndex, 'post-Enter state must remain audit-pending until exact transcript audit');
});

test('both Claude and Codex audit records retain operation and attempt identity', () => {
  const source = read(mainPath);
  const stagedCodex = source.indexOf('stagedCodexAudit = {');
  const stagedClaude = source.indexOf('stagedClaudeAudit = {');
  const publish = source.indexOf('function publishAgentPromptAuditResult');

  assert.ok(source.indexOf('sendOperationKey: sendOperationKey || null', stagedCodex) > stagedCodex);
  assert.ok(source.indexOf('sendOperationKey: sendOperationKey || null', stagedClaude) > stagedClaude);
  assert.ok(source.indexOf('sendOperationKey: audit.sendOperationKey || null', publish) > publish);
  assert.ok(source.indexOf('ignore stale/foreign prompt audit before projections', publish) > publish);
});

test('fresh Claude first prompt uses exact hook routing when no transcript exists yet', () => {
  const source = read(mainPath);
  const boundaryIndex = source.indexOf(
    'claudeAuditBoundary = await captureClaudePromptAuditBoundary',
  );
  const prebindIndex = source.indexOf(
    'claudeHookRouteProof = await prebindClaudeHookRouteForSubmit',
    boundaryIndex,
  );
  const admissionIndex = source.indexOf(
    'const auditAdmission = classifyClaudePromptAuditAdmission',
    prebindIndex,
  );
  const refusalIndex = source.indexOf('if (!auditAdmission.allowed)', admissionIndex);
  const stageIndex = source.indexOf('stagedClaudeAudit = {', refusalIndex);
  const routeProofIndex = source.indexOf('preSubmitRouteProof:', stageIndex);

  assert.ok(boundaryIndex >= 0, 'the transcript boundary is checked first');
  assert.ok(prebindIndex > boundaryIndex, 'only an unresolved first transcript triggers process proof');
  assert.ok(admissionIndex > prebindIndex, 'fresh-session admission must classify both proofs');
  assert.ok(refusalIndex > admissionIndex, 'the caller refuses the classifier verdict, not missing JSONL alone');
  assert.ok(routeProofIndex > stageIndex, 'the staged audit retains its exact pre-submit route proof');
  assert.equal(
    source.indexOf('if (!claudeAuditBoundary.available)', boundaryIndex),
    -1,
    'a missing first JSONL must not be an unconditional pre-Enter refusal',
  );
});

test('fresh Claude proof replaces stale PID cache and consumes the exact hook PID', () => {
  const source = read(mainPath);
  const prebindStart = source.indexOf('async function prebindClaudeHookRouteForSubmit');
  const prebindEnd = source.indexOf('\n}\n', prebindStart) + 2;
  const prebindBody = source.slice(prebindStart, prebindEnd);
  const hookStart = source.indexOf("if (event === 'UserPromptSubmit')");
  const hookEnd = source.indexOf("const busy = event === 'UserPromptSubmit'", hookStart);
  const hookBody = source.slice(hookStart, hookEnd);

  assert.match(prebindBody, /inspectAiDescendantProcessesByTab\([\s\S]*forceFresh: true/,
    'first-prompt proof must come from a fresh process tree');
  assert.doesNotMatch(prebindBody, /findLiveClaudePidByTab|live-pid-cache/,
    'process existence alone is not a route proof');
  assert.match(hookBody, /hookTabId: tabId[\s\S]*hookPpid: ppid/,
    'the hook selector must consume the exact tab and PID');
  assert.match(hookBody, /hookPidTabId: bridgePidCache\.get\(Number\(ppid\)\)/,
    'a session-first hook must still agree with the current PID route');
  assert.match(hookBody, /freshHookRouteConfirmed = true/,
    'fresh timestamp causality is armed only by that exact hook');
  assert.doesNotMatch(prebindBody, /claudeBridgeProcessStarts\.clearPid/,
    'refreshing a route must not replay once-per-process startup ownership');

  const launchStart = source.indexOf('async function waitForAiLaunchAccepted');
  const launchEnd = source.indexOf("ipcMain.handle('agent:get-launch-accepted'", launchStart);
  const launchBody = source.slice(launchStart, launchEnd);
  assert.match(launchBody, /prebindClaudeHookPid\([\s\S]*matches: lastMatches/,
    'launch observation must use the same ambiguity-safe route proof');
  assert.doesNotMatch(launchBody, /bridgePidCache\.set\(match\.pid/,
    'launch observation cannot fabricate a preferred owner from the first match');

  assert.match(hookBody,
    /waitForClaudeTranscriptMaterialization\([\s\S]*resolvedHookPath/,
    'the exact first hook path must be observed until its JSONL materializes');
});

test('IPC wrappers preserve an explicit unknown submit outcome', () => {
  const source = read(mainPath);
  const exactChecks = source.match(/Object\.prototype\.hasOwnProperty\.call\(result, 'submitted'\)/g) || [];

  assert.ok(exactChecks.length >= 3,
    'terminal paste and both replay wrappers must default only a missing submitted field');
  assert.doesNotMatch(source, /typeof result\.submitted !== 'boolean'\) result\.submitted/,
    'submitted:null must never be rewritten to the caller intent');
});

test('physical cancellation waits are scoped to the exact durable attempt', () => {
  const source = read(mainPath);
  const resolverStart = source.indexOf('function resolveAgentSendCancellationAttempt(');
  const resolverEnd = source.indexOf("ipcMain.handle('agent:cancel-send'", resolverStart);
  const resolverBody = source.slice(resolverStart, resolverEnd);
  const cancelEnd = source.indexOf("ipcMain.handle('agent:clear-send-cancel'", resolverEnd);
  const cancelBody = source.slice(resolverEnd, cancelEnd);
  const exactWaits = source.match(
    /agentSendCancellations\.wait\(\s*broadcastTabId,\s*handoffId,\s*sendAttemptId,?\s*\)/g,
  ) || [];

  assert.ok(exactWaits.length >= 2,
    'both the render wait and the held-after-paste boundary must wait on the exact attempt');
  assert.match(resolverBody,
    /durableRecords\.length === 1[\s\S]{0,180}surface === DESKTOP_HISTORY_SEND_SURFACE[\s\S]{0,180}attemptId: durableRecords\[0\]\.attemptId/,
    'a fresh desktop handoff may resolve only its sole exact durable attempt');
  assert.match(resolverBody,
    /return \{ accepted: false, attemptId: null, durableRecords \};/,
    'ambiguous durable attempts are not guessed');
  assert.match(cancelBody,
    /if \(!resolved\.accepted\)[\s\S]{0,600}reason: 'send-attempt-required'/,
    'API/orchestration and ambiguous cancellations still require explicit attempt identity');
});

test('closed-tab preparation stays retryable until the physical send attempt begins', () => {
  const source = read(webServerPath);
  const executeIndex = source.indexOf('const executeSend = async () => {');
  const preparingIndex = source.indexOf('agentSendReceiptStore.markPreparing(sendOperationKey)', executeIndex);
  const prepareIndex = source.indexOf('await prepareSend()', preparingIndex);
  const beginIndex = source.indexOf('agentSendReceiptStore.beginAttempt(durableIdentity)', prepareIndex);
  const bridgeIndex = source.indexOf("bridgeRequest('sendAgentPromptScenario'", beginIndex);

  assert.ok(preparingIndex > executeIndex, 'durable preparation must be recorded before reopening a tab');
  assert.ok(prepareIndex > preparingIndex, 'tab restoration must happen while the receipt is retryable');
  assert.ok(beginIndex > prepareIndex, 'the physical attempt must not start until tab restoration succeeds');
  assert.ok(bridgeIndex > beginIndex, 'the exact attempt must start immediately before the renderer bridge');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const runtimeSource = fs.readFileSync(
  path.join(__dirname, '../renderer/utils/historyAgentRuntimes.ts'),
  'utf8',
);
const runnerSource = fs.readFileSync(
  path.join(__dirname, '../renderer/hooks/usePromptQueueRunner.ts'),
  'utf8',
);

test('Codex timeout retries Enter only after an exact Ctrl+G composer capture', () => {
  const helperStart = mainSource.indexOf('async function retryCodexEnterAfterAuditTimeout');
  const helperEnd = mainSource.indexOf('\n// Map of term', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = mainSource.slice(helperStart, helperEnd);
  const admission = helper.indexOf('classifyCodexPostEnterRetryAdmission');
  const capture = helper.indexOf("captureAgentInputAtWriteBoundary(\n    tabId,\n    'copy',\n    'codex'");
  const proof = helper.indexOf('classifyCodexPostEnterRetryCapture');
  const enter = helper.indexOf("term.write('\\r')");
  assert.ok(admission >= 0 && capture > admission && proof > capture && enter > proof);
  assert.match(helper, /turnBusy: codexTurnWatchers\.get\(tabId\)\?\.busy === true/);
  assert.match(helper, /durableAfter[\s\S]{0,500}durableRecord: durableAfter/);
  assert.match(helper, /enterRetryCount = 1/);
});

test('a second caller deadline keeps confirmation pending without extending its budget', () => {
  const waitStart = mainSource.indexOf('if (stagedCodexAudit && awaitCodexUserMessageAudit');
  const waitEnd = mainSource.indexOf('\n    } else if (source', waitStart);
  const handoff = mainSource.slice(waitStart, waitEnd);
  assert.match(handoff, /__codexPostEnterDeferred/);
  assert.match(handoff, /finishCodexPasteAuditAfterWrite\(term, deferred\)/);
  const resolutionStart = mainSource.indexOf('async function finishCodexPasteAuditAfterWrite(');
  const resolutionEnd = mainSource.indexOf('\nfunction currentCodexAcceptedResumeSourceProof(', resolutionStart);
  assert.ok(resolutionStart >= 0 && resolutionEnd > resolutionStart);
  const wait = mainSource.slice(resolutionStart, resolutionEnd);
  assert.match(wait, /retryCodexEnterAfterAuditTimeout/);
  const firstWait = wait.indexOf('await waitForCodexPasteAudit(');
  const retry = wait.indexOf('if (retry?.retried === true)');
  const secondWait = wait.indexOf('await waitForCodexPasteAudit(', firstWait + 1);
  assert.ok(firstWait >= 0 && retry > firstWait && secondWait > retry);
  assert.match(wait, /withPtyWriteLock\(term, retryAtOwner, audit\.writeOperation\)/);
  assert.match(wait, /if \(scopeFailure\)[\s\S]{0,300}markCodexAuditDeliveryUnknown/);
  assert.match(wait, /status: 'audit-pending'/);
  assert.match(wait, /agentSendReceiptStore\.settleAttempt/);
  assert.match(wait, /reportTerminalSendDiagnostic\(record, 'send-confirmation-delayed'\)/);
  assert.match(mainSource, /const CODEX_PASTE_AUDIT_TIMEOUT_MS = 8000;/);
  // A legacy main that explicitly returned unknown remains unknown; new
  // pending results flow through unchanged and are never promoted to SENT.
  assert.match(runtimeSource, /auditTimeoutAfterSubmit[\s\S]{0,900}status: 'delivery-unknown'/);
  assert.match(runnerSource, /detail\?\.status === 'delivery-unknown'[\s\S]{0,350}queueStatus: 'delivery-unknown'/);
});

test('a later manual user carrier replays durable unresolved receipts after memory eviction', () => {
  const reconcileStart = mainSource.indexOf('function reconcileDurableCodexPromptAuditsForTab');
  const reconcileEnd = mainSource.indexOf('\nfunction processCodexUserMessagePasteAudit', reconcileStart);
  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart);
  const reconcile = mainSource.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /AGENT_SEND_DURABLE_STATES\.AUDIT_PENDING/);
  assert.match(reconcile, /AGENT_SEND_DURABLE_STATES\.DELIVERY_UNKNOWN/);
  assert.match(reconcile, /reconcileAgentSendStartupRecords\(unresolved, \{ allRecords \}\)/);
  assert.match(reconcile, /publishAgentPromptAuditResult\(tabId, auditCarrier, \{[\s\S]{0,180}\.\.\.decision\.audit,[\s\S]{0,120}auditTimestamp,[\s\S]{0,80}\}, 'codex'\)/);

  const processStart = reconcileEnd;
  const processEnd = mainSource.indexOf('\nfunction processCodexSourceAuditOnlyText', processStart);
  const process = mainSource.slice(processStart, processEnd);
  assert.match(process, /no-in-memory-audit/);
  assert.match(process, /in-memory-audit-unmatched/);
});

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

test('a second timeout becomes durable delivery-unknown while keeping late exact reconciliation', () => {
  const waitStart = mainSource.indexOf('if (stagedCodexAudit && awaitCodexUserMessageAudit');
  const waitEnd = mainSource.indexOf('\n    } else if (source', waitStart);
  const wait = mainSource.slice(waitStart, waitEnd);
  assert.match(wait, /retryCodexEnterAfterAuditTimeout/);
  assert.match(wait, /waitForCodexPasteAudit[\s\S]{0,700}waitForCodexPasteAudit/);
  assert.match(wait, /markCodexAuditDeliveryUnknown/);
  assert.match(wait, /status: 'delivery-unknown'/);
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

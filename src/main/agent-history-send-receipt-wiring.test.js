'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const historySource = fs.readFileSync(
  path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

function ordered(source, labels) {
  let cursor = -1;
  for (const [label, needle] of labels) {
    const index = source.indexOf(needle, cursor + 1);
    assert.notEqual(index, -1, `${label} wiring is present`);
    assert.ok(index > cursor, `${label} follows the preceding boundary`);
    cursor = index;
  }
}

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `start boundary ${startNeedle} exists`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `end boundary ${endNeedle} exists`);
  return source.slice(start, end);
}

test('desktop History transport, durable arm, and physical Enter are strictly ordered', () => {
  const sendBody = between(
    mainSource,
    'async function _safePasteAndSubmitInner(term, content, options = {})',
    '// Send input to terminal',
  );

  ordered(sendBody, [
    ['raw request captured', 'const durableRawPrompt = content;'],
    ['Claude PTY transport normalized', 'prepareClaudePromptTransport(content)'],
    ['desktop identity built from raw plus transport proof', 'buildDesktopHistorySendIdentity({'],
    ['durable attempt started', 'agentSendReceiptStore.beginAttempt(identity)'],
    ['exact attempt armed before Enter', 'AGENT_SEND_DURABLE_STATES.ENTER_ARMED'],
    ['physical Enter written', 'term.write(submitSequence)'],
    ['post-Enter state becomes audit pending', 'AGENT_SEND_DURABLE_STATES.AUDIT_PENDING'],
  ]);
  assert.match(sendBody, /rawPrompt: durableRawPrompt,[\s\S]{0,180}promptHash: pasteAuditHash\(content\)/);
});

test('late exact audit commits durable receipt before any renderer/web projection', () => {
  const publishBody = between(
    mainSource,
    'function publishAgentPromptAuditResult(tabId, audit, result, toolType)',
    'function holdPasteAuditCompletionForTest',
  );
  ordered(publishBody, [
    ['exact durable attempt loaded', 'agentSendReceiptStore.get(audit.sendOperationKey)'],
    ['exact audit promoted', 'agentSendReceiptStore.promoteFromAudit({'],
    ['rejected identity exits', "console.warn('[AgentSendReceipt] ignore audit rejected by durable identity'"],
    ['accepted receipt becomes projection detail', 'const baseDetail = {'],
    ['projection routed', 'routeAgentPromptAuditDetail(detail)'],
  ]);
});

test('main returns the generated attempt identity to the exact History handoff', () => {
  const outerBody = between(
    mainSource,
    'async function safePasteAndSubmit(term, content, options = {})',
    'async function _safePasteAndSubmitInner(term, content, options = {})',
  );
  assert.match(outerBody, /sendOperationKey: result\.sendOperationKey \|\| operation\.sendOperationKey/);
  assert.match(outerBody, /sendAttemptId: result\.sendAttemptId \|\| operation\.sendAttemptId \|\| null/);

  const resultBody = between(
    historySource,
    'const result = await sendAgentPromptScenario({',
    "historyDiag('SEND_RESULT tab='",
  );
  ordered(resultBody, [
    ['scenario result received', 'const result = await sendAgentPromptScenario({'],
    ['physical ownership classified', 'const resultOwnershipTransferred ='],
    ['attempt identity bound', 'bindHistoryPromptHandoffSendIdentity('],
    ['audit proof accepted only after binding', 'const auditProof = sendIdentityFailure'],
    ['same handoff settled', 'settleHistoryPromptHandoff(actionTabId, handoffId, {'],
  ]);
  assert.match(resultBody, /sendIdentityFailure[\s\S]{0,180}'delivery-unknown' as const/);
});

test('History remount reconciles only its bounded local overlay before first merge', () => {
  const mountBody = between(
    historySource,
    '// Initial load on mount / session change / tool type switch',
    '// `transcriptEntries` already committed the durable version',
  );
  ordered(mountBody, [
    ['bounded overlay loaded', 'historyVolatileOverlayCache.get<'],
    ['one exact handoff snapshot read', 'getHistoryPromptHandoffsSnapshot(tabId)'],
    ['bounded rows reconciled by exact handoff', 'reconcileHistoryPromptHandoffRows({'],
    ['reconciled rows merged into presentation', 'const restoredLocalEntries = mergeServerAndLocalEntries('],
  ]);
  assert.match(mountBody, /rows: restoredOverlayRows,/);
  assert.doesNotMatch(
    historySource,
    /change\.type === 'consume' \|\| change\.type === 'retract' \|\| change\.type === 'evict'/,
  );
});

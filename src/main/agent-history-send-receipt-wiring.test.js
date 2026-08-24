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
const webServerSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');

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
    ['exact writer and boundary persisted', 'agentSendReceiptStore.stageAttemptContext('],
    ['exact pre-Enter writer captured', 'sessionId: durablePreSubmitBoundary?.sessionId || null,'],
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
  assert.match(publishBody, /sourceIdentity: result\.sourceIdentity \|\| null/);
});

test('canonical History materialization is durably acknowledged before local SENT is consumed', () => {
  assert.match(historySource, /historyEntryHasExactIdentity\(entry, localEntry\.auditEntryUuid\)/,
    'a promoted Codex response carrier must adopt through its exact canonical alias');
  assert.match(historySource, /sourceIdentityAliases:\s*entry\.sourceIdentityAliases/,
    'canonical aliases must reach local-to-durable adoption');
  const consumeBody = between(
    historySource,
    'const consumeMaterializedPromptHandoffs = useCallback',
    '// Load full history',
  );
  ordered(consumeBody, [
    ['legacy completion is matched only by its exact durable run tag',
      'legacyOrchestrationCompletionMatchesCanonicalEntry(handoff, entry)'],
    ['exact canonical row matched',
      'const matched = legacyOrchestrationMatch || findServerPromptEntry('],
    ['durable presentation acknowledged', 'acknowledgeMaterializedHistoryReceipt({'],
    ['renderer-local handoff consumed', 'consumeHistoryPromptHandoff(tabId, handoff.handoffId)'],
  ]);

  const hydrationBody = between(
    historySource,
    "void ipcRenderer.invoke('agent:list-send-receipts'",
    'useEffect(() => subscribeHistoryPromptHandoffs',
  );
  ordered(hydrationBody, [
    ['confirmed receipt waits for a canonical projection', 'canonicalProjectionReady'],
    ['exact durable identity is checked', 'durableHistorySendReceiptMatchesCanonicalEntry(record, entry)'],
    ['external receipts are consumed but never rehydrated as History-owned drafts',
      "if (record?.surface !== 'desktop-history') continue;"],
    ['only unmatched receipts hydrate locally', 'hydrateHistoryPromptHandoffFromDurableReceipt(record)'],
  ]);
  assert.doesNotMatch(hydrationBody, /surface:\s*'desktop-history'/,
    'History must list all tab receipts so exact iOS/Project API cards can be retired');

  assert.match(mainSource, /ipcMain\.handle\('agent:acknowledge-send-receipt-presentation'/);
  assert.match(mainSource, /agentSendReceiptStore\.acknowledgePresentation\(\{/);
});

test('every local History status row has a presentation-only dismiss action with the right owner', () => {
  assert.match(mainSource, /ipcMain\.handle\('agent:dismiss-send-receipt-presentation'/);
  assert.match(mainSource, /agentSendReceiptStore\.dismissPresentation\(\{/);
  const mainDismissBody = between(
    mainSource,
    "ipcMain.handle('agent:dismiss-send-receipt-presentation'",
    '// Programmatic paste',
  );
  assert.match(mainDismissBody, /agentSendReceiptStore\.list\(\{ tabId \}\)/,
    'desktop History dismissal must resolve the exact handoff across every send origin');
  assert.doesNotMatch(mainDismissBody, /list\(\{[\s\S]{0,100}surface:/,
    'the immutable send origin must not be mistaken for the presentation surface');
  assert.match(historySource, /isLocalPromptEntry\(entry\)[\s\S]{0,180}onDismissPromptPresentation/);
  const dismissBody = between(
    historySource,
    'const dismissPromptPresentation = useCallback',
    'const acknowledgeMaterializedHistoryReceipt = useCallback',
  );
  assert.match(dismissBody, /planHistoryPromptPresentationDismissal\(\{/);
  assert.match(dismissBody, /mode === 'local-only'[\s\S]{0,500}consumeHistoryPromptHandoff[\s\S]{0,300}removeLocalPromptEntry/,
    'receiptless slash commands are presentation-only and must not call a missing durable receipt');
  const durableDismissBody = dismissBody.slice(
    dismissBody.indexOf("ipcRenderer.invoke('agent:dismiss-send-receipt-presentation'"),
  );
  ordered(durableDismissBody, [
    ['durable dismissal requested', "ipcRenderer.invoke('agent:dismiss-send-receipt-presentation'"],
    ['renderer handoff consumed', 'consumeHistoryPromptHandoff(tabId, handoffId)'],
    ['local row removed', "removeLocalPromptEntry(handoffId, 'user-dismissed-prompt-presentation')"],
  ]);
  assert.match(dismissBody, /showHistoryIncidentToast\(tabId,[\s\S]{0,500}action: 'dismiss-prompt-presentation'/,
    'dismiss errors use the persistent copyable terminal incident toast');
  assert.match(dismissBody, /sendAttemptId: currentHandoff\?\.sendAttemptId/);
  assert.match(dismissBody, /sendOperationKey: currentHandoff\?\.sendOperationKey/);
  assert.match(dismissBody, /statusAtSend: entry\.queueStatus/);
  assert.doesNotMatch(dismissBody, /\breportError\(/,
    'HistoryPanel must not fall through to the browser global reportError API');
  assert.doesNotMatch(dismissBody, /showToast\(\s*'Не удалось скрыть карточку сообщения'/);
  assert.match(historySource, /--hp-user-message-status-height:\s*20px/);
  assert.match(historySource, /\.hp-user-message-status > \.cb-message-status[\s\S]{0,180}height:\s*var\(--hp-user-message-status-height\)/);
  assert.match(historySource, /\.hp-user-message-status-dismiss[\s\S]{0,220}width:\s*var\(--hp-user-message-status-height\)[\s\S]{0,80}height:\s*var\(--hp-user-message-status-height\)/);
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
    ['local slash proof classified', 'const localSlashReceipt = projectAgentLocalCommandSendResult({'],
    ['physical ownership classified', 'const resultOwnershipTransferred ='],
    ['ordinary send identity gated away from local slash', 'if (resultOwnershipTransferred && !localSlashReceipt.handled)'],
    ['attempt identity bound', 'bindHistoryPromptHandoffSendIdentity('],
    ['audit proof accepted only after binding', 'const auditProof = localSlashReceipt.handled || sendIdentityFailure'],
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

test('History presents terminal lifecycle and input delivery as two independent statuses', () => {
  const statusBody = between(
    historySource,
    'const unifiedTransientStatus = isCancellingTurn',
    'const statusDetail = activeLifecycle?.detail || null',
  );
  ordered(statusBody, [
    ['compact keeps priority', "title: 'COMPACTING'"],
    ['ordinary history refresh stays lower priority', 'showUpdatingChip'],
    ['exact handoff status is selected independently', 'const displayedInputStatus = activeInputStatus'],
  ]);
  assert.doesNotMatch(
    between(historySource, 'const unifiedTransientStatus = isCancellingTurn', 'const displayedInputStatus'),
    /busyAction === 'send'/,
  );
  assert.match(historySource, /data-agent-send-phase=\{displayedInputStatus \|\| undefined\}/);
  // Судьба отправки НЕ склеивается с состоянием терминала в видимую плашку: она
  // уже показана бейджем над самим сообщением, а приставкой к терминалу
  // вытаскивала на экран слово «Ready», у которого своего права появиться нет.
  // В подсказке при наведении она остаётся — там место не расходуется.
  assert.doesNotMatch(historySource, /terminalStatusTitle \+ ' \/ ' \+ inputStatusPresentation\.label/);
  assert.match(historySource, /const statusTitle = statusCopied \? 'COPIED' : terminalStatusTitle;/);
  assert.match(
    historySource,
    /const statusDescription = inputStatusPresentation[\s\S]{0,120}inputStatusPresentation\.title/,
  );
  // Готовность сама по себе не показывается: «всё готово» = не происходит ничего.
  const showStatusTextRule = between(
    historySource,
    'const showStatusText = statusCopied',
    'const showBusyLoader',
  );
  assert.doesNotMatch(showStatusTextRule, /inputStatusPresentation/);
  assert.doesNotMatch(showStatusTextRule, /status === 'active'/);
  assert.match(historySource, /\|\| status === 'starting'[\s\S]{0,180}const canAcceptSubmitIntent/);
  assert.match(historySource, /busyAction === 'resume' && status === 'starting'/);
  assert.match(historySource, /sendCanJoinExistingLaunch[\s\S]{0,220}activeKind === 'resume'/);
});

test('main publishes exact handoff transport phases around physical Enter', () => {
  const sendBody = between(
    mainSource,
    'async function _safePasteAndSubmitInner(term, content, options = {})',
    '// Send input to terminal',
  );
  ordered(sendBody, [
    ['paste phase starts', "emitBusy(true, 'sending')"],
    ['physical Enter is written', 'term.write(submitSequence)'],
    ['confirmation phase starts after Enter', "emitBusy(false, 'confirming')"],
  ]);
  assert.match(sendBody, /handoffId: handoffId \|\| null/);
});

test('orchestration completion uses the same durable desktop History receipt as a manual send', () => {
  const completionBody = between(
    webServerSource,
    'async function sendOrchestrationCompletionNotification',
    'async function notifyAgentPromptAuditResult',
  );
  assert.match(completionBody, /const notificationHandoffId = 'orchestration-complete:' \+ current\.runId/);
  assert.match(completionBody, /handoffId:\s*notificationHandoffId/);
  assert.match(completionBody, /source:\s*'orchestration-completion:' \+ current\.runId/);
  assert.doesNotMatch(completionBody, /sendOperationKey:/,
    'main must mint the receipt from the exact History handoff instead of accepting caller identity');
  assert.match(mainSource, /isDesktopHistorySendReceiptEligible\(\{/);
  assert.match(mainSource, /buildDesktopHistorySendIdentity\(\{/);
});

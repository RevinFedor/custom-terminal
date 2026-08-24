import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(
  path.join(here, '../components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const toast = fs.readFileSync(
  path.join(here, '../components/UI/Toast.tsx'),
  'utf8',
);

test('History send errors copy a self-contained incident report', () => {
  const reportStart = panel.indexOf('const showHistoryIncidentToast = (');
  const reportEnd = panel.indexOf('const historyOwnerDigest', reportStart);
  const report = panel.slice(reportStart, reportEnd);
  assert.match(report, /buildHistorySendIncidentReport\(\{/);
  assert.match(report, /tabId,/);
  assert.match(report, /occurredAt: Date\.now\(\)/);
  assert.match(report, /incidentReport,[\s\S]{0,220}incidentPreview/,
    'the complete report must be both copyable and expandable');
  assert.match(report, /'error',\s*6000,\s*true,\s*incidentReport/,
    'terminal and AI lifecycle errors must remain until the user dismisses them');

  const controlsReportStart = panel.indexOf('const reportError = useCallback');
  const controlsReportEnd = panel.indexOf('const [draftWarning', controlsReportStart);
  const controlsReport = panel.slice(controlsReportStart, controlsReportEnd);
  assert.match(controlsReport, /showHistoryIncidentToast\(tabId, cause, incident\)/,
    'the composer and the outer History surface must share one incident presenter');

  const dismissStart = panel.indexOf('const dismissPromptPresentation = useCallback');
  const dismissEnd = panel.indexOf('const acknowledgeMaterializedHistoryReceipt', dismissStart);
  const dismiss = panel.slice(dismissStart, dismissEnd);
  assert.match(dismiss, /showHistoryIncidentToast\(tabId,/);
  assert.doesNotMatch(dismiss, /\breportError\(/,
    'reportError is a browser global outside AgentHistoryControls and would throw instead of showing a toast');

  const catchStart = panel.indexOf('} catch (e: any) {', panel.indexOf('const runAction'));
  const catchEnd = panel.indexOf('} finally {', catchStart);
  const catchBody = panel.slice(catchStart, catchEnd);
  assert.match(catchBody, /handoffId: sendHandoffId/);
  assert.match(catchBody, /sendAttemptId:/);
  assert.match(catchBody, /sendOperationKey:/);
  assert.match(catchBody, /statusAtSend: sendIncidentStatusAtSend/);
  assert.match(catchBody, /promptText: sendIncidentPromptText/);
});

test('incident copy feedback returns to the copy action', () => {
  assert.match(toast, /setCopyConfirmed\(true\)/);
  assert.match(toast, /setTimeout\(\(\) => \{[\s\S]{0,180}setCopyConfirmed\(false\)/);
  assert.match(toast, /\{copyConfirmed \? 'ok' : 'copy'\}/);
  assert.doesNotMatch(
    toast,
    /e\.currentTarget\.textContent = 'ok'/,
    'React clears currentTarget after the click; feedback must be component state',
  );
});

test('structured pre-submit refusals retain code and follower restore metadata', () => {
  assert.match(
    panel,
    /throw Object\.assign\([\s\S]{0,220}new Error\(result\?\.error \|\| 'Send failed before submit'\)[\s\S]{0,160}result && typeof result === 'object' \? result : \{\}/,
  );
  assert.match(panel, /cancelledFollowerHandoffIds/);
  assert.match(panel, /sendFailureResult\?\.code/);
});

test('Claude startup settings failures use a typed startup incident instead of a fake send', () => {
  const handlerStart = panel.indexOf('const handleStartupGate');
  const handlerEnd = panel.indexOf('const handleDraftWarning', handlerStart);
  const handler = panel.slice(handlerStart, handlerEnd);
  assert.match(handler, /describeClaudeStartupFailure\(\{/);
  assert.match(handler, /incidentKind: 'startup-settings'/);
  assert.match(handler, /toolType: 'claude'/);
  assert.match(handler, /action: 'startup-settings'/);
  assert.match(handler, /headline: failure\.subtitle/);
  assert.match(handler, /failedCommand: detail\.failedCommand/);
  assert.match(handler, /proofOutcome: detail\.proofOutcome/);
  assert.match(handler, /recovery: failure\.detail/);
});

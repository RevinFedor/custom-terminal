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

test('History send errors copy a self-contained incident report', () => {
  const reportStart = panel.indexOf('const reportError = useCallback');
  const reportEnd = panel.indexOf('const [draftWarning', reportStart);
  const report = panel.slice(reportStart, reportEnd);
  assert.match(report, /buildHistorySendIncidentReport\(\{/);
  assert.match(report, /tabId,/);
  assert.match(report, /occurredAt: Date\.now\(\)/);
  assert.match(report, /incidentReport,[\s\S]{0,220}incidentPreview/,
    'the complete report must be both copyable and expandable');
  assert.match(report, /'error',\s*6000,\s*true,\s*incidentReport/,
    'terminal and AI lifecycle errors must remain until the user dismisses them');

  const catchStart = panel.indexOf('} catch (e: any) {', panel.indexOf('const runAction'));
  const catchEnd = panel.indexOf('} finally {', catchStart);
  const catchBody = panel.slice(catchStart, catchEnd);
  assert.match(catchBody, /handoffId: sendHandoffId/);
  assert.match(catchBody, /sendAttemptId:/);
  assert.match(catchBody, /sendOperationKey:/);
  assert.match(catchBody, /statusAtSend: sendIncidentStatusAtSend/);
  assert.match(catchBody, /promptText: sendIncidentPromptText/);
});

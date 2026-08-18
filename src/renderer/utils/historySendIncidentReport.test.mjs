import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHistorySendIncidentReport,
  formatHistoryIncidentMoscowTime,
} from './historySendIncidentReport.mjs';

test('send incident copy contains exact tab, Moscow time, handoff and prompt', () => {
  const occurredAt = Date.parse('2026-08-17T18:58:20.120Z');
  assert.equal(
    formatHistoryIncidentMoscowTime(occurredAt),
    '2026-08-17 21:58:20.120 MSK',
  );
  const report = buildHistorySendIncidentReport({
    error: 'Terminal draft state is unknown',
    tabId: 'project-tab-3604',
    occurredAt,
    toolType: 'claude',
    action: 'send',
    handoffId: 'msxljtsv-trg751',
    statusAtSend: 'inactive',
    effectiveStatusAtSend: 'active',
    submitted: false,
    pasteWritten: false,
    code: 'terminal_draft_state_unknown',
    images: 1,
    promptText: 'exact prompt text',
  });
  assert.match(report, /Tab ID: project-tab-3604/);
  assert.match(report, /Time \(Moscow\): 2026-08-17 21:58:20\.120 MSK/);
  assert.match(report, /Handoff ID: msxljtsv-trg751/);
  assert.match(report, /Log lookup: \[HistoryHandoff\] SEND_RESULT tab=ect-tab-3604 handoff=msxljtsv-trg751/);
  assert.match(report, /Prompt \(17 chars\):\nexact prompt text/);
});

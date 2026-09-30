import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHistorySendIncidentReport,
  formatHistoryIncidentMoscowTime,
} from './historySendIncidentReport.mjs';

test('send incident copy contains exact operation metadata but never the prompt body', () => {
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
    chips: 3,
    textInserts: 2,
    promptText: 'exact prompt text',
  });
  assert.match(report, /Tab ID: project-tab-3604/);
  assert.match(report, /Time \(Moscow\): 2026-08-17 21:58:20\.120 MSK/);
  assert.match(report, /Handoff ID: msxljtsv-trg751/);
  assert.match(report, /Log lookup: \[HistoryHandoff\] SEND_RESULT tab=ect-tab-3604 handoff=msxljtsv-trg751/);
  assert.match(report, /Prompt: 17 chars \(content omitted\)/);
  assert.match(report, /Chips: 3/);
  assert.match(report, /Text inserts: 2/);
  assert.doesNotMatch(report, /exact prompt text/);
});

test('metadata-only caller does not require or expose pasted text, image paths, or saved prompt bodies', () => {
  const report = buildHistorySendIncidentReport({ promptChars: 500_000, images: 1, chips: 2, textInserts: 1,
    promptText: 'secret body /private/image.png <pasted_content>large private data</pasted_content>' });
  assert.match(report, /Prompt: 500000 chars/);
  assert.doesNotMatch(report, /secret|private|pasted_content/);
  assert.ok(report.length < 1000);
});

test('startup settings incident names Claude, the failed command, auth code and useful log key', () => {
  const report = buildHistorySendIncidentReport({
    incidentKind: 'startup-settings',
    error: 'Unable to validate model: OAuth refresh token is no longer valid; run /login to re-authenticate',
    tabId: 'project-tab-4241',
    occurredAt: Date.parse('2026-08-22T01:58:32.681Z'),
    toolType: 'claude',
    action: 'startup-settings',
    failedCommand: '/model claude-opus-5[1m]',
    proofOutcome: 'unresolved',
    code: 'claude_auth_expired',
    recovery: 'Run /login in the terminal, then retry /model claude-opus-5[1m].',
  });
  assert.match(report, /^Noted Terminal startup settings incident/);
  assert.match(report, /Tool: claude/);
  assert.match(report, /Action: startup-settings/);
  assert.match(report, /Failed command: \/model claude-opus-5\[1m\]/);
  assert.match(report, /Error code: claude_auth_expired/);
  assert.match(report, /Recovery: Run \/login in the terminal, then retry \/model/);
  assert.match(report, /Log lookup: \[ClaudeStartupDefaultsGate\] tab=ect-tab-4241/);
  assert.doesNotMatch(report, /Handoff ID:/);
  assert.doesNotMatch(report, /SEND_RESULT/);
});

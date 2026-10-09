import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRunAfterIncidentReport } from './runAfterIncidentReport.mjs';

test('Run after incident report carries exact tab, session, time and lifecycle reason', () => {
  const report = buildRunAfterIncidentReport({
    tabId: 'project-tab-4553',
    sessionId: 'b319508f-0146-4448-b954-93405d09f498',
    triggerName: '-> inbox',
    reason: 'process-exited',
    outcome: 'завершилась нештатно',
    source: 'codex-live',
    occurredAt: Date.parse('2026-08-30T10:07:48.664Z'),
  });
  assert.match(report, /^Noted Terminal Run after incident/m);
  assert.match(report, /^Error: process-exited$/m);
  assert.match(report, /^Tab ID: project-tab-4553$/m);
  assert.match(report, /^Session ID: b319508f-0146-4448-b954-93405d09f498$/m);
  assert.match(report, /^Time \(Moscow\): 2026-08-30 13:07:48\.664 MSK$/m);
  assert.match(report, /^Time \(UTC\): 2026-08-30T10:07:48\.664Z$/m);
  assert.match(report, /^Log lookup: \[PromptQueueRunner\] tab=ect-tab-4553 reason=process-exited$/m);
});

test('manual Stop has no incident or paused report', () => {
  const report = buildRunAfterIncidentReport({ tabId: 'tab-4412', triggerName: 'terminal mcp\\timeline',
    reason: 'manual-stop', outcome: 'была остановлена', source: 'codex-live', occurredAt: 1791548904320,
    ownerTabId: 'tab-4412', ownerName: 'terminal mcp\\timeline', remainingItems: 2 });
  assert.equal(report, null);
});

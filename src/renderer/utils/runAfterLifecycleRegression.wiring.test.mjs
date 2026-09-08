import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = fs.readFileSync(
  path.join(here, '../hooks/usePromptQueueRunner.ts'),
  'utf8',
);

test('rollout completion alias cannot disarm an already successful Run after edge', () => {
  assert.match(runner, /normalizeAgentTurnEndReason/);
  assert.match(
    runner,
    /reason:\s*normalizeAgentTurnEndReason\(data\.reason\) \|\| data\.reason/,
  );
  assert.match(
    runner,
    /normalizeAgentTurnEndReason\(data\.reason\)[\s\S]{0,120}\|\| 'natural'/,
    'dedupe identity must use the canonical lifecycle reason',
  );
});

test('genuine Run after failures use the shared persistent copyable toast', () => {
  const start = runner.indexOf('function applyAbnormalQueueOutcome(');
  const end = runner.indexOf('const SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS', start);
  const body = runner.slice(start, end);
  assert.match(body, /buildRunAfterIncidentReport\(\{/);
  assert.match(body, /sessionId:\s*triggerSessionId/);
  assert.match(body, /occurredAt:\s*outcomeTs/);
  assert.match(
    body,
    /'warning',\s*0,\s*true,\s*incidentReport[\s\S]{0,180}ownerTabId[\s\S]{0,100}incidentReport/,
  );
});

test('restored and overdue timers resume their original deadline only after workflow hydration', () => {
  assert.match(runner, /const resumePersistedTimers =/);
  assert.match(runner, /subscribeWorkflowRestoreReconciliation\([\s\S]*?resumePersistedTimers\(\)/);
  assert.match(runner, /queueDeadlineWakeListeners\.add\(resumePersistedTimers\)/);
  assert.match(runner, /queueDeadlineWakeListeners\.delete\(resumePersistedTimers\)/);
  const due = runner.slice(runner.indexOf('if (remainingMs <= 0)'), runner.indexOf('const sliceMs ='));
  assert.ok(due.indexOf('isTabWorkflowBlocked(ownerTabId)') < due.indexOf('consumeFirstDelayCountdown(ownerTabId)'));
  assert.match(due, /setPromptTrigger\(ownerTabId, head.id, \{ kind: 'timer', seconds: 0 \}\)/);
});

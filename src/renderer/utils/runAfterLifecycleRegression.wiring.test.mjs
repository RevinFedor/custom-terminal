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

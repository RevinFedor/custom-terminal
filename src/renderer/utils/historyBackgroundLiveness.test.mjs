import assert from 'node:assert/strict';
import test from 'node:test';
import { isHistoryTaskBackgroundLive } from './historyBackgroundLiveness.mjs';

const codex = (overrides = {}) => isHistoryTaskBackgroundLive({
  subagentStatus: 'running',
  actionProcessGeneration: 'pty-a:4',
  currentProcessGeneration: 'pty-a:4',
  agentProcessAlive: true,
  inLastTurn: false,
  isTurnBusy: false,
  hasResult: false,
  ...overrides,
});

test('keeps a same-generation Codex subagent live after its parent turn settles', () => {
  assert.equal(codex(), true);
});

test('does not resurrect an old Codex subagent when another process starts', () => {
  assert.equal(codex({ currentProcessGeneration: 'pty-a:5' }), false);
});

test('an unproven historical Codex card is visible but never live', () => {
  assert.equal(codex({ actionProcessGeneration: null }), false);
});

test('terminal Codex statuses and a dead process are not live', () => {
  assert.equal(codex({ subagentStatus: 'completed' }), false);
  assert.equal(codex({ subagentStatus: 'interrupted' }), false);
  assert.equal(codex({ agentProcessAlive: false }), false);
});

test('Claude task liveness remains scoped to the current busy turn', () => {
  assert.equal(codex({
    subagentStatus: undefined,
    actionProcessGeneration: undefined,
    currentProcessGeneration: undefined,
    inLastTurn: true,
    isTurnBusy: true,
  }), true);
  assert.equal(codex({
    subagentStatus: undefined,
    actionProcessGeneration: undefined,
    currentProcessGeneration: undefined,
    inLastTurn: false,
    isTurnBusy: true,
  }), false);
});

// ── provider intersection: the gap that produced production tab-2598 ────────

test('a Claude background agent is live without any process generation', () => {
  // Claude never writes a generation — nothing on that side produces one. The
  // Codex-only "generation must match" rule silently made every background
  // Claude agent impossible to show: no chip, and therefore no steps pane.
  // Both changes were correct on their own; only their intersection was broken.
  assert.equal(isHistoryTaskBackgroundLive({
    toolType: 'claude',
    subagentStatus: 'running',
    actionProcessGeneration: undefined,
    currentProcessGeneration: 'gen-1',
    agentProcessAlive: true,
    inLastTurn: true,
    isTurnBusy: false,   // its own turn already ended — that is normal for async
    hasResult: false,
  }), true);
});

test('a Claude background agent still dies with its host process', () => {
  // Process-scoped, not eternal: the agent cannot outlive the Claude process.
  assert.equal(isHistoryTaskBackgroundLive({
    toolType: 'claude',
    subagentStatus: 'running',
    agentProcessAlive: false,
    inLastTurn: true,
    isTurnBusy: false,
    hasResult: false,
  }), false);
});

test('terminal Claude statuses are never live', () => {
  for (const subagentStatus of ['completed', 'interrupted']) {
    assert.equal(isHistoryTaskBackgroundLive({
      toolType: 'claude',
      subagentStatus,
      agentProcessAlive: true,
      inLastTurn: true,
      isTurnBusy: true,
      hasResult: true,
    }), false, subagentStatus);
  }
});

test('the generation rule still guards Codex after the split', () => {
  const codexCard = (extra) => isHistoryTaskBackgroundLive({
    toolType: 'codex',
    subagentStatus: 'running',
    agentProcessAlive: true,
    currentProcessGeneration: 'gen-2',
    inLastTurn: true,
    isTurnBusy: false,
    hasResult: false,
    ...extra,
  });
  assert.equal(codexCard({ actionProcessGeneration: 'gen-2' }), true, 'same process');
  assert.equal(codexCard({ actionProcessGeneration: 'gen-1' }), false, 'previous process on this tab');
  assert.equal(codexCard({ actionProcessGeneration: null }), false, 'unproven historical card');
});

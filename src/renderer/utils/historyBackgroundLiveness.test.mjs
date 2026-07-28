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

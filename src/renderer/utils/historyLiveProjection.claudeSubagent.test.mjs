import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceHistoryLiveProjection } from './historyLiveProjection.mjs';
import { isHistoryTaskBackgroundLive } from './historyBackgroundLiveness.mjs';

/**
 * Claude subagent spawns must survive the LIVE path, not only the durable one.
 *
 * Scar 2026-07-29: a synchronous Claude agent ran for 42 seconds and produced
 * zero background chips. Its durable Task card was correct — but the durable
 * transcript is deliberately NOT re-read while the parent turn is busy
 * (reason=turn-busy), and a synchronous agent lives entirely inside that
 * window. The only rows the surface had were live ones, and the live projection
 * flattened the spawn into a generic tool row, so the strip (which matches on
 * `tool: 'Task'`) never saw an agent at all.
 *
 * Codex avoided this by attaching a prepared card to its live record; Claude
 * has none, so the card is rebuilt from the spawn block itself.
 */

const envelope = (message) => ({
  type: 'message',
  sessionId: 'session-a',
  timestamp: '2026-07-29T00:37:16.000Z',
  message,
});

const spawnRecord = (uuid, toolName, input) => ({
  type: 'assistant',
  uuid,
  sessionId: 'session-a',
  sourceIdentity: 'source-' + uuid,
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_' + uuid, name: toolName, input }],
  },
});

const firstAction = (entries) => entries[0]?.actions?.[0];

test('a live Claude Agent spawn becomes a Task card, not a generic tool row', () => {
  const entries = reduceHistoryLiveProjection([], envelope(spawnRecord('a1', 'Agent', {
    description: 'Чтение пяти файлов',
    subagent_type: 'general-purpose',
    prompt: 'Прочитай по очереди пять разных файлов из src/main',
  })));

  const action = firstAction(entries);
  assert.equal(action.tool, 'Task');
  assert.equal(action.description, 'Чтение пяти файлов');
  assert.equal(action.toolUseId, 'toolu_a1');
  assert.match(action.taskPrompt, /пять разных файлов/);
});

test('the legacy tool name Task builds the same card', () => {
  // The CLI renamed Task → Agent; sessions of both vintages must render alike.
  const entries = reduceHistoryLiveProjection([], envelope(spawnRecord('a2', 'Task', {
    description: 'Старое имя инструмента',
    prompt: 'что-нибудь',
  })));
  assert.equal(firstAction(entries).tool, 'Task');
});

test('a spawn without a description falls back to the task text', () => {
  const entries = reduceHistoryLiveProjection([], envelope(spawnRecord('a3', 'Agent', {
    prompt: 'Посчитай markdown-файлы в docs/knowledge и назови три самых больших по размеру',
  })));
  const action = firstAction(entries);
  assert.equal(action.tool, 'Task');
  assert.ok(action.description.length > 0);
  assert.ok(action.description.length <= 60);
});

test('the live spawn card carries no speculative status of its own', () => {
  // Claiming `running` from the tool call alone would bring back eternal chips
  // for rejected/synchronous attempts. A later exact main-owned async
  // acceptance can still make this statusless card process-scoped.
  const entries = reduceHistoryLiveProjection([], envelope(spawnRecord('a4', 'Agent', {
    description: 'Синхронный агент',
    prompt: 'p',
  })));
  const action = firstAction(entries);
  assert.equal(action.subagentStatus, undefined);

  const liveWhileBusy = isHistoryTaskBackgroundLive({
    toolType: 'claude',
    subagentStatus: action.subagentStatus,
    agentProcessAlive: true,
    inLastTurn: true,
    isTurnBusy: true,
    hasResult: false,
  });
  assert.equal(liveWhileBusy, true, 'visible while its own turn is running');

  const liveAfterTurn = isHistoryTaskBackgroundLive({
    toolType: 'claude',
    subagentStatus: action.subagentStatus,
    agentProcessAlive: true,
    inLastTurn: true,
    isTurnBusy: false,
    hasResult: false,
  });
  assert.equal(liveAfterTurn, false, 'without an exact async lease, the turn ending is terminal');
});

test('ordinary tools are still flattened to raw rows', () => {
  const entries = reduceHistoryLiveProjection([], envelope(spawnRecord('a5', 'Bash', {
    command: 'ls -la',
  })));
  const action = firstAction(entries);
  assert.equal(action.tool, '__raw__');
  assert.equal(action.rawTool.toolName, 'Bash');
});

test('a prepared card (Codex) still wins over the rebuilt one', () => {
  const record = {
    type: 'assistant',
    uuid: 'a6',
    sessionId: 'session-a',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call-1',
        name: 'Subagent',
        input: {},
        subagentCard: { tool: 'Task', description: 'из rollout', subagentStatus: 'running' },
      }],
    },
  };
  const action = firstAction(reduceHistoryLiveProjection([], envelope(record)));
  assert.equal(action.description, 'из rollout');
  assert.equal(action.subagentStatus, 'running');
});

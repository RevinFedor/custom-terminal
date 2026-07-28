import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildHistoryLivePresentation } from './historyLiveProjection.mjs';

// The background-chip strip must see the SAME rows the transcript shows:
// durable rows plus the live rollout tail. Codex writes a subagent into the
// durable history only when the rollout is re-read, but its spawn is already
// on screen through the live stream — so chips computed from durable rows
// alone miss every agent whose whole life fits between two durable reloads.
//
// E2E ct-e2e22 scar: three Codex subagents, each alive ~2s (17:38:05→07,
// 17:38:52→54, 17:39:53→55), while durable recomputes landed at 17:38:18,
// 17:38:45, 17:39:13 — all in the gaps. Result: 38 measurements, every one
// count=0, and the conclusion "the agent is too fast" instead of "the strip
// never looked at the live rows". After the fix the same setup produced
// `BACKGROUND_CHIPS ... count=1 ... keys=subagent:task:call_apR8zN6…`.

// `sourceIdentity` is how the merge recognises "same row from both sides" —
// the live tail and the durable reload of one rollout record share it.
const taskRow = (uuid, description, extra = {}, sourceIdentity = null) => ({
  uuid,
  role: 'assistant',
  timestamp: '2026-07-28T00:02:25.000Z',
  content: '',
  sessionId: 'sess-1',
  ...(sourceIdentity ? { sourceIdentity } : {}),
  actions: [{ tool: 'Task', description, toolUseId: 'call-' + uuid, ...extra }],
});

const userRow = (uuid) => ({
  uuid,
  role: 'user',
  timestamp: '2026-07-28T00:02:00.000Z',
  content: 'запусти агента',
  sessionId: 'sess-1',
});

test('live-only subagent row reaches the merged set the chips read', () => {
  // Durable side knows nothing yet — exactly the window that used to be blind.
  const durable = [userRow('u1')];
  const live = [taskRow('live-1', 'sleep_45 (explorer)', { subagentStatus: 'running' })];

  const merged = buildHistoryLivePresentation(durable, live);
  const tasks = merged.flatMap((entry) => entry.actions || []).filter((a) => a.tool === 'Task');

  assert.equal(tasks.length, 1, 'the live spawn is present for the chip collector');
  assert.equal(tasks[0].subagentStatus, 'running');
  assert.match(tasks[0].description, /explorer/);
});

test('durable row wins once the rollout is re-read (no duplicate chip)', () => {
  // Same rollout record seen from both sides: the live tail still says
  // "running", the durable reload already carries the terminal status. They
  // share sourceIdentity, so the merge must keep ONE row — otherwise the
  // strip would show a phantom second chip for an agent that already ended.
  const identity = 'rollout:sess-1:line-42';
  const durable = [
    userRow('u1'),
    taskRow('durable', 'sleep_45 (explorer)', { subagentStatus: 'completed', result: 'ГОТОВО' }, identity),
  ];
  const live = [taskRow('live', 'sleep_45 (explorer)', { subagentStatus: 'running' }, identity)];

  const merged = buildHistoryLivePresentation(durable, live);
  const tasks = merged.flatMap((entry) => entry.actions || []).filter((a) => a.tool === 'Task');

  assert.equal(tasks.length, 1, 'one row per agent after the handoff');
  assert.equal(tasks[0].subagentStatus, 'completed', 'durable truth wins over the live guess');
});

test('a live row with no identity yet is kept, not dropped', () => {
  // The spawn reaches the screen before it has a durable counterpart; losing
  // it here is exactly the blindness this fix removes.
  const durable = [userRow('u1')];
  const live = [taskRow('live', 'sleep_45 (explorer)', { subagentStatus: 'running' })];
  const merged = buildHistoryLivePresentation(durable, live);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].actions[0].subagentStatus, 'running');
});

test('no live rows leaves the durable set untouched', () => {
  const durable = [userRow('u1'), taskRow('d1', 'done (default)', { subagentStatus: 'completed' })];
  const merged = buildHistoryLivePresentation(durable, []);
  assert.deepEqual(merged.map((e) => e.uuid), ['u1', 'd1']);
});

// ── live spawn keeps the Task shape end-to-end ─────────────────────────────

import { reduceHistoryLiveProjection } from './historyLiveProjection.mjs';

test('a live subagent spawn rebuilds a Task row, not a generic tool row', () => {
  // Main sends the ready-made card alongside the tool_use block. Without the
  // rebuild the renderer produced a plain tool row and the chip strip — which
  // matches on `tool: 'Task'` — never saw the running agent (E2E ct-e2e24:
  // a `default` agent ran 41s with three recomputes inside its lifetime and
  // count=0 in every one, while the log said `projected=Subagent`).
  const detail = {
    uuid: 'live-1',
    sourceIdentity: 'rollout:sess:line-7',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call_abc:canonical:0',
        name: 'Subagent',
        input: {},
        subagentCard: { tool: 'Task', description: 'sleep_40 (default)', subagentStatus: 'running' },
      }],
    },
  };

  const entries = reduceHistoryLiveProjection([], detail);
  const tasks = entries.flatMap((entry) => entry.actions || []).filter((a) => a.tool === 'Task');

  assert.equal(tasks.length, 1, 'the spawn is a Task row the chip strip can see');
  assert.equal(tasks[0].subagentStatus, 'running');
  assert.equal(tasks[0].toolUseId, 'call_abc:canonical:0', 'identity is stamped for chip keys');
  assert.match(tasks[0].description, /default/);
});

test('an ordinary live tool call stays a generic row', () => {
  const detail = {
    uuid: 'live-2',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_x:canonical:0', name: 'Read', input: { path: 'a.txt' } }],
    },
  };
  const entries = reduceHistoryLiveProjection([], detail);
  const actions = entries.flatMap((entry) => entry.actions || []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].tool, '__raw__', 'non-subagent tools are untouched');
});

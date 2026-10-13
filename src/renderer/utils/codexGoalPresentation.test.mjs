import test from 'node:test';
import assert from 'node:assert/strict';
import { codexGoalPresentation, filterTimelineGoalPresentation } from './codexGoalPresentation.mjs';
import { timelinePromptPreview } from './timelineEntryPreview.mjs';
import { projectTimelineLiveUserMessage } from './timelineTranscriptRefresh.mjs';
import { reduceHistoryLiveProjection, reconcileCommittedHistoryLiveProjection } from './historyLiveProjection.mjs';

const sid = '4a2ba840-c002-4141-b3c3-e592f5641cbf';
const wire = status => `<codex_internal_context source="user_goal">\nUser set goal status: "${status}".\n</codex_internal_context>`;
const entry = (status, line = 31775) => ({ role: 'user', type: 'user', uuid: `codex-user-${sid}-${line}`,
  sourceIdentity: `codex-user-source-${sid}-228537875`, sessionId: sid,
  timestamp: '2026-10-10T06:23:30.722Z', content: wire(status) });

test('actual saved paused/active carriers become readable service labels without mutating transport', () => {
  for (const [status, label] of [['paused', 'Goal paused'], ['active', 'Goal active']]) {
    const original = entry(status), before = structuredClone(original);
    assert.deepEqual(codexGoalPresentation(original, 'codex'), {
      kind: 'status', status, title: 'Goal status', text: label,
    });
    assert.deepEqual(original, before);
    const preview = timelinePromptPreview(original);
    assert.equal(preview.text, label); assert.equal(preview.goal.kind, 'status');
  }
});

test('reserved full native source=goal and existing typed continuation share presentation', () => {
  for (const original of [
    { ...entry('active'), content: '<codex_internal_context source="goal">Continue the active goal.</codex_internal_context>' },
    { ...entry('active'), content: '<codex_internal_context source="goal">Continue\n<details>same Goal</details></codex_internal_context>' },
    { ...entry('active'), content: 'Goal continued', role: 'goal', serviceCarrier: 'goal-continuation' },
    { ...entry('active'), content: 'Goal continued', isGoalContinuation: true },
  ]) assert.equal(codexGoalPresentation(original, 'codex').kind, 'continuation');
});

test('plain/quoted/in-text/malformed/unknown and non-Codex inputs remain literal', () => {
  for (const content of ['Goal continued', 'User set goal status: "paused".',
    `Example: ${wire('paused')}`, '```xml\n' + wire('paused') + '\n```',
    wire('paused') + '\nordinary user tail', wire('paused').replace('</codex_internal_context>', ''),
    wire('paused').replace('source="user_goal"', 'source="other"'),
    wire('done'), wire('paused') + wire('active'),
    '<codex_internal_context source="goal">example <codex_internal_context source="user_goal">x</codex_internal_context></codex_internal_context>',
  ]) assert.equal(codexGoalPresentation({ ...entry('paused'), content }, 'codex'), null, content);
  assert.equal(codexGoalPresentation(entry('paused'), 'claude'), null);
  assert.equal(codexGoalPresentation({ role: 'user', uuid: 'ordinary-user', content: wire('paused') }), null);
});

test('exact MCP provenance stays MCP even if its body quotes the reserved native wire', () => {
  const original = { ...entry('paused'), semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp' }] };
  assert.equal(codexGoalPresentation(original, 'codex'), null);
});

test('display filtering removes Goal from all rail inputs, preserves later addresses and raw arrays', () => {
  const continuation = { ...entry('active', 31758), isGoalContinuation: true, content: 'Goal continued', turnIndex: 44 };
  const real = { ...entry('active', 31789), content: 'продолжай работу, в основном окне', turnIndex: 47 };
  const rows = [continuation, entry('paused'), entry('active', 31779), real,
    { uuid: 'compact-exact', type: 'compact', content: 'Conversation compacted' }];
  const before = structuredClone(rows), filtered = filterTimelineGoalPresentation(rows, 'codex');
  assert.deepEqual(filtered.map(row => row.uuid), [real.uuid, 'compact-exact']);
  assert.equal(filtered[0], real); assert.equal(filtered[0].turnIndex, 47);
  assert.deepEqual(rows, before);
  assert.equal(filterTimelineGoalPresentation(rows, 'claude'), rows);
  assert.equal(filterTimelineGoalPresentation([real], 'codex')[0], real);
});

test('busy native Goal carriers never mint a provisional Timeline user point; real user survives', () => {
  for (const content of [wire('paused'), wire('active'), '<codex_internal_context source="goal">Continue</codex_internal_context>']) {
    const e = entry('paused');
    const detail = { toolType: 'codex', sessionId: sid, timestamp: e.timestamp,
      message: { ...e, type: 'user', message: { content: [{ type: 'text', text: content }] } } };
    assert.equal(projectTimelineLiveUserMessage(detail, { toolType: 'codex', sessionId: sid }), null);
  }
  const e = entry('paused');
  const point = projectTimelineLiveUserMessage({ toolType: 'codex', sessionId: sid, timestamp: e.timestamp,
    message: { ...e, type: 'user', message: { content: [{ type: 'text', text: 'normal prompt' }] } } },
  { toolType: 'codex', sessionId: sid });
  assert.equal(point.content, 'normal prompt'); assert.equal(point.uuid, e.uuid);
});

test('actual live History reducer preserves the status carrier raw identity while the shared display makes it compact', () => {
  const saved = entry('paused');
  const detail = { type: 'message', toolType: 'codex', sessionId: sid, timestamp: saved.timestamp,
    message: { type: 'user', uuid: saved.uuid, sourceIdentity: saved.sourceIdentity, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: saved.content }] } } };
  const live = reduceHistoryLiveProjection([], detail, { includeUserText: true });
  assert.equal(live.length, 1); assert.equal(live[0].uuid, saved.uuid);
  assert.equal(live[0].sourceIdentity, saved.sourceIdentity); assert.equal(live[0].content, saved.content);
  assert.equal(live[0].role, 'user', 'presentation must not rewrite physical role/pairing');
  assert.equal(codexGoalPresentation(live[0], 'codex').text, 'Goal paused');
  const adopted = reconcileCommittedHistoryLiveProjection(live, [saved]);
  assert.equal(adopted.entries.length, 0, 'canonical adoption cannot leave a duplicate service row');
});

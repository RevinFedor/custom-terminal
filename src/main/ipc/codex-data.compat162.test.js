'use strict';

// Actual parsers/projectors; only protocol records and Main transport/owner ports
// are synthetic. No provider, PTY, stored user transcript or application launch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { _api } = require('./codex-data');
const { classifyCodexTurnRecord } = require('../codex-turn-outcome');
const { makeHistoryRowStub } = require('../history-entry-window');
const { cloneProjectionGraph } = require('../codex-projection-checkpoint');
const { normalizeCodexTextPhase } = require('../../shared/history-text-phase.cjs');

const sid = 'synthetic-codex162';
let seq = 0;
const record = (type, payload) => ({ type, payload, __line: ++seq, __byteOffset: seq * 100,
  timestamp: '2026-10-09T04:00:00.000Z' });
const user = () => record('event_msg', { type: 'user_message', message: 'private compatibility fixture' });
const assistant = phase => record('response_item', { type: 'message', role: 'assistant', phase,
  content: [{ type: 'output_text', text: 'A stable answer fragment.' }] });
const script = source => record('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'exec-test', input: source });
const wait = () => record('response_item', { type: 'function_call', name: 'wait', call_id: 'wait-test', arguments: '{"cell_id":"42"}' });
const output = (parts, cell = false) => [
  { type: 'input_text', text: cell ? 'Script running with cell ID 42\nWall time 1s\nOutput:\n' : 'Script completed\nWall time 1s\nOutput:\n' },
  ...parts.map(value => ({ type: 'input_text', text: typeof value === 'string' ? value : JSON.stringify(value) })),
];
const result = (parts, cell = false, id = 'exec-test') => record('response_item', {
  type: 'custom_tool_call_output', call_id: id, output: output(parts, cell),
});
const settled = (index, value, status = 'fulfilled') => ({ index, status,
  [status === 'fulfilled' ? 'value' : 'reason']: value });
const tools = '[tools.exec_command({cmd:"slow-A"}),tools.exec_command({cmd:"fast-B"})]';
const source = `await stream_settled(${tools}, text);`;
const decode = (input, parts) => _api.codexHistoryActionsForCall({ toolName: 'exec', callId: 'exec-test', args: { input } },
  parts === undefined ? undefined : output(parts), false);
const raws = entries => entries.flatMap(entry => entry.actions || []).map(action => action.rawTool).filter(Boolean);

function mainFixture() {
  const filename = path.join(__dirname, '..', 'main.js');
  const sourceText = fs.readFileSync(filename, 'utf8');
  const names = ['codexEventType', 'codexLiveUuid', 'codexLiveSourceIdentity', 'codexLiveProjectionState',
    'decodeCodexLiveToolActions', 'codexLiveToolResultText', 'buildCodexLiveCanonicalResultMessage', 'buildCodexLiveRawMessage'];
  const context = { require, path, srcMainDir: path.join(__dirname, '..'), codexDataModule: { _api },
    codexKnownSessions: new Map(), getCodexProcessActionGeneration: () => null,
    extractCodexLiveText: parts => parts.map(part => part.text || '').join('\n'),
    parseCodexLiveArgs: payload => payload.input ? { input: payload.input } : JSON.parse(payload.arguments || '{}'),
    console: { log() {}, warn() {} } };
  for (const name of names) {
    const start = sourceText.indexOf('function ' + name + '(');
    const end = sourceText.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start, name);
    vm.runInNewContext(sourceText.slice(start, end), context, { filename: 'actual-main-' + name });
  }
  return context;
}

for (const phase of ['commentary', 'partial_answer', 'final_answer', undefined, 'future_phase']) {
  test(`text phase ${phase}: durable and actual Main/live projection agree`, async () => {
    const { reduceHistoryLiveProjection } = await import('../../renderer/utils/historyLiveProjection.mjs');
    const input = assistant(phase);
    const expected = normalizeCodexTextPhase(phase);
    const durable = _api.buildCodexFullHistory([user(), input], sid).find(row => row.role === 'assistant');
    const main = mainFixture();
    const liveMessage = main.buildCodexLiveRawMessage({ tabId: 'private-tab', sessionId: sid }, input);
    const live = reduceHistoryLiveProjection([], { type: 'message', message: liveMessage, sessionId: sid });
    assert.equal(durable.textPhase, expected);
    assert.equal(live[0].textPhase, expected);
    assert.equal(live[0].content, durable.content);
    assert.equal(live[0].sourceIdentity, durable.sourceIdentity);
  });
}

test('partial answer remains standalone across caption/edit grouping and row stubs', async () => {
  const { buildHistoryDisplayUnits, isCaptionForNext } = await import('../../renderer/utils/historyDisplayUnits.mjs');
  const rows = _api.buildCodexFullHistory([user(), assistant('partial_answer'), script('text(await tools.exec_command({cmd:"inspect"}));'), result(['done'])], sid);
  const partial = rows.find(row => row.textPhase === 'partial_answer');
  const call = rows.find(row => row.actions?.length);
  assert.equal(isCaptionForNext(partial, call), false);
  const stub = makeHistoryRowStub(partial);
  assert.equal(stub.textPhase, 'partial_answer');
  assert.equal(isCaptionForNext(stub, call), false);
  const edit = uuid => ({ ...call, uuid, actions: [{ tool: '__raw__', rawTool: {
    toolUseId: uuid, toolName: 'Edit', family: 'edit', args: { file_path: '/private/synthetic' }, result: '' } }] });
  for (const answer of [partial, stub]) {
    const units = buildHistoryDisplayUnits([edit('e1'), answer, call, edit('e2')]);
    assert.ok(units.some(unit => unit.kind === 'entry' && unit.entry.uuid === partial.uuid));
  }
  assert.equal(isCaptionForNext({ ...partial, textPhase: 'commentary' }, call), true);
  assert.equal(isCaptionForNext({ ...partial, textPhase: undefined }, call), true);
});

test('partial is not final preview, response timing, or turn completion authority', async () => {
  const { latestCompletedHistoryResponseTiming } = await import('../../renderer/utils/historyResponseTiming.mjs');
  const { resolveTimelineFullResponse } = await import('../../renderer/utils/timelineEntryPreview.mjs');
  const records = [user(), record('event_msg', { type: 'task_started', turn_id: 'private-turn' }), assistant('partial_answer')];
  const rows = _api.buildCodexFullHistory(records, sid);
  const partial = rows.find(row => row.textPhase === 'partial_answer');
  assert.equal(_api.buildCodexTimeline(records, sid)[0].responsePreview, undefined);
  assert.equal(latestCompletedHistoryResponseTiming([{ ...partial, responseTiming: { startTs: 1, endTs: 2, durationMs: 1 } }]), null);
  assert.equal(resolveTimelineFullResponse(rows, { uuid: partial.uuid, content: partial.content, contentLength: partial.content.length }), null);
  const tracker = {};
  assert.equal(classifyCodexTurnRecord(tracker, records[1]).busy, true);
  assert.equal(classifyCodexTurnRecord(tracker, records[2]), null);
  assert.equal(tracker.currentTurnHasFinalResult, false);
  records.push(assistant('final_answer'));
  assert.ok(_api.buildCodexTimeline(records, sid)[0].responsePreview);
});

test('indexed stream results follow the input binding, not finish/source order', () => {
  const decoded = decode(source, [settled(1, 'B-output'), settled(0, 'A-output')]);
  assert.deepEqual(decoded.actions.map(action => action.rawTool.result), ['A-output', 'B-output']);
  assert.deepEqual(decoded.actions.map(action => action.rawTool.toolUseId), ['exec-test:canonical:0', 'exec-test:canonical:1']);
});

for (const input of [
  `const a=tools.exec_command({cmd:"slow-A"}); const b=tools.exec_command({cmd:"fast-B"}); await stream_settled([b,a], r=>text(r));`,
  `const a=tools.exec_command({cmd:"slow-A"}); const b=tools.exec_command({cmd:"fast-B"}); const p=[b,a]; for await(const r of as_settled(p)) { text(r); }`,
]) test('const input permutation is proved independently of lexical call order', () => {
  assert.deepEqual(decode(input, [settled(0, 'B-output'), settled(1, 'A-output')]).actions.map(action => action.rawTool.result), ['A-output', 'B-output']);
});

test('Map keys and rejected results retain exact call and error ownership', () => {
  const input = 'const a=tools.exec_command({cmd:"slow-A"}); const b=tools.exec_command({cmd:"fast-B"}); await stream_settled(new Map([["second",b],["first",a]]), async r=>{text(r)});';
  const actions = decode(input, [settled('second', 'B failed', 'rejected'), settled('first', 'A-output')]).actions.map(action => action.rawTool);
  assert.deepEqual(actions.map(action => [action.result, action.isError]), [['A-output', false], ['B failed', true]]);
});

for (const [label, input, parts] of [
  ['value-only callback', `await stream_settled(${tools}, r=>text(r.value));`, ['B-output', 'A-output']],
  ['duplicate index', source, [settled(1, 'B-output'), settled(1, 'other')]],
  ['foreign index', source, [settled(7, 'foreign'), settled(0, 'A-output')]],
  ['missing result', source, [settled(1, 'B-output')]],
  ['foreign output', source, ['prefix', settled(0, 'A-output')]],
  ['shadowed helper', `const stream_settled=custom; await stream_settled(${tools},text)`, [settled(1, 'B-output'), settled(0, 'A-output')]],
  ['aliased helper', `const settle=stream_settled; await settle(${tools},text)`, [settled(1, 'B-output'), settled(0, 'A-output')]],
  ['global helper', `await globalThis.stream_settled(${tools},text)`, [settled(1, 'B-output'), settled(0, 'A-output')]],
  ['deleted input slot', `const p=${tools}; const removed=delete p[0]; await stream_settled(p,text)`, [settled(1, 'B-output'), settled(0, undefined)]],
  ['mutated index', `await stream_settled(${tools}, r=>{r.index=0; text(r)});`, [settled(0, 'B-output'), settled(0, 'A-output')]],
  ['dynamic inputs', 'await stream_settled(items.map(x=>tools.exec_command({cmd:x})), text);', [settled(0, 'B-output'), settled(1, 'A-output')]],
]) test(`${label}: preserve aggregate on enclosing Script, never guess a child`, () => {
  const decoded = decode(input, parts);
  const raw = decoded.actions.map(action => action.rawTool);
  const aggregate = raw.at(-1);
  assert.equal(aggregate.toolName, 'Script');
  assert.deepEqual(raw.slice(0, -1).map(action => action.result), raw.slice(0, -1).map(() => ''));
  for (const part of parts) assert.ok(aggregate.result.includes(typeof part === 'string' ? part : JSON.stringify(part)));
});

for (const input of [
  `text(await tools.exec_command({cmd:"slow-A"})); text(await tools.exec_command({cmd:"fast-B"}));`,
  `const results=await Promise.all(${tools}); results.forEach(text);`,
  `const results=await Promise.allSettled(${tools}); results.forEach(text);`,
  `// stream_settled(x,text) example only\ntext(await tools.exec_command({cmd:"slow-A"})); text(await tools.exec_command({cmd:"fast-B"}));`,
]) test('old sequential/ordered Promise output keeps its prior shape', () => {
  const decoded = decode(input, ['A-output', 'B-output']);
  assert.equal(decoded.settledOutput, undefined);
  assert.deepEqual(decoded.actions.map(action => action.rawTool.result), ['A-output', 'B-output']);
});

test('settled output survives background wait, checkpoint restore and final reread', () => {
  const records = [user(), script(source), result([settled(1, 'B-output')], true), wait(), result([settled(0, 'A-output')], false, 'wait-test')];
  const projector = _api.createCodexHistoryProjector(sid);
  records.slice(0, 3).forEach(projector.feed);
  assert.equal(raws(projector.finalize())[1].result, 'B-output');
  const resumed = _api.createCodexHistoryProjector(sid, cloneProjectionGraph(projector.exportState()));
  records.slice(3).forEach(resumed.feed);
  assert.deepEqual(raws(resumed.finalize()).map(action => action.result), ['A-output', 'B-output']);
  assert.deepEqual(resumed.finalize(), _api.buildCodexFullHistory(records, sid));
});

test('actual Main cell completion and renderer retain unassigned output and stable child IDs', async () => {
  const { reduceHistoryLiveProjection } = await import('../../renderer/utils/historyLiveProjection.mjs');
  const main = mainFixture();
  const state = { tabId: 'private-tab', sessionId: sid };
  const input = `await stream_settled(${tools}, r=>text(r.value));`;
  const records = [script(input), result(['B-output'], true), wait(), result(['A-output'], false, 'wait-test')];
  let live = [];
  for (const rec of records) {
    const message = main.buildCodexLiveRawMessage(state, rec);
    if (message) live = reduceHistoryLiveProjection(live, { type: 'message', message, sessionId: sid });
  }
  const raw = raws(live);
  assert.equal(raw.length, 3);
  assert.equal(raw[2].toolName, 'Script');
  assert.equal(raw[2].result, 'B-output\nA-output');
  assert.deepEqual(raw.slice(0, 2).map(action => action.result), ['', '']);
  assert.deepEqual(raw.map(action => action.toolUseId), ['exec-test:canonical:0', 'exec-test:canonical:1', 'exec-test:canonical:2']);
});

test('second partial wait keeps live and durable results in parity before final completion', async () => {
  const { reduceHistoryLiveProjection } = await import('../../renderer/utils/historyLiveProjection.mjs');
  const input = 'await stream_settled([tools.exec_command({cmd:"A"}),tools.exec_command({cmd:"B"}),tools.exec_command({cmd:"C"})],text);';
  const records = [script(input), result([settled(2, 'C-output')], true), wait(), result([settled(1, 'B-output')], true, 'wait-test')];
  const main = mainFixture();
  const state = { tabId: 'private-tab', sessionId: sid };
  const projector = _api.createCodexHistoryProjector(sid);
  let live = [];
  for (const rec of records) {
    projector.feed(rec);
    const message = main.buildCodexLiveRawMessage(state, rec);
    if (message) live = reduceHistoryLiveProjection(live, { type: 'message', message, sessionId: sid });
  }
  assert.deepEqual(raws(projector.finalize()).map(action => action.result), [undefined, 'B-output', 'C-output']);
  assert.deepEqual(raws(live).map(action => action.result), [undefined, 'B-output', 'C-output']);
  const resumed = _api.createCodexHistoryProjector(sid, cloneProjectionGraph(projector.exportState()));
  [wait(), result([settled(0, 'A-output')], false, 'wait-test')].forEach(resumed.feed);
  assert.deepEqual(raws(resumed.finalize()).map(action => action.result), ['A-output', 'B-output', 'C-output']);
});

test('settled spawn identities stay attached to their own argument group', () => {
  const a = '01111111-1111-7111-8111-111111111111';
  const b = '02222222-2222-7222-8222-222222222222';
  const input = 'await stream_settled([tools.multi_agent_v1.spawn_agent({message:"A"}),tools.multi_agent_v1.spawn_agent({message:"B"})],text);';
  const actions = decode(input, [settled(1, { agent_id: b }), settled(0, { agent_id: a })]).actions;
  assert.deepEqual(actions.map(action => [action.subagentSpawn.args.message, action.agentSessionId]), [['A', a], ['B', b]]);
});

test('actual Main retains an earlier child and admits a later settlement on the same exec', () => {
  const main = mainFixture();
  const state = { tabId: 'private-tab', sessionId: sid };
  const a = '01111111-1111-7111-8111-111111111111';
  const b = '02222222-2222-7222-8222-222222222222';
  const input = 'await stream_settled([tools.multi_agent_v1.spawn_agent({message:"A"}),tools.multi_agent_v1.spawn_agent({message:"B"})],text);';
  main.buildCodexLiveRawMessage(state, script(input));
  const first = main.buildCodexLiveRawMessage(state, result([settled(1, { agent_id: b })], true));
  assert.ok(first.message.content.some(block => block.subagentCard?.agentSessionId === b));
  main.buildCodexLiveRawMessage(state, wait());
  const final = main.buildCodexLiveRawMessage(state, result([settled(0, { agent_id: a })], false, 'wait-test'));
  assert.deepEqual(Array.from(final.message.content, block => block.subagentCard?.agentSessionId), [a, b]);
  assert.equal(new Set(final.message.content.map(block => block.id)).size, 2);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _api } = require('./codex-data');

const SID = 'copy-identity';
const ABORTED = '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>';
const INSTRUCTIONS = '# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>Keep the contract.</INSTRUCTIONS>';

function fixture() {
  const records = [];
  const add = (type, payload) => {
    const record = { __line: records.length, type, payload,
      timestamp: new Date(Date.UTC(2026, 9, 20, 0, 0, records.length)).toISOString() };
    records.push(record);
    return record;
  };
  const user = text => add('response_item', { type: 'message', role: 'user',
    content: [{ type: 'input_text', text }] });
  const event = text => add('event_msg', { type: 'user_message', message: text });
  const answer = text => add('response_item', { type: 'message', role: 'assistant',
    phase: 'final_answer', content: [{ type: 'output_text', text }] });
  const turn = (text, order = 'response-first') => {
    add('event_msg', { type: 'task_started' });
    if (order === 'event-first') { event(text); user(text); }
    else if (order === 'response-only') user(text);
    else if (order === 'event-only') event(text);
    else { user(text); event(text); }
    answer('answer:' + text);
    add('event_msg', { type: 'task_complete' });
  };
  add('session_meta', { id: SID, cwd: '/fixture' });
  return { records, add, user, event, answer, turn };
}

function copy(f, start, end = start, options = {}) {
  const timeline = _api.buildCodexTimeline(f.records, SID).filter(e => e.type === 'user');
  return _api.buildCodexRangeExport(f.records, SID, '/fixture', options,
    timeline.at(start).uuid, timeline.at(end).uuid);
}

test('last four selected UUIDs cannot become four older turns after sixteen interrupted carriers', () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) { f.turn('old-' + i); f.user(ABORTED); }
  for (let i = 0; i < 4; i++) f.turn('selected-' + i);
  const before = JSON.stringify(f.records);
  const result = copy(f, -4, -1);
  assert.equal(result.success, true);
  assert.equal(result.selectedCount, 4);
  for (let i = 0; i < 4; i++) assert.ok(result.content.includes('answer:selected-' + i));
  assert.doesNotMatch(result.content, /old-|turn_aborted/);
  assert.equal(JSON.stringify(f.records), before, 'copy never rewrites its source');
});

for (const carrier of ['response-only', 'event-only', 'paired']) {
  for (const includeUser of [true, false]) {
    test(carrier + ' interrupt is not a copy turn; includeUser=' + includeUser, () => {
      const f = fixture();
      f.turn('previous');
      if (carrier !== 'event-only') f.user(ABORTED);
      if (carrier !== 'response-only') f.event(ABORTED);
      f.add('event_msg', { type: 'turn_aborted' });
      f.turn('selected'); f.turn('next');
      const result = copy(f, 1, 1, { includeUser });
      assert.equal(result.success, true);
      assert.match(result.content, /answer:selected/);
      assert.doesNotMatch(result.content, /answer:previous|answer:next|turn_aborted/);
      assert.equal(result.content.includes('👤 USER:'), includeUser);
      const selected = _api.buildCodexTimeline(f.records, SID).find(e => e.content === 'selected');
      const context = _api.buildCodexTurnAssistantContext(f.records, SID, selected.uuid, 8000);
      assert.equal(context.success, true);
      assert.equal(context.assistantText, 'answer:selected');
    });
  }
}

for (const order of ['response-first', 'event-first', 'response-only', 'event-only']) {
  test('same-text neighbors retain exact identity with ' + order + ' carriers and reversed selection', () => {
    const f = fixture();
    f.turn('same', order); f.user(ABORTED); f.turn('same', order);
    f.records.findLast(r => r.payload.role === 'assistant').payload.content[0].text = 'SECOND exact answer';
    const single = copy(f, 1);
    assert.equal(single.success, true);
    assert.match(single.content, /SECOND exact answer/);
    assert.doesNotMatch(single.content, /answer:same/);
    const reversed = copy(f, 1, 0);
    assert.equal(reversed.success, true);
    assert.match(reversed.content, /answer:same[\s\S]*SECOND exact answer/);
  });
}

test('filters never remove a structural user before rollback; following selected answer survives', () => {
  const f = fixture();
  f.turn('kept');
  f.user('discarded'); f.event('discarded');
  f.add('event_msg', { type: 'thread_rolled_back', num_turns: 1 });
  f.user(ABORTED);
  f.user(INSTRUCTIONS); f.event(INSTRUCTIONS);
  f.turn('selected');
  const full = _api.buildCodexCleanExport(f.records, SID, '/fixture', { includeUser: false });
  assert.match(full, /answer:kept/);
  assert.match(full, /answer:selected/);
  assert.doesNotMatch(full, /discarded|AGENTS.md|turn_aborted|👤 USER:/);
  const selected = copy(f, -1, -1, { includeUser: false });
  assert.equal(selected.success, true);
  assert.match(selected.content, /answer:selected/);
  assert.doesNotMatch(selected.content, /answer:kept|👤 USER:/);
});

test('compact-only and mixed ranges retain one opaque metadata line, not replacement history', () => {
  const f = fixture();
  f.turn('before'); f.user(ABORTED);
  f.add('compacted', { encrypted_content: 'opaque', replacement_history: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET old context' }] },
  ] });
  f.add('event_msg', { type: 'context_compacted' });
  f.user(INSTRUCTIONS); f.turn('after');
  const timeline = _api.buildCodexTimeline(f.records, SID);
  const compact = timeline.find(e => e.type === 'compact');
  const target = timeline.find(e => e.content === 'after');
  for (const end of [compact, target]) {
    const result = _api.buildCodexRangeExport(f.records, SID, '/fixture', {}, compact.uuid, end.uuid);
    assert.equal(result.success, true);
    assert.equal((result.content.match(/Context compacted/g) || []).length, 1);
    assert.doesNotMatch(result.content, /SECRET|AGENTS.md|turn_aborted|answer:before/);
    assert.equal(result.content.includes('answer:after'), end === target);
  }
});

test('adoption updates the stored clean carrier to the canonical event UUID', () => {
  const f = fixture(); f.turn('selected');
  const target = _api.buildCodexTimeline(f.records, SID).find(e => e.type === 'user');
  const clean = _api.buildCodexCleanEntries(f.records, SID);
  assert.equal(clean.find(e => e.kind === 'user').sourceUuid, target.uuid);
  assert.equal(clean.filter(e => e.kind === 'user').length, 1);
});

test('provider image markup in an event uses the same presentation identity as Timeline', () => {
  const f = fixture();
  f.turn('previous'); f.user(ABORTED);
  f.add('event_msg', { type: 'task_started' });
  f.user('inspect [Image #1]');
  f.event('<image name="[Image #1]" path="/fixture/image.png">[Image #1]</image>inspect [Image #1]');
  f.answer('IMAGE answer'); f.add('event_msg', { type: 'task_complete' });
  const timeline = _api.buildCodexTimeline(f.records, SID).filter(e => e.type === 'user');
  const clean = _api.buildCodexCleanEntries(f.records, SID).filter(e => e.kind === 'user');
  assert.deepEqual(clean.map(e => e.sourceUuid), timeline.map(e => e.uuid));
  const result = copy(f, -1);
  assert.equal(result.success, true);
  assert.match(result.content, /IMAGE answer/);
  assert.doesNotMatch(result.content, /answer:previous|image.png/);
});

test('Goal and subagent service carriers preserve neighboring ordinary selected answers', () => {
  const f = fixture();
  f.turn('previous'); f.user(ABORTED);
  f.turn('<codex_internal_context source="goal">Continue goal.</codex_internal_context>');
  f.user('<subagent_notification>completed</subagent_notification>');
  f.event('<subagent_notification>completed</subagent_notification>');
  f.turn('selected');
  const timeline = _api.buildCodexTimeline(f.records, SID).filter(e => e.type === 'user');
  const target = timeline.find(e => e.isGoalContinuation);
  const goal = _api.buildCodexRangeExport(f.records, SID, '/fixture', {}, target.uuid, target.uuid);
  assert.equal(goal.success, true);
  assert.match(goal.content, /Continue goal/);
  assert.doesNotMatch(goal.content, /answer:previous|answer:selected|subagent_notification/);
  const result = copy(f, -1);
  assert.equal(result.success, true);
  assert.match(result.content, /answer:selected/);
  assert.doesNotMatch(result.content, /Continue goal|subagent_notification/);
});

test('literal inline service text stays user content, not a broad substring filter', () => {
  const f = fixture();
  f.turn('Explain the literal <turn_aborted> marker and # AGENTS.md in this example.');
  const result = copy(f, 0);
  assert.equal(result.success, true);
  assert.match(result.content, /literal <turn_aborted> marker and # AGENTS.md/);
});

test('actual copy-range IPC uses the exact selected UUIDs with a controlled record loader', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'codex-data.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('codex:copy-range'");
  const end = source.indexOf("  ipcMain.handle('codex:edit-range'", start);
  assert.ok(start > 0 && end > start);
  const optionsStart = source.indexOf('function codexCopyOptions(');
  const optionsEnd = source.indexOf('\nfunction compactCopyTokenCount(', optionsStart);
  const actualCopyOptions = new Function(source.slice(optionsStart, optionsEnd) + '\nreturn codexCopyOptions;')();
  const f = fixture();
  f.turn('previous'); f.user(ABORTED); f.turn('selected');
  const handlers = new Map(), loads = [];
  new Function('ipcMain', 'loadSessionRecords', 'buildCodexTurnAssistantContext',
    'buildCodexRangeExport', 'codexCopyOptions', 'console', source.slice(start, end))(
    { handle: (name, fn) => handlers.set(name, fn) },
    async (sessionId, cwd) => { loads.push({ sessionId, cwd }); return { success: true, records: f.records, filePath: '/fixture/owned.jsonl' }; },
    _api.buildCodexTurnAssistantContext, _api.buildCodexRangeExport, actualCopyOptions, console);
  const target = _api.buildCodexTimeline(f.records, SID).find(e => e.content === 'selected');
  const params = { sessionId: SID, cwd: '/fixture', startUuid: target.uuid, endUuid: target.uuid };
  const result = await handlers.get('codex:copy-range')({}, params);
  assert.equal(result.success, true);
  assert.equal(result.filePath, '/fixture/owned.jsonl');
  assert.match(result.content, /answer:selected/);
  assert.doesNotMatch(result.content, /answer:previous/);
  const context = await handlers.get('codex:copy-range')({}, { ...params, assistantOnly: true });
  assert.equal(context.success, true);
  assert.equal(context.assistantText, 'answer:selected');
  assert.deepEqual(loads, [{ sessionId: SID, cwd: '/fixture' }, { sessionId: SID, cwd: '/fixture' }]);
});

// Exercise the production range join itself with deliberately different local
// counter spaces. Only builders/formatter are controlled in these two tests;
// all fixture tests above execute the complete actual parser and formatter.
function rangeJoin(buildClean) {
  const source = fs.readFileSync(path.join(__dirname, 'codex-data.js'), 'utf8');
  const start = source.indexOf('function buildCodexRangeExport(');
  const end = source.indexOf('\nfunction projectCodexAssistantContext(', start);
  assert.ok(start >= 0 && end > start);
  return new Function('buildCodexTimeline', 'buildCodexCleanEntries', 'codexCopyOptions',
    'getSessionMeta', 'formatCodexCleanExport', 'console', source.slice(start, end) + '\nreturn buildCodexRangeExport;')(
    () => [{ type: 'user', uuid: 'exact-A', turnIndex: 3 }, { type: 'user', uuid: 'exact-B', turnIndex: 4 }],
    buildClean, opts => ({ includeUser: true, ...opts }), () => ({}), entries => JSON.stringify(entries),
    { warn() {} });
}

test('range joins through UUID, not equality of unrelated ordinal counters', () => {
  const run = rangeJoin(() => [
    { kind: 'user', sourceUuid: 'older', turnIndex: 3, text: 'wrong older prompt' },
    { kind: 'assistant', turnIndex: 3, text: 'WRONG older answer' },
    { kind: 'user', sourceUuid: 'exact-B', turnIndex: 20, text: 'selected prompt' },
    { kind: 'assistant', turnIndex: 20, text: 'RIGHT selected answer' },
  ]);
  const result = run([], SID, '/fixture', { includeUser: false }, 'exact-B', 'exact-B');
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.content).map(e => e.text), ['RIGHT selected answer']);
});

test('missing exact clean user identity refuses instead of copying another numerically matching turn', () => {
  const run = rangeJoin(() => [
    { kind: 'user', sourceUuid: 'not-exact-B', turnIndex: 4, text: 'unrelated prompt' },
    { kind: 'assistant', turnIndex: 4, text: 'WRONG answer' },
  ]);
  const result = run([], SID, '/fixture', {}, 'exact-B', 'exact-B');
  assert.equal(result.success, false);
  assert.equal(result.error, 'Selected Codex user identity not found in copy projection');
});

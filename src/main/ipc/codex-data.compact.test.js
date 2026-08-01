const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _api } = require('./codex-data');

function compactFixture() {
  return [
    { __line: 10, type: 'compacted', timestamp: '2026-07-10T10:00:00Z', payload: { replacement_history: [] } },
    { __line: 11, type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { __line: 12, type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } },
    { __line: 13, type: 'turn_context', payload: { model: 'gpt-5' } },
    { __line: 14, type: 'event_msg', payload: { type: 'task_started' } },
    { __line: 20, type: 'event_msg', timestamp: '2026-07-10T10:00:01Z', payload: { type: 'context_compacted' } },
    { __line: 21, type: 'event_msg', timestamp: '2026-07-10T10:00:02Z', payload: { type: 'user_message', message: 'continue' } },
    { __line: 30, type: 'event_msg', timestamp: '2026-07-10T10:00:03Z', payload: { type: 'context_compacted' } },
  ];
}

test('pairs a compact telemetry companion across an arbitrary technical gap', () => {
  const records = compactFixture();
  assert.deepEqual([..._api.codexCompactCompanionLines(records)], [20]);

  const timeline = _api.buildCodexTimeline(records, 'session');
  assert.equal(timeline.filter((entry) => entry.type === 'compact').length, 2);

  const history = _api.buildCodexFullHistory(records, 'session');
  assert.equal(history.filter((entry) => entry.role === 'compact').length, 2);

  const clean = _api.buildCodexCleanEntries(records, 'session');
  assert.equal(clean.filter((entry) => entry.kind === 'compact').length, 2);
});

test('a real user turn ends pending companion pairing', () => {
  const records = [
    { __line: 1, type: 'compacted', payload: {} },
    { __line: 2, type: 'event_msg', payload: { type: 'user_message', message: 'new work' } },
    { __line: 3, type: 'event_msg', payload: { type: 'context_compacted' } },
  ];
  assert.equal(_api.codexCompactCompanionLines(records).size, 0);
  assert.equal(_api.buildCodexTimeline(records, 'session').filter((entry) => entry.type === 'compact').length, 2);
});

test('extracts the selected Codex turn after a user-only rollback, never the next answer', () => {
  const records = [
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'kept prior turn' } },
    { __line: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Prior answer that must stay prior.' }] } },
    // Codex writes the mirrored response_item user message before event_msg.
    { __line: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'discarded draft' }] } },
    { __line: 4, type: 'event_msg', payload: { type: 'user_message', message: 'discarded draft' } },
    // No assistant record exists for this turn. With includeUser:false in the
    // intermediate clean projection, rollback used to delete turn 0's assistant
    // and reset its counter to -1 while Timeline correctly retained turn 0.
    { __line: 5, type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    { __line: 6, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'garbled request' }] } },
    { __line: 7, type: 'event_msg', payload: { type: 'user_message', message: 'garbled request' } },
    { __line: 8, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect files without running code.' }] } },
    { __line: 9, type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] } },
    { __line: 10, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Static inspection completed safely.' }] } },
    { __line: 11, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next turn' }] } },
    { __line: 12, type: 'event_msg', payload: { type: 'user_message', message: 'next turn' } },
    { __line: 13, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Unrelated next answer.' }] } },
  ];
  const timeline = _api.buildCodexTimeline(records, 'session');
  assert.deepEqual(timeline.filter((entry) => entry.type === 'user').map((entry) => entry.content), [
    'kept prior turn',
    'garbled request',
    'next turn',
  ]);
  const target = timeline.find((entry) => entry.content === 'garbled request');
  assert.equal(target.turnIndex, 1);
  const targetUuid = target.uuid;
  const result = _api.buildCodexTurnAssistantContext(records, 'session', targetUuid, 8000);
  assert.equal(result.success, true);
  assert.equal(result.turnIndex, target.turnIndex);
  assert.equal(result.assistantMessageCount, 2);
  assert.match(result.assistantText, /inspect files without running code/);
  assert.match(result.assistantText, /Static inspection completed safely/);
  assert.doesNotMatch(result.assistantText, /Prior answer|private reasoning|Unrelated next answer/);
});

test('orchestration result keeps one Codex turn together across mid-turn compaction', () => {
  const records = [
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'run the matrix' } },
    { __line: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Starting the run.' }] } },
    { __line: 3, type: 'compacted', payload: { replacement_history: [] } },
    { __line: 4, type: 'event_msg', payload: { type: 'context_compacted' } },
    { __line: 5, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Still running after compact.' }] } },
    { __line: 6, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FINAL RESULT: all done.' }] } },
    { __line: 7, type: 'event_msg', payload: { type: 'task_complete' } },
    { __line: 8, type: 'event_msg', payload: { type: 'user_message', message: 'unrelated next request' } },
    { __line: 9, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'UNRELATED NEXT ANSWER' }] } },
  ];
  const sessionId = 'orchestration-compact-session';
  const target = _api.buildCodexTimeline(records, sessionId)
    .find((entry) => entry.type === 'user' && entry.content === 'run the matrix');
  const result = _api.buildCodexTurnAssistantResult(records, sessionId, target.uuid, 100000);

  assert.equal(result.success, true);
  assert.equal(result.complete, true);
  assert.equal(result.turnIndex, 0);
  assert.equal(result.assistantMessageCount, 3);
  assert.equal(result.assistantBlockCount, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.assistantChars, [
    'Starting the run.',
    'Still running after compact.',
    'FINAL RESULT: all done.',
  ].join('\n\n').length);
  assert.match(result.assistantText, /Starting the run/);
  assert.match(result.assistantText, /Still running after compact/);
  assert.match(result.assistantText, /FINAL RESULT: all done/);
  assert.doesNotMatch(result.assistantText, /UNRELATED NEXT ANSWER/);
});

test('F2: subagent notification does not split one external Codex result turn', () => {
  const records = [
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'run delegated checks' } },
    { __line: 2, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { __line: 3, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Partial result before child completion.' }] } },
    { __line: 4, type: 'event_msg', payload: { type: 'user_message', message: '<subagent_notification>{"agent_path":"/root/tester","status":{"completed":"ok"}}</subagent_notification>' } },
    { __line: 5, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final result after child completion.' }] } },
    { __line: 6, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  const sessionId = 'codex-subagent-result-session';
  const target = _api.buildCodexTimeline(records, sessionId)
    .find((entry) => entry.type === 'user' && entry.content === 'run delegated checks');
  const result = _api.buildCodexTurnAssistantResult(records, sessionId, target.uuid, 100000);

  assert.equal(result.success, true);
  assert.equal(result.complete, true);
  assert.equal(result.assistantMessageCount, 2);
  assert.match(result.assistantText, /Partial result before child completion/);
  assert.match(result.assistantText, /Final result after child completion/);
});

test('orchestration result bounds a long compacted turn while preserving its final tail', () => {
  const first = 'HEAD-SENTINEL ' + 'a'.repeat(700);
  const final = 'b'.repeat(700) + ' FINAL-TAIL-SENTINEL';
  const records = [
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'long run' } },
    { __line: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: first }] } },
    { __line: 3, type: 'compacted', payload: { replacement_history: [] } },
    { __line: 4, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: final }] } },
  ];
  const sessionId = 'orchestration-long-session';
  const target = _api.buildCodexTimeline(records, sessionId)
    .find((entry) => entry.type === 'user');
  const result = _api.buildCodexTurnAssistantResult(records, sessionId, target.uuid, 500);

  assert.equal(result.success, true);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.assistantChars, first.length + 2 + final.length);
  assert.ok(result.assistantText.length <= 500);
  assert.match(result.assistantText, /^HEAD-SENTINEL/);
  assert.match(result.assistantText, /FINAL-TAIL-SENTINEL$/);
});

test('reads JSONL incrementally across chunk and UTF-8 boundaries', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-jsonl-stream-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  const source = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'проверить большой файл' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'готово' }] } }),
  ].join('\n') + '\n';
  await fs.promises.writeFile(filePath, source, 'utf8');

  const stat = await fs.promises.stat(filePath);
  const result = await _api.readJsonlRange(filePath, 0, stat.size - 1, { highWaterMark: 7 });
  assert.equal(result.errors, 0);
  assert.equal(result.leftoverBuffer.length, 0);
  assert.deepEqual(result.records.map((record) => record.__line), [0, 1]);
  assert.equal(result.records[0].payload.message, 'проверить большой файл');
  assert.equal(result.records[1].payload.content[0].text, 'готово');
});

test('keeps incremental JSONL cache exact across partial append and rewrite', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-jsonl-cache-'));
  const filePath = path.join(dir, 'rollout.jsonl');
  t.after(async () => {
    _api.invalidateJsonlCache(filePath);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const firstLine = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'first' } }) + '\n');
  const secondLine = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'вторая' } }));
  const splitAt = secondLine.indexOf(Buffer.from('вторая')) + 1;
  await fs.promises.writeFile(filePath, Buffer.concat([firstLine, secondLine.subarray(0, splitAt)]));

  const firstRead = await _api.parseJsonlFile(filePath);
  assert.deepEqual(firstRead.map((record) => record.__line), [0]);

  const thirdLine = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'third' } }) + '\n');
  await fs.promises.appendFile(filePath, Buffer.concat([
    secondLine.subarray(splitAt),
    Buffer.from('\n'),
    thirdLine,
  ]));
  const appendedRead = await _api.parseJsonlFile(filePath);
  assert.deepEqual(appendedRead.map((record) => record.__line), [0, 1, 2]);
  assert.equal(appendedRead[1].payload.message, 'вторая');

  const unchangedRead = await _api.parseJsonlFile(filePath);
  assert.deepEqual(unchangedRead.map((record) => record.__line), [0, 1, 2]);

  await fs.promises.writeFile(filePath, firstLine);
  const rewrittenRead = await _api.parseJsonlFile(filePath);
  assert.deepEqual(rewrittenRead.map((record) => record.__line), [0]);
  assert.equal(rewrittenRead[0].payload.message, 'first');
});

test('forceFresh result read bypasses a same-size same-mtime Codex cache snapshot', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-jsonl-fresh-'));
  const filePath = path.join(dir, 'rollout.jsonl');
  const fixedTime = new Date('2026-07-27T12:00:00.000Z');
  const source = (message) => JSON.stringify({
    type: 'event_msg',
    payload: { type: 'user_message', message },
  }) + '\n';
  t.after(async () => {
    _api.invalidateJsonlCache(filePath);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  await fs.promises.writeFile(filePath, source('old'), 'utf8');
  await fs.promises.utimes(filePath, fixedTime, fixedTime);
  assert.equal((await _api.parseJsonlFile(filePath))[0].payload.message, 'old');

  await fs.promises.writeFile(filePath, source('new'), 'utf8');
  await fs.promises.utimes(filePath, fixedTime, fixedTime);
  assert.equal((await _api.parseJsonlFile(filePath))[0].payload.message, 'old');
  assert.equal((await _api.parseJsonlFile(filePath, { forceFresh: true }))[0].payload.message, 'new');
});

test('bounds fully parsed Codex rollout cache across sessions', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-jsonl-lru-'));
  const filePaths = [];
  t.after(async () => {
    for (const filePath of filePaths) _api.invalidateJsonlCache(filePath);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  for (let index = 0; index < 4; index += 1) {
    const filePath = path.join(dir, `rollout-${index}.jsonl`);
    filePaths.push(filePath);
    await fs.promises.writeFile(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: `turn-${index}` },
    }) + '\n');
    await _api.parseJsonlFile(filePath);
  }

  const stats = _api.getCodexJsonlCacheStats();
  assert.ok(stats.files <= 3, `retained ${stats.files} full rollout caches`);
  assert.equal(stats.filePaths.includes(filePaths[0]), false);
  assert.equal(stats.filePaths.includes(filePaths[3]), true);
});

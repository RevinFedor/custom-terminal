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

const test = require('node:test');
const assert = require('node:assert/strict');
const { _api } = require('./codex-data');

const record = (line, type, payload) => ({ __line: line, __byteOffset: line * 100,
  type, timestamp: `2026-10-08T09:00:${String(line).padStart(2, '0')}Z`, payload });
const user = (line, text) => record(line, 'event_msg', { type: 'user_message', message: text });
const assistant = (line, text, phase) => record(line, 'response_item', {
  type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }],
});

test('Timeline final preview addresses the same canonical assistant as History, not commentary', () => {
  const records = [user(1, 'Check the configuration.'), assistant(2, 'I will inspect it.', 'commentary'),
    assistant(3, 'The configuration matches.', 'final_answer')];
  const timeline = _api.buildCodexTimeline(records, 'preview-session');
  const history = _api.buildCodexFullHistory(records, 'preview-session');
  const final = history.find(entry => entry.textPhase === 'final_answer');
  assert.equal(timeline[0].responsePreview?.uuid, final.uuid);
  assert.equal(timeline[0].responsePreview?.sourceIdentity, final.sourceIdentity);
  assert.equal(timeline[0].responsePreview?.content, final.content);
  assert.equal(timeline[0].responsePreview?.timestamp, final.timestamp);
});

test('untyped legacy assistant requires completion proof and never turns commentary into final', () => {
  const source = [user(1, 'Check.'), assistant(2, 'Legacy answer.')];
  assert.equal(_api.buildCodexTimeline(source, 's')[0].responsePreview, undefined);
  const complete = [...source, record(3, 'event_msg', { type: 'task_complete' })];
  assert.equal(_api.buildCodexTimeline(complete, 's')[0].responsePreview?.content, 'Legacy answer.');
  const commentary = [user(1, 'Check.'), assistant(2, 'Interim text.', 'commentary'),
    record(3, 'event_msg', { type: 'task_complete' })];
  assert.equal(_api.buildCodexTimeline(commentary, 's')[0].responsePreview, undefined);
});

test('bounded preview retains full length and source locator, and does not leak to the next turn', () => {
  const text = 'Final answer with all details. '.repeat(800);
  const records = [user(1, 'First'), assistant(2, text, 'final_answer'), user(3, 'Second')];
  const rows = _api.buildCodexTimeline(records, 's');
  assert.equal(rows[0].responsePreview?.contentLength, text.length);
  assert.ok(rows[0].responsePreview?.content.length <= 2048);
  assert.equal(rows[0].responsePreview?.truncated, true);
  assert.equal(rows[1].responsePreview, undefined);
  const projector = _api.createCodexTimelineProjector('s');
  for (const entry of records) projector.feed(entry);
  assert.deepEqual(projector.finalize(), rows);
});

test('checkpoint and caller mutation do not change retained final-preview authority', () => {
  const projector = _api.createCodexTimelineProjector('s');
  projector.feed(user(1, 'First'));
  projector.feed(assistant(2, 'Legacy final'));
  const resumed = _api.createCodexTimelineProjector('s', projector.exportState());
  resumed.feed(record(3, 'event_msg', { type: 'task_complete' }));
  const caller = resumed.finalize();
  caller[0].responsePreview.content = 'Caller changed the display.';
  assert.equal(resumed.finalize()[0].responsePreview.content, 'Legacy final');
});

test('interruption, failed completion and rollback never promote a pending legacy caption', () => {
  for (const ending of [
    [record(3, 'event_msg', { type: 'task_complete', error: 'failure' })],
    [record(3, 'event_msg', { type: 'turn_aborted' }), record(4, 'event_msg', { type: 'task_complete' })],
  ]) assert.equal(_api.buildCodexTimeline([user(1, 'Check'), assistant(2, 'Caption'), ...ending], 's')[0].responsePreview, undefined);
  const records = [user(1, 'First'), assistant(2, 'First answer', 'final_answer'),
    user(3, 'Later'), assistant(4, 'Later caption'), record(5, 'event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
    record(6, 'event_msg', { type: 'task_complete' })];
  assert.equal(_api.buildCodexTimeline(records, 's')[0].responsePreview.content, 'First answer');
});

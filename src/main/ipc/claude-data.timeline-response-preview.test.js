'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { timelineResponsePreview } = require('../../shared/timeline-response-preview.cjs');
const { historyActionPresentationMeta } = require('../../shared/history-action-grammar.cjs');
const source = fs.readFileSync(require.resolve('./claude-data'), 'utf8');
const start = source.indexOf('          let responseTokens = 0;', source.indexOf('  const getTimeline = async'));
const end = source.indexOf('          if (!responseTokens)', start);
assert.ok(start > 0 && end > start);
const user = uuid => ({ type: 'user', uuid, message: { content: 'Prompt' } });
const assistant = (uuid, text, reason, extras = {}) => ({ type: 'assistant', uuid,
  timestamp: '2026-10-08T04:05:06.000Z', sessionId: 'claude-session',
  message: { id: 'shared-message', stop_reason: reason, content: [{ type: 'text', text }] }, ...extras });
function preview(records) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(source.slice(start, end) + '\nresponsePreview || null;', {
    entry: records[0], activeBranch: records, timelineResponsePreview, historyActionPresentationMeta, path: require('node:path'),
  })));
}
test('actual Claude Timeline lookahead keeps the terminal text UUID, not thinking/shared message.id', () => {
  const final = assistant('final-text', 'Exact final', 'end_turn');
  const result = preview([user('u'), assistant('progress', 'Doing work', 'tool_use'),
    assistant('thinking', '', 'end_turn', { message: { id: 'shared-message', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'Private reasoning' }] } }), final]);
  assert.equal(result.uuid, final.uuid);
  assert.equal(result.content, final.message.content[0].text);
  assert.equal(result.timestamp, final.timestamp);
});
test('tool_result and task notifications do not end the lookahead, real next user does', () => {
  const result = preview([user('u'), { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'user', message: { content: '<task-notification>done</task-notification>' } },
    assistant('first-final', 'First final', 'stop_sequence'), user('next'), assistant('next-final', 'Next', 'end_turn')]);
  assert.equal(result.uuid, 'first-final');
});
test('interim/tool text, API errors and missing completion proof are not finals', () => {
  for (const entry of [assistant('p', 'Progress', 'tool_use'), assistant('unknown', 'Unknown'),
    assistant('err', 'API failure', 'end_turn', { isApiErrorMessage: true }),
    assistant('synthetic', '', 'stop_sequence', { message: { model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'API failure' }] } }),
    assistant('tool', 'Tool caption', 'end_turn', { message: { stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Tool caption' }, { type: 'tool_use', id: 'tool', name: 'Read' }] } })]) {
    assert.equal(preview([user('u'), entry]), null);
  }
});
test('last terminal text wins, with bounded text and unknown time kept unknown', () => {
  const result = preview([user('u'), assistant('early', 'Early', 'end_turn'),
    assistant('last', 'Answer '.repeat(1000), 'end_turn', { timestamp: undefined })]);
  assert.equal(result.uuid, 'last');
  assert.ok(result.content.length <= 2048);
  assert.equal(result.contentLength, 6999);
  assert.equal(result.truncated, true);
  assert.equal(result.timestamp, undefined);
});

test('canonical History multi-block separator and trim also own the preview length', () => {
  const record = assistant('multi', '', 'end_turn', { message: { stop_reason: 'end_turn',
    content: [{ type: 'text', text: '\n One ' }, { type: 'text', text: 'Two \n' }] } });
  const result = preview([user('u'), record]);
  assert.equal(result.content, 'One \n\nTwo');
  assert.equal(result.contentLength, result.content.length);
});

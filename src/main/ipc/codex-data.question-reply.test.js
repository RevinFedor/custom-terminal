'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { _api } = require('./codex-data');
const { cloneProjectionGraph } = require('../codex-projection-checkpoint');
const { projectNativeQuestionReply } = require('../../shared/native-question-reply.cjs');
const hash = text => require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
const sid = 'native-question-fixture';
const wire = index => '<send_user_message_question_reply>\n' + JSON.stringify([{
  question: index ? 'Second question?' : 'First question?', answer: 'Other free text',
  questionItemId: JSON.stringify(['request_user_input_async', 'call-question', index]),
}]) + '\n</send_user_message_question_reply>';
const records = () => [
  { type: 'event_msg', payload: { type: 'user_message', message: 'Original task' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-question',
    arguments: JSON.stringify({ questions: [{ title: 'First question?' }, { title: 'Second question?' }] }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-question', output: '{"accepted":true}' } },
  { type: 'event_msg', payload: { type: 'task_complete' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wire(1) }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: wire(1) } },
].map((record, index) => ({ ...record, __line: index, __byteOffset: index * 1000,
  timestamp: '2026-10-08T12:00:0' + index + '.000Z' }));

for (const [name, create] of [['History', _api.createCodexHistoryProjector], ['Timeline', _api.createCodexTimelineProjector]]) {
  test(name + ' bounded native title survives carrier order and every checkpoint without raw JSON display', () => {
    const input = records(), title = 'я'.repeat(256) + '\r\nUnbounded original question';
    const content = '<send_user_message_question_reply>\n' + JSON.stringify([{
      answer: 'Human free answer', question: 'я'.repeat(256),
      questionItemId: JSON.stringify(['request_user_input_async', 'call-question', 1]),
    }]) + '\n</send_user_message_question_reply>';
    input[1].payload.arguments = JSON.stringify({ questions: [{ title: 'First question?' }, { title }] });
    input[4].payload.content[0].text = content;
    input[5].payload.message = content;
    for (const tail of [[input[4]], [input[5]], input.slice(4), [input[5], input[4]]]) {
      const rows = [...input.slice(0, 4), ...tail], fresh = create(sid);
      rows.forEach(record => fresh.feed(record));
      const expected = fresh.finalize(), replies = expected.filter(row => row.content === content);
      assert.equal(replies.length, 1);
      assert.ok(replies[0].questionReplyProof);
      assert.equal(projectNativeQuestionReply(replies[0], hash)?.kind, 'question-reply');
      for (let split = 0; split <= rows.length; split++) {
        const prefix = create(sid); rows.slice(0, split).forEach(record => prefix.feed(record)); prefix.finalize();
        const resumed = create(sid, cloneProjectionGraph(prefix.exportState()));
        rows.slice(split).forEach(record => resumed.feed(record));
        assert.deepEqual(resumed.finalize(), expected, 'native frame/checkpoint ' + split);
      }
    }
  });
  test(name + ' binds the reserved reply to raw call/index, preserves paired identity and raw transport', () => {
    const input = records(), projector = create(sid);
    input.forEach(record => projector.feed(record));
    const rows = projector.finalize(), reply = rows.find(row => row.content === wire(1));
    assert.ok(reply.questionReplyProof);
    assert.equal(reply.questionReplyProof.links[0].questionIndex, 1, 'question index is not canonical action index0');
    assert.match(projectNativeQuestionReply(reply, hash).text, /Second question\?/);
    assert.equal(reply.content, wire(1));
    assert.match(reply.uuid, /-5$/);
    assert.equal(rows.filter(row => row.content === wire(1)).length, 1);
    const other = rows.find(row => row.content === 'Original task');
    assert.equal(other.questionReplyProof, undefined, 'accepted:true is not a human answer');
  });
  test(name + ' certificate survives every checkpoint split and empty-call results', () => {
    const input = records(), fresh = create(sid); input.forEach(record => fresh.feed(record));
    const expected = fresh.finalize();
    assert.ok(expected.find(row => row.content === wire(1)).questionReplyProof);
    for (let split = 0; split <= input.length; split++) {
      const prefix = create(sid); input.slice(0, split).forEach(record => prefix.feed(record)); prefix.finalize();
      const resumed = create(sid, cloneProjectionGraph(prefix.exportState()));
      input.slice(split).forEach(record => resumed.feed(record));
      assert.deepEqual(resumed.finalize(), expected, 'split ' + split);
    }
  });
  test(name + ' event-only, response-only and reverse paired carriers share the same certificate', () => {
    const input = records();
    for (const tail of [[input[4]], [input[5]], [input[5], input[4]]]) {
      const projector = create(sid); [...input.slice(0, 4), ...tail].forEach(record => projector.feed(record));
      const replies = projector.finalize().filter(row => row.content === wire(1));
      assert.equal(replies.length, 1); assert.ok(replies[0].questionReplyProof);
    }
  });
}

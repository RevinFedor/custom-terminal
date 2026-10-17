'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createCodexLiveQuestionReplyProof } = require('./codex-live-question-reply');
const { projectNativeQuestionReply } = require('../shared/native-question-reply.cjs');
const { createCodexLiveUserCarrierPairer } = require('./codex-live-user-carrier-pairing');

const hash = text => createHash('sha256').update(text).digest('hex');
const sessionId = 'bounded-question-session';
const content = '<send_user_message_question_reply>\n' + JSON.stringify([{
  answer: 'Native free answer <saved_prompt name="literal">not a chip</saved_prompt>',
  question: 'я'.repeat(256),
  questionItemId: JSON.stringify(['request_user_input_async', 'call-bounded', 0]),
}]) + '\n</send_user_message_question_reply>';
const definition = { type: 'response_item', __byteOffset: 100,
  payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-bounded',
    arguments: JSON.stringify({ questions: [{ title: 'я'.repeat(256) + ' original suffix' }] }) } };
const message = (uuid, offset) => ({ type: 'user', uuid, sessionId,
  sourceIdentity: 'codex-user-source-' + sessionId + '-' + offset,
  message: { role: 'user', content: [{ type: 'text', text: content }] } });

test('bounded native reply is blue through actual live proof, pairing, History and Timeline without a refresh', async () => {
  const { projectHistoryServicePromptBody } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const { projectTimelineLiveUserMessage } = await import('../renderer/utils/timelineTranscriptRefresh.mjs');
  const { timelineMarkerKind } = await import('../renderer/utils/timelineMarkerPresentation.mjs');
  const { reduceHistoryLiveProjection } = await import('../renderer/utils/historyLiveProjection.mjs');
  for (const order of [['response_item', 'event_msg'], ['event_msg', 'response_item']]) {
    const proof = createCodexLiveQuestionReplyProof({ physicalSessionId: sessionId });
    proof.observe(definition, 'exact-call-source', sessionId);
    proof.observe({ type: 'response_item', payload: { type: 'function_call_output',
      call_id: 'call-bounded', output: '{"accepted":true}' } }, 'accepted-source', sessionId);
    const pairer = createCodexLiveUserCarrierPairer();
    let result;
    order.forEach((kind, index) => {
      const projection = { sessionId, message: message('live-' + index, 200 + index * 100) };
      result = pairer.accept({ kind, byteOffset: 200 + index * 100, text: content, projection });
    });
    assert.equal(result.paired, true);
    const decorated = proof.decorate(result.projections[0].message);
    assert.ok(decorated.questionReplyProof, 'accepted output must not lose the question definition');
    const detail = { tabId: 'tab-bounded', toolType: 'codex', sessionId,
      timestamp: '2026-10-17T13:30:13.889Z', message: decorated };
    const history = reduceHistoryLiveProjection([], detail, { includeUserText: true })[0];
    assert.ok(history, 'use the actual History live consumer');
    assert.equal(projectHistoryServicePromptBody(history, hash).questionReply?.kind, 'question-reply');
    const timeline = projectTimelineLiveUserMessage(detail, { toolType: 'codex', sessionId, fingerprint: hash });
    assert.equal(timelineMarkerKind(timeline, hash), 'question-reply');
    assert.equal(history.content, content);
    assert.equal(timeline.content, content);
    assert.equal(decorated.sourceIdentity, result.projections[0].message.sourceIdentity);
    assert.equal(history.questionReplyProof.transportHash, hash(content));
  }
});

test('live framing retains exact-owner, missing-call, rollback, ambiguity and definition cap guards', () => {
  const proof = createCodexLiveQuestionReplyProof({ physicalSessionId: sessionId, maxDefinitions: 1 });
  const input = message('live', 200);
  assert.equal(proof.decorate(input).questionReplyProof, undefined);
  proof.observe(definition, 'exact-call-source', 'foreign-session');
  assert.equal(proof.decorate(input).questionReplyProof, undefined);
  proof.observe(definition, 'exact-call-source', sessionId);
  const valid = proof.decorate(input);
  assert.equal(projectNativeQuestionReply({ role: 'user', content, questionReplyProof: valid.questionReplyProof }, hash)?.kind, 'question-reply');
  assert.equal(proof.decorate({ ...input, sessionId: 'foreign-session' }).questionReplyProof, undefined);
  proof.observe({ type: 'event_msg', payload: { type: 'thread_rolled_back' } }, 'rollback-source', sessionId);
  assert.equal(proof.decorate(valid).questionReplyProof, undefined, 'rollback revokes a stale certificate');
  proof.observe(definition, 'exact-call-source', sessionId);
  proof.observe({ ...definition, payload: { ...definition.payload,
    arguments: JSON.stringify({ questions: [{ title: 'я'.repeat(256) + ' different suffix' }] }) } }, 'exact-call-source', sessionId);
  assert.equal(proof.decorate(input).questionReplyProof, undefined);
  proof.observe({ ...definition, payload: { ...definition.payload, call_id: 'next-call' } }, 'next-source', sessionId);
  assert.equal(proof.decorate(valid).questionReplyProof, undefined, 'evicted definitions are not guessed');
});

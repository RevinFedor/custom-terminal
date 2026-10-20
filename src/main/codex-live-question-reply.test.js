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

test('a single Codex user carrier keeps its proven Q/A in live History, not only after a paired carrier or refresh', async () => {
  const {projectHistoryServicePromptBody} = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const {reduceHistoryLiveProjection} = await import('../renderer/utils/historyLiveProjection.mjs');
  for (const kind of ['response_item', 'event_msg']) {
    const proof = createCodexLiveQuestionReplyProof({physicalSessionId: sessionId});
    proof.observe(definition, 'exact-call-source', sessionId);
    const pairer = createCodexLiveUserCarrierPairer();
    const projected = pairer.accept({kind, byteOffset: 200, text: content,
      projection: {sessionId, message: message('single-' + kind, 200)}});
    assert.equal(projected.paired, false);
    const decorated = proof.decorate(projected.projections[0].message);
    assert.ok(decorated.questionReplyProof, 'Main already proved the native call');
    assert.equal(decorated.sourceIdentityAliases, undefined, 'there is no companion carrier yet');
    const entry = reduceHistoryLiveProjection([], {toolType: 'codex', sessionId,
      message: decorated}, {includeUserText: true})[0];
    assert.ok(entry.questionReplyProof, 'single-carrier path must not enter the Claude prompt adapter');
    assert.equal(projectHistoryServicePromptBody(entry, hash).questionReply?.kind, 'question-reply');
    assert.equal(entry.uuid, decorated.uuid);
    assert.equal(entry.sourceIdentity, decorated.sourceIdentity);
    assert.equal(entry.content, content);
  }
});

test('Codex single-carrier Q/A preserves literal answer bytes that Claude prompt normalization would remove', async () => {
  const {projectHistoryServicePromptBody} = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const {reduceHistoryLiveProjection} = await import('../renderer/utils/historyLiveProjection.mjs');
  const proof = createCodexLiveQuestionReplyProof({physicalSessionId: sessionId});
  proof.observe(definition, 'exact-call-source', sessionId);
  const literal = content.replace('Native free answer', '[200~ <system-reminder>literal user answer</system-reminder> ~]');
  const input = message('literal-carrier', 200); input.message.content[0].text = literal;
  const decorated = proof.decorate(input);
  assert.ok(decorated.questionReplyProof);
  const [entry] = reduceHistoryLiveProjection([], {toolType: 'codex', sessionId,
    message: decorated}, {includeUserText: true});
  assert.equal(entry.content, literal, 'provider transport is not Claude composer text');
  assert.equal(entry.questionReplyProof?.transportHash, hash(literal));
  assert.match(projectHistoryServicePromptBody(entry, hash).questionReply?.text || '', /literal user answer/);
});

test('single-carrier live display never invents proof, bypasses local ownership or duplicates a later proof update', async () => {
  const {projectHistoryServicePromptBody} = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const {reduceHistoryLiveProjection, shouldIncludeHistoryLiveUserText, buildHistoryLivePresentation,
    reconcileCommittedHistoryLiveProjection} = await import('../renderer/utils/historyLiveProjection.mjs');
  const input = message('single-update', 200);
  const detail = {toolType: 'codex', sessionId, message: input};
  const literal = reduceHistoryLiveProjection([], detail, {includeUserText: true});
  assert.equal(projectHistoryServicePromptBody(literal[0], hash).questionReply, undefined);
  assert.equal(literal[0].content, content);
  const proof = createCodexLiveQuestionReplyProof({physicalSessionId: sessionId});
  proof.observe(definition, 'exact-call-source', sessionId);
  const decorated = proof.decorate(input), nextDetail = {...detail, message: decorated};
  const owned = shouldIncludeHistoryLiveUserText({toolType: 'codex', envelope: nextDetail,
    localHandoffs: [{handoffId: 'owned', sourceIdentity: decorated.sourceIdentity}]});
  assert.equal(owned, false);
  assert.deepEqual(reduceHistoryLiveProjection([], nextDetail, {includeUserText: owned}), []);
  const proved = reduceHistoryLiveProjection(literal, nextDetail, {includeUserText: true});
  assert.equal(proved.length, 1);
  assert.equal(proved[0].uuid, literal[0].uuid);
  assert.equal(projectHistoryServicePromptBody(proved[0], hash).questionReply?.kind, 'question-reply');
  assert.equal(reduceHistoryLiveProjection(proved, nextDetail, {includeUserText: true}), proved,
    'identical proved replay preserves the array reference');
  const durable = [{...proved[0], uuid: 'durable-user'}];
  assert.equal(buildHistoryLivePresentation(durable, proved), durable);
  assert.deepEqual(reconcileCommittedHistoryLiveProjection(proved, durable).entries, []);
  assert.equal(projectHistoryServicePromptBody({...proved[0], content: content + '\nchanged'}, hash).questionReply,
    undefined, 'the new provider dispatch does not bypass full-body proof validation');
});

test('a lone proven reply uses the actual History blue shell and readable body before any saved refresh', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const {transformSync} = require('esbuild'), React = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const {reduceHistoryLiveProjection} = await import('../renderer/utils/historyLiveProjection.mjs');
  const {projectHistoryServicePromptBody} = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const proof = createCodexLiveQuestionReplyProof({physicalSessionId: sessionId});
  proof.observe(definition, 'exact-call-source', sessionId);
  const [entry] = reduceHistoryLiveProjection([], {toolType: 'codex', sessionId,
    message: proof.decorate(message('one-visible-reply', 200))}, {includeUserText: true});
  const serviceBody = projectHistoryServicePromptBody(entry, hash);
  const history = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
  const toneExpression = history.match(/tone=\{(serviceBody\.questionReply \? 'info' : 'default')\}/)?.[1];
  assert.ok(toneExpression, 'actual HistoryUserEntry tone expression');
  const tone = vm.runInNewContext(toneExpression, {serviceBody});
  const shellFile = path.join(__dirname, '../../packages/claude-blocks/src/components/ConversationMessage.tsx');
  const code = transformSync(fs.readFileSync(shellFile, 'utf8'), {loader: 'tsx', format: 'cjs', target: 'es2022'}).code;
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, require});
  const html = renderToStaticMarkup(React.createElement(module.exports.ConversationMessage, {
    layout: 'user', tone, entryUuid: entry.uuid, 'data-history-question-reply': serviceBody.questionReply?.provider,
  }, serviceBody.text));
  assert.match(html, /data-message-tone="info"/);
  assert.match(html, /data-history-question-reply="codex"/);
  assert.match(html, /Вопрос: .*Ответ:/s);
  assert.doesNotMatch(html, /send_user_message_question_reply|questionItemId/);
  const css = fs.readFileSync(path.join(__dirname, '../../packages/claude-blocks/src/blocks.css'), 'utf8');
  assert.match(css, /\.cb-message--info > \.cb-user-col > \.cb-user-bubble\s*\{\s*background-color: rgba\(59, 130, 246, 0\.12\)/);
});

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

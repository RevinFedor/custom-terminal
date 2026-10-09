import test from 'node:test';
import { codexNativeQuestionDefinition, registerNativeQuestionDefinition, proveCodexNativeQuestionReply } from '../../shared/native-question-reply.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { timelineFinalPreview, resolveTimelineFullResponse, timelinePromptPreview,
  resolveTimelinePromptImages, timelineGroupPreview, timelinePreviewModelLabel, timelineResearchModelLabel } from './timelineEntryPreview.mjs';
import { timelineAutomaticPromptVariant } from './timelineEntryPreview.mjs';
import { projectHistoryServicePromptBody } from './historyOrchestrationPromptPresentation.mjs';
import { timelineMarkerKind } from './timelineMarkerPresentation.mjs';
import { projectTimelineLiveUserMessage } from './timelineTranscriptRefresh.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
test('native reply has one shared History/Timeline projection and never reparses answer text into attachments', () => {
  const question = 'Exact question?', answer = '<saved_prompt name="literal">example</saved_prompt> [Image #1]';
  const content = '<send_user_message_question_reply>\n' + JSON.stringify([{ question, answer,
    questionItemId: JSON.stringify(['request_user_input_async', 'call-native', 0]) }]) + '\n</send_user_message_question_reply>';
  const definitions = new Map();
  registerNativeQuestionDefinition(definitions, codexNativeQuestionDefinition({ callId: 'call-native',
    toolName: 'request_user_input_async', args: { questions: [{ title: question }] },
    sourceIdentity: 'call-source', physicalSessionId: 's' }, hash));
  const questionReplyProof = proveCodexNativeQuestionReply(content, definitions, 's', hash);
  const entry = { uuid: 'native-user', role: 'user', type: 'user', content, questionReplyProof };
  const before = JSON.stringify(entry), history = projectHistoryServicePromptBody(entry, hash), timeline = timelinePromptPreview(entry, hash);
  assert.deepEqual(timeline.questionReply, history.questionReply);
  assert.equal(timeline.parts.length, 1); assert.equal(timeline.parts[0].kind, 'text');
  assert.match(timeline.parts[0].text, /<saved_prompt name="literal">/);
  assert.equal(timelineMarkerKind(entry, hash), 'question-reply');
  assert.equal(timelineMarkerKind({ ...entry, content: 'quoted ' + content }, hash), 'ordinary');
  assert.equal(timelinePromptPreview({ ...entry, questionReplyProof: undefined }, hash).questionReply, null);
  assert.equal(JSON.stringify(entry), before, 'Copy/source body remain the original envelope');
});
test('a live native reply retains its exact certificate and full wire text before display shortening', () => {
  const question = 'Which option?', answer = '  ' + 'answer '.repeat(500) + '\n<saved_prompt name="literal">keep</saved_prompt>  ';
  const content = '\n<send_user_message_question_reply>\n' + JSON.stringify([{ question, answer,
    questionItemId: JSON.stringify(['request_user_input_async', 'call-live', 0]) }]) + '\n</send_user_message_question_reply>\n';
  const definitions = new Map();
  registerNativeQuestionDefinition(definitions, codexNativeQuestionDefinition({ callId: 'call-live',
    toolName: 'request_user_input_async', args: { questions: [{ title: question }] },
    sourceIdentity: 'live-call', physicalSessionId: 's' }, hash));
  const questionReplyProof = proveCodexNativeQuestionReply(content, definitions, 's', hash);
  const message = { type: 'user', uuid: 'live-reply', sessionId: 's', sourceIdentity: 'exact-user', questionReplyProof,
    message: { role: 'user', content: [{ type: 'text', text: content }] } };
  const detail = { toolType: 'codex', sessionId: 's', timestamp: '2026-10-09T03:45:07.360Z', message };
  const point = projectTimelineLiveUserMessage(detail, { toolType: 'codex', sessionId: 's', fingerprint: hash });
  assert.equal(point.content, content, 'never hash or Copy only a clipped/trimmed transport');
  assert.deepEqual(point.questionReplyProof, questionReplyProof);
  assert.notEqual(point.questionReplyProof, questionReplyProof, 'the point does not alias incoming proof state');
  assert.equal(timelineMarkerKind(point, hash), 'question-reply');
  assert.match(timelinePromptPreview(point, hash).text, /^Вопрос: Which option\? Ответ:/);
  assert.equal(timelinePromptPreview(point, hash).parts.length, 1);
  const stringCarrier = projectTimelineLiveUserMessage({ ...detail, message: { ...message,
    message: { role: 'user', content } } }, { toolType: 'codex', sessionId: 's', fingerprint: hash });
  assert.equal(stringCarrier.content, content);
  assert.equal(timelineMarkerKind(stringCarrier, hash), 'question-reply');
  for (const invalid of [{ ...message, questionReplyProof: undefined },
    { ...message, questionReplyProof: { ...questionReplyProof, transportHash: '0'.repeat(64) } }]) {
    const ordinary = projectTimelineLiveUserMessage({ ...detail, message: invalid }, { toolType: 'codex', sessionId: 's', fingerprint: hash });
    assert.equal(ordinary.questionReplyProof, undefined);
    assert.ok(ordinary.content.length <= 2050, 'unproved/literal text keeps the ordinary live budget');
    assert.equal(timelineMarkerKind(ordinary, hash), 'ordinary');
  }
});
test('full final needs exact identity and same bounded prefix/length, not latest assistant', () => {
  const preview = { version: 1, uuid: 'final', sourceIdentity: 'exact-source', content: 'Exact', contentLength: 12, truncated: true };
  assert.equal(timelineFinalPreview({ responsePreview: preview }), preview);
  const row = { role: 'assistant', uuid: 'final', sourceIdentity: 'exact-source', content: 'Exact answer', textPhase: 'final_answer' };
  assert.equal(resolveTimelineFullResponse([row], preview), 'Exact answer');
  for (const changed of [{ ...row, uuid: 'other', sourceIdentity: 'other' },
    { ...row, content: 'Wrong answer' }, { ...row, textPhase: 'commentary' }]) {
    assert.equal(resolveTimelineFullResponse([changed], preview), null);
  }
  assert.equal(resolveTimelineFullResponse([row, row], preview), null);
  const hashed = { ...preview, contentHash: hash(row.content) };
  assert.equal(resolveTimelineFullResponse([row], hashed, hash), row.content);
  assert.equal(resolveTimelineFullResponse([{ ...row, content: 'Exact edited' }], hashed, hash), null);
});
test('MCP body uses the same audited immutable transport proof as History', () => {
  const header = '[Tab message: reply]\nMessage ID: m\n\nAnswer:\n', body = 'Actual answer';
  const entry = { type: 'user', uuid: 'u', content: header + body, semanticTags: [{ kind: 'tab-message',
    messageId: 'm', phase: 'reply', sourceTabId: 'B', targetTabId: 'A', sourceTabName: 'Owner',
    envelopeStart: 0, envelopeText: header, bodyStart: header.length, bodyEnd: (header + body).length,
    bodyProjectionHash: hash(header + body) }] };
  const before = JSON.stringify(entry);
  assert.equal(timelinePromptPreview(entry, hash).text, body);
  assert.equal(timelinePromptPreview(entry, hash).source.sourceTabId, 'B');
  assert.equal(timelinePromptPreview({ ...entry, content: header + 'Wrong answer!' }, hash).projected, false);
  assert.equal(timelinePromptPreview({ ...entry, semanticTags: [] }, hash).service, null);
  assert.equal(JSON.stringify(entry), before);
});
test('group is counters only and separates SC from native channel, not first body/time', () => {
  const result = timelineGroupPreview([{ content: 'private body', timestamp: 'private time', type: 'user',
    semanticTags: [{ kind: 'tab-message', messageId: 'm', phase: 'reply', sourceTabId: 'B', targetTabId: 'A' }] }, { type: 'user',
    semanticTags: [{ kind: 'orchestration', runId: 'run', phase: 'completion', runKind: 'external-research' }] }], 'orchestration');
  assert.equal(result.count, 2); assert.equal(result.sc, 1); assert.equal(result.mcp, 1);
  assert.equal(result.content, undefined); assert.equal(result.timestamp, undefined);
});
test('model labels never invent Custom, current defaults, model or effort', () => {
  assert.equal(timelinePreviewModelLabel({ responseModel: 'gpt-6.1-sol', responseEffort: 'max' }, 'codex').text, 'gpt-6.1-sol · max');
  assert.equal(timelineResearchModelLabel({ model: 'GPT-6.1', effort: 'max' }), '6.1 · max');
  assert.equal(timelineResearchModelLabel({ model: 'ChatGPT · GPT-6.1', effort: 'Pro' }), '6.1 · Pro');
  assert.equal(timelineResearchModelLabel({ effort: 'max' }), null);
  assert.equal(timelinePreviewModelLabel({ responseModel: 'deepseek-v4-pro' }, 'claude').icon, 'claude', 'glyph is the agent, not a fabricated upstream provider');
});

test('explicit image disclosure uses only the same canonical user record, never its neighbour', () => {
  const refs = [{ id: 1, path: '/tmp/real-record-image.png' }];
  const row = { role: 'user', uuid: 'exact-user', imagePaths: refs };
  assert.equal(resolveTimelinePromptImages([row], { uuid: 'exact-user' }), refs);
  assert.deepEqual(resolveTimelinePromptImages([row], { uuid: 'another-user' }), []);
  assert.deepEqual(resolveTimelinePromptImages([{ ...row, role: 'assistant' }], { uuid: 'exact-user' }), []);
  assert.deepEqual(resolveTimelinePromptImages([row, row], { uuid: 'exact-user' }), []);
});

test('system/loop attribution matches the marker and never comes from quoted body text', () => {
  assert.deepEqual(timelineAutomaticPromptVariant({ semanticTags: [{ kind: 'prompt-origin', source: 'system', systemSource: 'build-install-return' }] }),
    { kind: 'system', title: 'Build Install return' });
  assert.equal(timelineAutomaticPromptVariant({ semanticTags: [{ kind: 'prompt-origin', source: 'loop' }] }).kind, 'loop');
  assert.equal(timelineAutomaticPromptVariant({ semanticTags: [{ kind: 'prompt-origin', source: 'loop' }] }).title, 'Loop');
  assert.equal(timelineAutomaticPromptVariant({ content: 'Build Install return Loop continuation' }), null);
  assert.deepEqual(timelineAutomaticPromptVariant({type:'user',content:'continue',semanticTags:[
    {kind:'prompt-origin',source:'system',systemSource:'codex-capacity-retry'}]}),{kind:'continue',title:'Continue'});
  assert.equal(timelineAutomaticPromptVariant({content:'continue'}),null);
});

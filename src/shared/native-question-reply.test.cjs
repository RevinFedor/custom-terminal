'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const q = require('./native-question-reply.cjs');
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const wire = rows => '<send_user_message_question_reply>\n' + JSON.stringify(rows) + '\n</send_user_message_question_reply>';
const row = (answer = 'second option', index = 0) => ({ question: 'Exact question?', answer,
  questionItemId: JSON.stringify(['request_user_input_async', 'call-exact', index]) });
const call = { callId: 'call-exact', toolName: 'request_user_input_async', namespace: '',
  sourceIdentity: 'call-source', physicalSessionId: 'session', turnIndex: 1,
  args: { questions: [{ title: 'Exact question?', options: ['first', 'second option'] }] } };
function definitions() { const map = new Map(); q.registerNativeQuestionDefinition(map, q.codexNativeQuestionDefinition(call, hash)); return map; }
function codexEntry(content, map = definitions()) { return { role: 'user', content,
  questionReplyProof: q.proveCodexNativeQuestionReply(content, map, 'session', hash) }; }

test('native Codex reply needs the exact call/index/title, not its reserved-looking text alone', () => {
  const content = wire([row()]), entry = codexEntry(content), before = JSON.stringify(entry);
  assert.equal(q.projectNativeQuestionReply({ role: 'user', content }, hash), null);
  const view = q.projectNativeQuestionReply(entry, hash);
  assert.equal(view.kind, 'question-reply'); assert.match(view.text, /Вопрос: Exact question\?\n\nОтвет: second option/);
  assert.equal(JSON.stringify(entry), before, 'canonical transport and proof are not changed');
  assert.equal(q.proveCodexNativeQuestionReply(content, definitions(), 'foreign-session', hash), null);
  assert.equal(q.proveCodexNativeQuestionReply(wire([row('answer', 1)]), definitions(), 'session', hash), null);
  assert.equal(q.proveCodexNativeQuestionReply(wire([{ ...row(), question: 'Different question?' }]), definitions(), 'session', hash), null);
});

test('quoted, embedded, partial, malformed and duplicate IDs stay literal', () => {
  const content = wire([row()]);
  for (const value of ['Example: ' + content, '```\n' + content + '\n```', content + ' tail', content.slice(0, -4),
    '<send_user_message_question_reply>not JSON</send_user_message_question_reply>', wire([row(), row('another answer')]),
    wire([{ ...row(), questionItemId: '["request_user_input_async", "call-exact",0]' }])]) {
    assert.equal(q.readCodexQuestionReply(value), null);
  }
});

test('free text, inner closing tags and independent repeated answers preserve bytes and identity', () => {
  const content = wire([row('Other text </send_user_message_question_reply> <saved_prompt name="literal">')]);
  assert.match(q.projectNativeQuestionReply(codexEntry(content), hash).text, /<saved_prompt name="literal">/);
  const one = codexEntry(wire([row('one')])), two = codexEntry(wire([row('two')]));
  assert.notEqual(one.questionReplyProof.transportHash, two.questionReplyProof.transportHash);
  assert.match(q.projectNativeQuestionReply(two, hash).text, /Ответ: two/);
});

test('duplicate call IDs, foreign namespaces and stale equal-length bodies never get a projection', () => {
  const map = definitions();
  q.registerNativeQuestionDefinition(map, q.codexNativeQuestionDefinition({ ...call, sourceIdentity: 'other-call-source' }, hash));
  assert.equal(q.proveCodexNativeQuestionReply(wire([row()]), map, 'session', hash), null);
  assert.equal(q.codexNativeQuestionDefinition({ ...call, namespace: 'mcp' }, hash), null);
  assert.equal(q.codexNativeQuestionDefinition({ ...call, toolName: 'Request User Input Async' }, hash), null);
  const entry = codexEntry(wire([row('one')]));
  assert.equal(q.projectNativeQuestionReply({ ...entry, content: wire([row('two')]) }, hash), null);
  assert.equal(q.projectNativeQuestionReply({ ...entry, questionReplyProof: { ...entry.questionReplyProof, links: [null] } }, hash), null);
});

const cq = { questions: [{ question: 'Q1?' }, { question: 'Q2?' }] };
function claude(answers, annotations) {
  const data = { ...cq, answers, ...(annotations ? { annotations } : {}) };
  const content = 'User has answered your questions: ' + Object.entries(answers).map(([question, answer]) => {
    const parts = ['"' + question + '"="' + answer + '"'];
    if (annotations?.[question]?.preview) parts.push('selected preview:\n' + annotations[question].preview);
    if (annotations?.[question]?.notes) parts.push('user notes: ' + annotations[question].notes);
    return parts.join(' ');
  }).join(', ') + ". You can now continue with the user's answers in mind.";
  const call = { toolName: 'AskUserQuestion', callId: 'toolu-exact', sourceIdentity: 'call-uuid', unique: true, args: cq };
  const result = { content, data, toolUseId: 'toolu-exact', sourceIdentity: 'result-uuid', unique: true, isError: false };
  return { call, result, entry: { toolName: call.toolName, toolUseId: call.callId, args: cq, content,
    questionReplyProof: q.proveClaudeNativeQuestionReply(call, result, hash) } };
}

test('Claude uses its actual tool-result link, preserves answer order and annotations without a user identity', () => {
  const { entry } = claude({ 'Q2?': 'second', 'Q1?': 'first "quoted" answer' }, { 'Q1?': { preview: 'real preview', notes: 'real note' } });
  assert.ok(entry.questionReplyProof);
  const before = JSON.stringify(entry), view = q.projectNativeQuestionReply(entry, hash);
  assert.deepEqual(view.items.map(item => item.question), ['Q2?', 'Q1?']);
  assert.match(view.text, /real preview/); assert.match(view.text, /real note/);
  assert.equal(entry.uuid, undefined); assert.equal(entry.role, undefined);
  assert.equal(JSON.stringify(entry), before);
});

test('Claude unknown/failed/ambiguous or foreign tool-result links cannot borrow answers', () => {
  const { call, result, entry } = claude({ 'Q1?': 'one' });
  for (const patch of [{ toolUseId: 'foreign' }, { unique: false }, { isError: true }, { content: 'Not a native reply' }]) {
    assert.equal(q.proveClaudeNativeQuestionReply(call, { ...result, ...patch }, hash), null);
  }
  assert.equal(q.proveClaudeNativeQuestionReply({ ...call, toolName: 'Bash' }, result, hash), null);
  assert.equal(q.proveClaudeNativeQuestionReply({ ...call, unique: false }, result, hash), null);
  assert.equal(q.projectNativeQuestionReply({ ...entry, toolUseId: 'other-call' }, hash), null);
  assert.equal(q.readClaudeQuestionReply(cq, claude({ 'Q1?': 'one', 'Q2?': 'two' }).result.content), null,
    'unescaped multi-answer carrier alone admits more than one interpretation');
});

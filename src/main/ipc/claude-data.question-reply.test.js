'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), crypto = require('node:crypto');
const { proveClaudeNativeQuestionReply, projectNativeQuestionReply } = require('../../shared/native-question-reply.cjs');
const { claudeToolResultText, isClaudeToolResultError } = require('../claude-background-task-protocol');
const source = fs.readFileSync(require.resolve('./claude-data'), 'utf8');
const ast = ts.createSourceFile('claude-data.js', source, ts.ScriptTarget.Latest, true);
const indexNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildClaudeToolResultRecordIndex');
let finder;
const visit = node => { if (ts.isVariableDeclaration(node) && node.name?.getText(ast) === 'findToolResult') finder = node.initializer.getText(ast); ts.forEachChild(node, visit); };
visit(ast); assert.ok(indexNode && finder);
const index = vm.runInNewContext(indexNode.getText(ast) + '\nbuildClaudeToolResultRecordIndex;');
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function run({ duplicateCall = false, duplicateResult = false, foreignSource = false, batch = false, isError = false } = {}) {
  const input = { questions: [{ question: 'Q1?' }, { question: 'Q2?' }] }, answers = { 'Q1?': 'one', 'Q2?': 'two' };
  const block = { type: 'tool_use', id: 'toolu-question', name: 'AskUserQuestion', input };
  const entry = { type: 'assistant', uuid: 'call-uuid', message: { content: [block] } };
  const res = { type: 'tool_result', tool_use_id: block.id, is_error: isError,
    content: 'User has answered your questions: "Q1?"="one", "Q2?"="two". You can now continue with the user\'s answers in mind.' };
  const result = { type: 'user', uuid: 'result-uuid', sourceToolAssistantUUID: foreignSource ? 'foreign' : entry.uuid,
    toolUseResult: { ...input, answers }, message: { content: batch ? [res, { type: 'tool_result', tool_use_id: 'unrelated', content: 'other' }] : [res] } };
  const records = new Map([[entry.uuid, entry], [result.uuid, result]]);
  if (duplicateCall) records.set('duplicate-call', { ...entry, uuid: 'duplicate-call' });
  if (duplicateResult) records.set('duplicate-result', { ...result, uuid: 'duplicate-result' });
  const original = JSON.stringify([...records]);
  const rr = vm.runInNewContext('(' + finder + ')();', {
    entry, block, name: block.name, input, toolResultRecordByUseId: index(records),
    taskNotificationByToolUseId: new Map(), successfulTaskStopByTaskId: new Map(),
    claudeToolResultText, isClaudeToolResultError, claudeBackgroundToolKind: () => null,
    extractClaudeToolDiffHunks: () => null, proveClaudeNativeQuestionReply, questionReplyFingerprint: hash,
  });
  assert.equal(JSON.stringify([...records]), original, 'reader metadata never rewrites source records');
  return { rr, res, input, block };
}
test('actual Claude index/finder retains a readable linked result without a fake user entry', () => {
  const { rr, res, input, block } = run();
  assert.equal(rr.text, res.content);
  assert.ok(rr.questionReplyProof);
  const view = projectNativeQuestionReply({ toolName: block.name, toolUseId: block.id,
    args: input, content: rr.text, questionReplyProof: rr.questionReplyProof }, hash);
  assert.deepEqual(view.items.map(row => row.answer), ['one', 'two']);
});
test('actual Claude finder rejects duplicate calls/results, foreign source, batched metadata and errors', () => {
  for (const flag of ['duplicateCall', 'duplicateResult', 'foreignSource', 'batch', 'isError']) {
    assert.equal(run({ [flag]: true }).rr.questionReplyProof, undefined, flag);
  }
});

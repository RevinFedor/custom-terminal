'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {
  createCodexResumeUserActivityProof,
  matchesCodexResumeUserActivityProof,
} = require('./codex-resume-user-activity');
const { classifyCodexWriterAdoption } = require('./codex-writer-ownership');
const {
  consumeCodexUserMessageAuditChunk,
  selectCodexPreferredUserMessageAuditRecords,
} = require('./codex-prompt-audit');

const terminal = {};
const launch = {
  sessionId: 'source-a', filePath: '/rollout-a.jsonl', launchId: 'launch-a',
  terminalToken: terminal, runSeq: 3, lifecycleGeneration: 'pty-a:1',
  startByte: 300000000, endByte: 300010000,
  startedAt: Date.parse('2026-09-04T22:18:34Z'),
};
const userRecord = {
  type: 'event_msg', timestamp: '2026-09-04T22:26:39.300Z',
  payload: { type: 'user_message', message: 'New manual message, not the old 1640-char draft' },
  __byteOffset: 300000100,
};
const owner = {
  ...launch, sourceMode: 'resume', sourceMatch: 'source-in-place',
  sourceSessionId: 'source-a',
};

test('later real user input resolves writer without claiming an earlier unknown send', () => {
  const oldSend = { expectedText: 'Unconfirmed old draft', status: 'delivery-unknown' };
  const proof = createCodexResumeUserActivityProof({ ...launch, record: userRecord });
  assert.ok(proof);
  const matches = matchesCodexResumeUserActivityProof(proof, owner);
  assert.equal(matches, true);
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume', sourceMatch: 'source-in-place',
    resumeSubmitAuditPending: true, sourceUserMessageProven: matches,
  }).status, 'commit');
  assert.equal(oldSend.status, 'delivery-unknown');
  assert.equal('submitId' in proof, false);
  assert.equal('handoffId' in proof, false);
});

test('both canonical user carriers prove activity, including image-first content', () => {
  const response = {
    ...userRecord, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: '/staged/image.png' },
      { type: 'input_text', text: 'Compare this image' },
    ] },
  };
  assert.ok(createCodexResumeUserActivityProof({ ...launch, record: response }));
});

test('startup service text, tools and copied old records cannot release the writer', () => {
  for (const text of [
    '', '<environment_context>cwd</environment_context>',
    '# AGENTS.md instructions for /project\n<INSTRUCTIONS>rules</INSTRUCTIONS>',
    '<turn_aborted>interrupted</turn_aborted>',
  ]) {
    const record = { ...userRecord, payload: { type: 'user_message', message: text } };
    assert.equal(createCodexResumeUserActivityProof({ ...launch, record }), null, text);
  }
  for (const record of [
    { ...userRecord, __byteOffset: launch.startByte - 1 },
    { ...userRecord, __byteOffset: launch.endByte },
    { ...userRecord, timestamp: '2026-09-04T22:18:00Z' },
    { ...userRecord, timestamp: null },
    { ...userRecord, payload: { type: 'task_started' } },
    { ...userRecord, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
  ]) assert.equal(createCodexResumeUserActivityProof({ ...launch, record }), null);
});

test('proof cannot cross process, launch, file, source, run or truncation boundaries', () => {
  const proof = createCodexResumeUserActivityProof({ ...launch, record: userRecord });
  for (const changed of [
    { sessionId: 'child-b' }, { sourceSessionId: 'source-b' },
    { filePath: '/other.jsonl' }, { launchId: 'new-launch' },
    { terminalToken: {} }, { runSeq: 4 }, { lifecycleGeneration: 'pty-a:2' },
    { startByte: launch.startByte + 1 }, { endByte: proof.recordByteOffset },
    { sourceMode: 'fork' }, { sourceMatch: 'direct-fork' },
  ]) assert.equal(matchesCodexResumeUserActivityProof(proof, { ...owner, ...changed }), false);
  assert.equal(classifyCodexWriterAdoption({
    sourceMode: 'resume', sourceMatch: 'direct-fork',
    resumeSubmitAuditPending: true, sourceUserMessageProven: true,
  }).status, 'provisional-source', 'a source record cannot pick a competing child');
});

test('live source scanner records activity even when its old send audit rejects the text', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const from = main.indexOf('function processCodexSourceAuditOnlyText(');
  const to = main.indexOf('\nfunction armCodexManualWriterBindingConflict', from);
  assert.ok(from >= 0 && to > from);
  const auditResults = [];
  const context = vm.createContext({
    consumeCodexUserMessageAuditChunk,
    selectCodexPreferredUserMessageAuditRecords,
    createCodexResumeUserActivityProof,
    processCodexUserMessagePasteAudit: (_state, record) => {
      auditResults.push(record.payload.message === 'Unconfirmed old draft');
      return false;
    },
    console: { log() {} },
  });
  vm.runInContext(main.slice(from, to), context);
  const state = {
    tabId: 'tab-a', sessionId: launch.sessionId, filePath: launch.filePath,
    sourceObservationLaunchId: launch.launchId,
    sourceObservationTerminal: terminal, sourceObservationRunSeq: launch.runSeq,
    sourceObservationStartedAt: launch.startedAt,
    processGeneration: launch.lifecycleGeneration,
    processGenerationBoundaryOffset: launch.startByte, offset: launch.endByte,
    sourceAuditPartial: '', sourceAuditPartialStartOffset: launch.startByte,
  };
  const text = JSON.stringify({ ...userRecord, __byteOffset: undefined }) + '\n';
  // Real source appends may split one JSON record across two fs reads.
  const first = text.slice(0, 42);
  context.processCodexSourceAuditOnlyText(state, first, launch.startByte);
  assert.equal(state.sourceLiveUserActivityProof, undefined);
  context.processCodexSourceAuditOnlyText(state, text.slice(42), launch.startByte + Buffer.byteLength(first));
  assert.deepEqual(auditResults, [false]);
  assert.equal(matchesCodexResumeUserActivityProof(state.sourceLiveUserActivityProof, owner), true);
  assert.match(main, /processCodexSourceAuditOnlyText\(state, chunk, start\);\s*requestCodexSourceWriterProof\(state\)/);
  assert.match(main, /sourceUserMessageProven && !candidateSubmitAuditProven/);
  assert.match(main, /audit\.awaitUserMessage = false;\s*audit\.writerResolvedIndependently = true/);
});

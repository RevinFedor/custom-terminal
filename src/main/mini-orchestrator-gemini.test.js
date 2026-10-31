'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniOrchestratorGemini } = require('./mini-orchestrator-gemini');
const input = { instruction: { text: 'Read the attached iteration; no sending or editing.', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH' },
  inputs: [{ inputId: 'own-user', text: 'Need two numbers' }], answer: '1', owner: { provider: 'codex', sessionId: 'own', generation: 'g:1' },
  turnId: 'own-turn', jobId: 'own-job', previousFeedback: [] };
const readContent = { role: 'model', parts: [{ functionCall: { name: 'read_review_iteration', args: {} }, thoughtSignature: 'fixture-signature' }] };
const first = () => ({ success: true, content: readContent, parts: readContent.parts, usage: { input_tokens: 2, output_tokens: 3 } });
const final = () => ({ success: true, text: 'Missing the second number.', parts: [{ text: 'Missing the second number.' }],
  modelVersion: 'gemini-3.8-flash-002', usage: { input_tokens: 5, output_tokens: 7 } });
test('first request contains only an iteration reference; the one read supplies the exact pair', async () => {
  let calls = 0;
  const review = createMiniOrchestratorGemini({ callApi: async (system, prompt, model, thinking, options) => {
    calls++; assert.equal(system, input.instruction.text); assert.equal(model, input.instruction.model); assert.equal(thinking, 'HIGH');
    assert.deepEqual(options.tools[0].functionDeclarations.map(x => x.name), ['read_review_iteration']);
    const object = JSON.parse(prompt);
    assert.equal(object.kind, 'completed-response-review-reference');
    assert.equal(object.attachments[0].sessionId, 'own'); assert.equal(object.attachments[0].turnId, 'own-turn');
    assert.equal(object.completedAnswer, undefined); assert.equal(object.request, undefined);
    assert.doesNotMatch(prompt, /Need two numbers/);
    if (calls === 1) { assert.equal(options.toolConfig.functionCallingConfig.mode, 'ANY'); return first(); }
    assert.equal(options.toolConfig.functionCallingConfig.mode, 'NONE');
    assert.equal(options.contents[1], readContent, 'entire genuine model Content/signature is preserved');
    const data = options.contents[2].parts[0].functionResponse.response;
    assert.equal(data.request[0].inputId, 'own-user'); assert.equal(data.completedAnswer, '1'); return final();
  } });
  const result = await review({ ...input, onSendPrompt: () => assert.fail('read-only reviewer must never send') });
  assert.equal(calls, 2); assert.equal(result.readOnly, true);
  assert.equal(result.actualModel, 'gemini-3.8-flash-002');
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 10 });
});
test('read callback is used once, never an external session lookup', async () => {
  let calls = 0, reads = 0;
  const payload = { request: input.inputs, completedAnswer: input.answer };
  const review = createMiniOrchestratorGemini({ callApi: async (_s, _p, _m, _t, options) => {
    if (++calls === 1) return first();
    assert.equal(options.contents[2].parts[0].functionResponse.response, payload); return final();
  } });
  await review({ ...input, onReadIteration: () => { reads++; return payload; } });
  assert.equal(reads, 1);
});
test('sending, retargeting and parallel calls are rejected before any data or effect', async () => {
  for (const parts of [[{ functionCall: { name: 'send_prompt', args: { prompt: 'X' } } }],
    [{ functionCall: { name: 'read_review_iteration', args: { sessionId: 'foreign' } } }],
    [1, 2].map(() => ({ functionCall: { name: 'read_review_iteration', args: {} } }))]) {
    const review = createMiniOrchestratorGemini({ callApi: async () => ({ success: true, parts, content: { role: 'model', parts } }) });
    await assert.rejects(review({ ...input, onReadIteration: () => assert.fail('invalid call must not read'), onSendPrompt: () => assert.fail('must not send') }));
  }
});
test('no blind verdict is accepted without reading the attached iteration', async () => {
  const review = createMiniOrchestratorGemini({ callApi: async () => final() });
  await assert.rejects(review(input), /read_only_tool_required/);
});
test('cancellation after first response never reads or issues the second model call', async () => {
  const c = new AbortController(); let calls = 0;
  const review = createMiniOrchestratorGemini({ callApi: async () => { calls++; c.abort(); return first(); } });
  await assert.rejects(review({ ...input, signal: c.signal, onReadIteration: () => assert.fail('stale') }));
  assert.equal(calls, 1);
});
test('a tool intent in the final text-only phase is refused with no extra requests', async () => {
  let calls = 0;
  const review = createMiniOrchestratorGemini({ callApi: async () => { calls++; return first(); } });
  await assert.rejects(review(input), /final_text_required/); assert.equal(calls, 2);
});

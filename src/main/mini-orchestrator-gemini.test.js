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

function typedFinal(args, extraParts = []) {
  const parts = [{ functionCall: { name: 'finish_review', args }, thoughtSignature: 'final-output-signature' }, ...extraParts];
  return { success: true, text: '', parts, content: { role: 'model', parts }, usage: { input_tokens: 5, output_tokens: 7 } };
}
test('trusted automatic mode forces read then declarative finish in the same two RPCs; adapter never sends', async () => {
  for (const verdict of ['ok', 'needs_correction', 'unknown']) {
    let calls = 0, reads = 0;
    const args = { verdict, explanation: '  Exact explanation.  ', correction: verdict === 'needs_correction' ? 'Supply the missing second number.' : '' };
    const before = JSON.stringify(readContent);
    const review = createMiniOrchestratorGemini({ automaticCorrections: true, callApi: async (system, prompt, _m, _t, options) => {
      assert.equal(system, input.instruction.text, 'adapter does not append hidden system text');
      assert.equal(JSON.parse(prompt).readOnly, true);
      if (++calls === 1) {
        assert.deepEqual(options.tools[0].functionDeclarations.map(x => x.name), ['read_review_iteration']);
        assert.deepEqual(options.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['read_review_iteration'] });
        return first();
      }
      assert.equal(options.contents[1], readContent, 'full original model Content is retained by identity');
      assert.equal(options.contents[1].parts[0].thoughtSignature, 'fixture-signature');
      assert.deepEqual(options.tools[0].functionDeclarations.map(x => x.name), ['finish_review']);
      assert.deepEqual(options.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['finish_review'] });
      const schema = options.tools[0].functionDeclarations[0].parameters;
      assert.deepEqual(Object.keys(schema.properties).sort(), ['correction', 'explanation', 'verdict']);
      assert.deepEqual(schema.required, ['verdict', 'explanation', 'correction']);
      return typedFinal(args);
    } });
    const result = await review({ ...input, onReadIteration: () => { reads++; return { request: input.inputs, completedAnswer: input.answer }; },
      onSendPrompt: () => assert.fail('declarative adapter must never send, even needs_correction') });
    assert.equal(calls, 2); assert.equal(reads, 1); assert.equal(JSON.stringify(readContent), before);
    assert.equal(result.text, args.explanation); assert.equal(result.verdict, verdict);
    assert.equal(result.correctionPrompt, verdict === 'needs_correction' ? args.correction : undefined);
    assert.equal(result.readOnly, true); assert.equal(result.apiRequests, 2);
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 10 });
  }
});
test('default and nonboolean option stay text-only even if the instruction object claims automatic mode', async () => {
  for (const automaticCorrections of [undefined, false, 'true', 1]) {
    let calls = 0;
    const review = createMiniOrchestratorGemini({ automaticCorrections, callApi: async (_s, _p, _m, _t, options) => {
      if (++calls === 1) return first();
      assert.equal(options.toolConfig.functionCallingConfig.mode, 'NONE');
      assert.deepEqual(options.tools[0].functionDeclarations.map(x => x.name), ['read_review_iteration']);
      return final();
    } });
    const result = await review({ ...input, instruction: { ...input.instruction, automaticCorrections: true } });
    assert.equal(result.text, 'Missing the second number.'); assert.equal(result.verdict, undefined); assert.equal(result.correctionPrompt, undefined);
  }
});
test('automatic typed output validates exact keys, enum, bounds and correction conditions before returning any effect', async () => {
  const valid = { verdict: 'needs_correction', explanation: 'Missing a requested number.', correction: 'Supply the missing number.' };
  const invalid = [null, [], 'typed JSON is required', {},
    { ...valid, verdict: 'OK' }, { ...valid, verdict: false },
    { ...valid, explanation: '' }, { ...valid, explanation: ' \n ' }, { ...valid, explanation: 1 },
    { ...valid, explanation: 'a'.repeat(250001) },
    { ...valid, correction: '' }, { ...valid, correction: ' \n ' }, { ...valid, correction: null }, { ...valid, correction: false },
    { ...valid, correction: 'a'.repeat(16001) },
    { ...valid, verdict: 'ok', correction: 'No forwarding allowed' },
    { ...valid, verdict: 'unknown', correction: ' ' },
    { verdict: 'ok', explanation: 'OK' },
    ...['tabId', 'sessionId', 'recipient', 'filePath', 'prompt', 'extra'].map(key => ({ ...valid, [key]: 'foreign' }))];
  for (const args of invalid) {
    let calls = 0;
    const review = createMiniOrchestratorGemini({ automaticCorrections: true, callApi: async () => ++calls === 1 ? first() : typedFinal(args) });
    await assert.rejects(review({ ...input, onSendPrompt: () => assert.fail('invalid output cannot send') }), /finish_arguments_invalid/);
    assert.equal(calls, 2);
  }
  let calls = 0;
  const boundary = { verdict: 'needs_correction', explanation: 'a'.repeat(250000), correction: 'a'.repeat(16000) };
  const review = createMiniOrchestratorGemini({ automaticCorrections: true, callApi: async () => ++calls === 1 ? first() : typedFinal(boundary) });
  assert.equal((await review(input)).correctionPrompt.length, 16000);
});
test('automatic phase refuses text-only, rerouted, duplicated, and hidden contradictory finish calls', async () => {
  const valid = { verdict: 'ok', explanation: 'Complete.', correction: '' };
  const variants = [final(), first(),
    { success: true, parts: [{ functionCall: { name: 'send_prompt', args: { prompt: 'X' } } }] },
    typedFinal(valid, [{ functionCall: { name: 'finish_review', args: valid } }]),
    typedFinal(valid, [{ functionCall: null }]),
    typedFinal(valid, [{ functionCall: { name: 'send_prompt', args: { prompt: 'X' } } }]),
    { ...typedFinal(valid), content: { role: 'model', parts: [{ functionCall: { name: 'send_prompt', args: {} } }] } }];
  for (const result of variants) {
    let calls = 0;
    const review = createMiniOrchestratorGemini({ automaticCorrections: true, callApi: async () => ++calls === 1 ? first() : result });
    await assert.rejects(review({ ...input, onSendPrompt: () => assert.fail('must never send') }), /finish_(tool_required|content_invalid)/);
    assert.equal(calls, 2);
  }
});
test('automatic mode cannot skip the read or hide a different first tool inside signed Content', async () => {
  for (const result of [typedFinal({ verdict: 'ok', explanation: 'Blind verdict.', correction: '' }),
    { ...first(), parts: [{ functionCall: { name: 'read_review_iteration', args: [] } }] },
    { ...first(), content: { role: 'model', parts: [{ functionCall: { name: 'send_prompt', args: {} }, thoughtSignature: 'signed-foreign' }] } }]) {
    let calls = 0;
    const review = createMiniOrchestratorGemini({ automaticCorrections: true, callApi: async () => { calls++; return result; } });
    await assert.rejects(review({ ...input, onReadIteration: () => assert.fail('invalid first call cannot read'), onSendPrompt: () => assert.fail('cannot send') }));
    assert.equal(calls, 1);
  }
});
test('automatic cancellation before/after first RPC, during read, or after typed output never returns a correction', async () => {
  for (const stage of ['before', 'first', 'read', 'second']) {
    const controller = new AbortController(); let calls = 0, reads = 0;
    if (stage === 'before') controller.abort();
    const review = createMiniOrchestratorGemini({ automaticCorrections: true, callApi: async () => {
      if (++calls === 1) { if (stage === 'first') controller.abort(); return first(); }
      controller.abort(); return typedFinal({ verdict: 'needs_correction', explanation: 'Missing.', correction: 'Repair.' });
    } });
    await assert.rejects(review({ ...input, signal: controller.signal,
      onReadIteration: () => { reads++; if (stage === 'read') controller.abort(); return { request: input.inputs, completedAnswer: input.answer }; },
      onSendPrompt: () => assert.fail('cancelled output never sends') }), /cancelled or expired/);
    assert.equal(calls, stage === 'before' ? 0 : ['first', 'read'].includes(stage) ? 1 : 2);
    assert.equal(reads, ['before', 'first'].includes(stage) ? 0 : 1);
  }
});

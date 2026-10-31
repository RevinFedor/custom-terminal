'use strict';

// Same server-side key/config and Gemini function-calling transport as the
// Voice Record agent. This restricted role exposes ONE captured-iteration read,
// not sending, editing, other sessions, browser or command execution.
const { callGeminiApi } = require('./ipc/gemini-api');
const { getMainProcessEnvValue } = require('./child-process-env');
const READ_TOOL = Object.freeze({ functionDeclarations: [{
  name: 'read_review_iteration',
  description: 'Read the ONE immutable iteration attached by the application: exact source identity, user requests and completed answer. Read-only, no arguments, no other sessions or tools, no sending or editing.',
  parameters: { type: 'OBJECT', properties: {} },
}] });
// Historical export used only by the frozen v1 preparation. It is NOT exposed
// to the current read-only reviewer. Keep old receipts/templates historical.
const SEND_TOOL = Object.freeze({ functionDeclarations: [{
  name: 'send_prompt',
  description: 'Send at most ONE concise correction to the original reviewed tab. The application fixes the recipient and queue; no Reply or completion wait is created. Do not call for OK/UNKNOWN or a new task.',
  parameters: { type: 'OBJECT', properties: {
    prompt: { type: 'STRING', description: 'Original unmet request, concrete evidence-backed gap, required correction within original scope, and confirming result. No full answer/instruction copy.' },
  }, required: ['prompt'] },
}] });

function createMiniOrchestratorGemini({ callApi = callGeminiApi, deadlineMs = 90000 } = {}) {
  return async function review({ instruction, inputs, answer, owner, turnId, jobId, signal, onReadIteration, previousFeedback = [] }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, deadlineMs); // failure deadline, never readiness/polling
    try {
      const object = buildMiniReviewReference({ owner, turnId, jobId, inputs });
      const privateKey = getMainProcessEnvValue('NOTED_MINI_GEMINI_API_KEY') || process.env.NOTED_MINI_GEMINI_API_KEY;
      const assertLive = () => {
        if (signal?.aborted || controller.signal.aborted) throw Object.assign(new Error('Review cancelled or expired'), { code: 'mini_review_cancelled' });
      };
      const options = { tools: [READ_TOOL], maxOutputTokens: 8192, signal: controller.signal,
        ...(privateKey ? { apiKey: privateKey } : {}) };
      const prompt = JSON.stringify(object);
      assertLive();
      const first = await callApi(instruction.text, prompt, instruction.model, instruction.thinkingLevel || 'HIGH',
        { ...options, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_review_iteration'] } } });
      assertLive();
      if (!first?.success) throw Object.assign(new Error(first?.error || 'Gemini review failed'), { code: 'mini_gemini_failed' });
      const calls = (first.parts || []).filter(part => part?.functionCall).map(part => part.functionCall);
      if (calls.length !== 1 || calls[0].name !== 'read_review_iteration') throw new Error('mini_reviewer_read_only_tool_required');
      if (!calls[0].args || typeof calls[0].args !== 'object' || Object.keys(calls[0].args).length) throw new Error('mini_reviewer_tool_arguments_invalid');
      if (!first.content || first.content.role !== 'model' || !Array.isArray(first.content.parts)) throw new Error('mini_reviewer_model_content_missing');
      const iteration = onReadIteration ? await onReadIteration()
        : buildMiniReviewObject({ owner, turnId, jobId, inputs, answer, previousFeedback });
      assertLive();
      // Preserve the ENTIRE model Content, including thoughtSignature exactly
      // where Gemini returned it. Never fabricate or strip signatures.
      const contents = [{ role: 'user', parts: [{ text: prompt }] }, first.content,
        { role: 'user', parts: [{ functionResponse: { name: 'read_review_iteration', response: iteration } }] }];
      const result = await callApi(instruction.text, prompt, instruction.model, instruction.thinkingLevel || 'HIGH',
        { ...options, contents, toolConfig: { functionCallingConfig: { mode: 'NONE' } } });
      assertLive();
      if (!result?.success) throw Object.assign(new Error(result?.error || 'Gemini review failed'), { code: 'mini_gemini_failed' });
      if ((result.parts || []).some(part => part?.functionCall)) throw new Error('mini_reviewer_final_text_required');
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) throw new Error('mini_reviewer_empty_result');
      const usage = Object.fromEntries(['input_tokens', 'output_tokens'].map(key => [key,
        Number(first.usage?.[key] || 0) + Number(result.usage?.[key] || 0)]));
      return { text, usage, model: instruction.model, readOnly: true, apiRequests: 2,
        ...(result.modelVersion ? { actualModel: result.modelVersion } : {}), toolRequested: true };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}
function buildMiniReviewReference({ owner, turnId, jobId, inputs }) {
  return { kind: 'completed-response-review-reference', source: { ...owner, turnId }, reviewId: jobId,
    attachments: [{ kind: 'iteration', id: jobId, sessionId: owner.sessionId, turnId, requestCount: inputs.length }],
    readOnly: true };
}

function buildMiniReviewObject({ owner, turnId, jobId, inputs, answer, previousFeedback = [] }) {
  return { kind: 'completed-response-review', source: { ...owner, turnId },
    reviewId: jobId, request: inputs, completedAnswer: answer, previousReviewerFeedback: previousFeedback };
}
module.exports = { createMiniOrchestratorGemini, buildMiniReviewObject, buildMiniReviewReference,
  MINI_REVIEW_READ_TOOL: READ_TOOL, MINI_REVIEW_SEND_TOOL: SEND_TOOL };

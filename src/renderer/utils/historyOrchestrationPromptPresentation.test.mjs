import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHistoryOrchestrationHandoffPresentation,
  resolveHistoryOrchestrationPromptPresentation,
} from './historyOrchestrationPromptPresentation.mjs';

test('audited Terminal MCP orchestration metadata selects the purple user treatment', () => {
  for (const phase of ['request', 'completion', 'failure']) {
    assert.deepEqual(resolveHistoryOrchestrationPromptPresentation({
      role: 'user',
      content: phase === 'completion' ? '[Оркестрация] Запрос завершён.' : 'service prompt',
      semanticTags: [{ kind: 'orchestration', runId: ' run-1 ', phase }],
    }), { runId: 'run-1', phase });
  }
});

test('quoted orchestration text and malformed metadata remain ordinary user messages', () => {
  assert.equal(resolveHistoryOrchestrationPromptPresentation({
    role: 'user',
    content: '[Оркестрация] Запрос завершён.',
  }), null);
  assert.equal(resolveHistoryOrchestrationPromptPresentation({
    role: 'user',
    semanticTags: [{ kind: 'orchestration', runId: '' }],
  }), null);
  assert.equal(resolveHistoryOrchestrationPromptPresentation({
    role: 'assistant',
    semanticTags: [{ kind: 'orchestration', runId: 'run-1', phase: 'completion' }],
  }), null);
});

test('legacy audited orchestration metadata keeps provenance without inventing a phase', () => {
  assert.deepEqual(resolveHistoryOrchestrationPromptPresentation({
    role: 'user',
    semanticTags: [{ kind: 'orchestration', runId: 'legacy-run' }],
  }), { runId: 'legacy-run', phase: 'unknown' });
});

test('owned request and completion handoffs colour the optimistic row before durable audit', () => {
  assert.deepEqual(resolveHistoryOrchestrationHandoffPresentation({
    handoffId: 'orchestration:run-request',
    source: 'codex-orchestration:source-tab',
  }), { runId: 'run-request', phase: 'request' });
  assert.deepEqual(resolveHistoryOrchestrationHandoffPresentation({
    handoffId: 'orchestration-complete:run-complete',
    source: 'orchestration-completion:run-complete',
  }), { runId: 'run-complete', phase: 'unknown' });
});

test('a mismatched or merely similar handoff cannot claim orchestration colour', () => {
  assert.equal(resolveHistoryOrchestrationHandoffPresentation({
    handoffId: 'orchestration-complete:run-a',
    source: 'orchestration-completion:run-b',
  }), null);
  assert.equal(resolveHistoryOrchestrationHandoffPresentation({
    handoffId: 'ordinary',
    source: 'history-panel',
  }), null);
});

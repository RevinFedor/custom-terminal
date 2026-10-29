import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  resolveHistoryOrchestrationHandoffPresentation,
  resolveHistoryPromptHandoffSemanticTags,
  resolveHistoryOrchestrationPromptPresentation,
  projectHistoryServicePromptBody,
  resolveHistoryPromptSender,
} from './historyOrchestrationPromptPresentation.mjs';

const fingerprint = text => createHash('sha256').update(text, 'utf8').digest('hex');

test('one-way MCP user and queued cards preserve sender without reply/run identity or body projection', () => {
  const tag = { kind: 'prompt-origin', source: 'terminal-mcp', sourceTabId: 'sender',
    sourceTabName: 'Captured sender', sourceProjectId: 'source-project' };
  for (const role of ['user', 'queued']) {
    const entry = { role, content: 'No answer needed', semanticTags: [tag] };
    const presentation = resolveHistoryOrchestrationPromptPresentation(entry);
    assert.deepEqual(resolveHistoryPromptSender(presentation), { sourceTabId: 'sender',
      sourceTabName: 'Captured sender', sourceProjectId: 'source-project' });
    assert.equal(presentation.runId, undefined);
    assert.equal(presentation.messageId, undefined);
    assert.deepEqual(projectHistoryServicePromptBody(entry, fingerprint), { text: entry.content, projected: false });
  }
});

test('legacy plain MCP source is explicitly unknown, never guessed from a handoff name or body', () => {
  const presentation = resolveHistoryOrchestrationPromptPresentation({ role: 'user',
    content: 'From sender4196', handoffId: 'history4196-owned-looking',
    semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp' }] });
  assert.deepEqual(resolveHistoryPromptSender(presentation), { label: 'Terminal MCP',
    description: 'В этой записи не сохранена вкладка-отправитель' });
});

test('app-owned waiting outcomes use MCP presentation without pretending to be a target reply', () => {
  const tag = { kind: 'prompt-origin', source: 'system', systemSource: 'tab-message-outcome' };
  for (const role of ['user', 'queued']) {
    const entry = { role, content: '[Tab message: waiting outcome]\nTarget: Another tab', semanticTags: [tag] };
    const before = JSON.stringify(entry);
    const presentation = resolveHistoryOrchestrationPromptPresentation(entry);
    assert.deepEqual(presentation, { kind: 'tab-message-outcome', phase: 'prompt' });
    assert.deepEqual(resolveHistoryPromptSender(presentation), { label: 'Noted · статус вопроса',
      description: 'Служебное уведомление приложения о вашем исходящем вопросе, не сообщение другой вкладки' });
    assert.equal(presentation.messageId, undefined);
    assert.equal(presentation.runId, undefined);
    assert.deepEqual(projectHistoryServicePromptBody(entry, fingerprint), { text: entry.content, projected: false });
    assert.equal(JSON.stringify(entry), before);
  }
  assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'user', content: '[Tab message: waiting outcome]' }), null);
  assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'assistant', semanticTags: [tag] }), null);
  assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'user', semanticTags: [{ ...tag, source: 'user' }] }), null);
});

test('the exact outcome handoff is purple before audit and preserves frozen semantic tags', () => {
  const handoffId = 'tab-message-outcome:ed61ac6a-c867-433f-8f93-1d3ba6d9eb52:reply';
  const handoff = { handoffId, source: 'codex-' + handoffId };
  assert.deepEqual(resolveHistoryOrchestrationHandoffPresentation(handoff), { kind: 'tab-message-outcome', phase: 'prompt' });
  assert.deepEqual(resolveHistoryPromptHandoffSemanticTags(handoff), [
    { kind: 'prompt-origin', source: 'system', systemSource: 'tab-message-outcome' },
  ]);
  for (const patch of [{ handoffId: 'other' }, { source: 'tab-message-outcome' },
    { source: handoffId.replace('ed61ac6a', '00000000') }]) {
    assert.equal(resolveHistoryOrchestrationHandoffPresentation({ ...handoff, ...patch }), null);
  }
  const frozen = { ...handoff, semanticTags: [{ kind: 'orchestration', runId: 'old', phase: 'failure' }] };
  assert.deepEqual(resolveHistoryPromptHandoffSemanticTags(frozen), frozen.semanticTags);
});

test('plain MCP prompts select the same purple presentation without invented run identity', () => {
  const entry = { role: 'user', content: 'Continue source check', semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp' }] };
  assert.deepEqual(resolveHistoryOrchestrationPromptPresentation(entry), { kind: 'terminal-mcp', phase: 'prompt' });
  assert.deepEqual(projectHistoryServicePromptBody(entry, fingerprint), { text: entry.content, projected: false });
  assert.deepEqual(resolveHistoryOrchestrationHandoffPresentation({ handoffId: 'specific-send', source: 'codex-terminal-mcp' }),
    { kind: 'terminal-mcp', phase: 'prompt' });
  const id = 'tab-message:fd4156d7-3441-410a-bad3-534c2c8f005f';
  assert.deepEqual(resolveHistoryOrchestrationHandoffPresentation({ handoffId: id, source: 'codex-' + id }),
    { kind: 'terminal-mcp', phase: 'prompt' });
  assert.equal(resolveHistoryOrchestrationHandoffPresentation({ handoffId: 'other', source: 'codex-' + id }), null);
  assert.equal(resolveHistoryOrchestrationPromptPresentation({ ...entry, semanticTags: [], content: '[Tab message: reply] terminal-mcp' }), null);
});

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

test('addressed question/reply provenance preserves exact source and message identity without a run', () => {
  for (const phase of ['question', 'reply']) {
    const tag = { kind: 'tab-message', messageId: `message-${phase}`, replyTo: phase === 'reply' ? 'question-id' : null,
      phase, sourceTabId: 'source', sourceTabName: 'Stored name', sourceProjectId: 'source-project',
      targetTabId: 'target', targetTabName: 'Recipient', targetProjectId: 'target-project' };
    for (const role of ['user', 'queued']) {
      const result = resolveHistoryOrchestrationPromptPresentation({ role, content: 'arbitrary body mentioning a different source', semanticTags: [tag] });
      assert.deepEqual(result, tag);
      assert.equal(Object.hasOwn(result, 'runId'), false);
    }
    assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'assistant', semanticTags: [tag] }), null);
  }
});

test('quoted envelopes and malformed addressed provenance do not create a source card', () => {
  const tag = { kind: 'tab-message', messageId: 'm', phase: 'question', sourceTabId: 'a', targetTabId: 'b' };
  for (const patch of [{ messageId: '' }, { sourceTabId: '' }, { phase: 'request' }, { targetTabId: null }]) {
    assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'user', semanticTags: [{ ...tag, ...patch }] }), null);
  }
  assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'user', content: '<tab-message messageId="m" sourceTabId="a">quoted</tab-message>' }), null);
});

test('trusted offsets strip only generated envelope while preserving deferred prefix and exact Markdown', () => {
  const prefix = '<saved_prompt label="updates">context\n\nunchanged</saved_prompt>\n\n';
  const envelope = 'Question from A\nreply using tool with messageId=m\n\n';
  const body = '## Result\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\nUnicode: \u{1f600}\n';
  for (const identity of [{ kind: 'tab-message', messageId: 'm', phase: 'reply', sourceTabId: 'a', targetTabId: 'b' }, { kind: 'orchestration', runId: 'run', phase: 'completion' }]) {
    const content = prefix + envelope + body;
    const entry = { role: 'user', content, semanticTags: [{ ...identity, envelopeStart: prefix.length, bodyStart: prefix.length + envelope.length, bodyEnd: content.length, bodyProjectionHash: fingerprint(content) }] };
    assert.deepEqual(projectHistoryServicePromptBody(entry, fingerprint), { text: prefix + body, projected: true });
    assert.equal(entry.content, content, 'Copy/Rewind and context lookup retain raw transport');
    for (const offsets of [{ envelopeStart: -1 }, { envelopeStart: prefix.length + envelope.length + 1 }, { bodyStart: 0 }, { bodyEnd: content.length + 1 }, { bodyEnd: content.length - 1 }, { bodyStart: 0.5 }, { envelopeStart: undefined }, { bodyEnd: NaN }, { bodyEnd: '12' }]) {
      assert.deepEqual(projectHistoryServicePromptBody({ ...entry, semanticTags: [{ ...entry.semanticTags[0], ...offsets }] }, fingerprint), { text: content, projected: false });
    }
    assert.equal(projectHistoryServicePromptBody({ ...entry, semanticTags: [] }, fingerprint).text, content);
    assert.equal(projectHistoryServicePromptBody({ ...entry, role: 'assistant' }, fingerprint).text, content);
  }
});

test('canonical TAB/CRLF transformations cannot truncate the answer or shift the generated envelope', () => {
  const prefix = '<saved_prompt label="updates">context\tvalue</saved_prompt>\n\n';
  const envelope = 'APP HEADER\nreply using message ID\n\n';
  const body = 'first\tvalue\r\nsecond\r\nthird\r\nEXACT ANSWER TAIL';
  const prepared = prefix + envelope + body;
  for (const identity of [{ kind: 'tab-message', messageId: 'm', phase: 'reply', sourceTabId: 'a', targetTabId: 'b' }, { kind: 'orchestration', runId: 'run', phase: 'completion' }]) {
    const tag = { ...identity, envelopeStart: prefix.length, envelopeText: envelope, bodyStart: prefix.length + envelope.length, bodyEnd: prepared.length, bodyProjectionHash: fingerprint(prepared) };
    const entry = { role: 'user', content: prepared, semanticTags: [tag] };
    assert.deepEqual(projectHistoryServicePromptBody(entry, fingerprint), { text: prefix + body, projected: true });
    const sameLengthShift = prefix.replace('\t', '    ') + envelope + body.replaceAll('\r\n', '\n');
    assert.equal(sameLengthShift.length, prepared.length);
    for (const content of [
      prefix + envelope + body.replace('\t', '    '),
      prefix + envelope + body.replaceAll('\r\n', '\n'),
      prefix.replace('\t', '    ') + envelope + body,
      sameLengthShift,
      prefix + envelope.replace('HEADER', 'header') + body,
    ]) {
      const canonical = { ...entry, content };
      assert.deepEqual(projectHistoryServicePromptBody(canonical, fingerprint), { text: content, projected: false });
      assert.equal(canonical.content, content);
      assert.equal(canonical.semanticTags[0], tag);
      assert.ok(content.endsWith('EXACT ANSWER TAIL'));
    }
    for (const envelopeText of ['', null, 123, envelope + '\n']) {
      assert.deepEqual(projectHistoryServicePromptBody({ ...entry, semanticTags: [{ ...tag, envelopeText }] }, fingerprint), { text: prepared, projected: false });
    }
  }
});

test('full UTF-8 hash rejects equal-length body, prefix and complete prompt edits despite reused UUID/tags', () => {
  const prefix = 'context\n';
  const envelope = 'HEADER\n\n';
  const body = 'value=42\nUnicode: \u00e9';
  const content = prefix + envelope + body;
  for (const identity of [{ kind: 'tab-message', messageId: 'm', phase: 'reply', sourceTabId: 'a', targetTabId: 'b' }, { kind: 'orchestration', runId: 'run', phase: 'completion' }]) {
    const tag = { ...identity, envelopeStart: prefix.length, envelopeText: envelope, bodyStart: prefix.length + envelope.length, bodyEnd: content.length, bodyProjectionHash: fingerprint(content) };
    const entry = { uuid: 'reused-uuid', role: 'user', content, semanticTags: [tag] };
    assert.deepEqual(projectHistoryServicePromptBody(entry, fingerprint), { text: prefix + body, projected: true });
    for (const changed of [content.replace('42', '99'), content.replace('context', 'changed'), content.replace('\u00e9', 'e'), 'x'.repeat(content.length)]) {
      assert.equal(changed.length, content.length);
      assert.deepEqual(projectHistoryServicePromptBody({ ...entry, content: changed }, fingerprint), { text: changed, projected: false });
    }
    assert.equal(entry.content, content);
    assert.equal(entry.semanticTags[0], tag);
  }
});

test('missing, invalid or unverifiable full-text hashes keep the original without hashing ordinary prompts', () => {
  const content = 'HEADER\nanswer';
  const tag = { kind: 'tab-message', messageId: 'm', phase: 'reply', sourceTabId: 'a', targetTabId: 'b', envelopeStart: 0, bodyStart: 7, bodyEnd: content.length, bodyProjectionHash: fingerprint(content) };
  const entry = { role: 'user', content, semanticTags: [tag] };
  for (const bodyProjectionHash of [undefined, null, '', 'not-sha256', '0'.repeat(64)]) {
    assert.deepEqual(projectHistoryServicePromptBody({ ...entry, semanticTags: [{ ...tag, bodyProjectionHash }] }, fingerprint), { text: content, projected: false });
  }
  for (const callback of [undefined, () => { throw new Error('unavailable'); }, () => Promise.resolve(tag.bodyProjectionHash)]) {
    assert.deepEqual(projectHistoryServicePromptBody(entry, callback), { text: content, projected: false });
  }
  let calls = 0;
  projectHistoryServicePromptBody({ role: 'user', content }, () => { calls++; return fingerprint(content); });
  assert.equal(calls, 0);
});

test('completion sender is executor, tab reply sender is explicit source, external provider has no fake navigation', () => {
  const fields = { sourceTabId: 'requester', sourceTabName: 'Requester', sourceProjectId: 'pa', targetTabId: 'executor', targetTabName: 'Executor', targetProjectId: 'pb' };
  assert.deepEqual(resolveHistoryPromptSender({ kind: 'tab-message', phase: 'reply', ...fields }), { sourceTabId: 'requester', sourceTabName: 'Requester', sourceProjectId: 'pa' });
  assert.deepEqual(resolveHistoryPromptSender({ phase: 'completion', ...fields }), { sourceTabId: 'executor', sourceTabName: 'Executor', sourceProjectId: 'pb' });
  assert.deepEqual(resolveHistoryPromptSender({ phase: 'completion', ...fields, targetTabId: null, runKind: 'external-research', targetTabName: 'ChatGPT' }), { label: 'ChatGPT' });
  assert.equal(resolveHistoryPromptSender({ phase: 'completion', sourceTabId: 'requester' }), null);
  assert.deepEqual(resolveHistoryPromptSender({ phase:'completion',runKind:'external-research',runId:'exact-run',targetTabName:'ChatGPT' }),
    {label:'ChatGPT',researchRunId:'exact-run'});
});

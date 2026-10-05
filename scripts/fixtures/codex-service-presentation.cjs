'use strict';

const { createHash } = require('node:crypto');
const { _api: api } = require('../../src/main/ipc/codex-data');
const { saveAuditedPromptPresentation, decorateHistoryPromptPresentations } = require('../../src/main/history-prompt-presentations');

function makeServiceFixture(store, { sessionId = 'service-session', responseFirst = true,
  sameTimestamp = false, phase = 'completion', kind = 'orchestration',
  body: suppliedBody, runKind = 'external-research' } = {}) {
  const envelope = '[Answer from Astra]\n[orchestration-result {"runId":"service-run"}]\n\n';
  const body = suppliedBody ?? '## Verified answer\n\n| Check | Result |\n| --- | --- |\n| Exact | 42 |\n\n```js\nconst value = 42;\n```\n';
  const content = envelope + body;
  const firstTimestamp = '2026-10-05T07:01:15.763Z';
  const nextTimestamp = sameTimestamp ? firstTimestamp : '2026-10-05T07:01:15.764Z';
  const response = { __line: responseFirst ? 10 : 11, __byteOffset: responseFirst ? 1000 : 2000,
    timestamp: responseFirst ? firstTimestamp : nextTimestamp, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] } };
  const event = { __line: responseFirst ? 11 : 10, __byteOffset: responseFirst ? 2000 : 1000,
    timestamp: responseFirst ? nextTimestamp : firstTimestamp, type: 'event_msg',
    payload: { type: 'user_message', message: content } };
  const records = responseFirst ? [response, event] : [event, response];
  const first = records[0];
  const snapshot = { semanticTags: [{ kind, phase,
    ...(kind === 'orchestration' ? { runId: 'service-run', runKind, targetTabName: 'ChatGPT - Astra' }
      : { messageId: 'service-message', sourceTabId: 'b', targetTabId: 'a' }),
    envelopeStart: 0, envelopeText: envelope, bodyStart: envelope.length, bodyEnd: content.length,
    bodyProjectionHash: createHash('sha256').update(content).digest('hex') }] };
  saveAuditedPromptPresentation(store, { toolType: 'codex', sessionId,
    entryUuid: `codex-user-${sessionId}-${first.__line}`, auditTimestamp: first.timestamp,
    actualText: content, snapshot });
  const decorate = entries => decorateHistoryPromptPresentations(store, { toolType: 'codex', sessionId, entries });
  return { api, sessionId, content, body, envelope, response, event, records, snapshot, decorate,
    entries: decorate(api.buildCodexFullHistory(records, sessionId)) };
}

function memoryPresentationStore() {
  const rows = [];
  return { rows,
    saveHistoryPromptPresentation(row) { rows.push(structuredClone(row)); return true; },
    getHistoryPromptPresentations(toolType, sessionId) { return rows.filter(row => row.toolType === toolType && row.sessionId === sessionId); },
    getHistoryPromptPresentationsForEntries(toolType, ids) { return rows.filter(row => row.toolType === toolType && ids.includes(row.entryUuid)); },
  };
}

module.exports = { makeServiceFixture, memoryPresentationStore };

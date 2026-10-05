'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { makeServiceFixture, memoryPresentationStore } = require('../../scripts/fixtures/codex-service-presentation.cjs');
const { cloneProjectionGraph } = require('./codex-projection-checkpoint');

for (const responseFirst of [true, false]) for (const sameTimestamp of [false, true]) {
  test(`actual parser joins audited service presentation: responseFirst=${responseFirst}, sameTimestamp=${sameTimestamp}`, async () => {
    const f = makeServiceFixture(memoryPresentationStore(), { responseFirst, sameTimestamp });
    const original = JSON.stringify(f.records);
    const { resolveHistoryOrchestrationPromptPresentation, projectHistoryServicePromptBody } =
      await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
    const check = entries => {
      assert.equal(entries.length, 1, 'paired carriers remain one user message');
      assert.equal(entries[0].uuid, `codex-user-${f.sessionId}-${f.event.__line}`);
      assert.equal(entries[0].content, f.content, 'canonical text is never rewritten');
      assert.equal(resolveHistoryOrchestrationPromptPresentation(entries[0])?.runId, 'service-run');
      assert.deepEqual(projectHistoryServicePromptBody(entries[0], text => createHash('sha256').update(text).digest('hex')),
        { text: f.body, projected: true });
    };
    check(f.entries);
    for (const split of [0, 1, 2]) {
      const projector = f.api.createCodexHistoryProjector(f.sessionId);
      f.records.slice(0, split).forEach(record => projector.feed(record));
      projector.finalize();
      const restored = f.api.createCodexHistoryProjector(f.sessionId, cloneProjectionGraph(projector.exportState()));
      f.records.slice(split).forEach(record => restored.feed(record));
      check(f.decorate(restored.finalize()));
    }
    assert.equal(JSON.stringify(f.records), original);
  });
}

for (const [kind, phase] of [['orchestration', 'request'], ['orchestration', 'failure'], ['tab-message', 'question'], ['tab-message', 'reply']]) {
  test('the same alias preserves ' + kind + '/' + phase + ' without a provider-specific style', () => {
    const f = makeServiceFixture(memoryPresentationStore(), { kind, phase });
    assert.equal(f.entries[0].semanticTags?.[0].kind, kind);
    assert.equal(f.entries[0].semanticTags[0].phase, phase);
  });
}

test('same text is not provenance: a later real user and a different session stay ordinary', () => {
  const store = memoryPresentationStore();
  const f = makeServiceFixture(store);
  const next = { ...f.event, __line: 20, __byteOffset: 5000, timestamp: '2026-10-05T07:02:15.763Z' };
  const entries = f.decorate(f.api.buildCodexFullHistory([...f.records, next], f.sessionId));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].semanticTags[0].runId, 'service-run');
  assert.equal(entries[1].semanticTags, undefined);
  const { decorateHistoryPromptPresentations } = require('./history-prompt-presentations');
  const foreign = decorateHistoryPromptPresentations(store, { toolType: 'codex', sessionId: 'other',
    entries: f.api.buildCodexFullHistory(f.records, 'other') });
  assert.equal(foreign[0].semanticTags, undefined);
});

test('equal-length edits remain unprojected even with preserved provenance', async () => {
  const f = makeServiceFixture(memoryPresentationStore());
  const { projectHistoryServicePromptBody } = await import('../renderer/utils/historyOrchestrationPromptPresentation.mjs');
  const entry = { ...f.entries[0], content: f.content.replace('Verified', 'Modified') };
  assert.deepEqual(projectHistoryServicePromptBody(entry, text => createHash('sha256').update(text).digest('hex')),
    { text: entry.content, projected: false });
});

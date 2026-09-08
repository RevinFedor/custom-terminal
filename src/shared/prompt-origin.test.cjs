const test = require('node:test');
const assert = require('node:assert/strict');
const cjs = require('./prompt-origin.cjs');

test('service provenance uses owned send sources, never quoted message text', async () => {
  const esm = await import('./prompt-origin.mjs');
  for (const api of [cjs, esm]) {
    for (const source of ['build-install-return', 'codex-build-install-return',
      'claude-build-install-return', 'codex-capacity-retry', 'codex-codex-capacity-retry']) {
      const tag = api.promptOriginTagForSource(source);
      assert.equal(tag.source, 'system');
      assert.equal(api.isSystemPromptEntry({ semanticTags: [tag] }), true);
      assert.equal(api.isServicePromptEntry({ semanticTags: [tag] }), true);
      assert.equal(tag.runId, undefined);
    }
    for (const source of ['history-panel', 'codex-history-panel', '', 'build-install-return:quoted']) {
      assert.equal(api.promptOriginTagForSource(source), null);
    }
    assert.equal(api.isServicePromptEntry({
      type: 'user', content: 'build-install-return codex-capacity-retry [Оркестрация] runId: x',
    }), false);
    assert.equal(api.isServicePromptEntry({ semanticTags: [{ kind: 'prompt-origin', source: 'loop' }] }), false);
    assert.equal(api.isServicePromptEntry({ semanticTags: [{ kind: 'orchestration', runId: 'real' }] }), true);
  }
});

test('CommonJS and browser prompt-origin projections remain identical and preserve attachments', async () => {
  const esm = await import('./prompt-origin.mjs');
  const snapshot = { promptChips: [{ kind: 'prompt', text: 'rules' }], imagePaths: [{ id: 1, path: '/tmp/a.png' }] };
  for (const source of [null, '', 'history-panel', 'prompt-loop', 'build-install-return', 'codex-build-install-return', 'codex-capacity-retry']) {
    assert.deepEqual(cjs.promptOriginTagForSource(source), esm.promptOriginTagForSource(source));
    const projected = cjs.withPromptOriginPresentation(snapshot, source);
    assert.deepEqual(projected, esm.withPromptOriginPresentation(snapshot, source));
    assert.equal(projected.promptChips, snapshot.promptChips);
    assert.equal(cjs.withPromptOriginPresentation(projected, source), projected);
  }
});

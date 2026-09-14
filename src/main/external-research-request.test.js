const test = require('node:test');
const assert = require('node:assert/strict');
const {
  externalResearchJobId,
  normalizeExternalResearchRequest,
  externalResearchRequestFingerprint,
  continuationRequest,
} = require('./external-research-request');

test('normalizes an explicit persistent ChatGPT request without reading attachments', () => {
  const request = normalizeExternalResearchRequest({
    provider: 'chatgpt', prompt: 'review',
    options: { mode: 'chat', temporaryChat: false, autoClose: false },
    files: [{ path: '/tmp/source.md', lines: '1-4' }],
  });
  assert.deepEqual(request, {
    provider: 'chatgpt', prompt: 'review',
    options: { autoClose: false, mode: 'chat', temporaryChat: false },
    files: [{ path: '/tmp/source.md', lines: '1-4' }],
    conversationUrl: '',
  });
  assert.equal(externalResearchJobId('run-1'), 'noted_run-1');
  assert.throws(() => externalResearchJobId('bad run id'), /2-194 characters/);
});

test('follow-up keeps conversation and provider but has a separate request identity', () => {
  const previous = {
    runKind: 'external-research', status: 'completed', resultComplete: true,
    externalResearchConversationUrl: 'https://chatgpt.com/c/conversation-1',
    externalResearchIntent: {
      provider: 'chatgpt',
      options: { mode: 'chat', model: '6-astra', effort: 'pro', temporaryChat: false, autoClose: false },
    },
  };
  const request = continuationRequest(previous, {
    prompt: 'review the new version',
    files: [{ path: '/tmp/v2.md' }],
    options: { effort: 'medium' },
  });
  assert.equal(request.conversationUrl, 'https://chatgpt.com/c/conversation-1');
  assert.equal(request.options.model, '6-astra');
  assert.equal(request.options.effort, 'medium');
  assert.equal(request.options.temporaryChat, false);
  const first = externalResearchRequestFingerprint({ runId: 'one', sourceTabId: 'S', request });
  const second = externalResearchRequestFingerprint({ runId: 'two', sourceTabId: 'S', request });
  assert.notEqual(first, second);
});

test('continuation refuses an incomplete run or a missing conversation identity', () => {
  assert.throws(() => continuationRequest({ runKind: 'external-research', status: 'running' }, { prompt: 'x' }), /not complete/);
  assert.throws(() => continuationRequest({ runKind: 'external-research', status: 'completed', resultComplete: true }, { prompt: 'x' }), /no conversationUrl/);
});

test('file-bearing requests fail locally for providers whose SC contract cannot upload them', () => {
  assert.throws(() => normalizeExternalResearchRequest({
    provider: 'claude', prompt: 'review', files: [{ path: '/tmp/a.md' }],
  }), /only for provider=chatgpt/);
});

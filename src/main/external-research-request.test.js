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

test('completed Chat Pro can continue at GPT-6 Extra High in the same conversation without mutating the old intent', () => {
  const previous = {
    runId: 'completed-pro', runKind: 'external-research', status: 'completed', resultComplete: true,
    externalResearchConversationUrl: 'https://chatgpt.com/c/owned-pro-then-xhigh',
    externalResearchIntent: { provider: 'chatgpt', options: {
      mode: 'chat', model: '6-astra', effort: 'pro', temporaryChat: false, autoClose: true,
    } },
  };
  const original = structuredClone(previous);
  const request = continuationRequest(previous, {
    prompt: 'Continue the preserving review in this conversation at Extra High',
    options: { mode: 'chat', model: '6', effort: 'xhigh' },
  });
  assert.equal(request.conversationUrl, previous.externalResearchConversationUrl);
  assert.deepEqual(request.options, { autoClose: true, effort: 'xhigh', mode: 'chat', model: '6', temporaryChat: false });
  assert.deepEqual(previous, original);
  assert.notEqual(externalResearchRequestFingerprint({ runId: 'next', sourceTabId: 'S', request }),
    externalResearchRequestFingerprint({ runId: 'next', sourceTabId: 'S', request: {
      ...request, options: previous.externalResearchIntent.options,
    } }));
});

test('completed Chat Extra High can explicitly return to Pro without replacing the conversation', () => {
  const previous = {
    runKind: 'external-research', status: 'completed', resultComplete: true,
    externalResearchConversationUrl: 'https://chatgpt.com/c/owned-xhigh-then-pro',
    externalResearchIntent: { provider: 'chatgpt', options: { mode: 'chat', model: '6', effort: 'xhigh' } },
  };
  const request = continuationRequest(previous, { prompt: 'Review at Pro',
    options: { mode: 'chat', model: '6-astra', effort: 'pro' } });
  assert.equal(request.conversationUrl, previous.externalResearchConversationUrl);
  assert.equal(request.options.model, '6-astra');
  assert.equal(request.options.effort, 'pro');
  assert.equal(previous.externalResearchIntent.options.effort, 'xhigh');
});
test('new Chat/Work change fails before browser/packing; an existing raw intent remains readable/idempotent', () => {
  const previous = { runKind: 'external-research', status: 'completed', resultComplete: true,
    externalResearchConversationUrl: 'https://chatgpt.com/c/old-work',
    externalResearchIntent: { provider: 'chatgpt', options: { mode: 'work', model: '6-astra', effort: 'xhigh' } } };
  const body = { prompt: 'same addressed follow-up', options: { mode: 'chat', model: '6-astra', effort: 'pro' } };
  assert.throws(() => continuationRequest(previous, body), { code: 'external_research_continuation_mode_conflict' });
  assert.equal(continuationRequest(previous, body, { validateMode: false }).options.mode, 'chat');
  assert.equal(continuationRequest(previous, { prompt: 'normal', options: { effort: 'high' } }).options.mode, 'work');
});

test('file-bearing requests fail locally for providers whose SC contract cannot upload them', () => {
  assert.throws(() => normalizeExternalResearchRequest({
    provider: 'claude', prompt: 'review', files: [{ path: '/tmp/a.md' }],
  }), /only for provider=chatgpt/);
});

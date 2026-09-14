const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ScExternalResearchClient,
  normalizeExternalResearchFiles,
  isScResearchNotFound,
} = require('./sc-external-research-client');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('client sends deterministic requestId and file descriptors without reading files', async () => {
  const calls = [];
  const client = new ScExternalResearchClient({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      return response(200, { id: 'noted_run-1', status: 'queued' });
    },
  });
  await client.start({
    jobId: 'noted_run-1', provider: 'chatgpt', prompt: 'review',
    options: { mode: 'chat', temporaryChat: false },
    files: [{ path: '/tmp/a.md', lines: '2-5' }],
    conversationUrl: 'https://chatgpt.com/c/example',
  });
  assert.deepEqual(calls[0].body, {
    requestId: 'noted_run-1', provider: 'chatgpt', prompt: 'review',
    options: { mode: 'chat', temporaryChat: false },
    files: [{ path: '/tmp/a.md', lines: '2-5' }],
    conversationUrl: 'https://chatgpt.com/c/example',
  });
})

test('status uses a bounded long-poll and exposes typed 404', async () => {
  let requestedUrl = '';
  const client = new ScExternalResearchClient({
    fetchImpl: async (url) => { requestedUrl = url; return response(404, { error: 'job not found' }); },
  });
  await assert.rejects(
    client.status('missing', { waitMs: 999_999 }),
    (error) => isScResearchNotFound(error) && error.message === 'job not found',
  );
  assert.match(requestedUrl, /wait=60000$/);
})

test('files must be absolute but line ranges stay as descriptors', () => {
  assert.deepEqual(normalizeExternalResearchFiles(['/tmp/a.md']), [{ path: '/tmp/a.md' }]);
  assert.throws(() => normalizeExternalResearchFiles(['relative.md']), /must be absolute/);
  assert.throws(() => normalizeExternalResearchFiles([{ path: '/tmp/a.md', lines: '8-2' }]), /inclusive positive range/);
  assert.throws(() => normalizeExternalResearchFiles([{ path: '/tmp/a.md', lines: '1-2', startLine: 1 }]), /not both/);
});

test('a silent SC endpoint has a physical deadline', async () => {
  const client = new ScExternalResearchClient({
    capabilityTimeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(
    client.capabilities(),
    (error) => error.code === 'sc_research_request_timeout',
  );
});

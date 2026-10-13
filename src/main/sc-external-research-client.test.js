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

test('openJob uses only exact local navigation and accepts only the rendered matching job ACK', async () => {
  const calls = [];
  const client = new ScExternalResearchClient({ fetchImpl: async (url, init = {}) => {
    calls.push({url,body:init.body?JSON.parse(init.body):null});
    return response(200,url.endsWith('/research-capabilities') ? {navigation:{version:1,renderedAck:true}}
      : {ok:true,opened:true,jobId:'noted_job',requestId:'nav'});
  } });
  assert.equal((await client.openJob('noted_job',{requestId:'nav'})).opened,true);
  assert.equal(calls.length,2);assert.match(calls[1].url,/\/research-open$/);
  assert.deepEqual(calls[1].body,{jobId:'noted_job',requestId:'nav'});
  assert.ok(calls.every(call => !/research-start|open-url|research-stop/.test(call.url)));
});
test('old SC capabilities or an acceptance/foreign-job response cannot silently open a browser or claim success', async () => {
  for (const result of [{ok:true,accepted:true},{ok:true,opened:true,jobId:'other',requestId:'nav'}]) {
    const client=new ScExternalResearchClient({fetchImpl:async url=>response(200,url.endsWith('/research-capabilities')
      ? {navigation:{version:1,renderedAck:true}}:result)});
    await assert.rejects(client.openJob('job',{requestId:'nav'}),e=>e.code==='sc_research_navigation_not_confirmed');
  }
  let calls=0;
  const client=new ScExternalResearchClient({fetchImpl:async () => {calls++;return response(200,{version:1});}});
  await assert.rejects(client.openJob('job',{requestId:'nav'}),e=>e.code==='sc_research_navigation_unavailable');
  assert.equal(calls,1);
});

test('browser navigation is exact-job only and rejects legacy, queued or foreign ACKs', async () => {
  const capability = { browserNavigation: { version: 1, exactJob: true, confirmedTab: true } };
  for (const result of [{ ok: true, queued: true }, { ok: true, opened: true, jobId: 'other', requestId: 'nav', tabId: 7 },
    { ok: true, opened: true, jobId: 'job', requestId: 'other', tabId: 7 },
    { ok: true, opened: true, jobId: 'job', requestId: 'nav', tabId: -1 }]) {
    const client = new ScExternalResearchClient({ fetchImpl: async url => response(200,
      url.endsWith('/research-capabilities') ? capability : result) });
    await assert.rejects(client.openBrowser('job', { requestId: 'nav' }), e => e.code === 'sc_research_browser_navigation_not_confirmed');
  }
  const calls = [];
  const client = new ScExternalResearchClient({ fetchImpl: async (url, init) => {
    calls.push([url, init.body ? JSON.parse(init.body) : null]);
    return response(200, url.endsWith('/research-capabilities') ? capability
      : { ok: true, opened: true, jobId: 'job', requestId: 'nav', tabId: 7 });
  } });
  await client.openBrowser('job', { requestId: 'nav' });
  assert.deepEqual(calls[1][1], { jobId: 'job', requestId: 'nav' });
  assert.match(calls[1][0], /\/research-open-browser$/);
  let oldCalls = 0;
  const old = new ScExternalResearchClient({ fetchImpl: async () => { oldCalls++; return response(200, {}); } });
  await assert.rejects(old.openBrowser('job', { requestId: 'nav' }), e => e.code === 'sc_research_browser_navigation_unavailable');
  assert.equal(oldCalls, 1);
});

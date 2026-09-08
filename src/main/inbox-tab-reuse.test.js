'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareReusedInboxTab } = require('./inbox-tab-reuse');

function fixture(status, resumeResult = { success: true }) {
  const calls = [];
  return { calls, args: {
    tabId: 'inbox-tab', provider: 'codex',
    readStatus: async (id) => { calls.push(['status', id]); return status; },
    clearTimers: (id) => calls.push(['clear-cleanup', id]),
    resume: async (id) => { calls.push(['resume', id]); return resumeResult; },
  } };
}

test('a retained but auto-stopped Inbox tab resumes even without a live writer SID', async () => {
  const { args, calls } = fixture({ toolType: 'codex', status: 'inactive', sessionId: null });
  const result = await prepareReusedInboxTab(args);
  assert.equal(result.resumed, true);
  assert.deepEqual(calls.map(([name]) => name), ['status', 'clear-cleanup', 'resume']);
  assert.ok(calls.every(([, id]) => id === 'inbox-tab'));
});

test('live, busy and starting reuse cancels old cleanup without restarting the process', async () => {
  for (const state of ['active', 'busy', 'starting']) {
    const { args, calls } = fixture({ toolType: 'codex', status: state });
    assert.equal((await prepareReusedInboxTab(args)).resumed, false);
    assert.deepEqual(calls.map(([name]) => name), ['status', 'clear-cleanup']);
  }
});

test('unknown readiness is not silently converted into a stopped process', async () => {
  const { args, calls } = fixture({ toolType: 'codex', status: 'unknown' });
  assert.equal((await prepareReusedInboxTab(args)).resumed, false);
  assert.ok(!calls.some(([name]) => name === 'resume'));
});

test('provider mismatch and failed resume are not swallowed into readiness timeouts', async () => {
  const mismatch = fixture({ toolType: 'claude', status: 'inactive' });
  await assert.rejects(prepareReusedInboxTab(mismatch.args), { code: 'external_tab_provider_changed' });
  assert.deepEqual(mismatch.calls.map(([name]) => name), ['status']);
  const failure = fixture({ toolType: 'codex', status: 'inactive' }, { success: false, error: 'launch refused' });
  await assert.rejects(prepareReusedInboxTab(failure.args), /launch refused/);
});

test('every Inbox reuse branch converges on preparation before the first readiness wait', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const route = source.slice(source.indexOf("if (parsed.pathname === '/api/inbox/runs' && req.method === 'POST')"),
    source.indexOf("if (parsed.pathname === '/api/inbox/sessions/resume'"));
  const prepareAt = route.indexOf('await prepareReusedInboxTab(');
  assert.ok(prepareAt > route.indexOf('reservedDescriptor'));
  assert.ok(prepareAt > route.indexOf('const prevRun ='));
  assert.ok(prepareAt < route.indexOf('await waitForAgentReady('));
  assert.match(route.slice(prepareAt, route.indexOf('await waitForAgentReady(')), /resumeClaudeTab/);
});

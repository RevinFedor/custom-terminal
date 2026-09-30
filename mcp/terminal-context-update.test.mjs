import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function callTool(');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start);

function harness() {
  const calls = [];
  let sourceTabId = 'source-tab';
  const context = vm.createContext({
    PARENT_TAB_ID: () => sourceTabId,
    projectHint: () => ({ projectId: 'project' }),
    httpApiGet: async (_target, endpoint) => {
      calls.push({ method: 'GET', endpoint });
      return { ok: true };
    },
    httpApiPost: async (_target, endpoint, body) => {
      calls.push({ method: 'POST', endpoint, body });
      return { ok: true, updateId: 'created-update' };
    },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.call = callTool;', context);
  return { calls, call: context.call, setSource: (value) => { sourceTabId = value; } };
}

test('self update is rejected before HTTP, including an omitted target and another request owner', async () => {
  const h = harness();
  for (const tabId of [undefined, 'source-tab']) {
    await assert.rejects(h.call('publish_context_update', { tabId, text: 'Own checkpoint' }), /another tab/i);
  }
  h.setSource('other-source');
  await assert.rejects(h.call('publish_context_update', { tabId: 'other-source', text: 'Own checkpoint' }), /another tab/i);
  assert.equal(h.calls.length, 0);
});

test('peer updates retain caller identity and self reads/responsibility remain available', async () => {
  const h = harness();
  const result = JSON.parse(await h.call('publish_context_update', {
    tabId: 'peer-tab', title: 'Changed contract', text: 'The peer needs this fact', requestId: 'same-fact',
  }));
  assert.equal(result.updateId, 'created-update');
  assert.equal(h.calls[0].endpoint, '/api/terminal-tabs/peer-tab/work-context/updates');
  assert.equal(h.calls[0].body.sourceTabId, 'source-tab');
  assert.equal(h.calls[0].body.requestId, 'same-fact');
  await h.call('get_tab_context', {});
  await h.call('set_tab_responsibility', { description: 'User-agreed scope' });
  assert.equal(h.calls[1].endpoint, '/api/terminal-tabs/source-tab/work-context');
  assert.equal(h.calls[2].endpoint, '/api/terminal-tabs/source-tab/work-context/responsibility');
});

test('an external caller without a tab can still publish to an explicit target', async () => {
  const h = harness();
  h.setSource('');
  await h.call('publish_context_update', { tabId: 'target-tab', text: 'External fact' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.sourceTabId, undefined);
});

import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const begin = source.indexOf("case 'await_dependencies': {");
const end = source.indexOf("case 'complete_task':", begin);
assert.ok(begin > 0 && end > begin);
function fixture(version, external = false) {
  const posts = [], context = vm.createContext({
    EXTERNAL_MODE: external, PARENT_TAB_ID: () => 'P', PARENT_PROJECT_ID: () => 'project', PROJECT_CWD_: () => '/fixture',
    projectHint: value => value, buildSourceMeta: () => ({ tabId: 'P' }),
    httpApiGet: async () => ({ capabilities: { loopDependencies: { version } } }),
    httpApiPost: async (_target, route, body) => { posts.push({ route, body }); return { ok: true }; },
  });
  vm.runInContext('globalThis.call = async args => { switch ("await_dependencies") { '
    + source.slice(begin, end) + ' } };', context);
  return { posts, call: () => context.call({ dependencies: [{ kind: 'run', id: 'R' }], reason: 'Need R', reviewToken: 'this-review' }) };
}
test('old app and external caller are refused before any wait mutation', async () => {
  for (const h of [fixture(0), fixture(1, true)]) { await assert.rejects(h.call()); assert.equal(h.posts.length, 0); }
});
test('actual MCP caller keeps exact owner and dependency, one request and no completed status', async () => {
  const h = fixture(1); await h.call(); assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].route, '/api/terminal-tabs/P/await-dependencies');
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].body)), { sourceMeta: { tabId: 'P' },
    dependencies: [{ kind: 'run', id: 'R' }], reason: 'Need R', reviewToken: 'this-review' });
});

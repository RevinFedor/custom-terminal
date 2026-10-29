'use strict';
// Native test actor -> actual MCP dispatcher -> its exact private App HTTP.
// This is a bounded client/routing adapter, not another hub or stdio server.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { promisify } = require('node:util'), { execFile } = require('node:child_process');
const root = fs.realpathSync(path.dirname(__filename));
assert(root.includes('/noted4412-batch-') && root.endsWith('/workspace'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'client.json'), 'utf8'));
const ids = JSON.parse(process.argv[2]), text = process.argv[3];
assert(Array.isArray(ids) && ids.length && typeof text === 'string' && text.length < 4096);
if (process.env.NOTED_PARENT_TAB_ID) assert.equal(process.env.NOTED_PARENT_TAB_ID, cfg.tabId);
const token = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
const source = fs.readFileSync(cfg.mcpSource, 'utf8');
assert.equal(crypto.createHash('sha256').update(source).digest('hex'), cfg.mcpSHA);
const start = source.lastIndexOf('// stdio transport'); assert(start > source.indexOf('async function callTool('));
const executable = source.slice(0, start).replace(/^import .*;\n/gm, '');
const calls = [], origin = 'http://127.0.0.1:' + cfg.port;
const context = vm.createContext({ AsyncLocalStorage, Buffer, URL, URLSearchParams,
  AbortSignal, AbortController, setTimeout, clearTimeout,
  basename: path.basename, join: path.join, resolve: path.resolve, promisify, execFile,
  homedir: () => cfg.home, readdirSync: () => [], randomUUID: crypto.randomUUID,
  process: { env: {}, argv: ['node', cfg.mcpSource], cwd: () => root, stderr: { write() {} } },
  scopedInstance: target => {
    assert.equal(target.projectId, cfg.projectId); assert.equal(target.cwd, root);
    if (target.pid) assert.equal(target.pid, cfg.mainPid);
    return { port: cfg.port, pid: cfg.mainPid };
  },
  scopedToken: () => token,
  fetch: async (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.origin, origin);
    assert(['/api/me', '/api/tab-messages/replies'].includes(parsed.pathname));
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.sourceTabId, cfg.tabId); assert.equal(body.sourceMeta.tabId, cfg.tabId);
      assert.deepEqual(body.messageIds, ids); assert.equal(body.text, text);
    }
    calls.push({ method: options?.method || 'GET', pathname: parsed.pathname });
    return fetch(url, options);
  },
});
vm.runInContext(executable + '\npickWebInstance=scopedInstance;readSharedToken=scopedToken;globalThis.dispatch=handleRequest;', context);
const requestId = 'native-batch-' + crypto.createHash('sha256').update(JSON.stringify([ids, text])).digest('hex').slice(0, 32);
(async () => {
  const packet = JSON.parse(await context.dispatch({ id: 1, method: 'tools/call', params: {
    name: 'reply_to_message', arguments: { messageIds: ids, text, requestId },
    _meta: { noted: { tabId: cfg.tabId, projectId: cfg.projectId, cwd: root, mainPid: String(cfg.mainPid) } },
  } }));
  const result = packet.result; assert.notEqual(result?.isError, true, JSON.stringify(result));
  const data = result.structuredContent; assert(Array.isArray(data?.results));
  const evidence = { requestId, ids, text, calls, result: data, nativeParent: {
    tabId: process.env.NOTED_PARENT_TAB_ID || null, projectId: process.env.NOTED_PARENT_PROJECT_ID || null },
    caller: 'native Codex exec tool in own actor B', routing: 'actual dispatcher with private App instance/token lookup adapters; shared hub untouched' };
  const output = path.join(root, 'reply-' + requestId + '.json'), staged = output + '.tmp-' + process.pid;
  fs.writeFileSync(staged, JSON.stringify(evidence, null, 2) + '\n'); fs.renameSync(staged, output);
  console.log(JSON.stringify({ requestId, results: data.results, deliveries: data.messages?.length }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

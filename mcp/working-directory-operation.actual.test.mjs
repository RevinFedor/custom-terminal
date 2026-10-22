import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';
import { callWorkingDirectoryOperation } from './working-directory-operation.mjs';
const source = readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const executable = source.slice(0, source.lastIndexOf('// stdio transport')).replace(/^import .*;\n/gm, '');
const support = { version: 1, providers: ['codex'], receipts: true, expectedSessionId: true,
  physicalCwdProof: true, globalPolicyUnchanged: true };
const input = { tabId: 'tab/opaque', operationId: 'move:one', expectedSessionId: 'source', targetCwd: '/b' };

function fixture({ cap = support, response } = {}) {
  const calls = [], targets = [];
  const context = vm.createContext({ AsyncLocalStorage, Buffer, URL, URLSearchParams,
    basename, join, resolve, promisify, execFile, randomUUID, callWorkingDirectoryOperation,
    homedir: () => '/fixture-home', readdirSync: () => [],
    process: { env: {}, argv: ['node', 'terminal-server.mjs'], cwd: () => '/fixture', stderr: { write() {} } },
    testPick: target => { targets.push(JSON.parse(JSON.stringify(target))); return { port: 12345 }; },
    fetch: async (url, options = {}) => {
      const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
      const call = { route, method: options.method || 'GET', body }; calls.push(call);
      const value = route === '/api/me' ? { capabilities: { workingDirectory: cap } }
        : response ? response(call) : { ok: true, operation: { tabId: input.tabId, operationId: input.operationId,
          expectedSessionId: 'source', targetCwd: '/b', resume: true, pending: true, success: false } };
      return { ok: true, status: 200, text: async () => JSON.stringify(value) };
    },
  });
  vm.runInContext(executable + '\npickWebInstance=testPick;readSharedToken=()=>"fixture";this.dispatch=handleRequest;', context);
  let id = 0;
  return { calls, targets,
    list: async () => JSON.parse(await context.dispatch({ id: ++id, method: 'tools/list' })).result.tools,
    call: async (name, args) => JSON.parse(await context.dispatch({ id: ++id, method: 'tools/call', params: {
      name, arguments: args, _meta: { noted: { tabId: 'caller', projectId: 'P', cwd: '/source' } },
    } })).result };
}

test('real MCP catalog exposes strict directory request and structured receipt reader', async () => {
  const tools = new Map((await fixture().list()).map(tool => [tool.name, tool]));
  assert.deepEqual(tools.get('change_working_directory').inputSchema.required,
    ['tabId', 'operationId', 'expectedSessionId', 'targetCwd']);
  for (const name of ['change_working_directory', 'get_working_directory_operation']) {
    assert.equal(tools.get(name).inputSchema.additionalProperties, false);
    assert.equal(tools.get(name).inputSchema.properties.prompt, undefined);
  }
});

test('real MCP dispatch uses capability GET then ONE exact POST, with routing cwd separate', async () => {
  const f = fixture(), result = await f.call('change_working_directory', input);
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.operation.operationId, input.operationId);
  assert.deepEqual(f.calls, [
    { route: '/api/me', method: 'GET', body: null },
    { route: '/api/terminal-tabs/tab%2Fopaque/working-directory-operations', method: 'POST',
      body: { operationId: 'move:one', expectedSessionId: 'source', targetCwd: '/b', resume: true } },
  ]);
  assert.ok(f.targets.every(target => target.cwd === '/source'));
});

test('real MCP GET preserves failed partial outcome without any mutation', async () => {
  const f = fixture({ response: () => ({ ok: true, operation: { tabId: input.tabId, operationId: input.operationId,
    success: false, cwdChanged: true, launchWritten: false, pending: false, partial: true } }) });
  const result = await f.call('get_working_directory_operation', { tabId: input.tabId, operationId: input.operationId });
  assert.equal(result.structuredContent.operation.cwdChanged, true);
  assert.equal(result.structuredContent.operation.success, false);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('old app and forged response are typed errors, not fallback cd or Resume', async () => {
  const old = fixture({ cap: {} }); const missing = await old.call('change_working_directory', input);
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.code, 'app_update_required');
  assert.equal(missing.structuredContent.mutationAttempted, false); assert.equal(old.calls.length, 1);
  const wrong = fixture({ response: () => ({ ok: true, operation: { tabId: 'other', operationId: 'other' } }) });
  const refused = await wrong.call('change_working_directory', input);
  assert.equal(refused.isError, true); assert.equal(wrong.calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(refused.structuredContent.receiptRead, { tabId: input.tabId, operationId: input.operationId });
});

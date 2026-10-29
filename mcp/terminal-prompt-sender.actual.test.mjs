import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const executable = source.slice(0, source.lastIndexOf('// stdio transport')).replace(/^import .*;\n/gm, '');
const owner = { tabId: 'sender', projectId: 'source-project', cwd: '/source', mainPid: '123' };

function harness({ loseReply = false, external = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    AsyncLocalStorage, Buffer, URL, URLSearchParams, basename, join, resolve, promisify, execFile, randomUUID,
    homedir: () => '/fixture-home', readdirSync: () => [],
    process: { env: external ? { NOTED_EXTERNAL_MODE: '1' } : {}, argv: ['node', 'terminal-server.mjs'],
      cwd: () => '/fixture', stderr: { write() {} } },
    testPickInstance: () => ({ port: 43210 }),
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({ method: options.method || 'GET', path: parsed.pathname + parsed.search,
        headers: { ...options.headers }, body: options.body ? JSON.parse(options.body) : null });
      if (loseReply && options.method === 'POST') throw Error('lost ACK');
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'sent', handoffId: 'fixed' }) };
    },
  });
  vm.runInContext(executable + '\npickWebInstance = testPickInstance; readSharedToken = () => "fixture"; globalThis.dispatch = handleRequest;', context);
  let id = 0;
  return { calls, async call(name, args, identity = owner) {
    return JSON.parse(await context.dispatch({ id: ++id, method: 'tools/call',
      params: { name, arguments: args, _meta: { noted: identity } } })).result;
  } };
}

test('one-way send carries hub sender outside immutable prompt/request body', async () => {
  const h = harness();
  const result = await h.call('send_prompt', { tabId: 'recipient', prompt: 'No reply needed',
    handoffId: 'fixed', submit: true, queue: true, sourceMeta: { tabId: 'forged' } });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.path, '/api/terminal-tabs/recipient/send');
  assert.deepEqual(call.body, { prompt: 'No reply needed', source: 'terminal-mcp', queue: true, handoffId: 'fixed' });
  assert.deepEqual(JSON.parse(Buffer.from(call.headers['x-noted-terminal-source'], 'base64url').toString('utf8')),
    { server: 'terminal', mode: 'internal', projectId: owner.projectId, tabId: owner.tabId, cwd: owner.cwd });
});

test('each multiplexed request uses its own sender rather than the previous tab', async () => {
  const h = harness();
  await h.call('send_prompt', { tabId: 'T', prompt: 'one', handoffId: 'a' });
  await h.call('send_prompt', { tabId: 'T', prompt: 'two', handoffId: 'b' }, { ...owner, tabId: 'another' });
  assert.deepEqual(h.calls.map(call => JSON.parse(Buffer.from(call.headers['x-noted-terminal-source'], 'base64url')).tabId),
    ['sender', 'another']);
});

test('read-only receipt recovery sends no sender claim or second POST after lost ACK', async () => {
  const h = harness({ loseReply: true });
  assert.equal((await h.call('send_prompt', { tabId: 'T', prompt: 'one', handoffId: 'fixed' })).isError, true);
  await h.call('get_send_receipt', { tabId: 'T', handoffId: 'fixed' });
  assert.deepEqual(h.calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(h.calls[1].headers['x-noted-terminal-source'], undefined);
});

test('oversized optional provenance cannot break an otherwise valid Send with an oversized HTTP header', async () => {
  const h = harness();
  const result = await h.call('send_prompt', { tabId: 'T', prompt: 'same notice', handoffId: 'fixed' },
    { ...owner, cwd: 'x'.repeat(16000) });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers['x-noted-terminal-source'], undefined);
  assert.equal(h.calls[0].body.prompt, 'same notice');
});

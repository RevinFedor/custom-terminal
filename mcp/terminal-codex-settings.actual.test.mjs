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
const owner = { tabId: 'source', projectId: 'project', cwd: '/fixture', mainPid: '123' };
const support = { version: 1, standalone: true, busy: true, fast: 'absolute' };

function harness({ capability = support, respond = null } = {}) {
  const calls = [], targets = [];
  const context = vm.createContext({
    AsyncLocalStorage, Buffer, URL, URLSearchParams, basename, join, resolve, promisify, execFile, randomUUID,
    homedir: () => '/fixture-home', readdirSync: () => [],
    process: { env: {}, argv: ['node', 'terminal-server.mjs'], cwd: () => '/fixture', stderr: { write() {} } },
    testPickInstance: target => { targets.push(JSON.parse(JSON.stringify(target))); return { port: 43210 }; },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const call = { method: options.method || 'GET', path: parsed.pathname + parsed.search,
        body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      const body = call.path === '/api/me' ? { capabilities: { codexSettings: capability } }
        : respond ? await respond(call)
          : call.method === 'GET' ? { tabId: 'T', provider: 'codex', coherent: true,
            model: 'gpt-live', effort: 'medium', fastCurrent: false, fastKnown: true,
            requestedModel: 'gpt-next', requestedEffort: 'high', settingsPending: true }
            : { success: true, queued: true, applied: false, intentRevision: 7, desiredFast: call.body.enabled };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  vm.runInContext(executable + '\npickWebInstance = testPickInstance; readSharedToken = () => "fixture-token"; globalThis.dispatch = handleRequest;', context);
  let id = 0;
  return { calls, targets,
    async list() { return JSON.parse(await context.dispatch({ id: ++id, method: 'tools/list' })).result.tools; },
    async call(name, args) { return JSON.parse(await context.dispatch({ id: ++id, method: 'tools/call',
      params: { name, arguments: args, _meta: { noted: owner } } })).result; },
  };
}
const data = result => result.structuredContent || JSON.parse(result.content[0].text);

test('catalog exposes standalone read/model-effort/absolute Fast controls without prompt fields', async () => {
  const tools = new Map((await harness().list()).map(tool => [tool.name, tool]));
  for (const [name, keys] of [
    ['get_codex_settings', ['tabId', 'cwd']],
    ['set_codex_model_effort', ['tabId', 'modelSelection', 'effort', 'cwd']],
    ['set_codex_fast', ['tabId', 'enabled', 'cwd']],
  ]) {
    const tool = tools.get(name);
    assert.ok(tool, name);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), keys);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.description, /without.*prompt|no.*prompt/i);
  }
  assert.equal(tools.get('set_codex_fast').inputSchema.properties.enabled.type, 'boolean');
});

test('busy model/effort selection uses only standalone params, preserving queued rather than applied', async () => {
  const h = harness();
  const result = await h.call('set_codex_model_effort', { tabId: 'T',
    modelSelection: { kind: 'catalog', id: 'gpt-next' }, effort: 'high' });
  assert.equal(result.isError, undefined);
  assert.equal(data(result).queued, true);
  assert.equal(data(result).applied, false);
  assert.deepEqual(h.calls, [
    { method: 'GET', path: '/api/me', body: null },
    { method: 'POST', path: '/api/terminal-tabs/T/codex/settings',
      body: { modelSelection: { kind: 'catalog', id: 'gpt-next' }, effort: 'high' } },
  ]);
  assert.ok(h.targets.every(target => target.projectId === 'project' && target.cwd === '/fixture'));
});

test('effort-only selection preserves omission of model and does not create a send', async () => {
  const h = harness();
  const result = await h.call('set_codex_model_effort', { tabId: 'T', effort: 'max' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(h.calls[1].body, { effort: 'max' });
  assert.equal(h.calls.length, 2);
});

test('Fast false is an absolute boolean, never an omitted field or a toggle', async () => {
  const h = harness();
  const result = await h.call('set_codex_fast', { tabId: 'tab/?', enabled: false });
  assert.equal(result.isError, undefined);
  assert.equal(data(result).desiredFast, false);
  assert.deepEqual(h.calls[1], { method: 'POST', path: '/api/terminal-tabs/tab%2F%3F/codex/fast', body: { enabled: false } });
});

test('read returns observed and pending settings separately with no mutation', async () => {
  const h = harness();
  const result = await h.call('get_codex_settings', { tabId: 'T' });
  assert.equal(result.isError, undefined);
  assert.equal(data(result).model, 'gpt-live');
  assert.equal(data(result).requestedModel, 'gpt-next');
  assert.equal(data(result).settingsPending, true);
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'GET']);
});

test('old application is update-required before any mutation or prompt fallback', async () => {
  for (const [name, args] of [['set_codex_fast', { tabId: 'T', enabled: true }],
    ['set_codex_model_effort', { tabId: 'T', effort: 'high' }]]) {
    const h = harness({ capability: null });
    const result = await h.call(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /update|required|support/i);
    assert.equal(h.calls.length, 1);
  }
});

test('malformed or forged settings fail before network', async () => {
  const requests = [
    ['set_codex_fast', { tabId: 'T', enabled: 'false' }],
    ['set_codex_fast', { tabId: 'T' }],
    ['set_codex_fast', { tabId: 'T', enabled: true, prompt: 'forged' }],
    ['set_codex_model_effort', { tabId: 'T' }],
    ['set_codex_model_effort', { tabId: 'T', model: 'guessed' }],
    ['set_codex_model_effort', { tabId: 'T', effort: '' }],
    ['set_codex_model_effort', { tabId: 'T', modelSelection: { kind: 'catalog', id: 'x', extra: true } }],
    ['get_codex_settings', { tabId: '' }],
  ];
  for (const [name, args] of requests) {
    const h = harness();
    assert.equal((await h.call(name, args)).isError, true, name + JSON.stringify(args));
    assert.equal(h.calls.length, 0);
  }
});

test('lost mutation ACK never causes automatic retry; recovery read performs GET only', async () => {
  const h = harness({ respond: call => {
    if (call.method === 'POST') throw new Error('connection lost after intent acceptance');
    return { provider: 'codex', coherent: true, fast: true, fastPending: true };
  } });
  const result = await h.call('set_codex_fast', { tabId: 'T', enabled: true });
  assert.equal(result.isError, true);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  const current = await h.call('get_codex_settings', { tabId: 'T' });
  assert.equal(current.isError, undefined);
  assert.equal(data(current).fastPending, true);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

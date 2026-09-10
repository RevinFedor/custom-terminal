import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../src/main/web-server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function httpPromptLibraryMutation(');
const end = source.indexOf('\n}\n', start) + 2;
const declaration = source.slice(start, end);
const catalogStart = source.indexOf('async function readPromptCatalog(');
const catalogEnd = source.indexOf('\n}\n', catalogStart) + 2;
const catalogDeclaration = source.slice(catalogStart, catalogEnd);

function harness(response) {
  const calls = [];
  const context = vm.createContext({
    pickWebInstance: () => ({ port: 49995 }),
    apiAuthHeaders: () => ({ Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response;
    },
  });
  vm.runInContext(declaration + '\nglobalThis.call = httpPromptLibraryMutation;', context);
  return { calls, call: (method, endpoint, body) => context.call({}, method, endpoint, body) };
}

test('prompt mutation transport sends one authenticated request and turns old-app 404 into an app-update requirement', async () => {
  const old = harness({ ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) });
  await assert.rejects(old.call('PATCH', '/api/prompts/prompt-a', { revision: 'r1' }), /does not support.*mutation/i);
  assert.equal(old.calls.length, 1);
  assert.equal(old.calls[0].options.method, 'PATCH');
  assert.equal(old.calls[0].options.headers.Authorization, 'Bearer fixture');
  assert.equal(old.calls[0].options.body, JSON.stringify({ revision: 'r1' }));

  const fresh = harness({ ok: true, status: 200, text: async () => JSON.stringify({ prompt: { id: 'prompt-a' } }) });
  assert.equal(JSON.stringify(await fresh.call('DELETE', '/api/prompts/prompt-a', { revision: 'r2' })), JSON.stringify({ prompt: { id: 'prompt-a' } }));
  assert.equal(fresh.calls[0].options.method, 'DELETE');
});

test('typed 404 from a new prompt API remains a not-found error instead of an app-update request', async () => {
  const typed = harness({ ok: false, status: 404, text: async () => JSON.stringify({
    error: 'saved prompt not found: gone', code: 'saved_prompt_not_found',
  }) });
  await assert.rejects(
    typed.call('DELETE', '/api/prompts/gone', { revision: 'r1' }),
    (error) => error.code === 'saved_prompt_not_found' && !/install a build/i.test(error.message),
  );
  assert.equal(typed.calls.length, 1);
});

test('new MCP reads use the compact catalog and only old applications fall back to legacy library fetch', async () => {
  const calls = [];
  const context = vm.createContext({
    httpApiGet: async (_target, endpoint) => {
      calls.push(endpoint);
      return { groups: [], prompts: [] };
    },
  });
  vm.runInContext(catalogDeclaration + '\nglobalThis.read = readPromptCatalog;', context);
  const fresh = await context.read({});
  assert.equal(fresh.legacy, false);
  assert.deepEqual(calls, ['/api/prompt-library']);

  const legacyCalls = [];
  const legacyContext = vm.createContext({
    httpApiGet: async (_target, endpoint) => {
      legacyCalls.push(endpoint);
      if (endpoint === '/api/prompt-library') throw new Error('HTTP 404: not found');
      return { groups: [], prompts: [] };
    },
  });
  vm.runInContext(catalogDeclaration + '\nglobalThis.read = readPromptCatalog;', legacyContext);
  const legacy = await legacyContext.read({});
  assert.equal(legacy.legacy, true);
  assert.deepEqual(legacyCalls, ['/api/prompt-library', '/api/prompts']);

  const typedContext = vm.createContext({
    httpApiGet: async () => { throw Object.assign(new Error('HTTP 404: prompt group not found'), { code: 'prompt_group_not_found' }); },
  });
  vm.runInContext(catalogDeclaration + '\nglobalThis.read = readPromptCatalog;', typedContext);
  await assert.rejects(typedContext.read({}), (error) => error.code === 'prompt_group_not_found');
});

test('Terminal MCP and HTTP source expose the full prompt-library contract', () => {
  for (const name of [
    'list_prompt_catalog', 'read_prompts', 'create_prompt', 'update_prompt', 'move_prompt', 'delete_prompt',
    'create_prompt_group', 'get_prompt_group', 'update_prompt_group', 'delete_prompt_group',
  ]) assert.match(source, new RegExp("name: '" + name + "'"));
  for (const route of [
    '/api/prompt-library', '/api/prompt-library/read', '/api/prompt-groups', '/api/prompts', '/move',
  ]) assert.ok(webSource.includes(route), 'missing HTTP route marker: ' + route);
  assert.match(source, /No fallback whole-library save was attempted/);
  const getPromptStart = source.indexOf("case 'get_prompt':");
  const getPromptEnd = source.indexOf("case 'update_prompt':", getPromptStart);
  const getPromptHandler = source.slice(getPromptStart, getPromptEnd);
  assert.match(getPromptHandler, /readPromptCatalog\(target\)/);
  assert.match(getPromptHandler, /const mode = args\.mode === 'own' \? 'own' : 'resolved'/);
  assert.match(getPromptHandler, /httpPromptLibraryMutation\(target, 'POST', '\/api\/prompt-library\/read'/);
  assert.doesNotMatch(getPromptHandler, /httpApiGet\(target, '\/api\/prompts'\)/);
  assert.match(source, /case 'get_prompt_group':[\s\S]*HTTP 404.*!error\.code/);
  assert.match(webSource, /savedPromptService\.readMany/);
  assert.match(webSource, /savedPromptService\.movePrompt/);
  assert.match(webSource, /resolvedText: await resolveSavedPromptText\(prompt, \[\]\)/);
});

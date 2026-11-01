import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

// Fedor31Oct named this the main flow: tabs must be able to create each other,
// change the model, and exchange questions. This exercises the MCP boundaries
// of create_tab -> set_codex_model_effort -> send_prompt/send_message, with the
// emphasis on WHAT THE CALLING SESSION RECEIVES when a step is refused.
//
// Those refusals matter more than before: a programmatic Send that never
// reached the terminal no longer leaves a card in the user's History, so the
// tool result is the only place the failure is reported.

const source = readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const transportStart = source.lastIndexOf('// stdio transport');
assert.ok(transportStart > source.indexOf('async function callTool('));
const executable = source.slice(0, transportStart).replace(/^import .*;\n/gm, '');
const owner = { tabId: 'caller-tab', projectId: 'caller-project', cwd: '/source/worktree', mainPid: '123' };

const CODEX_SETTINGS_CAPABILITY = { version: 1, standalone: true, busy: true, fast: 'absolute' };

function harness({ respond, env = {} } = {}) {
  const calls = [];
  const context = vm.createContext({
    AsyncLocalStorage, Buffer, URL, URLSearchParams, basename, join, resolve, promisify, execFile,
    homedir: () => '/isolated-home',
    readdirSync: () => [],
    process: { env, argv: ['node', 'terminal-server.mjs'], cwd: () => '/fallback', stderr: { write() {} } },
    randomUUID,
    testPickInstance: () => ({ port: 43210 }),
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const call = {
        method: options.method || 'GET',
        endpoint: parsed.pathname + parsed.search,
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      const response = await respond(call, calls);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        text: async () => JSON.stringify(response.body),
      };
    },
  });
  vm.runInContext(executable
    + '\npickWebInstance = testPickInstance; pickInstance = () => ({ port: 43211 });'
    + ' readSharedToken = () => "test-token"; globalThis.dispatch = handleRequest;', context);
  let nextId = 0;
  return {
    calls,
    async call(name, args, identity = owner) {
      return JSON.parse(await context.dispatch({
        id: ++nextId, method: 'tools/call',
        params: { name, arguments: args, _meta: { noted: identity } },
      })).result;
    },
  };
}

// --- step 2: set_codex_model_effort -----------------------------------------

test('model+effort change is a separate operation and returns structured state', async () => {
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { codexSettings: CODEX_SETTINGS_CAPABILITY } } }
    : { status: 200, body: { ok: true, requested: { model: 'gpt-6.1-terra', effort: 'max' },
        observed: { model: 'gpt-6-luna', effort: 'max' }, queued: true } } });
  const result = await h.call('set_codex_model_effort', {
    tabId: 'target-tab', modelSelection: { kind: 'catalog', id: 'gpt-6.1-terra' }, effort: 'max' });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent;
  assert.ok(data, 'the caller gets machine-readable settings state');
  assert.equal(data.queued, true, 'queued is an intent, not applied confirmation');
  assert.deepEqual(data.observed, { model: 'gpt-6-luna', effort: 'max' },
    'observed stays distinct from requested');
  const post = h.calls.find(call => call.method === 'POST');
  assert.match(post.endpoint, /\/codex\/settings$/);
  assert.deepEqual(post.body.modelSelection, { kind: 'catalog', id: 'gpt-6.1-terra' });
});

test('settings refusal on an older backend never reaches a mutation', async () => {
  const h = harness({ respond: () => ({ status: 200, body: { capabilities: {} } }) });
  const result = await h.call('set_codex_model_effort', { tabId: 'target-tab', effort: 'max' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /app_update_required/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0,
    'no settings mutation was sent');
});

// --- step 3: send_prompt, the refusal paths the user cares about ------------

test('a Send refused before input returns code/handoffId and reachedTerminal=false', async () => {
  // The real 4412 shape: model+Send in one call against a stopped tab.
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { contextFiles: { version: 1 }, agentModelSelection: { version: 1 } } } }
    : { status: 409, body: { ok: false, success: false, submitted: false,
        pasteWritten: false, enterWritten: false, status: 'not-submitted',
        code: 'codex_settings_change_send_inflight', tabId: 'target-tab',
        handoffId: 'project-send:805fea62', error: 'settings and prompt were not sent' } } });
  const result = await h.call('send_prompt', { tabId: 'target-tab', prompt: 'do the thing', submit: true });
  assert.equal(result.isError, true, 'the calling session sees an error');
  const data = result.structuredContent;
  assert.ok(data, 'the refusal is machine-readable, not only an HTTP string');
  assert.equal(data.code, 'codex_settings_change_send_inflight');
  assert.equal(data.submitted, false);
  assert.equal(data.pasteWritten, false);
  assert.equal(data.enterWritten, false);
  assert.equal(data.reachedTerminal, false,
    'this is the case the user History must NOT show');
  assert.equal(data.handoffId, 'project-send:805fea62', 'receipt recovery stays possible');
  assert.equal(data.tabId, 'target-tab');
});

test('an unknown delivery is reported as reaching the terminal and forbids blind retry', async () => {
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { contextFiles: { version: 1 }, agentModelSelection: { version: 1 } } } }
    : { status: 202, body: { ok: true, status: 'delivery-unknown', deliveryUnknown: true,
        handoffId: 'project-send:8e88fd27' } } });
  const result = await h.call('send_prompt', { tabId: 'target-tab', prompt: 'do the thing', submit: true });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent;
  assert.equal(data.status, 'delivery-unknown');
  assert.equal(data.deliveryUnknown, true);
  assert.equal(data.reachedTerminal, true, 'unknown is never downgraded to no-input');
  assert.match(data.summary, /do not retry/i);
  assert.match(data.summary, /get_send_receipt/);
});

test('a submitted Send reports reachedTerminal and keeps its handoff', async () => {
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { contextFiles: { version: 1 }, agentModelSelection: { version: 1 } } } }
    : { status: 200, body: { ok: true, success: true, submitted: true, status: 'queued',
        queued: true, handoffId: 'project-send:ok' } } });
  const result = await h.call('send_prompt', { tabId: 'target-tab', prompt: 'do the thing', submit: true });
  const data = result.structuredContent;
  assert.equal(data.status, 'queued');
  assert.equal(data.queued, true);
  assert.equal(data.reachedTerminal, true);
  assert.equal(data.handoffId, 'project-send:ok');
});

test('audit-pending stays distinguishable from both sent and unknown', async () => {
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { contextFiles: { version: 1 }, agentModelSelection: { version: 1 } } } }
    : { status: 202, body: { ok: true, status: 'audit-pending', auditPending: true,
        submitted: true, handoffId: 'project-send:pending' } } });
  const data = (await h.call('send_prompt', { tabId: 'target-tab', prompt: 'x', submit: true })).structuredContent;
  assert.equal(data.status, 'audit-pending');
  assert.equal(data.auditPending, true);
  assert.equal(data.submitted, true);
  assert.equal(data.reachedTerminal, true);
});

test('an editable draft keeps its original plain-text contract', async () => {
  // submit:false never reaches the terminal and owns no receipt/handoff, so it
  // deliberately stays a plain line: existing actual draft-paste integration
  // tests read this exact text. Only the submitting path became structured.
  const h = harness({ respond: () => ({ status: 200, body: { status: 'pasted' } }) });
  const result = await h.call('send_prompt',
    { tabId: 'target-tab', prompt: 'draft me', submit: false });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text,
    'Prompt pasted as editable draft into tab target-tab. Status: pasted');
  assert.equal(result.structuredContent, undefined,
    'no structured payload is invented for a non-submitting draft');
});

// --- the pair "model + Send" and its idle requirement ----------------------

test('send_prompt carries model/effort in ONE request so main owns the idle decision', async () => {
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { contextFiles: { version: 1 }, agentModelSelection: { version: 1 } } } }
    : { status: 200, body: { ok: true, submitted: true, status: 'sent', handoffId: 'h' } } });
  await h.call('send_prompt', { tabId: 'target-tab', prompt: 'x', submit: true,
    modelSelection: { kind: 'catalog', id: 'gpt-6.1-terra' }, effort: 'max', queue: true });
  const post = h.calls.find(call => call.method === 'POST' && /\/send$/.test(call.endpoint));
  assert.deepEqual(post.body.modelSelection, { kind: 'catalog', id: 'gpt-6.1-terra' });
  assert.equal(post.body.effort, 'max');
  assert.equal(post.body.queue, true);
  assert.equal(post.body.source, 'terminal-mcp',
    'the programmatic origin is declared, which is what the History rule reads');
});

test('the caller cannot forge the return address of a send', async () => {
  const h = harness({ respond: call => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { contextFiles: { version: 1 }, agentModelSelection: { version: 1 } } } }
    : { status: 200, body: { ok: true, submitted: true, status: 'sent', handoffId: 'h' } } });
  await h.call('send_prompt', { tabId: 'target-tab', prompt: 'x', submit: true });
  const post = h.calls.find(call => call.method === 'POST' && /\/send$/.test(call.endpoint));
  assert.equal(post.body.sourceTabId, undefined, 'no caller-supplied source address');
  assert.equal(post.body.sourceMeta, undefined, 'identity travels in the header, not the body');
});

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
const transportStart = source.lastIndexOf('// stdio transport');
assert.ok(transportStart > source.indexOf('async function callTool('));
// Execute the real JSON-RPC dispatcher, routing and HTTP adapters, without stdio.
const executable = source.slice(0, transportStart).replace(/^import .*;\n/gm, '');
const owner = { tabId: 'hub-source', projectId: 'hub-project', cwd: '/source/worktree', mainPid: '123' };
const capability = { version: 1, replyTo: true, durable: true };

function harness({ respond, env = {} } = {}) {
  const calls = [];
  const targets = [];
  const events = [];
  const context = vm.createContext({
    AsyncLocalStorage, Buffer, URL, URLSearchParams, basename, join, resolve, promisify, execFile,
    homedir: () => '/isolated-home',
    readdirSync: () => [],
    process: { env, argv: ['node', 'terminal-server.mjs'], cwd: () => '/fallback', stderr: { write() {} } },
    randomUUID: () => {
      const id = randomUUID();
      events.push({ kind: 'uuid', id });
      return id;
    },
    testPickInstance: (target) => {
      targets.push(JSON.parse(JSON.stringify(target)));
      return { port: 43210 };
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const call = {
        method: options.method || 'GET',
        endpoint: parsed.pathname + parsed.search,
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      events.push({ kind: 'http', ...call });
      const response = respond ? await respond(call, calls) : {
        status: call.method === 'POST' ? 202 : 200,
        body: call.endpoint === '/api/me'
          ? { capabilities: { tabMessages: capability } }
          : { ok: true, accepted: true, messageId: 'message-new', requestId: call.body?.requestId, deliveryState: 'queued' },
      };
      return { ok: response.status >= 200 && response.status < 300, status: response.status, text: async () => JSON.stringify(response.body) };
    },
  });
  vm.runInContext(executable + '\npickWebInstance = testPickInstance; readSharedToken = () => "test-token"; globalThis.dispatch = handleRequest;', context);
  let nextId = 0;
  return {
    calls, targets, events,
    async list() {
      return JSON.parse(await context.dispatch({ id: ++nextId, method: 'tools/list' })).result.tools;
    },
    async call(name, args, identity = owner) {
      return JSON.parse(await context.dispatch({
        id: ++nextId, method: 'tools/call',
        params: { name, arguments: args, _meta: { noted: identity } },
      })).result;
    },
  };
}

function assertStructured(result) {
  assert.ok(result.structuredContent);
  if (!result.isError) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

test('inspect_tabs actual dispatcher is two GETs, strict bounds and update-required without fallback', async () => {
  const h = harness({ respond: call => ({ status: 200, body: call.endpoint === '/api/me'
    ? { capabilities: { tabInspection: { version: 1 } } }
    : { version: 1, passive: true, tabs: [{ tabId: 'T', known: false, revision: 'r' }] } }) });
  const schema = (await h.list()).find(tool => tool.name === 'inspect_tabs').inputSchema;
  assert.equal(schema.properties.tabIds.maxItems, 8); assert.equal(schema.properties.maxPreviewChars.maximum, 2000);
  const result = assertStructured(await h.call('inspect_tabs', { tabIds: ['T'], includeLastResponse: true, maxPreviewChars: 0 }));
  assert.equal(result.tabs[0].known, false);
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'GET']);
  const params = new URL('http://local' + h.calls[1].endpoint).searchParams;
  assert.equal(params.get('tabIds'), '["T"]'); assert.equal(params.get('maxPreviewChars'), '0');
  const count = h.calls.length;
  assert.equal((await h.call('inspect_tabs', { tabIds: Array.from({ length: 9 }, (_, i) => String(i)) })).isError, true);
  assert.equal(h.calls.length, count);
  const old = harness();
  assert.equal((await old.call('inspect_tabs', { tabIds: ['T'] })).isError, true);
  assert.equal(old.calls.length, 1);
});

test('tool schemas expose only the agreed arguments and describe message/receipt/completion workflows', async () => {
  const tools = await harness().list();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const [name, fields] of [
    ['send_message', ['tabId', 'text', 'requestId']],
    ['reply_to_message', ['messageId', 'text', 'requestId']],
    ['get_message', ['messageId']],
    ['get_send_receipt', ['tabId', 'handoffId']],
  ]) {
    const tool = byName.get(name);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), fields);
    assert.deepEqual(tool.inputSchema.required, fields.filter((field) => field !== 'requestId'));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.description, /poll/i);
  }
  assert.match(byName.get('send_message').description, /busy owner.*continue.*before its final/s);
  assert.match(byName.get('reply_to_message').description, /server derives the recipient/);
  assert.match(byName.get('send_prompt').description, /get_send_receipt.*never retry changed or empty text/);
  assert.match(byName.get('send_prompt').inputSchema.properties.handoffId.description, /get_send_receipt/);
  for (const name of ['delegate_to_session', 'start_external_research', 'continue_external_research', 'import_external_conversation', 'get_delegation_result']) {
    const description = byName.get(name).description;
    assert.match(description, /orchestrationInlineResults:\{version:1\}/);
    assert.match(description, /Check the actual notification/);
    assert.match(description, /inline full answer directly/);
    assert.match(description, /omitted\/oversize.*older apps.*explicit recovery/);
    assert.doesNotMatch(description, /exactly once|one short completion notification/);
  }
  assert.doesNotMatch(byName.get('close_tab').description, /after get_delegation_result/);
});

test('send routes through the source app and never trusts caller identity overrides', async () => {
  const h = harness({ env: { NOTED_PARENT_TAB_ID: 'env-tab', NOTED_PARENT_PROJECT_ID: 'env-project' } });
  const tabId = Buffer.from('/different/app/project').toString('base64') + '-tab-123';
  const text = '  What is verified?\nKeep your current work.  ';
  const result = await h.call('send_message', {
    tabId, text, requestId: 'exact-send-key',
    sourceTabId: 'forged', sourceMeta: { tabId: 'forged' }, projectId: 'forged-project', cwd: '/forged',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(h.calls, [
    { method: 'GET', endpoint: '/api/me', body: null },
    { method: 'POST', endpoint: '/api/tab-messages', body: {
      sourceTabId: owner.tabId, targetTabId: tabId, text, requestId: 'exact-send-key',
      sourceMeta: { server: 'terminal', mode: 'internal', projectId: owner.projectId, tabId: owner.tabId, cwd: owner.cwd },
    } },
  ]);
  for (const target of h.targets) assert.deepEqual(target, { projectId: owner.projectId, cwd: owner.cwd, port: null, pid: null });
  const status = assertStructured(result);
  assert.equal(status.messageId, 'message-new');
  assert.equal(status.requestId, 'exact-send-key');
  assert.equal(status.deliveryState, 'queued');
  assert.match(status.guidance, /not proof the model has read or answered/);
  assert.equal(h.events.filter((event) => event.kind === 'uuid').length, 0);
});

test('reply addresses an encoded messageId and leaves recipient derivation to the server', async () => {
  const h = harness();
  const messageId = 'question/id ?#&';
  const result = await h.call('reply_to_message', {
    messageId, text: 'Verified answer', requestId: 'reply-key',
    tabId: 'wrong-recipient', targetTabId: 'also-wrong', sourceTabId: 'forged', sourceMeta: { tabId: 'forged' },
  });
  const post = h.calls[1];
  assert.equal(post.endpoint, '/api/tab-messages/' + encodeURIComponent(messageId) + '/replies');
  assert.deepEqual(Object.keys(post.body).sort(), ['requestId', 'sourceMeta', 'sourceTabId', 'text']);
  assert.equal(post.body.sourceTabId, owner.tabId);
  assert.equal(post.body.sourceMeta.tabId, owner.tabId);
  assert.equal(assertStructured(result).requestId, 'reply-key');
});

test('concurrent hub requests retain separate source identities across capability awaits', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  const h = harness({ respond: async (call) => {
    if (call.endpoint === '/api/me') {
      if (++checks === 2) release();
      await gate;
      return { status: 200, body: { capabilities: { tabMessages: capability } } };
    }
    return { status: 202, body: { messageId: call.body.sourceTabId + '-message', deliveryState: 'queued' } };
  } });
  const other = { tabId: 'other-source', projectId: 'other-project', cwd: '/other/worktree' };
  const results = await Promise.all([
    h.call('send_message', { tabId: 'recipient', text: 'First' }, owner),
    h.call('reply_to_message', { messageId: 'question', text: 'Second' }, other),
  ]);
  for (const [index, identity] of [owner, other].entries()) {
    const body = h.calls.find((call) => call.body?.sourceTabId === identity.tabId).body;
    assert.equal(body.sourceMeta.tabId, identity.tabId);
    assert.equal(body.sourceMeta.projectId, identity.projectId);
    assert.equal(body.sourceMeta.cwd, identity.cwd);
    assert.equal(assertStructured(results[index]).messageId, identity.tabId + '-message');
  }
});

for (const name of ['send_message', 'reply_to_message']) {
  const address = name === 'send_message' ? { tabId: 'recipient' } : { messageId: 'question' };

  test(name + ' generates a UUID before network and recovers a lost ACK only under the exact key', async () => {
    const saved = new Map();
    let loseAck = true;
    const h = harness({ respond: (call) => {
      if (call.endpoint === '/api/me') return { status: 200, body: { capabilities: { tabMessages: capability } } };
      const previous = saved.get(call.body.requestId);
      if (previous) assert.deepEqual(call.body, previous);
      else saved.set(call.body.requestId, call.body);
      if (loseAck) { loseAck = false; throw new Error('connection lost after durable acceptance'); }
      return { status: 202, body: { messageId: 'durable-message', requestId: call.body.requestId, deliveryState: 'queued' } };
    } });
    const failed = await h.call(name, { ...address, text: 'Same exact payload' });
    assert.equal(failed.isError, true);
    const status = assertStructured(failed);
    assert.equal(h.events[0].kind, 'uuid');
    assert.match(status.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(status.requestId, h.events[0].id);
    assert.equal(status.deliveryState, 'unknown');
    assert.equal(status.messageId, null);
    assert.ok(failed.content[0].text.includes(JSON.stringify(status.requestId)));
    assert.match(status.recovery, /identical.*never use a new ID or changed text/);
    const recovered = await h.call(name, { ...address, text: 'Same exact payload', requestId: status.requestId });
    assert.equal(assertStructured(recovered).messageId, 'durable-message');
    assert.equal(saved.size, 1);
    assert.equal(h.events.filter((event) => event.kind === 'uuid').length, 1);
    assert.deepEqual(h.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'POST']);
  });

  test(name + ' rejects spoofed source identity without a full session before any HTTP', async () => {
    const h = harness();
    const result = await h.call(name, { ...address, text: 'Question', sourceTabId: 'forged', sourceMeta: owner }, null);
    assert.equal(result.isError, true);
    assert.match(assertStructured(result).error, /source identity cannot be supplied/);
    assert.deepEqual(h.calls, []);
  });

  test(name + ' refuses old/incomplete app capabilities without POST or fallback', async () => {
    for (const tabMessages of [undefined, { version: 0, replyTo: true, durable: true }, { version: 1 }, { ...capability, replyTo: false }, { ...capability, durable: false }]) {
      const h = harness({ respond: () => ({ status: 200, body: { capabilities: { tabMessages } } }) });
      const result = await h.call(name, { ...address, text: 'Question' });
      assert.equal(result.isError, true);
      const status = assertStructured(result);
      assert.equal(status.code, 'app_update_required');
      assert.equal(status.deliveryState, 'not-submitted');
      assert.equal(status.requestId, h.events[0].id);
      assert.match(status.error, /requires an update.*No message POST or send_prompt fallback/);
      assert.deepEqual(h.calls.map((call) => call.endpoint), ['/api/me']);
    }
  });
}

test('capability transport failure preserves the generated key and does not claim a POST occurred', async () => {
  const h = harness({ respond: () => { throw new Error('capability service unavailable'); } });
  const result = await h.call('send_message', { tabId: 'recipient', text: 'Question' });
  const status = assertStructured(result);
  assert.equal(result.isError, true);
  assert.equal(status.code, 'message_preflight_failed');
  assert.equal(status.deliveryState, 'not-submitted');
  assert.equal(status.requestId, h.events[0].id);
  assert.deepEqual(h.calls.map((call) => call.method), ['GET']);
});

test('HTTP errors preserve server status and the caller exact retry key', async () => {
  const h = harness({ respond: (call) => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { tabMessages: capability } } }
    : { status: 409, body: { error: 'immutable request conflict', code: 'request_conflict', messageId: 'existing-message', deliveryState: 'queued' } },
  });
  const result = await h.call('send_message', { tabId: 'recipient', text: 'Changed payload', requestId: 'original-key' });
  const status = assertStructured(result);
  assert.equal(result.isError, true);
  assert.equal(status.requestId, 'original-key');
  assert.equal(status.messageId, 'existing-message');
  assert.equal(status.code, 'request_conflict');
  assert.equal(status.deliveryState, 'queued');
  assert.match(result.content[0].text, /HTTP 409.*requestId="original-key"/);
  assert.equal(h.calls.length, 2);
});

test('an invalid acceptance response cannot claim successful durable delivery', async () => {
  for (const body of [null, {}, { accepted: true }, { messageId: '' }, { ok: false, error: 'rejected' }]) {
    const h = harness({ respond: (call) => call.endpoint === '/api/me'
      ? { status: 200, body: { capabilities: { tabMessages: capability } } }
      : { status: 202, body },
    });
    const result = await h.call('reply_to_message', { messageId: 'question', text: 'Answer', requestId: 'same-key' });
    assert.equal(result.isError, true);
    const status = assertStructured(result);
    assert.equal(status.code, 'invalid_message_response');
    assert.equal(status.requestId, 'same-key');
    assert.equal(status.deliveryState, 'unknown');
    assert.equal(h.calls.length, 2);
  }
});

test('get_message preserves the bounded server response using only an encoded GET through the source app', async () => {
  const bounded = { ok: true, message: { messageId: 'question/id', deliveryState: 'sent' }, replies: [{ messageId: 'reply', text: 'answer' }], truncated: true, nextCursor: 'reply-cursor' };
  const h = harness({ respond: () => ({ status: 200, body: bounded }) });
  const result = await h.call('get_message', { messageId: 'question/id', cwd: '/forged', projectId: 'forged' });
  assert.deepEqual(assertStructured(result), bounded);
  assert.deepEqual(h.calls, [{ method: 'GET', endpoint: '/api/tab-messages/question%2Fid', body: null }]);
  assert.equal(h.targets[0].cwd, owner.cwd);
  assert.equal(h.targets[0].projectId, owner.projectId);
});

test('get_send_receipt is a thin read-only exact-key GET, including an empty receipt response', async () => {
  const tabId = 'recipient/id ?';
  const handoffId = 'key/&=?#';
  const receipt = { ok: true, tabId, handoffId, receipts: [] };
  const h = harness({ respond: () => ({ status: 200, body: receipt }) });
  const result = await h.call('get_send_receipt', { tabId, handoffId });
  assert.deepEqual(assertStructured(result), receipt);
  assert.deepEqual(h.calls, [{ method: 'GET', endpoint: '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/send-receipts?handoffId=' + encodeURIComponent(handoffId), body: null }]);
});

test('invalid inputs cannot broaden a read or cause a message POST', async () => {
  for (const [name, args] of [
    ['send_message', { text: 'Question' }],
    ['send_message', { tabId: 'recipient', text: '   ' }],
    ['send_message', { tabId: 'recipient', text: 'Question', requestId: '' }],
    ['send_message', { tabId: 'recipient', text: 'Question', requestId: null }],
    ['reply_to_message', { messageId: 123, text: 'Answer' }],
    ['get_message', { messageId: '' }],
    ['get_send_receipt', { tabId: 'recipient' }],
    ['get_send_receipt', { handoffId: 'key' }],
  ]) {
    const h = harness();
    const result = await h.call(name, args);
    assert.equal(result.isError, true);
    assert.match(assertStructured(result).error, /non-empty string/);
    assert.deepEqual(h.calls, []);
  }
});

test('send_prompt pending and unknown results point to the reader without another send', async () => {
  for (const status of [{ status: 'delivery-unknown' }, { deliveryUnknown: true }, { status: 'audit-pending' }, { auditPending: true }]) {
    const h = harness({ respond: () => ({ status: 202, body: { ...status, handoffId: 'original-handoff' } }) });
    const result = await h.call('send_prompt', { tabId: 'recipient', prompt: 'Original text' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('get_send_receipt({"tabId":"recipient","handoffId":"original-handoff"})'));
    assert.match(result.content[0].text, /changed\/empty text/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].endpoint, '/api/terminal-tabs/recipient/send');
  }
});

test('ordinary send_prompt delivery and editable-draft behavior are not redefined', async () => {
  const h = harness({ respond: () => ({ status: 200, body: { status: 'queued', queued: true, handoffId: 'send-key' } }) });
  const result = await h.call('send_prompt', { tabId: 'recipient', prompt: 'Original text' });
  assert.equal(result.content[0].text, 'Prompt sent to tab recipient through Project API scenario layer. Status: queued (queued). Handoff: send-key');
  assert.deepEqual(h.calls.map((call) => call.endpoint), ['/api/terminal-tabs/recipient/send']);
  const rejectedDraft = await h.call('send_prompt', { tabId: 'recipient', prompt: 'draft', submit: false, files: [{ path: '/source.txt' }] });
  assert.equal(rejectedDraft.isError, true);
  assert.match(rejectedDraft.content[0].text, /files require submit=true/);
  assert.equal(h.calls.length, 1);
});

test('delegation acceptance retains its durable run and descendant lifecycle on an older app', async () => {
  const accepted = { ok: true, accepted: true, run: { runId: 'existing-run', state: 'queued' } };
  const h = harness({ respond: () => ({ status: 202, body: accepted }) });
  const result = await h.call('delegate_to_session', { targetTabId: 'existing-codex-owner', prompt: 'Execute and verify' });
  assert.deepEqual(assertStructured(result), { ...accepted, runId: 'existing-run' });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.endpoint, '/api/orchestrations');
  assert.equal(call.body.sourceTabId, owner.tabId);
  assert.equal(call.body.waitForDescendants, true);
  assert.equal(call.body.notifySource, true);
  assert.equal(call.body.queue, true);
  assert.equal(Object.hasOwn(call.body, 'toolType'), false);
  assert.equal(Object.hasOwn(call.body, 'orchestrationInlineResults'), false);
});

test('browser research retains run/job identity without requiring inline-result support or reading results early', async () => {
  const h = harness({ respond: (call) => call.endpoint === '/api/me'
    ? { status: 200, body: { capabilities: { externalResearchOrchestration: { version: 1 } } } }
    : { status: 202, body: { ok: true, runId: 'research-run', jobId: 'research-job' } },
  });
  const result = await h.call('start_external_research', { prompt: 'Review the contract' });
  assert.deepEqual(assertStructured(result), { ok: true, runId: 'research-run', jobId: 'research-job' });
  assert.deepEqual(h.calls.map((call) => call.endpoint), ['/api/me', '/api/external-research/orchestrations']);
  assert.equal(h.calls[1].body.waitForDescendants, true);
  assert.equal(h.calls[1].body.notifySource, true);
  assert.equal(h.calls[1].body.sourceTabId, owner.tabId);
});

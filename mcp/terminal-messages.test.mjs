import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createRequire } from 'node:module';
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
  vm.runInContext(executable + '\npickWebInstance = testPickInstance; pickInstance = () => ({ port: 43211 }); readSharedToken = () => "test-token"; globalThis.dispatch = handleRequest;', context);
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

test('rewind_self is caller-bound, retains the context cut and delegates its sole followup to the app', async () => {
  const args = { operationId: 'self-op', expectedSessionId: 'S', targetUuid: 'user-before-deploy',
    retainedContext: 'Deployment succeeded; files and server changes remain.', expectedContextRevision: 7, expectedContextSnapshot: 'observed-proof',
    coveredContextUpdateIds: ['old-member'], nextPrompt: 'Inspect the result without redeploying.' };
  const h = harness({ respond: call => ({ status: call.method === 'POST' ? 202 : 200,
    body: call.endpoint === '/api/me' ? { capabilities: { savedHistory: { version: 1, receipts: true,
      structuredDraft: true, operations: ['rewind'], providers: ['codex'], codexPhysicalSuffix: true,
      selfRewind: { version: 1, contextSnapshot: 1 } } } } : { ok: true, operation: { operationId: 'self-op', tabId: owner.tabId,
        expectedSessionId: 'S', targetUuid: args.targetUuid, kind: 'rewind', toolType: 'codex', state: 'running', pending: true } } }) });
  const schema = (await h.list()).find(tool => tool.name === 'rewind_self').inputSchema;
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.tabId, undefined);
  assert.equal(schema.required.includes('expectedContextSnapshot'), true);
  const result = assertStructured(await h.call('rewind_self', args));
  assert.equal(result.operationId, 'self-op'); assert.equal(result.tabId, owner.tabId);
  assert.match(result.guidance, /Finish this old turn/); assert.match(result.guidance, /Do not send it yourself/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].endpoint, '/api/terminal-tabs/' + owner.tabId + '/self-rewind');
  assert.deepEqual(h.calls[1].body.selfRewind, { retainedContext: args.retainedContext, expectedContextRevision: 7,
    expectedContextSnapshot: args.expectedContextSnapshot,
    coveredContextUpdateIds: ['old-member'], nextPrompt: args.nextPrompt });
  assert.equal(h.calls[1].body.sourceMeta.tabId, owner.tabId);
  const forged = await h.call('rewind_self', { ...args, tabId: 'another-tab' });
  assert.equal(forged.isError, true); assert.equal(h.calls.length, 2, 'no mutation to an arbitrary target');
});

test('rewind_self on an older backend refuses before POST; no use of ordinary Rewind/Send as fallback', async () => {
  const h = harness({ respond: () => ({ status: 200, body: { capabilities: { savedHistory: {
    version: 1, receipts: true, structuredDraft: true, operations: ['rewind'], providers: ['codex'], codexPhysicalSuffix: true,
  } } } }) });
  const result = await h.call('rewind_self', { operationId: 'frozen-id', expectedSessionId: 'S', targetUuid: 'u',
    retainedContext: 'Facts', expectedContextRevision: 0 });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.code, 'app_update_required');
  assert.equal(result.structuredContent.mutationAttempted, false); assert.equal(h.calls.length, 1);
});

test('self Rewind pre-admission rejection and lost ACK remain distinguishable with the original recovery ID', async () => {
  const args = { operationId: 'fixed-id', expectedSessionId: 'S', targetUuid: 'u', retainedContext: 'Facts', expectedContextRevision: 2, expectedContextSnapshot: 'observed-proof' };
  const capability = { capabilities: { savedHistory: { version: 1, receipts: true, structuredDraft: true,
    operations: ['rewind'], providers: ['codex'], codexPhysicalSuffix: true, selfRewind: { version: 1, contextSnapshot: 1 } } } };
  for (const lost of [false, true]) {
    const h = harness({ respond: call => {
      if (call.endpoint === '/api/me') return { status: 200, body: capability };
      if (lost) throw Error('controlled transport ACK loss');
      return { status: 409, body: { ok: false, code: 'self_rewind_context_revision_changed',
        error: 'self_rewind_context_revision_changed', mutationAttempted: false } };
    } });
    const result = await h.call('rewind_self', args);
    assert.equal(result.isError, true); assert.equal(result.structuredContent.mutationAttempted, lost);
    assert.equal(result.structuredContent.receiptRead.operationId, 'fixed-id');
    assert.equal(result.structuredContent.receiptRead.tabId, owner.tabId);
    assert.equal(h.calls.length, 2, 'no automatic read/retry/followup');
  }
});

test('context reader requests the observed snapshot, and a new app rejects a missing proof without POST', async () => {
  const capability = { capabilities: { savedHistory: { version: 1, receipts: true, structuredDraft: true,
    operations: ['rewind'], providers: ['codex'], codexPhysicalSuffix: true, selfRewind: { version: 1, contextSnapshot: 1 } } } };
  const h = harness({ respond: call => ({ status: 200, body: call.endpoint === '/api/me' ? capability
    : { ok: true, context: { revision: 7, rewindSnapshot: 'opaque-proof' } } }) });
  const observed = assertStructured(await h.call('get_tab_context', {}));
  assert.equal(observed.context.rewindSnapshot, 'opaque-proof');
  assert.equal(h.calls[0].endpoint, '/api/terminal-tabs/' + owner.tabId + '/work-context?rewindSnapshot=1');
  const currentRead = await h.call('current_context', {});
  assert.ok(!currentRead.isError, JSON.stringify(currentRead));
  const current = assertStructured(currentRead);
  assert.equal(current.workingContext.rewindSnapshot, 'opaque-proof');
  assert.equal(h.calls.filter(call => call.endpoint.endsWith('/work-context?rewindSnapshot=1')).length, 2);
  const missing = await h.call('rewind_self', { operationId: 'never-posted', expectedSessionId: 'S', targetUuid: 'U',
    retainedContext: 'Facts', expectedContextRevision: 7 });
  assert.equal(missing.isError, true); assert.equal(h.calls.some(call => call.method === 'POST'), false);
});

test('actual MCP -> context/self routes -> real SQLite snapshot admits status-only drift, not a mocked success', async t => {
  const require = createRequire(import.meta.url);
  let db;
  try { const Sqlite = require('better-sqlite3'); db = new Sqlite(':memory:'); }
  catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Run this native SQLite case with E28 ELECTRON_RUN_AS_NODE=1'); return; }
    throw error;
  }
  const { TabWorkContext } = require('../src/main/tab-work-context');
  const { SavedHistoryOperations } = require('../src/main/saved-history-operation');
  const { promptAuditFingerprint } = require('../src/main/prompt-audit-fingerprint');
  const ts = require('typescript');
  const context = new TabWorkContext({ db, listTabs: () => [{ ...owner, commandType: 'codex', codexSessionId: 'S' }] });
  t.after(async () => { await context.syncing; for (const watcher of context.watchers.values()) watcher.close(); db.close(); });
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const store = { db, getAppState: key => {
    const row = db.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null;
  }, setAppState: (key, value) => db.prepare('INSERT INTO app_state VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) };
  const dispatches = [];
  const service = new SavedHistoryOperations({ db: store, dispatch: async (...args) => {
    dispatches.push(args);
    throw Object.assign(new Error('Controlled executor not dispatched; no Stop or provider input'), { dispatched: false });
  },
    selfRewind: { context, send: () => assert.fail('no native/extra task allowed in this admission fixture') } });
  const web = readFileSync(new URL('../src/main/web-server.js', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleApi').body.statements;
  const at = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === 'contextRoute'));
  const selfAt = statements.findIndex(node => ts.isExpressionStatement(node) && node.getText(ast).includes('self-rewind$/'));
  assert.ok(at >= 0 && selfAt >= 0);
  const route = vm.runInNewContext('(async(req,res,parsed)=>{let m;\n'
    + [statements[at], statements[at + 1], statements[selfAt], statements[selfAt + 1]].map(node => node.getText(ast)).join('\n') + '})', {
    tabWorkContext: context, savedHistoryOperations: service, decId: decodeURIComponent,
    readBody: async req => req.body, sendJson: (res, status, body) => Object.assign(res, { status, body }),
  });
  const h = harness({ respond: async call => {
    if (call.endpoint === '/api/me') return { status: 200, body: { capabilities: { savedHistory: { version: 1,
      receipts: true, structuredDraft: true, operations: ['rewind'], providers: ['codex'], codexPhysicalSuffix: true,
      selfRewind: { version: 1, contextSnapshot: 1 } } } } };
    const url = new URL(call.endpoint, 'http://owned-fixture'), result = {};
    await route({ method: call.method, body: call.body }, result, { pathname: url.pathname, query: Object.fromEntries(url.searchParams) });
    return result;
  } });
  const update = context.publish(owner.tabId, { text: 'Known factual result', requestId: 'known' });
  const prepared = await context.prepare(owner.tabId, 'old-delivery', 'Original task');
  const observed = assertStructured(await h.call('get_tab_context', {})).context;
  assert.ok(observed.rewindSnapshot); context.confirm(owner.tabId, 'old-delivery', promptAuditFingerprint(prepared.prompt));
  const result = assertStructured(await h.call('rewind_self', { operationId: 'context-snapshot-real', expectedSessionId: 'S', targetUuid: 'U',
    retainedContext: 'Known factual result; no repetition of the old task', expectedContextRevision: observed.revision,
    expectedContextSnapshot: observed.rewindSnapshot }));
  assert.equal(result.operation.phase, 'accepted'); assert.equal(result.operation.historyMutated, false);
  assert.equal(service.read(owner.tabId, 'context-snapshot-real').rewindContext.covered[0].id, update.updateId);
  assert.equal(db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(update.updateId).status, 'delivered');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(dispatches.length, 1, 'the sole existing executor is dispatched once, not run by this test');
  context.publish(owner.tabId, { text: 'New fact absent from the observed summary', requestId: 'unseen' });
  const rejected = await h.call('rewind_self', { operationId: 'unseen-facts-never-dispatched', expectedSessionId: 'S', targetUuid: 'U',
    retainedContext: 'Only the earlier facts', expectedContextRevision: observed.revision, expectedContextSnapshot: observed.rewindSnapshot });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.code, 'self_rewind_context_revision_changed');
  assert.equal(rejected.structuredContent.mutationAttempted, false);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(dispatches.length, 1, 'new facts fail before the executor');
});

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
    ['reply_to_message', ['messageId', 'messageIds', 'text', 'requestId']],
    ['get_message', ['messageId']],
    ['get_send_receipt', ['tabId', 'handoffId']],
  ]) {
    const tool = byName.get(name);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), fields);
    assert.deepEqual(tool.inputSchema.required, name === 'reply_to_message' ? ['text'] : fields.filter((field) => field !== 'requestId'));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.description, /poll/i);
  }
  assert.match(byName.get('send_message').description, /busy owner.*continue.*before its final/s);
  assert.match(byName.get('reply_to_message').description, /server derives recipients/);
  assert.match(byName.get('send_prompt').description, /get_send_receipt.*never retry changed or empty text/);
  assert.match(byName.get('send_prompt').inputSchema.properties.handoffId.description, /get_send_receipt/);
  for (const name of ['delegate_to_session', 'start_external_research', 'continue_external_research', 'import_external_conversation', 'observe_external_turn', 'get_delegation_result']) {
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

test('one MCP batch call sends the explicit list once and returns mixed per-ID outcomes, including an empty delivery list', async () => {
  for (const empty of [false, true]) {
    const results = [{ questionId: 'Q1', status: 'already-answered', replyMessageId: 'old' },
      { questionId: 'Q2', status: empty ? 'already-answered' : 'reply-created', replyMessageId: empty ? 'old2' : 'new' }];
    const h = harness({ respond: call => call.endpoint === '/api/me'
      ? { status: 200, body: { capabilities: { tabMessages: { ...capability, batchReply: { version: 1 } } } } }
      : { status: 202, body: { ok: true, accepted: !empty, results, messages: empty ? [] : [{ messageId: 'new', deliveryState: 'queued' }] } } });
    const result = await h.call('reply_to_message', { messageIds: ['Q1', 'Q2'], text: 'one shared text', requestId: 'same-batch-key' });
    assert.notEqual(result.isError, true);
    const body = assertStructured(result); assert.deepEqual(body.results, results);
    const posts = h.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 1);
    assert.equal(posts[0].endpoint, '/api/tab-messages/replies');
    assert.deepEqual(posts[0].body.messageIds, ['Q1', 'Q2']); assert.equal(posts[0].body.text, 'one shared text');
    assert.equal(posts[0].body.sourceTabId, owner.tabId); assert.equal(posts[0].body.requestId, 'same-batch-key');
  }
});
test('old loaded App refuses batch before mutation; no fanout into separate single Replies', async () => {
  const h = harness(); const result = await h.call('reply_to_message', { messageIds: ['Q1', 'Q2'], text: 'shared', requestId: 'same' });
  assert.equal(result.isError, true); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(assertStructured(result).code, 'app_update_required');
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
test('actual get_message dispatcher preserves a modern durable wait outcome and a late reply without any POST or model input', async () => {
  const snapshot = { ok: true, message: { messageId: 'Q', kind: 'question', deliveryState: 'sent',
    loopWait: { version: 1, revision: 8, state: 'returning', disposition: 'reply_timeout',
      notice: { operationKey: 'tab-message-outcome:Q', handoffId: 'tab-message-outcome:Q', state: 'sent' } } },
    reply: { messageId: 'R', kind: 'reply', replyTo: 'Q', deliveryState: 'pending', text: 'Late exact answer' } };
  const h = harness({ respond: () => ({ status: 200, body: snapshot }) });
  assert.deepEqual(assertStructured(await h.call('get_message', { messageId: 'Q' })), snapshot);
  assert.deepEqual(h.calls, [{ method: 'GET', endpoint: '/api/tab-messages/Q', body: null }]);
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
    // send_prompt is now a structured tool: the human guidance moved into
    // `summary`, and the pending/unknown phase is reported as fields so the
    // caller no longer has to parse prose. The guidance itself is unchanged.
    const data = assertStructured(result);
    assert.ok(data.summary.includes('get_send_receipt({"tabId":"recipient","handoffId":"original-handoff"})'));
    assert.match(data.summary, /changed\/empty text/);
    assert.equal(data.reachedTerminal, true, 'pending/unknown is never a proven no-input');
    assert.equal(data.handoffId, 'original-handoff');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].endpoint, '/api/terminal-tabs/recipient/send');
  }
});

test('ordinary send_prompt delivery and editable-draft behavior are not redefined', async () => {
  const h = harness({ respond: () => ({ status: 200, body: { status: 'queued', queued: true, handoffId: 'send-key' } }) });
  const result = await h.call('send_prompt', { tabId: 'recipient', prompt: 'Original text' });
  const delivered = assertStructured(result);
  assert.equal(delivered.summary,
    'Prompt sent to tab recipient through Project API scenario layer. Status: queued (queued). Handoff: send-key');
  assert.equal(delivered.status, 'queued');
  assert.equal(delivered.queued, true);
  assert.equal(delivered.handoffId, 'send-key');
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

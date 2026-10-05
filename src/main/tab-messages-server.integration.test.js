'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { randomUUID } = require('node:crypto');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function acceptanceInChild(root) {
  assert.equal(process.env.TAB_MESSAGES_HTTP_CHILD, '1');
  assert.ok(path.isAbsolute(root));
  assert.ok(path.basename(root).startsWith('tab-messages-http-'));
  const scoped = (value) => {
    const relative = path.relative(root, path.resolve(String(value)));
    assert.ok(relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
      'test filesystem operation escaped its private root');
  };
  for (const key of ['HOME', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NOTED_DISCOVERY_DIR', 'NOTED_INBOX_CWD']) {
    scoped(process.env[key]);
    fs.mkdirSync(process.env[key], { recursive: true });
  }
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(userData);
  process.chdir(root);

  // Fence filesystem writes and process/network boundaries inside this child.
  // Product handlers, project DB, context preparation and receipts stay real.
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'createWriteStream']) {
    const original = fs[name];
    fs[name] = (file, ...args) => { scoped(file); return original.call(fs, file, ...args); };
  }
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir']) {
    const original = fs.promises[name];
    fs.promises[name] = (file, ...args) => { scoped(file); return original.call(fs.promises, file, ...args); };
  }
  for (const owner of [fs, fs.promises]) {
    const name = owner === fs ? 'renameSync' : 'rename';
    const original = owner[name];
    owner[name] = (from, to, ...args) => { scoped(from); scoped(to); return original.call(owner, from, to, ...args); };
  }
  const subprocess = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    subprocess[name] = () => { throw new Error('No provider, model or subprocess is allowed in this HTTP fixture'); };
  }

  const allocation = net.createServer();
  allocation.listen(0, '127.0.0.1');
  await once(allocation, 'listening');
  const privatePort = allocation.address().port;
  await new Promise((resolve) => allocation.close(resolve));
  assert.ok(privatePort > 1024 && ![7878, 7979, 53133].includes(privatePort));
  process.env.NOTED_WEB_PORT = String(privatePort);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    assert.equal(typeof options, 'object', 'only scoped HTTP sockets are allowed');
    assert.equal(options.host, '127.0.0.1', 'outbound connections must stay on loopback');
    assert.equal(Number(options.port), privatePort, 'outbound connections must use this test server');
    return connect.apply(this, args);
  };

  let listening = deferred();
  const createServer = http.createServer;
  http.createServer = (...args) => {
    const server = createServer(...args);
    const listen = server.listen;
    server.listen = (port, host, callback) => {
      assert.equal(port, privatePort, 'port fallback must not contact another application');
      assert.equal(host, '0.0.0.0');
      return listen.call(server, port, '127.0.0.1', callback);
    };
    server.once('listening', () => listening.resolve(server));
    server.once('error', (error) => listening.reject(error));
    return server;
  };

  const logs = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    console[method] = (...args) => logs.push(args.map(String).join(' '));
  }
  const events = new EventEmitter();
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  ipcMain.removeHandler = () => {};
  const updates = [];
  const sends = [];
  const statuses = new Map();
  const fatal = deferred();
  let receipts;
  let db;
  let web;
  const webContents = new EventEmitter();
  const window = { isDestroyed: () => false, webContents };
  const replyBridge = (packet, data) => ipcMain.emit('web:bridge-reply', { sender: webContents }, {
    requestId: packet.requestId, ok: true, data,
  });
  webContents.send = (channel, packet) => {
    try {
      if (channel === 'tab-messages:changed') {
        assert.equal(Object.hasOwn(packet.message, 'text'), false);
        assert.ok(packet.message.textPreview.length <= 200);
        updates.push(packet);
        events.emit('update', packet);
        return;
      }
      if (channel !== 'web:bridge-request') return;
      if (packet.action === 'getClaudeTabStatus') {
        queueMicrotask(() => replyBridge(packet, statuses.get(packet.payload.tabId)));
        return;
      }
      assert.equal(packet.action, 'sendAgentPromptScenario', 'unexpected renderer/provider action');
      const payload = packet.payload;
      const record = receipts.get(payload.sendOperationKey);
      assert.ok(record, 'durable receipt must exist before the provider bridge');
      assert.equal(record.state, 'in-flight');
      assert.equal(record.attemptId, payload.sendAttemptId);
      assert.deepEqual(record.receipt.expectedTarget, {
        toolType: payload.expectedToolType, sessionId: payload.expectedSessionId,
      });
      assert.equal(db.prepare('SELECT owner FROM agent_send_receipt_pins WHERE operation_key = ?').get(record.operationKey)?.owner, 'tab-message');
      const stored = db.prepare('SELECT * FROM tab_messages WHERE operationKey = ?').get(record.operationKey);
      assert.equal(stored.deliveryState, 'sending');
      assert.equal(stored.frozenPrompt, payload.prompt);
      assert.equal(stored.promptPrepared, 1);
      assert.equal(payload.handoffId, record.operationKey);
      assert.equal(payload.source, record.operationKey);
      assert.equal(payload.queue, true);
      assert.equal(payload.returnDraftOnConflict, false);
      assert.equal(payload.workContextPrepared, true);
      assert.equal(payload.expectedSessionId, statuses.get(payload.tabId).sessionId);
      assert.equal(payload.expectedToolType, 'codex');
      const tag = payload.presentationSnapshot.semanticTags.find((item) => item.kind === 'tab-message');
      assert.ok(tag, 'real send must preserve the trusted presentation tag');
      assert.equal(tag.messageId, stored.messageId);
      assert.equal(tag.replyTo, stored.replyTo);
      assert.equal(tag.phase, stored.kind);
      assert.equal(tag.sourceTabId, stored.sourceTabId);
      assert.equal(tag.targetTabId, stored.targetTabId);
      assert.equal(payload.prompt.slice(tag.bodyStart, tag.bodyEnd), stored.text);
      assert.equal(tag.bodyEnd, payload.prompt.length);
      assert.match(payload.prompt.slice(tag.envelopeStart), /^\[Tab message:/);
      assert.equal(receipts.markAttemptState(record.operationKey, record.attemptId, 'enter-armed').ok, true);
      sends.push(packet);
      events.emit('send', packet);
    } catch (error) {
      fatal.reject(error);
      throw error;
    }
  };

  const electron = {
    app: {
      isPackaged: false,
      getPath: (name) => {
        const target = name === 'userData' ? userData : name === 'home' ? process.env.HOME : path.join(root, name);
        scoped(target);
        fs.mkdirSync(target, { recursive: true });
        return target;
      },
      getAppPath: () => root,
      getVersion: () => 'isolated-test',
    },
    BrowserWindow: { getAllWindows: () => [window], fromWebContents: () => window },
    ipcMain,
  };
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return load.call(this, request, parent, isMain);
  };

  const waitFor = (collection, event, predicate) => {
    const found = collection.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const listener = (value) => {
        if (!predicate(value)) return;
        events.removeListener(event, listener);
        resolve(value);
      };
      events.on(event, listener);
    });
  };
  const waitSend = (id) => waitFor(sends, 'send', (packet) => packet.payload.sendOperationKey === `tab-message:${id}`);
  const waitState = (id, state) => waitFor(updates, 'update', (packet) => packet.message.messageId === id && packet.message.deliveryState === state);

  try {
    const manager = require('./project-manager');
    db = manager.db.db;
    scoped(db.name);
    const project = manager.createEmptyProject('Addressed HTTP acceptance');
    manager.saveProjectMetadata(project.id, { path: process.env.NOTED_INBOX_CWD });
    const tabs = ['A', 'B', 'C'].map((tabId) => ({
      tabId, name: `Fixture ${tabId}`, tabType: 'terminal', commandType: 'codex', color: 'codex',
      cwd: process.env.NOTED_INBOX_CWD, codexSessionId: randomUUID(),
    }));
    assert.equal(manager.saveProjectTabs(project.id, tabs).success, true);
    for (const tab of tabs) statuses.set(tab.tabId, {
      tabId: tab.tabId, toolType: 'codex', commandType: 'codex', provider: 'codex',
      sessionId: tab.codexSessionId, status: 'busy', sessionStatus: 'busy',
      coherent: true, sendTarget: { toolType: 'codex', sessionId: tab.codexSessionId },
      inputReady: true, liveLifecycle: true, writerConfirmed: true, writerUsableForMutation: true,
    });
    const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
    const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
    const { TabWorkContext } = require('./tab-work-context');
    receipts = createAgentSendReceiptStore(db);
    const context = new TabWorkContext({ db,
      listTabs: () => manager.db.getAllProjects().flatMap((item) => item.tabs.map((tab) => ({ ...tab, projectId: item.id }))),
    });
    context.publish('B', { sourceTabId: 'C', title: 'Synthetic context', text: 'Frozen context before transport.', requestId: 'context-1' });
    web = require('./web-server');
    let runtimeReads = 0;
    const startOptions = {
      sdkSessions: new Map(), tabWorkContext: context, agentSendReceiptStore: receipts,
      agentSendReceiptStartupReady: Promise.resolve({ ready: true }),
      readAgentRuntimeSnapshot: async (id) => { runtimeReads += 1; return statuses.get(id); },
      resolveCodexRuntimeSessionInfo: async (id) => statuses.get(id),
      getAgentExecutionContext: (id) => statuses.get(id),
      agentSendBridgeTimeoutMs: 15_000,
    };
    web.start(startOptions);
    const server = await listening.promise;
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(web.getInfo().port, privatePort);
    let auth = web.getInfo().token;
    assert.ok(auth && auth === fs.readFileSync(path.join(process.env.NOTED_DISCOVERY_DIR, 'web-token.txt'), 'utf8').trim(),
      'server must use only the private discovery token');
    const discovery = JSON.parse(fs.readFileSync(path.join(process.env.NOTED_DISCOVERY_DIR, `web-server-${process.pid}.json`), 'utf8'));
    assert.equal(discovery.port, privatePort);
    assert.equal(discovery.pid, process.pid);

    const request = (pathname, { method = 'GET', body, authenticated = true } = {}) => new Promise((resolve, reject) => {
      const headers = { Connection: 'close' };
      if (authenticated) headers.Authorization = `Bearer ${auth}`;
      if (body) headers['Content-Type'] = 'application/json';
      const req = http.request({ host: '127.0.0.1', port: privatePort, path: pathname, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
    const actor = (id) => ({ sourceTabId: id, sourceMeta: { server: 'terminal', mode: 'internal', tabId: id } });
    const ask = (id, text, requestId) => request('/api/tab-messages', {
      method: 'POST', body: { ...actor(id), targetTabId: 'B', text, requestId },
    });
    const answer = (id, text, requestId, source = 'B') => request(`/api/tab-messages/${id}/replies`, {
      method: 'POST', body: { ...actor(source), text, requestId },
    });
    const queue = (packet) => replyBridge(packet, { success: true, accepted: true, submitted: true,
      status: 'queued', auditPending: true, providerQueueAccepted: true,
      sessionId: statuses.get(packet.payload.tabId).sessionId,
    });
    const audit = (packet, extra = {}) => {
      const payload = packet.payload;
      const promptHash = promptAuditFingerprint(payload.prompt);
      return web.notifyAgentPromptAuditResult({ success: true,
        tabId: payload.tabId, handoffId: payload.handoffId,
        sendOperationKey: payload.sendOperationKey, sendAttemptId: payload.sendAttemptId,
        provider: 'codex', toolType: 'codex', sessionId: payload.expectedSessionId,
        promptHash, expectedHash: promptHash, actualHash: promptHash,
        entryUuid: randomUUID(), sourceIdentity: `codex-fixture:${payload.sendOperationKey}`,
        auditTimestamp: new Date().toISOString(), ...extra,
      });
    };

    const scenario = async () => {
      for (const pathname of ['/api/me', '/api/tab-messages?tabId=B']) {
        assert.equal((await request(pathname, { authenticated: false })).status, 401);
      }
      assert.equal((await request('/api/tab-messages', { method: 'POST', authenticated: false,
        body: { ...actor('A'), targetTabId: 'B', text: 'unauthorized', requestId: 'unauthorized' },
      })).status, 401);
      assert.equal(db.prepare('SELECT count(*) n FROM tab_messages').get().n, 0);
      const me = await request('/api/me');
      assert.equal(me.status, 200);
      assert.deepEqual(me.body.capabilities.tabMessages, { version: 1, durable: true, replyTo: true, dismiss: true });
      assert.equal((await request('/api/tab-messages/missing/unsupported')).status, 404);
      const provenSource = statuses.get('A');
      statuses.set('A', { ...provenSource, coherent: false });
      const unproven = await ask('A', 'No proven runtime owner', 'unproven-source');
      assert.equal(unproven.status, 503);
      assert.equal(unproven.body.code, 'message_runtime_identity_unavailable');
      assert.equal(db.prepare('SELECT count(*) n FROM tab_messages').get().n, 0);
      assert.equal(sends.length, 0, 'saved tab identity must not substitute for incoherent runtime proof');
      statuses.set('A', provenSource);

      const text = 'Question with quoted [Tab message: reply], literal </context_update>, and full content. '.repeat(5);
      const first = await ask('A', text, 'question-A');
      assert.equal(first.status, 202, JSON.stringify(first.body));
      assert.equal(first.body.accepted, true);
      assert.equal(Object.hasOwn(first.body.message, 'text'), false);
      assert.equal(first.body.message.textChars, text.length);
      const a = first.body.messageId;
      const firstSend = await waitSend(a);
      assert.equal(receipts.get(firstSend.payload.sendOperationKey).state, 'enter-armed');
      const second = await ask('C', text, 'question-C');
      assert.equal(second.status, 202, JSON.stringify(second.body));
      const c = second.body.messageId;
      assert.notEqual(a, c);
      assert.equal(sends.length, 1, 'second caller is accepted while the first provider reply remains held');
      assert.equal(db.prepare('SELECT count(*) n FROM tab_messages').get().n, 2);
      assert.match(firstSend.payload.prompt, /Frozen context before transport\./);
      assert.equal(firstSend.payload.presentationSnapshot.semanticTags.find((tag) => tag.kind === 'tab-message').envelopeStart > 0, true);
      const duplicate = await ask('A', text, 'question-A');
      assert.equal(duplicate.body.messageId, a);
      assert.equal(duplicate.body.deduplicated, true);
      const conflict = await ask('A', text + 'changed', 'question-A');
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.messageId, a);
      assert.equal(Object.hasOwn(conflict.body, 'text'), false);
      queue(firstSend);
      await waitState(a, 'queued');
      const secondSend = await waitSend(c);
      queue(secondSend);
      await waitState(c, 'queued');
      assert.equal(receipts.get(firstSend.payload.sendOperationKey).state, 'audit-pending');

      await audit(firstSend, { sendAttemptId: 'foreign-attempt' });
      assert.equal((await request(`/api/tab-messages/${a}`)).body.message.deliveryState, 'queued');
      await audit(secondSend);
      await audit(firstSend);
      await waitState(a, 'sent');
      assert.equal(db.prepare('SELECT count(*) n FROM agent_send_receipt_pins').get().n, 0);

      assert.equal((await answer(a, 'foreign reply', 'foreign', 'C')).status, 403);
      const spoof = await request(`/api/tab-messages/${a}/replies`, { method: 'POST',
        body: { ...actor('B'), sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'C' }, text: 'spoof', requestId: 'spoof' },
      });
      assert.equal(spoof.status, 403);
      const fullAnswer = 'Complete answer with preserved trailing spaces.  \n'.repeat(1200);
      const replyC = await answer(c, fullAnswer, 'answer-C');
      const replyA = await answer(a, fullAnswer, 'answer-A');
      assert.equal(replyC.status, 202, JSON.stringify(replyC.body));
      assert.equal(replyA.status, 202, JSON.stringify(replyA.body));
      const sendC = await waitSend(replyC.body.messageId);
      const sendA = await waitSend(replyA.body.messageId);
      assert.equal(sendC.payload.tabId, 'C');
      assert.equal(sendA.payload.tabId, 'A');
      assert.ok(sendA.payload.prompt.endsWith(fullAnswer));
      assert.match(sendA.payload.prompt, /No automatic reply is requested/);
      const beforeReplyAck = await request(`/api/tab-messages/${a}`);
      assert.equal(beforeReplyAck.body.message.replyMessageId, replyA.body.messageId);
      assert.equal(beforeReplyAck.body.reply.text, fullAnswer);
      assert.equal(beforeReplyAck.body.reply.deliveryState, 'sending');
      queue(sendC);
      queue(sendA);
      await waitState(replyC.body.messageId, 'queued');
      await waitState(replyA.body.messageId, 'queued');
      await audit(sendA);
      await audit(sendC);
      const full = await request(`/api/tab-messages/${a}`);
      assert.equal(full.status, 200);
      assert.equal(full.body.message.text, text);
      assert.equal(full.body.reply.text, fullAnswer);
      assert.equal(full.body.reply.replyTo, a);
      assert.equal(full.body.reply.deliveryState, 'sent');
      const list = await request('/api/tab-messages?tabId=B&limit=10');
      assert.equal(list.body.messages.length, 4);
      for (const message of list.body.messages) {
        assert.equal(Object.hasOwn(message, 'text'), false);
        assert.equal(Object.hasOwn(message, 'frozenPrompt'), false);
        assert.ok(message.textPreview.length <= 200);
      }
      assert.equal((await request(`/api/tab-messages/${a}`, { authenticated: false })).status, 401);
      assert.equal((await answer(a, fullAnswer, 'answer-A')).body.deduplicated, true);
      assert.equal(sends.length, 4);
      assert.equal((await web.listActiveOrchestrationRuns()).length, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM agent_send_receipt_pins').get().n, 0);
      assert.equal(context.get('B').pendingCount, 0);

      await web.stop();
      assert.equal(fs.existsSync(path.join(process.env.NOTED_DISCOVERY_DIR, `web-server-${process.pid}.json`)), false);
      listening = deferred();
      web.start(startOptions);
      await listening.promise;
      const oldAuth = auth;
      auth = web.getInfo().token;
      assert.ok(auth === oldAuth, 'restart preserves only the isolated token');
      assert.equal((await request(`/api/tab-messages/${a}`)).body.reply.text, fullAnswer);
      assert.equal((await ask('A', text, 'question-A')).body.deduplicated, true);
      assert.equal(sends.length, 4, 'server restart and exact retries must not submit another provider prompt');
      const originalPrompt = db.prepare('SELECT frozenPrompt FROM tab_messages WHERE messageId = ?').get(a).frozenPrompt;
      const shifted = tabs.map((tab) => ({ ...tab, codexSessionId: randomUUID() }));
      assert.equal(manager.saveProjectTabs(project.id, shifted).success, true);
      for (const tab of shifted) statuses.set(tab.tabId, { ...statuses.get(tab.tabId), sessionId: tab.codexSessionId,
        sendTarget: { toolType: 'codex', sessionId: tab.codexSessionId } });
      const beforeRetryReads = runtimeReads;
      const drifted = await ask('A', text, 'question-A');
      assert.equal(drifted.status, 202);
      assert.equal(drifted.body.messageId, a);
      assert.equal(drifted.body.message.targetSessionId, firstSend.payload.expectedSessionId);
      db.prepare('DELETE FROM tabs WHERE project_id = ?').run(project.id);
      statuses.clear();
      const closed = await ask('A', text, 'question-A');
      const closedReply = await answer(a, fullAnswer, 'answer-A');
      assert.equal(closed.status, 202);
      assert.equal(closed.body.messageId, a);
      assert.equal(closedReply.status, 202);
      assert.equal(closedReply.body.messageId, replyA.body.messageId);
      assert.equal(runtimeReads, beforeRetryReads, 'exact retries never resolve a drifted or closed tab');
      const changedClosed = await ask('A', text + 'changed', 'question-A');
      assert.equal(changedClosed.status, 409);
      assert.equal(changedClosed.body.messageId, a);
      assert.equal(changedClosed.body.submitted, false);
      const forgedClosed = await request('/api/tab-messages', { method: 'POST', body: {
        ...actor('A'), sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'C' },
        targetTabId: 'B', text, requestId: 'question-A',
      } });
      assert.equal(forgedClosed.status, 403);
      assert.equal(Object.hasOwn(forgedClosed.body, 'messageId'), false);
      assert.equal((await ask('A', text, 'unknown-request')).status, 404);
      assert.equal(db.prepare('SELECT frozenPrompt FROM tab_messages WHERE messageId = ?').get(a).frozenPrompt, originalPrompt);
      assert.equal(db.prepare('SELECT count(*) n FROM tab_messages').get().n, 4);
      assert.equal(sends.length, 4);
      return { checks: ['private-root-and-loopback', 'actual-http-authentication', 'durable-before-held-provider-ack',
        'two-callers-serial-delivery', 'out-of-order-addressed-replies', 'compact-list-and-full-get',
        'frozen-context-and-trusted-offsets', 'exact-audit-and-pin-release', 'actual-server-restart',
        'idempotent-drift-and-closed-retries'], sends: sends.length };
    };
    return await Promise.race([scenario(), fatal.promise]);
  } finally {
    if (web) await web.stop();
    if (db?.open) db.close();
    Module._load = load;
  }
}

if (process.env.TAB_MESSAGES_HTTP_CHILD === '1') {
  acceptanceInChild(process.env.TAB_MESSAGES_HTTP_ROOT).then(
    (report) => process.send({ ok: true, report }, () => process.exit(0)),
    (error) => process.send({ ok: false, error: error.stack || String(error) }, () => process.exit(1)),
  );
} else {
  const test = require('node:test');
  test('actual web-server HTTP accepts durable addressed messages, authenticates, reconciles and survives restart in isolation',
    { timeout: 45_000 }, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-messages-http-'));
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [__filename], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          ELECTRON_RUN_AS_NODE: '1', TAB_MESSAGES_HTTP_CHILD: '1', TAB_MESSAGES_HTTP_ROOT: root,
          HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'temp'),
          CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
          NOTED_DISCOVERY_DIR: path.join(root, 'discovery'), NOTED_INBOX_CWD: path.join(root, 'workspace'),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      let result;
      child.on('message', (message) => { result = message; });
      const exited = once(child, 'exit');
      const abort = () => child.kill('SIGKILL');
      t.signal.addEventListener('abort', abort, { once: true });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        t.signal.removeEventListener('abort', abort);
        fs.rmSync(root, { recursive: true, force: true });
      });
      const [code] = await exited;
      assert.equal(code, 0, result?.error || stderr || 'isolated HTTP child failed');
      assert.equal(result?.ok, true);
      assert.equal(result.report.sends, 4);
      assert.equal(result.report.checks.length, 10);
    });
}

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { classifyAgentSendReceipt } = require('./orchestration-runs');

const repoDir = path.join(__dirname, '../..');
const historyAgentRuntimeSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/utils/historyAgentRuntimes.ts'),
  'utf8',
);
const webServerSource = fs.readFileSync(
  path.join(repoDir, 'src/main/web-server.js'),
  'utf8',
);

test('F4 real Codex runtime preserves its softened post-Enter state as audit-pending', () => {
  assert.match(
    historyAgentRuntimeSource,
    /if \(auditTimeoutAfterSubmit\)[\s\S]{0,700}status: 'audit-pending',[\s\S]{0,180}auditPending: true/,
    'the renderer may soften the History error, but it must keep the pending receipt for Project API, MCP, and Inbox',
  );
});

test('F4 renderer bridge timeout remains delivery-unknown instead of fabricated failure or success', () => {
  assert.deepEqual(classifyAgentSendReceipt({
    success: null,
    submitted: null,
    status: 'delivery-unknown',
    deliveryUnknown: true,
  }), {
    state: 'delivery-unknown',
    submitted: null,
    accepted: true,
  });
  assert.match(
    webServerSource,
    /error\?\.code !== 'bridge_timeout'[\s\S]{0,1200}status: 'delivery-unknown'[\s\S]{0,200}deliveryUnknown: true/,
    'the live renderer bridge timeout must produce an explicit unknown receipt',
  );
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message + (last instanceof Error ? ': ' + last.message : ''));
}

async function callMcpSendPrompt({ homeDir, tabId, prompt }) {
  const child = spawn(process.execPath, [
    path.join(repoDir, 'mcp/terminal-server.mjs'),
    '--project',
    repoDir,
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      HOME: homeDir,
      NOTED_TERMINAL_EXTERNAL: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const responsePromise = waitFor(() => {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === 41) return parsed;
      } catch {}
    }
    return null;
  }, 'Terminal MCP did not return send_prompt response; stderr=' + stderr, 5_000);
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: {
      name: 'send_prompt',
      arguments: { tabId, prompt, submit: true },
    },
  }) + '\n');
  try {
    return await responsePromise;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  }
}

test('F4/F5 complete server caller paths preserve physical post-Enter receipts', async (t) => {
  const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-phase2-f4-f5-'));
  const userDataDir = path.join(tempHome, 'user-data');
  await fs.promises.mkdir(userDataDir, { recursive: true });
  const port = await freePort();
  const oldHome = process.env.HOME;
  const oldPort = process.env.NOTED_WEB_PORT;
  process.env.HOME = tempHome;
  process.env.NOTED_WEB_PORT = String(port);

  const projects = [{
    id: 'phase2-project',
    name: 'Phase 2 project',
    path: '/tmp/noted-phase2-project',
    tabs: [
      {
        tabId: 'phase2-source-tab',
        name: 'Source',
        commandType: 'claude',
        claudeSessionId: 'phase2-source-session',
        cwd: '/tmp/noted-phase2-project',
      },
      {
        tabId: 'phase2-target-tab',
        name: 'Target',
        commandType: 'claude',
        claudeSessionId: 'phase2-target-session',
        cwd: '/tmp/noted-phase2-project',
      },
      {
        tabId: 'phase2-target-refusal-tab',
        name: 'Target refusal control',
        commandType: 'claude',
        claudeSessionId: 'phase2-target-session',
        cwd: '/tmp/noted-phase2-project',
      },
      {
        tabId: 'phase2-target-completion-tab',
        name: 'Target completion control',
        commandType: 'claude',
        claudeSessionId: 'phase2-target-session',
        cwd: '/tmp/noted-phase2-project',
      },
      {
        tabId: 'phase2-target-unknown-tab',
        name: 'Target unknown-receipt control',
        commandType: 'claude',
        claudeSessionId: 'phase2-target-session',
        cwd: '/tmp/noted-phase2-project',
      },
    ],
  }, {
    id: '__noted_inbox__',
    name: 'Inbox',
    path: '/tmp/noted-phase2-inbox',
    tabs: [],
  }];
  const projectManager = {
    db: {
      getAllProjects: () => projects,
      getProjectById: (id) => projects.find((project) => project.id === id) || null,
      getTabHistoryEntriesByTabId: () => [],
    },
  };

  const ipcMain = new EventEmitter();
  const controller = {
    calls: [],
    completionPrompt: '',
    completionSendCount: 0,
    inboxCounter: 0,
    sendResponder: async () => ({ success: true, submitted: true }),
    turnResult: {
      found: false,
      resultAvailable: false,
      resultComplete: false,
      error: 'not materialized',
    },
  };
  const readyStatus = (tabId) => ({
    tabId,
    toolType: tabId.startsWith('phase2-inbox') ? 'codex' : 'claude',
    commandType: tabId.startsWith('phase2-inbox') ? 'codex' : 'claude',
    status: 'active',
    sessionStatus: 'active',
    inputReady: true,
    busy: false,
    sessionId: tabId === 'phase2-source-tab'
      ? 'phase2-source-session'
      : tabId.startsWith('phase2-inbox')
        ? 'phase2-inbox-session'
        : 'phase2-target-session',
    lifecycleGeneration: 'phase2-life:' + tabId,
    writerConfirmed: tabId.startsWith('phase2-inbox'),
    writerUsableForMutation: tabId.startsWith('phase2-inbox'),
    cwd: '/tmp/noted-phase2-project',
  });
  const resolveBridge = async (action, payload) => {
    controller.calls.push({ action, payload });
    if (action === 'sendAgentPromptScenario') {
      if (String(payload?.source || '').startsWith('orchestration-completion:')) {
        controller.completionPrompt = payload.prompt;
        controller.completionSendCount += 1;
      }
      return controller.sendResponder(payload);
    }
    if (action === 'getClaudeTabStatus') return readyStatus(payload.tabId);
    if (action === 'ensureInboxProject') return { success: true };
    if (action === 'createAgentTab') {
      controller.inboxCounter += 1;
      return {
        success: true,
        tabId: payload.reservedTabId || `phase2-inbox-tab-${controller.inboxCounter}`,
        toolType: payload.toolType,
        commandType: payload.toolType,
        cwd: '/tmp/noted-phase2-project',
      };
    }
    if (action === 'setExternalRunMeta') return { success: true };
    return { success: true };
  };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send(channel, message) {
        if (channel !== 'web:bridge-request') return;
        Promise.resolve(resolveBridge(message.action, message.payload)).then(
          (data) => setImmediate(() => ipcMain.emit('web:bridge-reply', {}, {
            requestId: message.requestId,
            ok: true,
            data,
          })),
          (error) => setImmediate(() => ipcMain.emit('web:bridge-reply', {}, {
            requestId: message.requestId,
            ok: false,
            error: String(error?.message || error),
          })),
        );
      },
    },
  };
  const electronStub = {
    app: {
      isPackaged: false,
      getPath: () => userDataDir,
    },
    BrowserWindow: { getAllWindows: () => [fakeWindow] },
    ipcMain,
  };

  const originalLoad = Module._load;
  Module._load = function phase2Load(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === './project-manager' && parent?.filename?.endsWith('/src/main/web-server.js')) {
      return projectManager;
    }
    if (typeof request === 'string' && request.endsWith('/src/main/ipc/claude-data')) return {};
    if (typeof request === 'string' && request.endsWith('/src/main/ipc/codex-data')) return {};
    if (typeof request === 'string' && request.endsWith('/src/main/ipc/settings')) return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  let webServer;
  try {
    delete require.cache[require.resolve('./web-server')];
    webServer = require('./web-server');
    webServer.start({
      sdkSessions: new Map(),
      readAgentStartReadiness: async (tabId) => readyStatus(tabId),
      getAgentTurnResult: async () => controller.turnResult,
      getAgentExecutionContext: () => ({
        provider: 'claude',
        sessionId: 'phase2-source-session',
        turnId: 'phase2-source-turn',
        generation: 1,
        startedAt: Date.now(),
      }),
    });
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }

  t.after(async () => {
    try { webServer?.stop(); } catch {}
    Module._load = originalLoad;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPort === undefined) delete process.env.NOTED_WEB_PORT;
    else process.env.NOTED_WEB_PORT = oldPort;
    await fs.promises.rm(tempHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  const info = await waitFor(() => {
    const current = webServer.getInfo();
    return current.running && current.port === port && current.token ? current : null;
  }, 'mock Project API did not start');
  const api = async (pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + info.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: response.status, body: json };
  };
  await waitFor(async () => {
    try {
      const response = await api('/api/me');
      return response.status === 200;
    } catch {
      return false;
    }
  }, 'mock Project API was not reachable');

  await t.test('F4 strongest counterexample: submitted:false remains a retryable HTTP 409', async () => {
    controller.sendResponder = async () => ({
      success: false,
      submitted: false,
      accepted: false,
      error: 'refused_before_submit',
    });
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'pre-submit counterexample',
      source: 'phase2-test',
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.submitted, false);
  });

  await t.test('F4 exact audited delivery remains an HTTP 200 success', async () => {
    controller.sendResponder = async (payload) => ({
      success: true,
      submitted: true,
      accepted: true,
      handoffId: payload.handoffId,
      pasteAudit: {
        success: true,
        handoffId: payload.handoffId,
        entryUuid: 'phase2-exact-user-entry',
      },
    });
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'exactly audited Project API prompt',
      handoffId: 'phase2-project-api-exact-handoff',
      source: 'phase2-test',
    });
    assert.deepEqual({ status: response.status, submitted: response.body.submitted }, {
      status: 200,
      submitted: true,
    });
  });

  await t.test('F4 Project API keeps post-Enter delivery pending instead of inviting a duplicate retry', async () => {
    controller.sendResponder = async (payload) => ({
      success: false,
      submitted: true,
      accepted: true,
      handoffId: payload.handoffId || 'phase2-project-api-handoff',
      error: 'claude_user_message_audit_timeout',
    });
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'post-enter Project API prompt',
      handoffId: 'phase2-project-api-handoff',
      source: 'phase2-test',
    });
    assert.deepEqual({ status: response.status, submitted: response.body.submitted }, {
      status: 202,
      submitted: true,
    }, 'User-visible invariant violated: Project API must return accepted/pending after Enter, not a retryable 409 that can duplicate the prompt.');
  });

  await t.test('F4 Project API keeps a missing renderer receipt as delivery-unknown', async () => {
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: null,
      accepted: true,
      status: 'delivery-unknown',
      deliveryUnknown: true,
      handoffId: payload.handoffId,
    });
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'renderer reply unknown Project API prompt',
      handoffId: 'phase2-project-api-unknown-handoff',
      source: 'phase2-test',
    });
    assert.deepEqual({
      status: response.status,
      deliveryStatus: response.body.status,
      submitted: response.body.submitted,
      success: response.body.success,
    }, {
      status: 202,
      deliveryStatus: 'delivery-unknown',
      submitted: null,
      success: null,
    });
  });

  await t.test('F4 softened Codex History receipt is still HTTP 202, never a false 200', async () => {
    controller.sendResponder = async (payload) => ({
      success: true,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      userMessageAuditPending: true,
      handoffId: payload.handoffId || 'phase2-codex-soft-handoff',
    });
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'softened Codex post-enter prompt',
      handoffId: 'phase2-codex-soft-handoff',
      source: 'phase2-test',
    });
    assert.deepEqual({ status: response.status, submitted: response.body.submitted }, {
      status: 202,
      submitted: true,
    });
  });

  await t.test('F4 Terminal MCP preserves the same post-Enter pending receipt', async () => {
    controller.sendResponder = async (payload) => ({
      success: false,
      submitted: true,
      accepted: true,
      handoffId: payload.handoffId || 'phase2-mcp-handoff',
      error: 'codex_user_message_audit_timeout',
    });
    const response = await callMcpSendPrompt({
      homeDir: tempHome,
      tabId: 'phase2-target-tab',
      prompt: 'post-enter MCP prompt',
    });
    const text = response?.result?.content?.[0]?.text || '';
    assert.equal(response?.result?.isError === true, false,
      'User-visible invariant violated: Terminal MCP must not report an error that invites retry after Enter already crossed.');
    assert.match(text, /pending|unverified|confirmation/i,
      'Terminal MCP must tell the caller that exact delivery confirmation is pending.');
  });

  await t.test('F4 Inbox keeps a post-Enter run alive until exact audit', async () => {
    controller.sendResponder = async (payload) => ({
      success: false,
      submitted: true,
      accepted: true,
      handoffId: payload.handoffId || 'phase2-inbox-handoff',
      error: 'codex_user_message_audit_timeout',
    });
    const response = await api('/api/inbox/runs', {
      provider: 'codex',
      prompt: 'post-enter Inbox prompt',
      runId: 'phase2-inbox-run',
      source: 'phase2-test',
      autoStopMs: 0,
    });
    assert.deepEqual({ status: response.status, submitted: response.body.submitted }, {
      status: 202,
      submitted: true,
    }, 'User-visible invariant violated: Inbox must retain a post-Enter run as audit-pending instead of marking send_failed and inviting a duplicate.');

    const exactHash = promptAuditFingerprint('post-enter Inbox prompt');
    const wrongProvider = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: response.body.tabId,
      toolType: 'claude',
      handoffId: 'external-run:phase2-inbox-run',
      expectedHash: exactHash,
      actualHash: exactHash,
      sessionId: 'phase2-inbox-session',
      entryUuid: 'phase2-inbox-wrong-provider',
    });
    const wrongSession = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: response.body.tabId,
      toolType: 'codex',
      handoffId: 'external-run:phase2-inbox-run',
      expectedHash: exactHash,
      actualHash: exactHash,
      sessionId: 'phase2-foreign-session',
      entryUuid: 'phase2-inbox-wrong-session',
    });
    const exact = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: response.body.tabId,
      toolType: 'codex',
      handoffId: 'external-run:phase2-inbox-run',
      expectedHash: exactHash,
      actualHash: exactHash,
      sessionId: 'phase2-inbox-session',
      entryUuid: 'phase2-inbox-exact-entry',
    });
    assert.deepEqual({
      wrongProvider: wrongProvider.confirmed,
      wrongSession: wrongSession.confirmed,
      exact: exact.confirmed,
    }, {
      wrongProvider: false,
      wrongSession: false,
      exact: true,
    }, 'Inbox late audit must belong to the exact provider and session of the same external run.');
  });

  await t.test('F4 Inbox preserves a missing renderer receipt without blind retry authority', async () => {
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: null,
      accepted: true,
      status: 'delivery-unknown',
      deliveryUnknown: true,
      handoffId: payload.handoffId,
    });
    const response = await api('/api/inbox/runs', {
      provider: 'codex',
      prompt: 'renderer reply unknown Inbox prompt',
      runId: 'phase2-inbox-unknown-run',
      source: 'phase2-test',
      autoStopMs: 0,
    });
    assert.deepEqual({
      status: response.status,
      deliveryStatus: response.body.status,
      submitted: response.body.submitted,
    }, {
      status: 202,
      deliveryStatus: 'delivery-unknown',
      submitted: null,
    });
  });

  await t.test('F5 target delivery-unknown is completed only by its late exact audit', async () => {
    const runId = 'phase2-f5-target-unknown-run';
    const prompt = 'target prompt with missing renderer receipt';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: null,
      accepted: true,
      status: 'delivery-unknown',
      deliveryUnknown: true,
      handoffId: payload.handoffId,
    });
    const created = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-unknown-tab',
      prompt,
      queue: false,
      notifySource: false,
    });
    const beforeAudit = await api('/api/orchestrations/' + runId);
    const hash = promptAuditFingerprint(prompt);
    const audit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-target-unknown-tab',
      toolType: 'claude',
      handoffId: 'orchestration:' + runId,
      source: 'orchestration:phase2-source-tab',
      auditTimestamp: new Date().toISOString(),
      actualHash: hash,
      expectedHash: hash,
      sessionId: 'phase2-target-session',
      entryUuid: 'phase2-target-unknown-exact-entry',
      executionContext: {
        provider: 'claude',
        sessionId: 'phase2-target-session',
        turnId: 'phase2-target-unknown-turn',
        generation: 3,
        startedAt: Date.now(),
      },
    });
    const afterAudit = await api('/api/orchestrations/' + runId);
    assert.deepEqual({
      createStatus: created.status,
      createReceipt: created.body.status,
      before: beforeAudit.body.run?.status,
      exactAudit: audit.confirmed,
      after: afterAudit.body.run?.status,
    }, {
      createStatus: 202,
      createReceipt: 'delivery-unknown',
      before: 'sending',
      exactAudit: true,
      after: 'running',
    });
  });

  await t.test('F5 target handoff survives post-Enter transport failure and late exact audit', async () => {
    const runId = 'phase2-f5-target-run';
    const prompt = 'target prompt whose Enter already crossed';
    controller.turnResult = {
      found: false,
      resultAvailable: false,
      resultComplete: false,
      error: 'not materialized',
    };
    controller.sendResponder = async (payload) => ({
      success: false,
      submitted: true,
      accepted: true,
      handoffId: payload.handoffId,
      error: 'claude_user_message_audit_timeout',
    });
    const created = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-tab',
      prompt,
      queue: false,
      notifySource: false,
    });
    const auditHash = promptAuditFingerprint(prompt);
    const audit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-target-tab',
      toolType: 'claude',
      handoffId: 'orchestration:' + runId,
      source: 'orchestration:phase2-source-tab',
      auditTimestamp: new Date().toISOString(),
      actualHash: auditHash,
      expectedHash: auditHash,
      actualLen: prompt.length,
      expectedLen: prompt.length,
      sessionId: 'phase2-target-session',
      entryUuid: 'phase2-target-user-entry',
      executionContext: {
        provider: 'claude',
        sessionId: 'phase2-target-session',
        turnId: 'phase2-target-turn',
        generation: 1,
        startedAt: Date.now(),
      },
    });
    const current = await api('/api/orchestrations/' + runId);
    assert.deepEqual({
      createStatus: created.status,
      auditConfirmed: audit.confirmed,
      durableStatus: current.body.run?.status,
      deliveryAccepted: Boolean(current.body.run?.deliveryAcceptedAt),
    }, {
      createStatus: 202,
      auditConfirmed: true,
      durableStatus: 'running',
      deliveryAccepted: true,
    }, 'User-visible invariant violated: an orchestration target whose Enter crossed must retain its handoff and become running when the late exact audit arrives.');
  });

  await t.test('F5 strongest target counterexample: proven pre-submit refusal remains an immediate failure', async () => {
    const runId = 'phase2-f5-pre-submit-run';
    controller.sendResponder = async () => ({
      success: false,
      submitted: false,
      accepted: false,
      error: 'refused_before_submit',
    });
    const created = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-refusal-tab',
      prompt: 'definitely not submitted',
      queue: false,
      notifySource: false,
    });
    const current = await api('/api/orchestrations/' + runId);
    assert.equal(created.status, 409);
    assert.equal(current.body.run?.status, 'failed');
  });

  await t.test('F5 completion handoff remains reconcilable after post-Enter timeout', async () => {
    const runId = 'phase2-f5-completion-run';
    const prompt = 'complete this orchestration once';
    controller.turnResult = {
      found: false,
      resultAvailable: false,
      resultComplete: false,
      error: 'not materialized',
    };
    controller.completionPrompt = '';
    controller.completionSendCount = 0;
    controller.sendResponder = async (payload) => {
      if (String(payload?.source || '').startsWith('orchestration-completion:')) {
        return {
          success: false,
          submitted: true,
          accepted: true,
          handoffId: payload.handoffId,
          error: 'claude_user_message_audit_timeout',
        };
      }
      return {
        success: true,
        submitted: true,
        accepted: true,
        handoffId: payload.handoffId,
      };
    };
    const created = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-completion-tab',
      prompt,
      queue: false,
      notifySource: true,
    });
    assert.equal(created.status, 202, 'completion harness must first deliver the target prompt');

    const targetHash = promptAuditFingerprint(prompt);
    const targetAudit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-target-completion-tab',
      toolType: 'claude',
      handoffId: 'orchestration:' + runId,
      source: 'orchestration:phase2-source-tab',
      auditTimestamp: new Date().toISOString(),
      actualHash: targetHash,
      expectedHash: targetHash,
      sessionId: 'phase2-target-session',
      entryUuid: 'phase2-completion-target-user',
      executionContext: {
        provider: 'claude',
        sessionId: 'phase2-target-session',
        turnId: 'phase2-completion-turn',
        generation: 2,
        startedAt: Date.now(),
      },
    });
    assert.equal(targetAudit.confirmed, true, 'completion harness must prove its target prompt');

    const executionContext = {
      provider: 'claude',
      sessionId: 'phase2-target-session',
      turnId: 'phase2-completion-turn',
      generation: 2,
      startedAt: Date.now(),
    };
    webServer.webBroadcast('phase2-target-completion-tab', {
      type: 'busy',
      busy: true,
      sessionId: 'phase2-target-session',
      executionContext,
    });
    await waitFor(async () => {
      const state = await api('/api/orchestrations/' + runId);
      return state.body.run?.status === 'running' ? state : null;
    }, 'completion harness target never became running');

    controller.turnResult = {
      found: true,
      resultAvailable: true,
      complete: true,
      sessionId: 'phase2-target-session',
      turnIndex: 1,
      userUuid: 'phase2-completion-target-user',
      assistantText: 'completed exactly once',
      assistantChars: 22,
      sourceSnapshot: { size: 100, mtimeMs: Date.now() },
    };
    webServer.webBroadcast('phase2-target-completion-tab', {
      type: 'done',
      busy: false,
      reason: 'task_complete',
      sessionId: 'phase2-target-session',
      executionContext,
    });
    const pendingNotification = await waitFor(async () => {
      const state = await api('/api/orchestrations/' + runId);
      return state.body.run?.notificationStatus === 'audit-pending' ? state : null;
    }, 'completion harness did not retain the post-Enter handoff as audit-pending');
    assert.equal(pendingNotification.body.run.status, 'completed');
    assert.ok(controller.completionPrompt, 'completion prompt must have crossed the real notification caller');
    assert.equal(controller.completionSendCount, 1);

    const retryWhilePending = await api('/api/orchestrations/' + runId + '/action', {
      action: 'retry',
      tabId: 'phase2-source-tab',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retryWhilePending.body?.ok === true, false,
      'Retry must be refused while the exact completion audit is still pending.');
    assert.equal(controller.completionSendCount, 1,
      'Retry during audit-pending must not perform a second physical notification send.');

    const completionHash = promptAuditFingerprint(controller.completionPrompt);
    const lateAudit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-source-tab',
      toolType: 'claude',
      handoffId: 'orchestration-complete:' + runId,
      source: 'orchestration-completion:' + runId,
      auditTimestamp: new Date().toISOString(),
      actualHash: completionHash,
      expectedHash: completionHash,
      sessionId: 'phase2-source-session',
      entryUuid: 'phase2-completion-source-user',
    });
    const afterAudit = await api('/api/orchestrations/' + runId);
    const retry = await api('/api/orchestrations/' + runId + '/action', {
      action: 'retry',
      tabId: 'phase2-source-tab',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual({
      lateAuditConfirmed: lateAudit.confirmed === true,
      notificationStatus: afterAudit.body.run?.notificationStatus,
      retryAccepted: retry.body?.ok === true,
      physicalNotificationSends: controller.completionSendCount,
    }, {
      lateAuditConfirmed: true,
      notificationStatus: 'sent',
      retryAccepted: false,
      physicalNotificationSends: 1,
    }, 'User-visible invariant violated: a completion message whose Enter crossed must keep its handoff for late audit and must never expose a duplicate Retry send.');
  });
});

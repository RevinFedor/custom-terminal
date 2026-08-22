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
const Database = require('better-sqlite3');

const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');

const repoDir = path.join(__dirname, '../..');
const historyAgentRuntimeSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/utils/historyAgentRuntimes.ts'),
  'utf8',
);
const historyPanelSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const historyPromptHandoffSource = fs.readFileSync(
  path.join(repoDir, 'src/renderer/utils/historyPromptHandoffs.ts'),
  'utf8',
);
const webServerSource = fs.readFileSync(
  path.join(repoDir, 'src/main/web-server.js'),
  'utf8',
);

function exactProviderNotAccepted(overrides = {}) {
  return {
    success: false,
    accepted: false,
    submitted: true,
    pasteWritten: true,
    enterWritten: true,
    semanticStatus: 'not-submitted',
    providerAccepted: false,
    providerTurnCreated: false,
    composerDraftState: 'exact-original',
    exactDraftRemained: true,
    draftPreserved: true,
    lateReconciliationPending: false,
    code: 'claude_prompt_not_accepted_exact_draft_remained',
    error: 'claude_prompt_not_accepted_exact_draft_remained',
    ...overrides,
  };
}

test('F4 real Codex runtime preserves its softened post-Enter state as audit-pending', () => {
  assert.match(
    historyAgentRuntimeSource,
    /if \(auditTimeoutAfterSubmit\)[\s\S]{0,700}status: 'audit-pending',[\s\S]{0,180}auditPending: true/,
    'the renderer may soften the History error, but it must keep the pending receipt for Project API, MCP, and Inbox',
  );
  const pendingStart = historyPanelSource.indexOf(
    'const unconfirmedStatus = localSlashReceipt.handled',
  );
  assert.ok(pendingStart >= 0);
  const pendingSendBoundary = historyPanelSource.slice(pendingStart, pendingStart + 3_500);
  assert.match(
    pendingSendBoundary,
    /historyPromptHandoffUnconfirmedStatusFromSendResult\(result\)/,
    'an exact bound send keeps using the shared unresolved-receipt classifier',
  );
  // An unresolved receipt still keeps the prompt — that is the invariant here.
  // The condition gained one guard since this test was written: a prompt the
  // provider handed BACK to the terminal composer is cancelled, not
  // "delivered but unconfirmed", so it must not raise the unconfirmed notice.
  // Assert the classifier's verdict is what drives the flag, and that the
  // provider-queue return is excluded — not the exact former spelling.
  assert.match(
    pendingSendBoundary,
    /sendDeliveryUnconfirmed = localSlashReceipt\.handled[\s\S]{0,320}unconfirmedStatus !== null/,
    'History must preserve the prompt while rendering a post-Enter soft timeout as unresolved rather than final sent',
  );
  assert.match(
    pendingSendBoundary,
    /: !providerQueueReturned && \(/,
    'a prompt returned to the terminal composer is cancelled, not an unconfirmed delivery',
  );
  assert.match(
    historyPromptHandoffSource,
    /result\.auditPending === true[\s\S]{0,500}return 'audit-pending'/,
    'the shared renderer classifier must preserve audit-pending as a distinct UI receipt',
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
    /BrowserWindow\.send crossed the main -> renderer boundary[\s\S]{0,1600}status: 'delivery-unknown'[\s\S]{0,200}deliveryUnknown: true/,
    'the live renderer bridge timeout must produce an explicit unknown receipt',
  );
  assert.deepEqual(classifyAgentSendReceipt({ success: true }), {
    state: 'delivery-unknown',
    submitted: null,
    accepted: true,
  }, 'an incomplete success-shaped adapter response must not fabricate physical Enter proof');
  assert.deepEqual(classifyAgentSendReceipt({
    success: true,
    receiptState: 'delivery-unknown',
  }), {
    state: 'delivery-unknown',
    submitted: null,
    accepted: true,
  }, 'the exact registry state must win over a legacy success-shaped field');
});

test('F4 exact post-Enter provider refusal is terminal while ambiguous refusal stays pending', () => {
  assert.deepEqual(classifyAgentSendReceipt(exactProviderNotAccepted()), {
    state: 'provider-not-accepted',
    submitted: true,
    accepted: false,
  });
  assert.deepEqual(
    classifyAgentSendReceipt(exactProviderNotAccepted({ exactDraftRemained: false })),
    {
      state: 'audit-pending',
      submitted: true,
      accepted: true,
    },
  );
  assert.deepEqual(classifyAgentSendReceipt({
    success: false,
    submitted: true,
    status: 'provider-not-accepted',
    receiptState: 'provider-not-accepted',
  }), {
    state: 'audit-pending',
    submitted: true,
    accepted: true,
  }, 'a renderer cannot manufacture terminal proof by returning only the state label');
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

async function callMcpSendPrompt({ homeDir, tabId, prompt, handoffId }) {
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
      arguments: { tabId, prompt, submit: true, ...(handoffId ? { handoffId } : {}) },
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
  const receiptDb = new Database(path.join(userDataDir, 'agent-send-receipts.sqlite'));
  const receiptStore = createAgentSendReceiptStore(receiptDb);
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
      {
        tabId: 'phase2-model-restart-target',
        name: 'Model restart target',
        commandType: 'claude',
        claudeSessionId: 'phase2-model-restart-session',
        cwd: '/tmp/noted-phase2-project',
      },
      {
        tabId: 'phase2-codex-target-tab',
        name: 'Codex target',
        commandType: 'codex',
        codexSessionId: 'phase2-codex-session',
        cwd: '/tmp/noted-phase2-project',
      },
    ],
  }, {
    id: '__noted_inbox__',
    name: 'Inbox',
    path: '/tmp/noted-phase2-inbox',
    tabs: [],
  }];
  const archivedClosedTarget = {
    id: 902,
    project_id: 'phase2-project',
    tab_id: 'phase2-closed-target',
    name: 'Closed target',
    cwd: '/tmp/noted-phase2-project',
    command_type: 'claude',
    claude_session_id: 'phase2-closed-session',
  };
  const archivedModelTarget = {
    id: 903,
    project_id: 'phase2-project',
    tab_id: 'phase2-closed-model-target',
    name: 'Closed model target',
    cwd: '/tmp/noted-phase2-project',
    command_type: 'claude',
    claude_session_id: 'phase2-closed-model-session',
  };
  const appState = {
    defaultClaudeModel: 'claude-opus-5[1m]',
    claudeCodeSettings: {
      models: [
        {
          key: 'opus-200k',
          id: 'claude-opus-5',
          label: 'Opus 5 (200K context)',
        },
        {
          key: 'opus',
          id: 'claude-opus-5[1m]',
          label: 'Opus 5 (1M context)',
        },
      ],
    },
  };
  const projectManager = {
    db: {
      getAllProjects: () => projects,
      getProjectById: (id) => projects.find((project) => project.id === id) || null,
      getAppState: (key) => appState[key] ?? null,
      getTabHistoryEntriesByTabId: (tabId) => {
        if (tabId === archivedClosedTarget.tab_id) return [archivedClosedTarget];
        if (tabId === archivedModelTarget.tab_id) return [archivedModelTarget];
        return [];
      },
    },
  };

  const ipcMain = new EventEmitter();
  const controller = {
    calls: [],
    completionPrompt: '',
    completionSendCount: 0,
    inboxCounter: 0,
    createAgentTabCalls: 0,
    failNextCreateAgentTab: false,
    closedRestoreCount: 0,
    bridgeAvailable: true,
    busyTabs: new Set(),
    sendResponder: async () => ({ success: true, submitted: true }),
    turnResult: {
      found: false,
      resultAvailable: false,
      resultComplete: false,
      error: 'not materialized',
    },
  };
  const isInboxTab = (tabId) => tabId.startsWith('phase2-inbox')
    || tabId.startsWith('__noted_inbox__-tab-external-');
  const isCodexTab = (tabId) => isInboxTab(tabId) || tabId === 'phase2-codex-target-tab';
  const readyStatus = (tabId) => ({
    tabId,
    toolType: isCodexTab(tabId) ? 'codex' : 'claude',
    commandType: isCodexTab(tabId) ? 'codex' : 'claude',
    status: controller.busyTabs.has(tabId) ? 'busy' : 'active',
    sessionStatus: controller.busyTabs.has(tabId) ? 'busy' : 'active',
    inputReady: !controller.busyTabs.has(tabId),
    busy: controller.busyTabs.has(tabId),
    sessionId: tabId === 'phase2-source-tab'
      ? 'phase2-source-session'
      : isInboxTab(tabId)
        ? 'phase2-inbox-session'
        : tabId === 'phase2-codex-target-tab'
          ? 'phase2-codex-session'
        : 'phase2-target-session',
    lifecycleGeneration: 'phase2-life:' + tabId,
    writerConfirmed: isInboxTab(tabId),
    writerUsableForMutation: isInboxTab(tabId),
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
    if (action === 'restoreClosedAgentTab') {
      controller.closedRestoreCount += 1;
      const project = projects.find((item) => item.id === payload.projectId);
      if (!project) throw new Error('restore project missing');
      if (!project.tabs.some((tab) => tab.tabId === payload.expectedTabId)) {
        project.tabs.push({
          tabId: payload.expectedTabId,
          name: archivedClosedTarget.name,
          commandType: 'claude',
          claudeSessionId: archivedClosedTarget.claude_session_id,
          cwd: archivedClosedTarget.cwd,
        });
      }
      return { success: true, tabId: payload.expectedTabId };
    }
    if (action === 'createAgentTab') {
      controller.createAgentTabCalls += 1;
      if (controller.failNextCreateAgentTab) {
        controller.failNextCreateAgentTab = false;
        throw new Error('synthetic create failure before tab exists');
      }
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
    BrowserWindow: { getAllWindows: () => (controller.bridgeAvailable ? [fakeWindow] : []) },
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
  const startOptions = {
    sdkSessions: new Map(),
    agentSendReceiptStore: receiptStore,
    computeActiveLoaders: () => ({ idle: true, count: 0, loaders: [], ts: Date.now() }),
    readAgentStartReadiness: async (tabId) => readyStatus(tabId),
    getAgentTurnResult: async () => controller.turnResult,
    getAgentExecutionContext: () => ({
      provider: 'claude',
      sessionId: 'phase2-source-session',
      turnId: 'phase2-source-turn',
      generation: 1,
      startedAt: Date.now(),
    }),
    agentSendBridgeTimeoutMs: 30,
  };
  try {
    delete require.cache[require.resolve('./web-server')];
    webServer = require('./web-server');
    webServer.start(startOptions);
  } catch (error) {
    Module._load = originalLoad;
    throw error;
  }

  t.after(async () => {
    try { webServer?.stop(); } catch {}
    try { receiptDb.close(); } catch {}
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
  const scenarioSendCount = (handoffId) => controller.calls.filter((call) => (
    call.action === 'sendAgentPromptScenario'
      && (!handoffId || call.payload?.handoffId === handoffId)
  )).length;
  const scenarioPayload = (handoffId) => controller.calls.findLast((call) => (
    call.action === 'sendAgentPromptScenario' && call.payload?.handoffId === handoffId
  ))?.payload || null;

  await t.test('provider-model mismatch is rejected before a durable run or empty target exists', async () => {
    const runId = 'phase2-provider-model-new-target';
    const createsBefore = controller.createAgentTabCalls;
    const sendsBefore = scenarioSendCount();
    const response = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetProjectId: 'phase2-project',
      toolType: 'claude',
      model: 'gpt-5.6-luna',
      prompt: 'must never create or submit',
      notifySource: false,
    });
    const absentRun = await api('/api/orchestrations/' + runId);

    assert.deepEqual({
      status: response.status,
      code: response.body.code,
      creates: controller.createAgentTabCalls - createsBefore,
      sends: scenarioSendCount() - sendsBefore,
      runStatus: absentRun.status,
    }, {
      status: 400,
      code: 'agent_model_provider_mismatch',
      creates: 0,
      sends: 0,
      runStatus: 404,
    });
  });

  await t.test('Claude Settings alias resolves to the exact 1M id before target creation and send', async () => {
    const runId = 'phase2-claude-model-alias-new-target';
    controller.sendResponder = async () => ({
      success: true,
      submitted: true,
      accepted: true,
    });
    const response = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetProjectId: 'phase2-project',
      toolType: 'claude',
      model: 'opus',
      prompt: 'exact 1M model selection',
      notifySource: false,
    });
    const created = controller.calls.findLast((call) => (
      call.action === 'createAgentTab' && call.payload?.reservedTabId === response.body.run?.targetTabId
    ));
    const sent = scenarioPayload('orchestration:' + runId);
    assert.deepEqual({
      status: response.status,
      launchModel: created?.payload?.codexModel,
      sendModel: sent?.model,
    }, {
      status: 202,
      launchModel: 'claude-opus-5[1m]',
      sendModel: 'claude-opus-5[1m]',
    });
  });

  await t.test('ambiguous Claude display name fails before reserving or creating a target', async () => {
    const runId = 'phase2-claude-model-ambiguous';
    const createsBefore = controller.createAgentTabCalls;
    const response = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetProjectId: 'phase2-project',
      toolType: 'claude',
      model: 'Opus 5',
      prompt: 'must not choose a context variant',
      notifySource: false,
    });
    const absentRun = await api('/api/orchestrations/' + runId);
    assert.deepEqual({
      status: response.status,
      code: response.body.code,
      creates: controller.createAgentTabCalls - createsBefore,
      runStatus: absentRun.status,
    }, {
      status: 400,
      code: 'agent_model_alias_ambiguous',
      creates: 0,
      runStatus: 404,
    });
  });

  await t.test('closed target restore keeps the exact Settings model id', async () => {
    const runId = 'phase2-claude-model-closed-restore';
    const restoresBefore = controller.closedRestoreCount;
    try {
      controller.sendResponder = async () => ({
        success: true,
        submitted: true,
        accepted: true,
      });
      const response = await api('/api/orchestrations', {
        runId,
        sourceTabId: 'phase2-source-tab',
        targetTabId: archivedModelTarget.tab_id,
        model: 'opus',
        prompt: 'restore with exact 1M model',
        notifySource: false,
      });
      assert.deepEqual({
        status: response.status,
        restores: controller.closedRestoreCount - restoresBefore,
        sendModel: scenarioPayload('orchestration:' + runId)?.model,
      }, {
        status: 202,
        restores: 1,
        sendModel: 'claude-opus-5[1m]',
      });
    } finally {
      controller.closedRestoreCount = restoresBefore;
    }
  });

  await t.test('direct tab creation and Inbox reject a foreign model before creating a target', async () => {
    const createsBefore = controller.createAgentTabCalls;
    const directCreate = await api('/api/projects/phase2-project/agent-tabs', {
      toolType: 'claude',
      model: 'gpt-5.6-luna',
      name: 'must not exist',
    });
    const inbox = await api('/api/inbox/runs', {
      provider: 'codex',
      model: 'claude-opus-5[1m]',
      prompt: 'must not create an Inbox target',
      runId: 'phase2-provider-model-inbox',
    });
    assert.deepEqual({
      directStatus: directCreate.status,
      directCode: directCreate.body.code,
      inboxStatus: inbox.status,
      inboxCode: inbox.body.code,
      creates: controller.createAgentTabCalls - createsBefore,
    }, {
      directStatus: 400,
      directCode: 'agent_model_provider_mismatch',
      inboxStatus: 400,
      inboxCode: 'agent_model_provider_mismatch',
      creates: 0,
    });
  });

  await t.test('existing target provider cannot be contradicted by orchestration metadata', async () => {
    const runId = 'phase2-provider-target-conflict';
    const sendsBefore = scenarioSendCount();
    const response = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-tab',
      provider: 'codex',
      prompt: 'must not submit to a Claude target',
      notifySource: false,
    });
    const absentRun = await api('/api/orchestrations/' + runId);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'agent_target_provider_mismatch');
    assert.equal(absentRun.status, 404);
    assert.equal(scenarioSendCount(), sendsBefore);
  });

  await t.test('existing target send rejects a known foreign model before restore or scenario dispatch', async () => {
    const sendsBefore = scenarioSendCount();
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'must not submit',
      model: 'gpt-5.6-luna',
      handoffId: 'phase2-provider-model-existing-target',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'agent_model_provider_mismatch');
    assert.equal(scenarioSendCount(), sendsBefore);
  });

  await t.test('known matching Codex model reaches an existing Codex target', async () => {
    const handoffId = 'phase2-provider-model-codex-valid';
    controller.sendResponder = async () => ({
      success: true,
      submitted: true,
      accepted: true,
    });
    const response = await api('/api/terminal-tabs/phase2-codex-target-tab/send', {
      prompt: 'valid Codex request',
      model: 'gpt-5.6-luna',
      handoffId,
    });
    assert.equal(response.status, 200);
    assert.equal(scenarioSendCount(handoffId), 1);
    assert.equal(scenarioPayload(handoffId)?.model, 'gpt-5.6-luna');
  });

  await t.test('semantic pre-submit failure remains exact before, on, and after the bridge deadline', async () => {
    const cases = [
      { suffix: 'before', delayMs: 0, initialStatus: 409 },
      { suffix: 'boundary', delayMs: 30, initialStatus: null },
      { suffix: 'after', delayMs: 60, initialStatus: 202 },
    ];
    for (const item of cases) {
      const runId = `phase2-late-semantic-${item.suffix}`;
      const exactError = `exact-pre-submit-${item.suffix}`;
      controller.sendResponder = async () => {
        if (item.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, item.delayMs));
        }
        return {
          success: false,
          submitted: false,
          accepted: false,
          code: 'agent_model_apply_failed',
          error: exactError,
        };
      };
      const response = await api('/api/orchestrations', {
        runId,
        sourceTabId: 'phase2-source-tab',
        targetTabId: 'phase2-target-refusal-tab',
        prompt: `deadline matrix ${item.suffix}`,
        queue: false,
        notifySource: false,
      });
      if (item.initialStatus === null) {
        assert.ok(response.status === 202 || response.status === 409,
          'an exact deadline tie may be observed by either event-loop callback');
      } else {
        assert.equal(response.status, item.initialStatus);
      }
      const failed = await waitFor(async () => {
        const state = await api('/api/orchestrations/' + runId);
        return state.body.run?.status === 'failed' ? state : null;
      }, `late semantic receipt did not settle ${item.suffix}`);
      assert.equal(failed.body.run.error, exactError);
      assert.equal(Boolean(failed.body.run.deliveryAcceptedAt), false);
      assert.equal(scenarioSendCount('orchestration:' + runId), 1);
    }
  });

  await t.test('exact provider-not-accepted terminalizes orchestration without recovery grace', async () => {
    const runId = 'phase2-provider-not-accepted-orchestration';
    const handoffId = 'orchestration:' + runId;
    controller.sendResponder = async () => exactProviderNotAccepted({ handoffId });
    const response = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-tab',
      prompt: 'orchestration exact draft remained',
      queue: false,
      notifySource: false,
    });
    const state = await api('/api/orchestrations/' + runId);
    assert.deepEqual({
      httpStatus: response.status,
      submitted: response.body.submitted,
      receiptState: response.body.receiptState,
      runStatus: state.body.run?.status,
      recoveryDeadlineAt: state.body.run?.recoveryDeadlineAt,
      sends: scenarioSendCount(handoffId),
    }, {
      httpStatus: 409,
      submitted: true,
      receiptState: 'provider-not-accepted',
      runStatus: 'failed',
      recoveryDeadlineAt: null,
      sends: 1,
    });
  });

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

  await t.test('F4 a missing archived target preserves its exact HTTP 404 before any send', async () => {
    const before = scenarioSendCount();
    const response = await api('/api/terminal-tabs/phase2-missing-target/send', {
      prompt: 'missing target must fail before submit',
      handoffId: 'phase2-missing-target-handoff',
      source: 'phase2-test',
    });
    assert.deepEqual({
      status: response.status,
      submitted: response.body.submitted,
      code: response.body.code,
      sends: scenarioSendCount() - before,
    }, {
      status: 404,
      submitted: false,
      code: 'target_tab_not_restorable',
      sends: 0,
    });
  });

  await t.test('F4 bridge unavailable is proven pre-dispatch and remains retryable HTTP 503', async () => {
    controller.bridgeAvailable = false;
    try {
      const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
        prompt: 'bridge unavailable before renderer dispatch',
        handoffId: 'phase2-bridge-unavailable-handoff',
        source: 'phase2-test',
      });
      assert.deepEqual({
        status: response.status,
        submitted: response.body.submitted,
        code: response.body.code,
      }, {
        status: 503,
        submitted: false,
        code: 'bridge_unavailable',
      });
    } finally {
      controller.bridgeAvailable = true;
    }
  });

  await t.test('F4 incomplete success-shaped renderer result remains HTTP 202 unknown', async () => {
    controller.sendResponder = async () => ({ success: true });
    const response = await api('/api/terminal-tabs/phase2-target-tab/send', {
      prompt: 'incomplete renderer receipt must not become sent',
      handoffId: 'phase2-incomplete-success-handoff',
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

  await t.test('exact Claude provider refusal returns an actionable 409 without replaying Enter', async () => {
    const handoffId = 'phase2-provider-not-accepted-project';
    controller.sendResponder = async () => exactProviderNotAccepted({ handoffId });
    const request = {
      prompt: 'exact original draft remains after Enter',
      handoffId,
      source: 'phase2-test',
    };
    const first = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    const replay = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.deepEqual({
      firstStatus: first.status,
      replayStatus: replay.status,
      submitted: first.body.submitted,
      receiptState: first.body.receiptState,
      providerAccepted: first.body.providerAccepted,
      draftPreserved: first.body.draftPreserved,
      sends: scenarioSendCount(handoffId),
    }, {
      firstStatus: 409,
      replayStatus: 409,
      submitted: true,
      receiptState: 'provider-not-accepted',
      providerAccepted: false,
      draftPreserved: true,
      sends: 1,
    });
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
    assert.deepEqual({
      status: response.status,
      submitted: response.body.submitted,
      success: response.body.success,
    }, {
      status: 202,
      submitted: true,
      success: null,
    });
  });

  await t.test('G09 same Project API handoff replays pending receipt and exact late audit promotes it', async () => {
    const handoffId = 'g09-project-idempotent-handoff';
    const prompt = 'G09 exact one physical Project API prompt';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = {
      prompt,
      handoffId,
      source: 'phase2-test',
      queue: false,
    };
    const first = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    const durablePayload = scenarioPayload(handoffId);
    assert.ok(durablePayload?.sendOperationKey);
    assert.ok(durablePayload?.sendAttemptId);
    const replay = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    const changed = await api('/api/terminal-tabs/phase2-target-tab/send', {
      ...request,
      prompt: prompt + ' changed',
    });
    assert.deepEqual({
      first: first.status,
      replay: replay.status,
      replayed: replay.body.replayed,
      changed: changed.status,
      changedCode: changed.body.code,
      sends: scenarioSendCount(handoffId),
    }, {
      first: 202,
      replay: 202,
      replayed: true,
      changed: 409,
      changedCode: 'agent_send_handoff_conflict',
      sends: 1,
    });

    const hash = promptAuditFingerprint(prompt);
    const wrongAudit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-target-tab',
      toolType: 'claude',
      handoffId,
      expectedHash: hash,
      actualHash: promptAuditFingerprint(prompt + ' wrong'),
      sessionId: 'phase2-target-session',
      entryUuid: 'g09-wrong-entry',
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
    });
    assert.equal(wrongAudit.confirmed, false);
    assert.equal((await api('/api/terminal-tabs/phase2-target-tab/send', request)).status, 202);

    const exactAudit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-target-tab',
      toolType: 'claude',
      handoffId,
      expectedHash: hash,
      actualHash: hash,
      sessionId: 'phase2-target-session',
      entryUuid: 'g09-exact-entry',
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
    });
    const confirmedReplay = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.deepEqual({
      auditConfirmed: exactAudit.confirmed,
      status: confirmedReplay.status,
      exactAuditConfirmed: confirmedReplay.body.exactAuditConfirmed,
      sends: scenarioSendCount(handoffId),
    }, {
      auditConfirmed: true,
      status: 200,
      exactAuditConfirmed: true,
      sends: 1,
    });
  });

  await t.test('G09 audit without the durable operation and attempt cannot confirm only memory', async () => {
    const handoffId = 'g09-missing-durable-audit-identity';
    const prompt = 'G09 missing durable audit identity must stay pending';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = { prompt, handoffId, source: 'phase2-test' };
    assert.equal((await api('/api/terminal-tabs/phase2-target-tab/send', request)).status, 202);
    const durablePayload = scenarioPayload(handoffId);
    assert.ok(durablePayload?.sendOperationKey);
    assert.ok(durablePayload?.sendAttemptId);
    const hash = promptAuditFingerprint(prompt);
    const auditBase = {
      success: true,
      tabId: 'phase2-target-tab',
      toolType: 'claude',
      handoffId,
      expectedHash: hash,
      actualHash: hash,
      sessionId: 'phase2-target-session',
      entryUuid: 'g09-missing-durable-identity-entry',
    };

    const missing = await webServer.notifyAgentPromptAuditResult(auditBase);
    const partial = await webServer.notifyAgentPromptAuditResult({
      ...auditBase,
      sendOperationKey: durablePayload.sendOperationKey,
    });
    const stillPending = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.deepEqual({
      missingConfirmed: missing.confirmed,
      missingReason: missing.reason,
      partialConfirmed: partial.confirmed,
      partialReason: partial.reason,
      replayStatus: stillPending.status,
      durableState: receiptStore.get(durablePayload.sendOperationKey)?.state,
      sends: scenarioSendCount(handoffId),
    }, {
      missingConfirmed: false,
      missingReason: 'durable-audit-identity-missing',
      partialConfirmed: false,
      partialReason: 'durable-audit-identity-missing',
      replayStatus: 202,
      durableState: STORE_STATES.AUDIT_PENDING,
      sends: 1,
    });

    const exact = await webServer.notifyAgentPromptAuditResult({
      ...auditBase,
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
    });
    assert.equal(exact.confirmed, true);
    assert.equal((await api('/api/terminal-tabs/phase2-target-tab/send', request)).status, 200);
  });

  await t.test('G09 delivery-unknown replay cannot cross the renderer bridge twice', async () => {
    const handoffId = 'g09-project-unknown-handoff';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: null,
      accepted: true,
      status: 'delivery-unknown',
      deliveryUnknown: true,
      handoffId: payload.handoffId,
    });
    const request = {
      prompt: 'G09 delivery unknown one physical attempt',
      handoffId,
      source: 'phase2-test',
    };
    const first = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    const replay = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.deepEqual({
      first: first.status,
      replay: replay.status,
      replayed: replay.body.replayed,
      sends: scenarioSendCount(handoffId),
    }, { first: 202, replay: 202, replayed: true, sends: 1 });
  });

  await t.test('G09 pending receipt replay cannot reopen a closed target or submit twice', async () => {
    const handoffId = 'g09-closed-target-handoff';
    const prompt = 'G09 closed target has one physical delivery attempt';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = { prompt, handoffId, source: 'phase2-test' };
    const first = await api('/api/terminal-tabs/phase2-closed-target/send', request);
    assert.equal(first.status, 202);
    assert.equal(controller.closedRestoreCount, 1);
    assert.equal(scenarioSendCount(handoffId), 1);

    const project = projects.find((item) => item.id === 'phase2-project');
    project.tabs = project.tabs.filter((tab) => tab.tabId !== 'phase2-closed-target');

    const replay = await api('/api/terminal-tabs/phase2-closed-target/send', request);
    assert.deepEqual({
      status: replay.status,
      replayed: replay.body.replayed,
      restores: controller.closedRestoreCount,
      sends: scenarioSendCount(handoffId),
      reopened: project.tabs.some((tab) => tab.tabId === 'phase2-closed-target'),
    }, {
      status: 202,
      replayed: true,
      restores: 1,
      sends: 1,
      reopened: false,
    });
  });

  await t.test('G09 proven pre-submit refusal remains retryable for the same exact handoff', async () => {
    const handoffId = 'g09-project-retryable-handoff';
    let attempt = 0;
    controller.sendResponder = async (payload) => {
      attempt += 1;
      return attempt === 1
        ? { success: false, submitted: false, accepted: false, code: 'refused_before_submit' }
        : { success: true, submitted: true, accepted: true, handoffId: payload.handoffId };
    };
    const request = {
      prompt: 'G09 retry only after proven not submitted',
      handoffId,
      source: 'phase2-test',
    };
    const first = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    const retry = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.deepEqual({
      first: first.status,
      retry: retry.status,
      sends: scenarioSendCount(handoffId),
    }, { first: 409, retry: 200, sends: 2 });
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

  await t.test('Terminal MCP surfaces exact provider-not-accepted without a blind retry', async () => {
    const handoffId = 'phase2-provider-not-accepted-mcp';
    controller.sendResponder = async () => exactProviderNotAccepted({ handoffId });
    const request = {
      homeDir: tempHome,
      tabId: 'phase2-target-tab',
      prompt: 'MCP exact draft remained',
      handoffId,
    };
    const first = await callMcpSendPrompt(request);
    const replay = await callMcpSendPrompt(request);
    const firstText = first?.result?.content?.[0]?.text || '';
    const replayText = replay?.result?.content?.[0]?.text || '';
    assert.equal(first?.result?.isError, true);
    assert.equal(replay?.result?.isError, true);
    assert.match(firstText, /not.accepted|exact.draft|409/i);
    assert.match(replayText, /not.accepted|exact.draft|409/i);
    assert.equal(scenarioSendCount(handoffId), 1);
  });

  await t.test('G09 Terminal MCP can reuse one exact pending handoff without a second send', async () => {
    const handoffId = 'g09-terminal-mcp-handoff';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = {
      homeDir: tempHome,
      tabId: 'phase2-target-tab',
      prompt: 'G09 Terminal MCP exact pending prompt',
      handoffId,
    };
    const first = await callMcpSendPrompt(request);
    const replay = await callMcpSendPrompt(request);
    const firstText = first?.result?.content?.[0]?.text || '';
    const replayText = replay?.result?.content?.[0]?.text || '';
    assert.match(firstText, /pending|confirmation/i);
    assert.match(replayText, /pending|confirmation/i);
    assert.equal(scenarioSendCount(handoffId), 1);
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
    const durablePayload = scenarioPayload('external-run:phase2-inbox-run');
    assert.ok(durablePayload?.sendOperationKey);
    assert.ok(durablePayload?.sendAttemptId);
    const wrongProvider = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: response.body.tabId,
      toolType: 'claude',
      handoffId: 'external-run:phase2-inbox-run',
      expectedHash: exactHash,
      actualHash: exactHash,
      sessionId: 'phase2-inbox-session',
      entryUuid: 'phase2-inbox-wrong-provider',
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
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
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
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
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
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

  await t.test('G09 Inbox reserves runId before tab creation and replays one exact receipt', async () => {
    const runId = 'g09-inbox-idempotent-run';
    const handoffId = 'external-run:' + runId;
    const prompt = 'G09 Inbox exact one physical prompt';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = {
      provider: 'codex',
      prompt,
      runId,
      source: 'phase2-test',
      autoStopMs: 0,
    };
    const tabsBefore = controller.inboxCounter;
    const first = await api('/api/inbox/runs', request);
    const replay = await api('/api/inbox/runs', request);
    const conflict = await api('/api/inbox/runs', { ...request, prompt: prompt + ' changed' });
    assert.deepEqual({
      first: first.status,
      replay: replay.status,
      replayed: replay.body.idempotent,
      conflict: conflict.status,
      conflictCode: conflict.body.code,
      createdTabs: controller.inboxCounter - tabsBefore,
      sends: scenarioSendCount(handoffId),
    }, {
      first: 202,
      replay: 202,
      replayed: true,
      conflict: 409,
      conflictCode: 'external_run_identity_conflict',
      createdTabs: 1,
      sends: 1,
    });

    const hash = promptAuditFingerprint(prompt);
    const durablePayload = scenarioPayload(handoffId);
    assert.ok(durablePayload?.sendOperationKey);
    assert.ok(durablePayload?.sendAttemptId);
    const exact = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: first.body.tabId,
      toolType: 'codex',
      handoffId,
      expectedHash: hash,
      actualHash: hash,
      sessionId: 'phase2-inbox-session',
      entryUuid: 'g09-inbox-exact-entry',
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
    });
    const confirmedReplay = await api('/api/inbox/runs', request);
    assert.deepEqual({
      auditConfirmed: exact.confirmed,
      status: confirmedReplay.status,
      exactAuditConfirmed: confirmedReplay.body.exactAuditConfirmed,
      createdTabs: controller.inboxCounter - tabsBefore,
      sends: scenarioSendCount(handoffId),
    }, {
      auditConfirmed: true,
      status: 200,
      exactAuditConfirmed: true,
      createdTabs: 1,
      sends: 1,
    });
  });

  await t.test('G09 concurrent Inbox duplicates join the early run reservation', async () => {
    const runId = 'g09-inbox-concurrent-run';
    const handoffId = 'external-run:' + runId;
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = {
      provider: 'codex',
      prompt: 'G09 concurrent Inbox request',
      runId,
      source: 'phase2-test',
      autoStopMs: 0,
    };
    const tabsBefore = controller.inboxCounter;
    const [first, joined] = await Promise.all([
      api('/api/inbox/runs', request),
      api('/api/inbox/runs', request),
    ]);
    assert.equal(first.status, 202);
    assert.equal(joined.status, 202);
    assert.equal(controller.inboxCounter - tabsBefore, 1);
    assert.equal(scenarioSendCount(handoffId), 1);
  });

  await t.test('G09 concurrent retry after setup failure owns one new tab and one send', async () => {
    const runId = 'g09-inbox-setup-retry-run';
    const handoffId = 'external-run:' + runId;
    const request = {
      provider: 'codex',
      prompt: 'G09 retry one reservation after setup failure',
      runId,
      source: 'phase2-test',
      autoStopMs: 0,
    };
    const callsBefore = controller.createAgentTabCalls;
    const tabsBefore = controller.inboxCounter;
    controller.failNextCreateAgentTab = true;
    const failed = await api('/api/inbox/runs', request);
    assert.equal(failed.status, 500);
    assert.equal(controller.createAgentTabCalls - callsBefore, 1);
    assert.equal(controller.inboxCounter - tabsBefore, 0);

    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const [retry, joined] = await Promise.all([
      api('/api/inbox/runs', request),
      api('/api/inbox/runs', request),
    ]);
    assert.equal(retry.status, 202);
    assert.equal(joined.status, 202);
    assert.equal(controller.createAgentTabCalls - callsBefore, 2);
    assert.equal(controller.inboxCounter - tabsBefore, 1);
    assert.equal(scenarioSendCount(handoffId), 1);
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

  await t.test('preflight no-Enter proof releases the target lane for an explicit retry', async () => {
    const refusedRunId = 'phase2-terminal-draft-unknown-refusal';
    const retryRunId = 'phase2-terminal-draft-unknown-retry';
    let attempt = 0;
    controller.sendResponder = async (payload) => {
      attempt += 1;
      if (attempt === 1) {
        return {
          success: false,
          ok: false,
          submitted: false,
          accepted: false,
          code: 'terminal_draft_state_unknown',
          error: 'Terminal draft state is unknown; send stopped before touching input',
        };
      }
      return {
        success: true,
        submitted: true,
        accepted: true,
        handoffId: payload.handoffId,
      };
    };

    const refused = await api('/api/orchestrations', {
      runId: refusedRunId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-refusal-tab',
      prompt: 'first prompt refused before input',
      queue: false,
      notifySource: false,
    });
    const refusedState = await api('/api/orchestrations/' + refusedRunId);
    const loadersAfterRefusal = await api('/api/active-loaders');
    const retried = await api('/api/orchestrations', {
      runId: retryRunId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: 'phase2-target-refusal-tab',
      prompt: 'explicitly authorized retry',
      queue: false,
      notifySource: false,
    });
    const retryState = await api('/api/orchestrations/' + retryRunId);

    assert.deepEqual({
      refusedHttp: refused.status,
      refusedStatus: refusedState.body.run?.status,
      refusedAccepted: Boolean(refusedState.body.run?.deliveryAcceptedAt),
      refusalLoaderPresent: loadersAfterRefusal.body.loaders?.some((loader) => (
        loader.runId === refusedRunId
      )) === true,
      retryHttp: retried.status,
      retryStatus: retryState.body.run?.status,
      retryDeferredReason: retryState.body.run?.deliveryDeferredReason || null,
      retrySends: scenarioSendCount('orchestration:' + retryRunId),
    }, {
      refusedHttp: 409,
      refusedStatus: 'failed',
      refusedAccepted: false,
      refusalLoaderPresent: false,
      retryHttp: 202,
      retryStatus: 'sent',
      retryDeferredReason: null,
      retrySends: 1,
    });
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
      return state.body.run?.notificationStatus === 'unconfirmed' ? state : null;
    }, 'completion harness did not expose the unconfirmed post-Enter handoff');
    assert.equal(pendingNotification.body.run.status, 'completed');
    assert.ok(controller.completionPrompt, 'completion prompt must have crossed the real notification caller');
    assert.equal(controller.completionSendCount, 1);

    assert.equal(controller.completionSendCount, 1,
      'Unconfirmed delivery must not retry automatically.');

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

  await t.test('completion handoff enters a streaming source queue immediately', async () => {
    const runId = 'phase2-streaming-source-completion';
    const targetTabId = 'phase2-target-completion-tab';
    const prompt = 'return while the parent is streaming';
    let completionPayload = null;
    controller.turnResult = {
      found: false,
      resultAvailable: false,
      resultComplete: false,
      error: 'not materialized',
    };
    controller.completionPrompt = '';
    controller.completionSendCount = 0;
    controller.busyTabs.add('phase2-source-tab');
    controller.sendResponder = async (payload) => {
      if (String(payload?.source || '').startsWith('orchestration-completion:')) {
        completionPayload = payload;
        return {
          success: false,
          submitted: true,
          accepted: true,
          handoffId: payload.handoffId,
          error: 'claude_user_message_audit_timeout',
        };
      }
      return { success: true, submitted: true, accepted: true, handoffId: payload.handoffId };
    };
    try {
      const created = await api('/api/orchestrations', {
        runId,
        sourceTabId: 'phase2-source-tab',
        targetTabId,
        prompt,
        queue: false,
        notifySource: true,
      });
      assert.equal(created.status, 202);

      const targetHash = promptAuditFingerprint(prompt);
      const executionContext = {
        provider: 'claude',
        sessionId: 'phase2-target-session',
        turnId: 'phase2-streaming-source-turn',
        generation: 3,
        startedAt: Date.now(),
      };
      const targetAudit = await webServer.notifyAgentPromptAuditResult({
        success: true,
        tabId: targetTabId,
        toolType: 'claude',
        handoffId: 'orchestration:' + runId,
        source: 'orchestration:phase2-source-tab',
        auditTimestamp: new Date().toISOString(),
        actualHash: targetHash,
        expectedHash: targetHash,
        sessionId: 'phase2-target-session',
        entryUuid: 'phase2-streaming-source-user',
        executionContext,
      });
      assert.equal(targetAudit.confirmed, true);

      webServer.webBroadcast(targetTabId, {
        type: 'busy',
        busy: true,
        sessionId: 'phase2-target-session',
        executionContext,
      });
      await waitFor(async () => {
        const state = await api('/api/orchestrations/' + runId);
        return state.body.run?.status === 'running' ? state : null;
      }, 'streaming source target never became running');

      controller.turnResult = {
        found: true,
        resultAvailable: true,
        complete: true,
        sessionId: 'phase2-target-session',
        turnIndex: 1,
        userUuid: 'phase2-streaming-source-user',
        assistantText: 'streaming source result',
        assistantChars: 23,
        sourceSnapshot: { size: 120, mtimeMs: Date.now() },
      };
      webServer.webBroadcast(targetTabId, {
        type: 'done',
        busy: false,
        reason: 'task_complete',
        sessionId: 'phase2-target-session',
        executionContext,
      });
      await waitFor(async () => {
        const state = await api('/api/orchestrations/' + runId);
        return state.body.run?.notificationStatus === 'unconfirmed' ? state : null;
      }, 'streaming source completion was not attempted immediately');

      assert.equal(controller.busyTabs.has('phase2-source-tab'), true);
      assert.equal(controller.completionSendCount, 1);
      assert.equal(completionPayload?.queue, true);
      assert.equal(completionPayload?.statusAtSend, 'busy');
    } finally {
      controller.busyTabs.delete('phase2-source-tab');
    }
  });

  const restartWebServer = async () => {
    await webServer.stop();
    webServer.start(startOptions);
    await waitFor(async () => {
      try {
        const response = await api('/api/me');
        return response.status === 200;
      } catch {
        return false;
      }
    }, 'mock Project API did not restart');
  };

  await t.test('queued orchestration preserves its exact Settings model across server restart', async () => {
    const runId = 'phase2-claude-model-restart';
    const tabId = 'phase2-model-restart-target';
    const handoffId = 'orchestration:' + runId;
    controller.busyTabs.add(tabId);
    controller.sendResponder = async () => ({
      success: true,
      submitted: true,
      accepted: true,
    });
    const response = await api('/api/orchestrations', {
      runId,
      sourceTabId: 'phase2-source-tab',
      targetTabId: tabId,
      model: 'opus',
      prompt: 'restart keeps canonical model',
      notifySource: false,
    });
    assert.equal(response.status, 202);
    assert.equal(scenarioSendCount(handoffId), 0);

    await restartWebServer();
    assert.equal(scenarioSendCount(handoffId), 0);
    controller.busyTabs.delete(tabId);
    webServer.webBroadcast(tabId, {
      type: 'snapshot',
      status: 'active',
      sessionStatus: 'active',
      inputReady: true,
      busy: false,
      sessionId: 'phase2-model-restart-session',
      lifecycleGeneration: 'phase2-life:' + tabId,
    });
    await waitFor(
      () => scenarioSendCount(handoffId) === 1,
      'restarted queued orchestration did not dispatch',
    );
    assert.equal(scenarioPayload(handoffId)?.model, 'claude-opus-5[1m]');
  });

  await t.test('G09 durable Project handoff survives server restart without another bridge send', async () => {
    const handoffId = 'g09-project-restart-handoff';
    const prompt = 'G09 Project API restart must replay one pending receipt';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = { prompt, handoffId, source: 'phase2-test' };
    const first = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.equal(first.status, 202);
    const durablePayload = scenarioPayload(handoffId);
    assert.ok(durablePayload?.sendOperationKey);
    assert.ok(durablePayload?.sendAttemptId);
    const sendsBeforeRestart = scenarioSendCount(handoffId);

    await restartWebServer();
    const replay = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    const conflict = await api('/api/terminal-tabs/phase2-target-tab/send', {
      ...request,
      prompt: prompt + ' changed',
    });
    const hash = promptAuditFingerprint(prompt);
    const audit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: 'phase2-target-tab',
      toolType: 'claude',
      handoffId,
      expectedHash: hash,
      actualHash: hash,
      sessionId: 'phase2-target-session',
      entryUuid: 'g09-project-restart-exact-entry',
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
    });
    const confirmed = await api('/api/terminal-tabs/phase2-target-tab/send', request);
    assert.deepEqual({
      replayStatus: replay.status,
      replayed: replay.body.replayed,
      conflictStatus: conflict.status,
      conflictCode: conflict.body.code,
      auditConfirmed: audit.confirmed,
      confirmedStatus: confirmed.status,
      sends: scenarioSendCount(handoffId),
    }, {
      replayStatus: 202,
      replayed: true,
      conflictStatus: 409,
      conflictCode: 'agent_send_handoff_conflict',
      auditConfirmed: true,
      confirmedStatus: 200,
      sends: sendsBeforeRestart,
    });
  });

  await t.test('G09 durable Inbox runId survives restart with one deterministic tab and one send', async () => {
    const runId = 'g09-inbox-restart-run';
    const handoffId = 'external-run:' + runId;
    const prompt = 'G09 Inbox restart must not create or submit twice';
    controller.sendResponder = async (payload) => ({
      success: null,
      submitted: true,
      accepted: true,
      status: 'audit-pending',
      auditPending: true,
      handoffId: payload.handoffId,
    });
    const request = {
      provider: 'codex',
      prompt,
      runId,
      source: 'phase2-test',
      autoStopMs: 0,
    };
    const tabsBefore = controller.createAgentTabCalls;
    const first = await api('/api/inbox/runs', request);
    assert.equal(first.status, 202);
    const durablePayload = scenarioPayload(handoffId);
    assert.ok(durablePayload?.sendOperationKey);
    assert.ok(durablePayload?.sendAttemptId);
    const createsAfterFirst = controller.createAgentTabCalls;
    const sendsAfterFirst = scenarioSendCount(handoffId);

    await restartWebServer();
    const replay = await api('/api/inbox/runs', request);
    const conflict = await api('/api/inbox/runs', { ...request, prompt: prompt + ' changed' });
    const hash = promptAuditFingerprint(prompt);
    const audit = await webServer.notifyAgentPromptAuditResult({
      success: true,
      tabId: first.body.tabId,
      toolType: 'codex',
      handoffId,
      expectedHash: hash,
      actualHash: hash,
      sessionId: 'phase2-inbox-session',
      entryUuid: 'g09-inbox-restart-exact-entry',
      sendOperationKey: durablePayload.sendOperationKey,
      sendAttemptId: durablePayload.sendAttemptId,
    });
    const confirmed = await api('/api/inbox/runs', request);
    assert.deepEqual({
      replayStatus: replay.status,
      replayTabId: replay.body.tabId,
      firstTabId: first.body.tabId,
      conflictStatus: conflict.status,
      conflictCode: conflict.body.code,
      auditConfirmed: audit.confirmed,
      confirmedStatus: confirmed.status,
      createdTabs: controller.createAgentTabCalls - tabsBefore,
      createsAfterFirst: createsAfterFirst - tabsBefore,
      sends: scenarioSendCount(handoffId),
    }, {
      replayStatus: 202,
      replayTabId: first.body.tabId,
      firstTabId: first.body.tabId,
      conflictStatus: 409,
      conflictCode: 'external_run_identity_conflict',
      auditConfirmed: true,
      confirmedStatus: 200,
      createdTabs: 1,
      createsAfterFirst: 1,
      sends: sendsAfterFirst,
    });
  });

  await t.test('G09 restart reconciles an Enter-armed Project attempt to unknown without sending', async () => {
    const tabId = 'phase2-target-tab';
    const handoffId = 'g09-enter-armed-restart-handoff';
    const prompt = 'G09 Enter armed restart stays unknown';
    const source = 'phase2-test';
    const operationKey = `project:${tabId}:${handoffId}`;
    const requestFingerprint = fingerprintAgentSendRequest({
      prompt,
      model: null,
      effort: null,
      thinking: null,
      cwd: null,
      source,
      queue: false,
      ownership: 'project',
    });
    const attempt = receiptStore.beginAttempt({
      operationKey,
      surface: 'project-api',
      runId: null,
      tabId,
      handoffId,
      requestFingerprint,
      provider: 'claude',
      sessionId: null,
      promptHash: promptAuditFingerprint(prompt),
      promptLength: prompt.length,
    });
    assert.equal(attempt.action, 'attempt-started');
    receiptStore.markAttemptState(operationKey, attempt.attemptId, STORE_STATES.ENTER_ARMED);
    const sendsBeforeRestart = scenarioSendCount(handoffId);

    await restartWebServer();
    const replay = await api(`/api/terminal-tabs/${tabId}/send`, {
      prompt,
      handoffId,
      source,
    });
    assert.deepEqual({
      status: replay.status,
      deliveryStatus: replay.body.status,
      submitted: replay.body.submitted,
      sends: scenarioSendCount(handoffId),
      durableState: receiptStore.get(operationKey)?.state,
    }, {
      status: 202,
      deliveryStatus: 'delivery-unknown',
      submitted: null,
      sends: sendsBeforeRestart,
      durableState: STORE_STATES.DELIVERY_UNKNOWN,
    });
  });

  await t.test('G09 stale attempt callback cannot overwrite the current durable receipt exposed by API', async () => {
    const tabId = 'phase2-target-tab';
    const handoffId = 'g09-stale-attempt-handoff';
    const prompt = 'G09 stale callback is rejected';
    const source = 'phase2-test';
    const operationKey = `project:${tabId}:${handoffId}`;
    const identity = {
      operationKey,
      surface: 'project-api',
      runId: null,
      tabId,
      handoffId,
      requestFingerprint: fingerprintAgentSendRequest({
        prompt,
        model: null,
        effort: null,
        thinking: null,
        cwd: null,
        source,
        queue: false,
        ownership: 'project',
      }),
      provider: 'claude',
      sessionId: null,
      promptHash: promptAuditFingerprint(prompt),
      promptLength: prompt.length,
    };
    const first = receiptStore.beginAttempt(identity);
    receiptStore.settleAttempt(operationKey, first.attemptId, {
      success: false,
      submitted: false,
    });
    const second = receiptStore.beginAttempt(identity);
    receiptStore.settleAttempt(operationKey, second.attemptId, {
      success: null,
      submitted: true,
      status: 'audit-pending',
      auditPending: true,
    });
    const stale = receiptStore.settleAttempt(operationKey, first.attemptId, {
      success: true,
      submitted: true,
      status: 'sent',
    });
    assert.equal(stale.stale, true);
    const sendsBeforeReplay = scenarioSendCount(handoffId);
    const replay = await api(`/api/terminal-tabs/${tabId}/send`, {
      prompt,
      handoffId,
      source,
    });
    assert.deepEqual({
      status: replay.status,
      receiptState: replay.body.receiptState,
      sends: scenarioSendCount(handoffId),
      attemptId: replay.body.attemptId,
    }, {
      status: 202,
      receiptState: 'audit-pending',
      sends: sendsBeforeReplay,
      attemptId: second.attemptId,
    });
  });
});

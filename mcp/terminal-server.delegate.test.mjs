import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const terminalServerPath = fileURLToPath(new URL('./terminal-server.mjs', import.meta.url));

function readJsonLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Terminal MCP response'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

async function createHarness(t, respond) {
  const home = await mkdtemp(join(tmpdir(), 'terminal-mcp-delegate-'));
  const discoveryDir = join(home, '.noted-terminal');
  const projectId = 'test-project';
  const projectPath = '/tmp/terminal-mcp-test-project';
  const sourceTabId = 'test-source-tab';
  const requests = [];
  await mkdir(discoveryDir, { recursive: true });

  const webServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body });
    const response = respond(body, requests.length, req);
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  webServer.listen(0, '127.0.0.1');
  await once(webServer, 'listening');
  const webPort = webServer.address().port;
  const ownerPid = process.pid;

  await writeFile(join(discoveryDir, 'web-token.txt'), 'test-token', 'utf8');
  await writeFile(join(discoveryDir, `web-server-${ownerPid}.json`), JSON.stringify({
    port: webPort,
    updatedAt: Date.now(),
  }), 'utf8');
  await writeFile(join(discoveryDir, `mcp-port-${ownerPid}`), JSON.stringify({
    port: 1,
    openProjectPaths: [projectPath],
    openProjects: [{ id: projectId, path: projectPath, name: 'test-project' }],
    updatedAt: Date.now(),
  }), 'utf8');

  const child = spawn(process.execPath, [terminalServerPath, '--project', projectPath], {
    env: {
      ...process.env,
      HOME: home,
      NOTED_MAIN_PID: String(ownerPid),
      NOTED_PARENT_PROJECT_ID: projectId,
      NOTED_PARENT_TAB_ID: sourceTabId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await new Promise((resolve) => webServer.close(resolve));
    await rm(home, { recursive: true, force: true });
  });

  let requestId = 0;
  return {
    requests,
    async invoke(args, name = 'delegate_to_session') {
      requestId += 1;
      const response = readJsonLine(child.stdout);
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name, arguments: args },
      }) + '\n');
      return response;
    },
  };
}

test('existing targets infer their provider while newly created targets keep the Claude default', async (t) => {
  const harness = await createHarness(t, (_body, index) => ({
    status: 202,
    body: {
      ok: true,
      accepted: true,
      run: { runId: `run-${index}` },
    },
  }));

  const existing = await harness.invoke({
    targetTabId: 'existing-codex-tab',
    prompt: 'audit existing Codex tab',
  });
  const created = await harness.invoke({
    targetProjectId: 'test-project',
    prompt: 'create a default target',
  });

  assert.equal('toolType' in harness.requests[0].body, false);
  assert.equal(harness.requests[1].body.toolType, 'claude');
  assert.equal(existing.result.structuredContent.runId, 'run-1');
  assert.equal(created.result.structuredContent.runId, 'run-2');
  assert.equal(JSON.parse(existing.result.content[0].text).runId, 'run-1');
});

test('delegation failure remains an explicit structured MCP error', async (t) => {
  const harness = await createHarness(t, () => ({
    status: 400,
    body: { error: 'Requested claude cannot target an existing codex tab.' },
  }));

  const response = await harness.invoke({
    targetTabId: 'existing-codex-tab',
    toolType: 'claude',
    prompt: 'contradict the target provider',
  });

  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.structuredContent, {
    ok: false,
    error: 'HTTP 400: Requested claude cannot target an existing codex tab.',
  });
  assert.match(response.result.content[0].text, /^Error: HTTP 400:/);
});

test('window-targeted delegation lets Project API resolve the destination project', async (t) => {
  const harness = await createHarness(t, () => ({
    status: 202,
    body: { ok: true, accepted: true, run: { runId: 'window-run' } },
  }));

  await harness.invoke({
    prompt: 'work beside me',
    cwd: '/repo/context',
    windowTarget: { anchor: 'source', mode: 'same-window' },
  });

  const body = harness.requests[0].body;
  assert.equal('targetProjectId' in body, false);
  assert.equal(body.sourceTabId, 'test-source-tab');
  assert.equal(body.cwd, '/repo/context');
  assert.deepEqual(body.windowTarget, { anchor: 'source', mode: 'same-window' });
  assert.equal(body.toolType, 'claude');
});

test('send and delegation forward canonical context-file descriptors without reading bodies', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => {
    if (req.url === '/api/me') {
      return {
        status: 200,
        body: { ok: true, capabilities: { contextFiles: { version: 1 } } },
      };
    }
    if (req.url.startsWith('/api/terminal-tabs/')) {
      return { status: 200, body: { ok: true, success: true, status: 'sent' } };
    }
    return {
      status: 202,
      body: { ok: true, accepted: true, run: { runId: 'files-run' } },
    };
  });

  await harness.invoke({
    targetTabId: 'worker',
    prompt: 'Use the attached context',
    files: [
      { path: 'rules.md', role: 'instructions', label: 'Rules' },
      { path: '/tmp/raw.md', role: 'source' },
    ],
  });
  await harness.invoke({
    tabId: 'worker',
    prompt: 'Continue',
    files: [{ path: 'source.md' }],
  }, 'send_prompt');

  const mutations = harness.requests.filter((request) => request.url !== '/api/me');
  assert.deepEqual(mutations[0].body.files, [
    {
      path: '/tmp/terminal-mcp-test-project/rules.md',
      role: 'instructions',
      label: 'Rules',
    },
    { path: '/tmp/raw.md', role: 'source' },
  ]);
  assert.deepEqual(mutations[1].body.files, [
    { path: '/tmp/terminal-mcp-test-project/source.md', role: 'source' },
  ]);
  assert.equal(JSON.stringify(harness.requests).includes('file body'), false);
});

test('an old backend is rejected before a context-file prompt can cross POST', async (t) => {
  const harness = await createHarness(t, (_body, _index, req) => ({
    status: 200,
    body: req.url === '/api/me'
      ? { ok: true }
      : { ok: true, status: 'sent' },
  }));

  const response = await harness.invoke({
    tabId: 'worker',
    prompt: 'must not send without the capability',
    files: [{ path: '/tmp/rules.md', role: 'instructions' }],
  }, 'send_prompt');

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /does not support server-resolved context files/i);
  assert.deepEqual(harness.requests.map((request) => request.url), ['/api/me']);
});

test('create and placement tools carry one source-owned window contract', async (t) => {
  const harness = await createHarness(t, (_body, index, req) => {
    if (req.url === '/api/agent-tabs') {
      return { status: 200, body: { ok: true, tabId: 'new-agent', placement: { spaceId: 'main' } } };
    }
    if (req.url === '/api/workspace/windows') {
      return { status: 200, body: { ok: true, spaceId: 'main', paneIndex: 2 } };
    }
    if (req.url === '/api/workspace/place-tabs') {
      return { status: 200, body: { ok: true, spaceId: 'main', insertedAt: 1 } };
    }
    return { status: 500, body: { error: `unexpected request ${index}` } };
  });

  const created = await harness.invoke({
    command: 'codex',
    name: 'worker',
    windowTarget: { anchor: 'source', mode: 'same-window' },
  }, 'create_tab');
  await harness.invoke({
    side: 'below',
    windowTarget: { anchor: 'source' },
  }, 'create_window');
  await harness.invoke({
    tabs: ['existing-tab'],
    windowTarget: { anchor: 'source', mode: 'same-window' },
  }, 'open_tabs_in_window');

  assert.equal(created.result.structuredContent.tabId, 'new-agent');
  assert.deepEqual(harness.requests.map((request) => request.url), [
    '/api/agent-tabs',
    '/api/workspace/windows',
    '/api/workspace/place-tabs',
  ]);
  assert.equal(harness.requests[0].body.sourceTabId, 'test-source-tab');
  assert.equal(harness.requests[0].body.fallbackProjectId, 'test-project');
  assert.deepEqual(harness.requests[1].body.windowTarget, {
    anchor: 'source',
    mode: 'new-window',
    side: 'below',
    reveal: false,
  });
  assert.deepEqual(harness.requests[2].body.entries, ['existing-tab']);
});

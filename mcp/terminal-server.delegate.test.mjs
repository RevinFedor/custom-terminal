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
    const response = respond(body, requests.length);
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
    async invoke(args) {
      requestId += 1;
      const response = readJsonLine(child.stdout);
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name: 'delegate_to_session', arguments: args },
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const source = await fs.readFile(new URL('./tab-message-ui-regression.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('runner.mjs', source, ts.ScriptTarget.Latest, true);
let loader, shim;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'shim') shim = node.getText(tree);
  if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'loader' && ts.isObjectLiteralExpression(node.initializer)) {
    loader = Object.fromEntries(node.initializer.properties.map(property => [property.name.text, property.initializer.text]));
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(loader);
const asset = new URL('../src/renderer/assets/sc-desktop.png', import.meta.url);
const input = { stdin: { contents: 'import icon from ' + JSON.stringify(asset.pathname) + '; export default icon;',
  resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'actual-png-entry.mjs' },
  bundle: true, write: false, outfile: '/tmp/noted-png-check-not-written.js', format: 'esm', platform: 'browser', logLevel: 'silent' };

test('missing PNG loader reproduces the preserved runner setup failure', async () => {
  const { '.png': removed, ...oldLoader } = loader;
  assert.equal(removed, 'dataurl');
  await assert.rejects(build({ ...input, loader: oldLoader }), /No loader is configured for.*\.png/);
});

test('the actual runner loader packages the original PNG byte-for-byte without touching it', async () => {
  const png = await fs.readFile(asset), hash = createHash('sha256').update(png).digest('hex');
  const result = await build({ ...input, loader });
  const encoded = result.outputFiles[0].text.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(encoded); assert.deepEqual(Buffer.from(encoded, 'base64'), png);
  assert.equal(createHash('sha256').update(await fs.readFile(asset)).digest('hex'), hash);
});

test('actual controlled IPC ports preserve exact message/cancel and saved-job navigation shapes', async () => {
  assert.ok(shim);
  const window = { require: name => { assert.equal(name, 'node:crypto'); return crypto; } };
  const f = vm.runInNewContext(shim + '\nshim();window.fixture;', { window });
  f.ownedPairs.owned = { message: { ...f.q, messageId: 'owned' }, reply: { ...f.r, replyTo: 'owned' } };
  const thread = await f.ipc.invoke('tab-messages:get', { messageId: 'owned' });
  assert.equal(thread.message.messageId, 'owned'); assert.equal(thread.reply.replyTo, 'owned');
  await assert.rejects(f.ipc.invoke('tab-messages:dismiss', { tabId: 'other', messageId: 'owned' }), /foreign dismiss/);
  const cancelled = await f.ipc.invoke('tab-messages:dismiss', { tabId: 'a', messageId: 'owned' });
  assert.ok(cancelled.message.sourceDismissedAt); assert.equal(cancelled.message.messageId, 'owned');
  assert.equal(cancelled.message.cancelledAt, undefined);
  assert.equal(f.ownedPairs.owned.reply.text, f.r.text);
  for (const channel of ['orchestration:open-research-job', 'orchestration:open-research-browser']) {
    const result = await f.ipc.invoke(channel, { runId: 'exact-fixture-run' });
    assert.equal(result.success, true); assert.equal(result.jobId, 'fixture-exact-fixture-run');
    if (channel.endsWith('-browser')) assert.equal(result.tabId, 7);
  }
  const status = await f.ipc.invoke('build-install:status-for-tab', { tabId: 'a' });
  assert.equal(status.known, true); assert.equal(status.jobs.length, 0);
  await assert.rejects(f.ipc.invoke('terminal:paste', {}), /Forbidden fixture operation/);
});

test('Source-only preflight returns before importing or launching the GUI SDK', () => {
  assert.equal(tree.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'playwright'), false);
  let gate;
  function find(node) {
    if (ts.isIfStatement(node) && node.expression.getText(tree) === 'preflightOnly') gate = node;
    ts.forEachChild(node, find);
  }
  find(tree); assert.ok(gate);
  assert.equal(gate.thenStatement.statements.at(-1).kind, ts.SyntaxKind.ReturnStatement);
  const runtimeImport = source.indexOf("await import('playwright')");
  assert.ok(runtimeImport > gate.end); assert.ok(source.indexOf('electron.launch(', runtimeImport) > runtimeImport);
});

test('native actor client packages the actual dispatcher with exact private routing and explicit body identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted4412-batch-client-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const posts = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/me') return res.end(JSON.stringify({ capabilities: { tabMessages: {
      version: 1, durable: true, replyTo: true, batchReply: { version: 1 } } } }));
    assert.equal(req.url, '/api/tab-messages/replies');
    let body = ''; for await (const data of req) body += data;
    posts.push(JSON.parse(body));
    res.end(JSON.stringify({ ok: true, accepted: true, messages: [{ messageId: 'R', deliveryState: 'pending' }],
      results: [{ questionId: 'Q', status: 'reply-created', replyMessageId: 'R' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const mcpSource = new URL('../mcp/terminal-server.mjs', import.meta.url).pathname;
  const tokenFile = path.join(root, 'token'); await fs.writeFile(tokenFile, 'private-fixture-token');
  await fs.copyFile(new URL('./fixtures/tab-message-model-client.cjs', import.meta.url), path.join(workspace, 'client.cjs'));
  const realWorkspace = await fs.realpath(workspace);
  await fs.writeFile(path.join(workspace, 'client.json'), JSON.stringify({ tabId: 'B', projectId: 'P', mainPid: process.pid,
    port: server.address().port, tokenFile, home: root, mcpSource,
    mcpSHA: createHash('sha256').update(await fs.readFile(mcpSource)).digest('hex') }));
  const output = await promisify(execFile)(process.execPath, [path.join(workspace, 'client.cjs'), '["Q"]', 'one answer'], {
    cwd: realWorkspace, env: { PATH: process.env.PATH, NOTED_PARENT_TAB_ID: 'B',
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, timeout: 10000,
  });
  assert.equal(JSON.parse(output.stdout).deliveries, 1);
  assert.equal(posts.length, 1); assert.equal(posts[0].sourceTabId, 'B'); assert.equal(posts[0].sourceMeta.tabId, 'B');
  assert.deepEqual(posts[0].messageIds, ['Q']); assert.equal(posts[0].text, 'one answer');
});

test('owned work rejects a previous release epoch and ends only for this exact fixture generation', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted4412-batch-work-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const epoch = crypto.randomUUID();
  await fs.writeFile(path.join(workspace, 'finish-work'), JSON.stringify({ epoch: crypto.randomUUID() }));
  const child = spawn(process.execPath, [new URL('./fixtures/tab-message-busy.cjs', import.meta.url).pathname, epoch], {
    cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) await fs.writeFile(path.join(workspace, 'finish-work'), JSON.stringify({ epoch }));
    await closed; await fs.rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  const started = JSON.parse(await fs.readFile(path.join(workspace, 'busy-started.json'), 'utf8'));
  assert.equal(started.epoch, epoch); assert.equal(started.pid, child.pid); assert.equal(child.exitCode, null);
  await fs.writeFile(path.join(workspace, 'finish-work'), JSON.stringify({ epoch }));
  assert.deepEqual(await closed, [0, null]);
});

test('full-App admission observation preserves exact calls, results and rejection without retry', async () => {
  const scenario = await fs.readFile(new URL('./testing/tab-message-full-app-scenario.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('scenario.mjs', scenario, ts.ScriptTarget.Latest, true);
  const observer = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installAdmissionObserver');
  assert.ok(observer);
  const input = { tabId: 'A', handoffId: 'frozen-H', source: 'prompt-loop' }, calls = [];
  const failure = Error('actual admission failure'), result = { submitted: null, deliveryUnknown: true };
  let next = () => Promise.resolve(result);
  const ipc = { invoke(channel, ...args) { calls.push({ receiver: this, channel, args }); return next(); } };
  const window = { batchAcceptance: {}, require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc }; } };
  vm.runInNewContext(observer.getText(parsed) + '; installAdmissionObserver();', { window });
  assert.equal(await ipc.invoke('agent:enqueue-prompt', input), result);
  assert.equal(calls[0].receiver, ipc); assert.equal(calls[0].args[0], input);
  assert.equal(window.batchAcceptance.admissions[0].deliveryUnknown, true);
  next = () => Promise.reject(failure);
  await assert.rejects(ipc.invoke('agent:enqueue-prompt', input), error => error === failure);
  assert.equal(calls.length, 2); assert.equal(window.batchAcceptance.admissions[1].error, failure.message);
  next = () => { throw failure; };
  assert.throws(() => ipc.invoke('agent:enqueue-prompt', input), error => error === failure);
  assert.equal(calls.length, 3);
  next = () => Promise.resolve(result);
  for (let n = 0; n < 70; n++) await ipc.invoke('agent:enqueue-prompt', input);
  assert.equal(window.batchAcceptance.admissions.length, 64);
});

test('owned compiler reports the original resource refusal instead of its resulting signal exit', async () => {
  const driver = await fs.readFile(new URL('./testing/tab-message-full-app.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('driver.mjs', driver, ts.ScriptTarget.Latest, true);
  let postClose;
  function visit(node) {
    if (ts.isTryStatement(node) && node.tryBlock.getText(parsed) === '{ await closed; }') {
      const statements = node.parent.statements, index = statements.indexOf(node);
      postClose = statements.slice(index + 1, index + 4).map(statement => statement.getText(parsed)).join('\n');
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed); assert.ok(postClose);
  const refusal = Error('resource refusal: pressure');
  assert.throws(() => vm.runInNewContext(postClose, { assert, entry: { code: null, signal: 'SIGTERM' },
    guard() { throw refusal; } }), error => error === refusal);
});

test('compiler heap selection can only lower the existing baseline without raising resource caps', async () => {
  const driver = await fs.readFile(new URL('./testing/tab-message-full-app.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('driver.mjs', driver, ts.ScriptTarget.Latest, true);
  const index = parsed.statements.findIndex(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'compilerHeapMiB'));
  assert(index >= 0);
  const code = parsed.statements.slice(index, index + 2).map(node => node.getText(parsed)).join('\n') + ';compilerHeapMiB;';
  for (const limit of [undefined, 1024, 1280, 1792]) {
    assert.equal(vm.runInNewContext(code, { cfg: { compilerHeapMiB: limit }, assert }), limit ?? 1792);
  }
  for (const limit of [768, 1793, 4096, '1024', NaN]) {
    assert.throws(() => vm.runInNewContext(code, { cfg: { compilerHeapMiB: limit }, assert }));
  }
});

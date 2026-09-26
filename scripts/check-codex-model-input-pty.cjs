'use strict';
// Explicit isolated PTY integration, not a production/provider run.
// ELECTRON_RUN_AS_NODE=1 electron scripts/check-codex-model-input-pty.cjs <artifact-dir> <codex-binary>
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.argv[2] || '');
const binary = process.argv[3];
if (!artifacts.startsWith('/private/tmp/noted-model-input-repair-') || !binary) throw Error('explicit isolated paths required');
const fixture = fs.mkdtempSync(path.join(artifacts, 'pty-'));
const profile = path.join(fixture, 'codex-profile');
fs.mkdirSync(profile);
const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw Error(name); return node.getText(ast);
};
const variable = name => {
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    const d = statement.declarationList.declarations.find(n => n.name.getText(ast) === name);
    if (d) return 'const ' + d.getText(ast) + ';';
  }
  throw Error(name);
};
const log = (event, detail = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
  fs.appendFileSync(path.join(fixture, 'events.jsonl'), line + '\n');
  console.log(line);
};
let child, closed = false, held = false, chunks = [], sequence = 0, flushed = 0;
let stream = null, requests = 0, inputRevision = 1;
const streams = new Set();
const events = new EventEmitter();
const screen = new Terminal({ cols: 100, rows: 32, allowProposedApi: true, scrollback: 1000 });
const mirror = { generation: 'private-pty', writeSeq: 0, synchronizedFrameWaiters: new Set(), terminal: screen };
const fullScreen = () => {
  const b = screen.buffer.active;
  return Array.from({ length: screen.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) || '').join('\n');
};
const waitFor = (predicate, label, timeout = 15000) => new Promise((resolve, reject) => {
  let timer;
  const finish = (error) => { clearTimeout(timer); events.off('frame', check); events.off('http', check); error ? reject(error) : resolve(); };
  const check = () => { try { if (predicate()) finish(); } catch (error) { finish(error); } };
  events.on('frame', check); events.on('http', check);
  timer = setTimeout(() => finish(Error('timeout: ' + label + '\n' + fullScreen())), timeout);
  check();
});
const server = http.createServer((req, res) => {
  const body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(body).toString());
      log('local-request-shape', { model: data.model, inputItems: data.input?.length,
        instructionHead: String(data.instructions || '').slice(0, 100) });
    } catch {}
  });
  req.resume();
  log('local-http', { method: req.method, path: req.url });
  if (req.method === 'POST' && req.url.startsWith('/v1/responses')) {
    requests++;
    stream = res;
    streams.add(res);
    res.on('close', () => log('local-stream-close', { request: requests }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created',
      response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } }) + '\n\n');
    events.emit('http');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [], models: [] }));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  fs.writeFileSync(path.join(profile, 'config.toml'), `model = "gpt-6-sol"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "max"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[projects.${JSON.stringify(fixture)}]\ntrust_level = "trusted"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  child = pty.spawn(binary, ['--no-daemon', '--no-alt-screen', '-C', fixture], {
    name: 'xterm-256color', cols: 100, rows: 32, cwd: fixture,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8', CODEX_HOME: profile, DO_NOT_TRACK: '1' },
  });
  log('spawn', { pid: child.pid, fixture, profile, binary, port });
  child.onExit(e => { closed = true; log('exit', e); events.emit('frame'); });
  screen.onData(data => { log('terminal-reply', { escaped: JSON.stringify(data) }); child.write(data); });
  const feed = ({ data, seq }) => screen.write(data, () => {
    flushed = seq;
    events.emit('frame');
    for (const listener of [...mirror.synchronizedFrameWaiters]) listener();
  });
  child.onData(data => {
    fs.appendFileSync(path.join(fixture, 'pty.ansi'), data);
    mirror.writeSeq = ++sequence;
    const item = { data, seq: sequence };
    if (held) chunks.push(item); else feed(item);
  });
  const operations = [];
  const term = { write(data) { operations.push(data); log('source-write', { escaped: JSON.stringify(data) }); child.write(data); },
    onExit: handler => child.onExit(handler) };
  const queue = require('../src/main/codex-settings-mutation-queue').createCodexSettingsMutationQueue();
  const { createAgentInputObservation, observeAgentInput } = require('../src/main/agent-input-observation');
  const ctx = vm.createContext({
    ...require('../src/main/codex-model-picker'), ...require('../src/main/codex-tui-readiness'),
    queueMicrotask, setTimeout, clearTimeout, observeAgentInput,
    console: { log: message => log('main', { message }), warn: message => log('main-warning', { message }) },
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { isRunning: true, runSeq: 1 }]]),
    aiStoppingTabs: new Map(), codexLastRunCommandPayload: new Map([['T', { launchId: 'private-launch' }]]),
    getTerminalInputRevision: () => inputRevision, getTerminalStopRevision: () => 0,
    getTerminalLifecycleGeneration: () => 'private:1', getHeadlessTerminalMirror: () => mirror,
    getCodexWriterProofSnapshot: () => null, getCodexProvisionalSettingsSnapshot: () => null,
    codexSettingsMutationQueue: queue, ipcMain: events,
    codexTuiReadyTabs: new Set(['T']), codexLateMcpProofPending: new Map(), codexRuntimePolicies: null,
    emitAgentReadinessChanged: (_tabId, payload) => events.emit('agent:readiness-changed-internal', null, { tabId: 'T', ...payload }),
    pasteInflight: new WeakMap(), ptyActiveWriteOperation: new WeakMap(),
    ptyLastQueuedWriteOperation: new WeakMap(), ptyWriteOwners: new WeakMap(),
    recordComposerForensicPtyInput() {}, scheduleCodexModelEffortIntentReconcile: () => { log('intent-wake'); events.emit('frame'); },
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~', CODEX_SYNC_MARKER: '\x1b[?2026l',
    readCodexPickerWriteRefusal: () => null,
    createMainAgentInputObservation: (_tab, _tool, timeoutMs) => {
      const rev = inputRevision;
      return createAgentInputObservation({ timeoutMs, isCurrent: () => !closed && rev === inputRevision,
        subscribe(wake) { mirror.synchronizedFrameWaiters.add(wake); return () => mirror.synchronizedFrameWaiters.delete(wake); },
      });
    },
  });
  const names = ['describeXtermCellStyle', 'xtermStyleHasNonDefaultBg', 'getLogicalLineSnapshotAt', 'extractCodexDraftFromLine',
    'withPtyWriteLock', 'captureCodexOwnedSlashDraftIdentity', 'validateCodexOwnedSlashDraftIdentity',
    'releaseCodexOwnedModelInput', 'validateCodexOwnedModelInputIdentity', 'readCodexOwnedModelInputDecision',
    'waitForCodexOwnedModelPaste', 'reconcileCodexOwnedModelInputAtWriteBoundary', 'settleCodexOwnedModelInput',
    'retainCodexOwnedModelInput', 'inspectCodexOwnedSlashDraft', 'rollbackCodexOwnedSlashDraft', 'sendCodexSlashCommand'];
  vm.runInContext(['CODEX_NON_DRAFT_LINE_RE', 'CODEX_EMPTY_COMPOSER_HINT_RE'].map(variable).join('\n')
    + '\n' + names.map(declaration).join('\n'), ctx);
  const draft = () => {
    if (flushed !== sequence) return { success: true, hasDraft: null };
    const b = screen.buffer.active;
    const line = ctx.getLogicalLineSnapshotAt(b, b.baseY + b.cursorY);
    if (!ctx.hasCodexComposerPromptGlyph(line.text)) return { success: true, hasDraft: null };
    return { success: true, ...ctx.extractCodexDraftFromLine(line), source: 'headless-main:cursor:' + (b.baseY + b.cursorY),
      frameIdentity: { generation: mirror.generation, writeSeq: flushed } };
  };
  ctx.getHeadlessCodexDraftState = draft;
  const trustVisible = () => {
    const current = fullScreen();
    return current.includes('Trust this folder?') && current.includes(fixture)
      && current.includes('› 1. Trust and continue') && current.includes('enter continue · esc quit');
  };
  await waitFor(() => trustVisible() || (draft().hasDraft === false && /gpt-6-sol/i.test(fullScreen())), 'owned folder trust/ready');
  if (trustVisible()) { log('accept-private-folder'); child.write('\r'); }
  await waitFor(() => draft().hasDraft === false && /gpt-6-sol/i.test(fullScreen()), 'initial composer');
  const runDelayed = async label => {
    held = true;
    const before = operations.length;
    const result = await ctx.withPtyWriteLock(term, () => ctx.sendCodexSlashCommand(term, '/model', '[private-' + label + ']', { tabId: 'T' }));
    assert.equal(result.submitted, false);
    assert.ok(queue.getUnsubmittedInput(term));
    assert.equal(operations.length, before + 1);
    log('expired-owned', { label, heldChunks: chunks.length, result });
    held = false;
    const pending = chunks; chunks = []; pending.forEach(feed);
    await waitFor(() => !queue.getUnsubmittedInput(term) && draft().hasDraft === false, label + ' owned clear');
    assert.equal(closed, false);
    assert.deepEqual(operations.slice(before), ['\x01\x0b\x1b[200~/model\x1b[201~', '\x01\x0b']);
    fs.writeFileSync(path.join(fixture, label + '-after.txt'), fullScreen());
    log('owned-clear-pass', { label, draft: draft(), processAlive: !closed });
  };
  await runDelayed('idle');
  child.write('\x1b[200~MODEL_INPUT_FIXTURE_BUSY\x1b[201~');
  await waitFor(() => draft().hasDraft === true, 'fixture prompt visible');
  child.write('\r');
  await waitFor(() => requests === 1 && /Working|Thinking/.test(fullScreen()) && draft().hasDraft === false, 'local busy stream');
  await runDelayed('busy');
  assert.ok(requests >= 1);
  // Codex may make a separate title/preparation request for the same single
  // fixture prompt. No extra Enter was produced by the code under test.
  assert.ok([...streams].every(response => !response.destroyed), 'no local stream may be cancelled by cleanup');
  assert.equal(stream.destroyed, false, 'cleanup must not interrupt the active local response');
  assert.match(fullScreen(), /Working|Thinking/);
  const result = { success: true, fixture, pid: child.pid, requests, provider: 'loopback-only',
    cases: ['idle-late-echo', 'busy-late-echo'], noControlC: !operations.includes('\x03'), noEnter: !operations.includes('\r') };
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2));
  log('PASS', result);
})().catch(error => { console.error(error.stack); fs.writeFileSync(path.join(fixture, 'failure.txt'), error.stack + '\n' + fullScreen()); process.exitCode = 1; })
  .finally(async () => {
    if (child && !closed) {
      child.kill();
      await Promise.race([new Promise(resolve => child.onExit(resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    for (const response of streams) response.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    screen.dispose();
    log('cleanup', { processExited: closed });
    if (!closed) process.exitCode = 1;
  });

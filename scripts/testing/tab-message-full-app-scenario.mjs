// Specific full Noted acceptance, using two own native Codex actors.
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), sha = value => createHash('sha256').update(value).digest('hex');
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function fileEvent(root, name, timeout = 120000, accept = () => true) {
  const file = path.join(root, name);
  return new Promise((resolve, reject) => {
    let timer;
    const check = async () => {
      try { const result = JSON.parse(await fs.readFile(file, 'utf8')); if (!accept(result)) return;
        watcher.close(); clearTimeout(timer); resolve(result); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) { watcher.close(); clearTimeout(timer); reject(error); } }
    };
    const watcher = sync.watch(root, (_event, entry) => { if (entry === name) void check(); });
    timer = setTimeout(() => { watcher.close(); reject(Error('owned file event deadline: ' + name)); }, timeout);
    void check();
  });
}
function installAdmissionObserver() {
  const ipc = window.require('electron').ipcRenderer, invoke = ipc.invoke;
  const admissions = window.batchAcceptance.admissions = [];
  ipc.invoke = function (channel, ...args) {
    if (channel !== 'agent:enqueue-prompt') return invoke.call(this, channel, ...args);
    const input = args[0], entry = { tabId: input?.tabId, handoffId: input?.handoffId,
      source: input?.source, at: Date.now(), state: 'invoking' };
    if (admissions.length === 64) admissions.shift();
    admissions.push(entry);
    const failed = error => { Object.assign(entry, { state: 'threw', atEnd: Date.now(),
      error: String(error?.message || error).slice(0, 1500) }); throw error; };
    try {
      return invoke.call(this, channel, ...args).then(result => {
        Object.assign(entry, { state: 'returned', atEnd: Date.now(), code: result?.code,
          status: result?.status, submitted: result?.submitted, accepted: result?.accepted,
          deliveryUnknown: result?.deliveryUnknown, deferred: result?.deferred,
          error: typeof result?.error === 'string' ? result.error.slice(0, 1500) : null });
        return result;
      }, failed);
    } catch (error) { return failed(error); }
  };
}
export async function run({ root, source, repo, cfg, known, events, sample, guard, setApp, ports, fixtureSource }) {
  const { _electron } = await import('playwright');
  const O = require(path.join(root, 'helpers/owned-process.cjs'));
  const workspace = path.join(root, 'data/workspace'), apiPort = await port(), cdpPort = await port();
  assert.notEqual(apiPort, cdpPort);
  ports.add(apiPort); ports.add(cdpPort);
  await fs.copyFile(path.join(fixtureSource, 'tab-message-busy.cjs'), path.join(workspace, 'busy-work.cjs'));
  await fs.copyFile(path.join(fixtureSource, 'tab-message-model-client.cjs'), path.join(workspace, 'reply-client.cjs'));
  const profile = path.join(root, 'auth-profile.json');
  await fs.writeFile(profile, JSON.stringify({ ...cfg.auth, fixtureCwd: workspace }), { mode: 0o600 });
  const env = { PATH: path.dirname(process.execPath) + ':' + path.join(process.env.HOME, '.local/bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'temp'), LANG: 'en_US.UTF-8',
    NODE_ENV: 'production', NOTED_E2E_TEST: 'true', NOTED_E2E_USE_BUILT_RENDERER: 'true',
    NOTED_E2E_CLI_ISOLATION_ROOT: path.join(root, 'data'), NOTED_USER_DATA_DIR: path.join(root, 'data/app'),
    NOTED_DISCOVERY_DIR: path.join(root, 'data/discovery'), CODEX_HOME: path.join(root, 'data/codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'data/claude'),
    NOTED_SHARED_FILE_EXPLORER_DB_PATH: path.join(root, 'data/explorer.sqlite'),
    NOTED_CODEX_AUTH_PROFILE_CONFIG: profile, NOTED_WEB_PORT: String(apiPort), NOTED_CDP_PORT: String(cdpPort),
  };
  await sample(); guard();
  let app, main, page;
  async function boot() {
    await sample(); guard();
    app = await _electron.launch({ executablePath: require('electron'), args: [source], cwd: source, env, timeout: 30000 });
    setApp(app);
    const child = app.process(), tails = {};
    for (const stream of ['stdout', 'stderr']) {
      const state = tails[stream] = { bytes: 0, retained: Buffer.alloc(0) };
      child[stream].on('data', data => {
        state.bytes += data.length;
        state.retained = Buffer.concat([state.retained, data.subarray(-256 * 1024)]).subarray(-256 * 1024);
      });
    }
    child.once('close', () => {
      for (const [stream, state] of Object.entries(tails)) {
        sync.writeFileSync(path.join(root, 'MAIN-' + child.pid + '-' + stream + '.log'), state.retained);
        events.push({ kind: 'main-stream-tail', pid: child.pid, stream, totalBytes: state.bytes,
          retainedBytes: state.retained.length, omittedBytes: state.bytes - state.retained.length });
      }
    });
    main = await O.observe(app.process().pid); assert.equal(main.state, 'found'); assert.equal(main.cwd, source);
    known.set(main.pid, main); events.push({ kind: 'own-app-launched', main, source, branch: 'full built unpackaged' });
    page = await app.firstWindow();
  page.on('pageerror', error => events.push({ kind: 'renderer-error', error: error.message.slice(0, 1000) }));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) events.push({ kind: 'renderer-console-' + message.type(), error: message.text().slice(0, 1500) }); });
  await page.waitForFunction(() => document.querySelector('#react-root')?.children.length > 0, undefined, { timeout: 30000 });
  assert(page.url().startsWith('file:') && page.url().includes('/dist/renderer/index.html'), 'no Vite or fixture-only renderer');
  await page.evaluate(() => {
    const ipc = window.require('electron').ipcRenderer;
    const proof = window.batchAcceptance = { messages: [], receipts: [], busy: [], readiness: [] };
    ipc.on('tab-messages:changed', (_event, packet) => {
      const m = packet.message;
      proof.messages.push({ messageId: m.messageId, replyTo: m.replyTo, replyToIds: m.replyToIds,
        deliveryState: m.deliveryState, waitState: m.loopWait?.state, sourceDismissedAt: m.sourceDismissedAt });
    });
    ipc.on('agent:send-queue-receipt', (_event, r) => proof.receipts.push({ operationKey: r.operationKey, attemptId: r.attemptId,
      state: r.state, tabId: r.tabId, handoffId: r.handoffId, surface: r.surface,
      userUuid: r.auditIdentity?.entryUuid, sourceIdentity: r.auditIdentity?.sourceIdentity,
      provider: r.provider, sessionId: r.sessionId, promptHash: r.promptHash, observedAt: Date.now() }));
    ipc.on('codex:busy-state', (_event, data) => proof.busy.push({ tabId: data.tabId, busy: data.busy, turnId: data.turnId, reason: data.reason, observedAt: Date.now() }));
    ipc.on('agent:readiness-changed', (_event, data) => proof.readiness.push(data));
    });
    await page.evaluate(installAdmissionObserver);
    const discovery = await fileEvent(path.join(root, 'data/discovery'), 'web-server-' + main.pid + '.json', 20000);
    assert.equal(discovery.pid, main.pid); assert.equal(discovery.port, apiPort, 'no fallback to another app');
  }
  await boot();
  const tokenFile = path.join(root, 'data/discovery/web-token.txt');
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  let apiInputs = 0;
  async function api(route, body) {
    guard(); await sample();
    const response = await fetch('http://127.0.0.1:' + apiPort + route, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000),
    });
    const value = await response.json();
    events.push({ kind: 'api', route, status: response.status, messageId: value.messageId, deliveryState: value.deliveryState });
    assert(response.ok, route + ': ' + JSON.stringify(value).slice(0, 1200)); return value;
  }
  const me = await api('/api/me'); assert.equal(me.capabilities.tabMessages.batchReply.version, 1);
  assert.equal(me.capabilities.tabMessages.loopWait.naturalReturnRequired, false);
  const models = await api('/api/agent-models');
  if (cfg.modelSelection.kind === 'catalog') assert(models.codex.some(model => model.id === cfg.modelSelection.id));
  const resolvedModel = await api('/api/agent-models/resolve', { provider: 'codex', modelSelection: cfg.modelSelection });
  assert.equal(resolvedModel.model, cfg.modelSelection.id);
  await fs.writeFile(path.join(root, 'MODEL-SELECTION.json'), JSON.stringify({ requested: cfg.modelSelection,
    resolved: resolvedModel, visibleInPrivateCatalog: models.codex.some(model => model.id === cfg.modelSelection.id),
    note: 'same explicitly selected Luna ID; custom selection is an existing App API contract, not fallback to a different model/account' }, null, 2));
  const priorActors = cfg.reuseUnsentActors ? JSON.parse(await fs.readFile(path.join(root, 'ACTORS.json'), 'utf8')) : null;
  const a = priorActors?.a || await api('/api/agent-tabs', { toolType: 'codex', cwd: workspace, name: 'Batch-A', placement: 'root',
    background: false, modelSelection: cfg.modelSelection, effort: cfg.effort });
  const b = priorActors?.b || await api('/api/agent-tabs', { toolType: 'codex', cwd: workspace, name: 'Batch-B', placement: 'root',
    background: false, modelSelection: cfg.modelSelection, effort: cfg.effort, sourceTabId: a.tabId });
  assert(a.tabId && b.tabId && a.tabId !== b.tabId);
  if (priorActors) {
    assert.equal(a.cwd, workspace); assert.equal(b.cwd, workspace);
    const old = await api('/api/terminal-tabs/' + a.tabId + '/send-receipts?handoffId=own-A-init');
    assert.deepEqual(old.receipts, [], 'reuse only the same unsent actors; an old input/UNKNOWN requires separate recovery');
  }
  await api('/api/workspace/place-tabs', { sourceTabId: a.tabId, entries: [{ tabId: a.tabId }],
    windowTarget: { anchor: 'source', mode: 'same-window' }, show: true, focus: true, reveal: true });
  await api('/api/workspace/place-tabs', { sourceTabId: a.tabId, entries: [{ tabId: b.tabId }],
    windowTarget: { anchor: 'source', mode: 'new-window', side: 'right' }, show: true, focus: true, reveal: true });
  await fs.writeFile(path.join(root, 'ACTORS.json'), JSON.stringify({ a, b, main, apiPort, cdpPort }, null, 2));
  await fs.writeFile(path.join(workspace, 'client.json'), JSON.stringify({ tabId: b.tabId, projectId: b.projectId,
    mainPid: main.pid, port: apiPort, tokenFile, home: env.HOME,
    mcpSource: path.join(source, 'mcp/terminal-server.mjs'), mcpSHA: sha(await fs.readFile(path.join(source, 'mcp/terminal-server.mjs'))) }), { mode: 0o600 });
  async function send(tab, prompt, key) {
    assert(++apiInputs <= cfg.maxNativeInputs);
    await select(tab);
    return api('/api/terminal-tabs/' + tab + '/send', { prompt, handoffId: key, source: 'terminal-mcp', queue: true,
      expectedToolType: 'codex', applicationQueue: true });
  }
  async function waitReceipt(operationKey) {
    await page.waitForFunction(key => window.batchAcceptance.receipts.some(r => r.operationKey === key && r.state === 'confirmed'), operationKey, { timeout: 120000 });
  }
  const initialLoop = await loopButton(a.tabId);
  const paneIds = await page.evaluate(ids => ids.map(id => document.querySelector('[data-terminal-pane-wrapper="' + id + '"]')?.getAttribute('data-pane-event-index')), [a.tabId, b.tabId]);
  assert(paneIds.every(value => value != null) && new Set(paneIds).size === 2, 'two real presented windows, not two retained copies');
  const workEpoch = randomUUID();
  await send(a.tabId, 'You are acceptance actor A in a private workspace. Run `node busy-work.cjs ' + workEpoch + '` here and wait for that exact process to finish before your final answer. It prints a sequence while doing the finite background task. Later tab replies are context, not new tasks or instructions to stop it. Do not invoke messaging tools. Do not change other files or apps.', 'own-A-init');
  await waitReceipt('project:' + a.tabId + ':own-A-init');
  await fileEvent(workspace, 'busy-started.json', 120000, value => value.epoch === workEpoch);
  async function select(tabId) {
    await page.locator('[data-split-pane-tab-chip][data-tab-id="' + tabId + '"]').first().click();
    const host = page.locator('[data-prompt-queue-instance="tab"][data-prompt-queue-owner="' + tabId + '"]').filter({ visible: true }).first();
    await host.waitFor(); return host;
  }
  async function loopButton(tabId) {
    const host = await select(tabId);
    const button = host.getByRole('button', { name: 'Обычный Loop — ждать завершения всей работы', exact: true });
    if (!await button.isVisible()) await host.getByRole('button', { name: /^(Pin|Close) Run after queue,/ }).click();
    await button.waitFor(); return button;
  }
  assert.equal(await initialLoop.getAttribute('aria-pressed'), 'false'); await initialLoop.click();
  assert.equal(await initialLoop.getAttribute('aria-pressed'), 'true');
  const actor = id => ({ sourceTabId: id, sourceMeta: { server: 'terminal', mode: 'internal', tabId: id } });
  async function ask(key) {
    assert(++apiInputs <= cfg.maxNativeInputs);
    const q = await api('/api/tab-messages', { ...actor(a.tabId), targetTabId: b.tabId, text: key + ': retain this ID and await the COMMIT instruction; do not send a separate answer yet.', requestId: key });
    await page.waitForFunction(id => window.batchAcceptance.messages.some(m => m.messageId === id && m.deliveryState === 'sent'), q.messageId, { timeout: 120000 });
    return q.messageId;
  }
  async function commit(ids, text, key) {
    const requestId = 'native-batch-' + sha(JSON.stringify([ids, text])).slice(0, 32);
    const command = 'node reply-client.cjs ' + "'" + JSON.stringify(ids) + "' '" + text + "'";
    await send(b.tabId, 'COMMIT: run exactly `' + command + '` once in this workspace. This invokes the actual Reply dispatcher against only this isolated app. Use the explicit IDs, keep the one common answer text. Do not call another messaging tool. Report its output.', key);
    const result = await fileEvent(workspace, 'reply-' + requestId + '.json');
    assert.equal(result.result.messages.length, 1); assert.equal(result.calls.filter(c => c.method === 'POST').length, 1);
    const id = result.result.messages[0].messageId;
    assert(++apiInputs <= cfg.maxNativeInputs);
    await page.waitForFunction(id => window.batchAcceptance.messages.some(m => m.messageId === id && m.deliveryState === 'sent'), id, { timeout: 120000 });
    return result;
  }
  const q1 = await ask('Q1'), first = await commit([q1], 'ONE-FIRST-ANSWER', 'own-B-commit1');
  const q2 = await ask('Q2'), q3 = await ask('Q3');
  let host = await select(a.tabId);
  await host.locator('[data-tab-message-tracker] [data-tab-message-dismiss="' + q3 + '"]').click();
  const hidden = await api('/api/tab-messages/' + q3); assert(hidden.message.sourceDismissedAt); assert.equal(hidden.message.cancelledAt, null);
  const mixed = await commit([q1, q2, q3], 'ONE-COMMON-MIXED-ANSWER', 'own-B-commit2');
  assert.deepEqual(mixed.result.results.map(r => r.status), ['already-answered', 'reply-created', 'reply-created']);
  const pair2 = await api('/api/tab-messages/' + q2), pair3 = await api('/api/tab-messages/' + q3);
  assert.equal(pair2.reply.messageId, pair3.reply.messageId); assert.deepEqual(pair2.reply.replyToIds, [q2, q3]);
  assert.equal((await api('/api/tab-messages/' + q1)).reply.messageId, first.result.messages[0].messageId);
  const inspection = await api('/api/terminal-tabs/inspect?tabIds=' + encodeURIComponent(JSON.stringify([a.tabId])) + '&maxPreviewChars=0');
  assert.equal(inspection.tabs[0].runtime.busy, true, 'exchange completed while the source still works');
  host = await select(a.tabId);
  await host.locator('[data-orchestration-history-button]').click();
  for (const id of [q1, q2, q3]) {
    const row = page.locator('[data-orchestration-history-panel] [data-tab-message-history-row="' + id + '"]'); await row.waitFor();
    for (const stage of ['send', 'reply']) assert.equal(await row.locator('[data-tab-message-stage="' + stage + '"]').evaluate(node => getComputedStyle(node).color), 'rgb(74, 222, 128)');
  }
  await page.screenshot({ path: path.join(root, 'mixed-history.png') });
  await page.keyboard.press('Escape');
  const afterEscape = await api('/api/terminal-tabs/inspect?tabIds=' + encodeURIComponent(JSON.stringify([a.tabId])) + '&maxPreviewChars=0');
  assert.equal(afterEscape.tabs[0].runtime.busy, true, 'popup Escape must not Stop the source');
  assert.equal(await host.locator('[data-tab-message-tracker] [data-tab-message-row]').count(), 0);
  const ids = [await ask('Q4'), await ask('Q5'), await ask('Q6')];
  const hostB = await select(b.tabId);
  await hostB.locator('[data-tab-message-tracker] [data-tab-message-dismiss="' + ids[0] + '"]').click();
  assert.equal((await api('/api/tab-messages/' + ids[0])).message.loopWait.state, 'waiting', 'B local X cannot release A');
  const all = await commit([ids[2], ids[0], ids[1]], 'ONE-THREE-QUESTION-ANSWER', 'own-B-commit3');
  const links = [];
  for (const id of ids) links.push((await api('/api/tab-messages/' + id)).reply.messageId);
  assert.equal(new Set(links).size, 1); assert.equal(links[0], all.result.messages[0].messageId);
  host = await select(a.tabId);
  assert.equal((await page.evaluate(tab => window.batchAcceptance.receipts.filter(r => r.tabId === tab && r.surface === 'desktop-history' && r.state === 'confirmed').length, a.tabId)), 0,
    'no Loop user input while the original source remains busy, even after message delivery/local X');
  assert.equal(await page.evaluate(tab => window.batchAcceptance.busy.some(r => r.tabId === tab && r.reason === 'turn_aborted'), a.tabId), false);
  const workReleaseAt = Date.now(); events.push({ kind: 'work-release', workEpoch, at: workReleaseAt });
  await fs.writeFile(path.join(workspace, 'finish-work'), JSON.stringify({ epoch: workEpoch }));
  const workFinished = await fileEvent(workspace, 'busy-finished.json', 10000, value => value.epoch === workEpoch);
  assert.equal(workFinished.reason, 'released');
  const loopObservation = await Promise.race([
    page.waitForFunction(tab => window.batchAcceptance.receipts.some(r => r.tabId === tab && r.surface === 'desktop-history' && r.state === 'confirmed')
      || window.batchAcceptance.admissions.some(r => r.tabId === tab && r.source === 'prompt-loop'
        && (r.state === 'threw' || r.deliveryUnknown || r.deferred || r.submitted === false)), a.tabId, { timeout: 120000 }).then(() => null),
    page.waitForEvent('console', { timeout: 120000, predicate: message => message.type() === 'error'
      && message.text().includes('retain interrupted automatic send owner=' + a.tabId) }).then(message => message.text()),
  ]);
  assert.equal(loopObservation, null, 'Root failed around enqueue: ' + loopObservation);
  const loopAdmission = await page.evaluate(tab => ({ admissions: window.batchAcceptance.admissions.filter(r => r.tabId === tab && r.source === 'prompt-loop'),
    confirmed: window.batchAcceptance.receipts.some(r => r.tabId === tab && r.surface === 'desktop-history' && r.state === 'confirmed') }), a.tabId);
  assert(loopAdmission.confirmed, 'Loop admission did not deliver: ' + JSON.stringify(loopAdmission.admissions));
  assert(++apiInputs <= cfg.maxNativeInputs);
  const stopLoop = await loopButton(a.tabId); await stopLoop.click();
  assert.equal(await stopLoop.getAttribute('aria-pressed'), 'false');
  const proof = await page.evaluate(() => window.batchAcceptance);
  const sourceTurn = proof.busy.find(r => r.tabId === a.tabId && r.reason === 'task_started')?.turnId;
  assert(sourceTurn && proof.busy.some(r => r.tabId === a.tabId && r.turnId === sourceTurn
    && r.reason === 'task_complete' && r.observedAt >= workFinished.finishedAt), 'same source work must end naturally, not a later reply turn');
  const loopOperations = new Set(proof.receipts.filter(r => r.tabId === a.tabId && r.surface === 'desktop-history' && r.state === 'confirmed').map(r => r.operationKey));
  assert.equal(loopOperations.size, 1, 'one actual natural-cause dispatch, not a synthetic delivery cause');
  assert(proof.receipts.filter(r => loopOperations.has(r.operationKey)).every(r => r.observedAt >= workReleaseAt));
  const native = new Map(proof.receipts.filter(r => r.state === 'confirmed').map(r => [r.operationKey, r]));
  const returnIds = [first, mixed, all].map(value => value.result.messages[0].messageId);
  for (const id of returnIds) {
    const receipt = native.get('tab-message:' + id); assert(receipt?.attemptId && (receipt.userUuid || receipt.sourceIdentity));
  }
  await sample();
  await fs.writeFile(path.join(root, 'FORWARD-RESULT.json'), JSON.stringify({ status: 'FORWARD_RUNTIME_PASS',
    a, b, questionIds: [q1, q2, q3, ...ids], returnIds, native: [...native.values()], proof, workReleaseAt, workFinished, sourceTurn,
    cases: { mixed: true, threeWaiting: true, outOfOrder: true, sourceBusyAtSettlement: true,
      localOutgoingX: true, localIncomingX: true, greenHistory: true, automaticHide: true,
      restart: false, timeoutLateReply: false, loopOnce: true }, apiInputs,
    controlledPorts: ['MCP instance/token lookup routes to this private App instead of the shared hub; actual dispatcher and HTTP remain used'],
    realParticipants: ['full built Noted Main/renderer/SQLite/FIFO', 'two native authenticated Codex TUI actors', 'native B exec tool invokes the Reply client', 'actual native user audit receipts'],
    loadedUserApp: false }, null, 2) + '\n');

  // One real unanswered question is retained across an own-App restart. Only
  // its private wait clock input is aged offline, not its delivery/IDs/receipts.
  const timeoutQ = await ask('Q-TIMEOUT');
  const original = await api('/api/tab-messages/' + timeoutQ);
  await fs.writeFile(path.join(root, 'TIMEOUT-BEFORE.json'), JSON.stringify(original, null, 2));
  let closeDeadline;
  try { await Promise.race([app.close(), new Promise((_, reject) => {
    closeDeadline = setTimeout(() => reject(Error('own restart normal Quit deadline')), 20000);
  })]); } finally { clearTimeout(closeDeadline); }
  setApp(null);
  for (const identity of known.values()) assert.equal((await O.observe(identity.pid)).state, 'absent', 'normal own-App shutdown before offline fixture');
  const dbFile = path.join(root, 'data/app/noted-terminal-dev.db'); assert(sync.existsSync(dbFile));
  const clockScript = `const D=require(${JSON.stringify(path.join(repo, 'node_modules/better-sqlite3'))});const db=new D(${JSON.stringify(dbFile)});
    const row=db.prepare('SELECT value FROM tab_message_loop_waits WHERE questionId=?').get(${JSON.stringify(timeoutQ)});if(!row)throw Error('missing own wait');
    const entry=JSON.parse(row.value),before=entry.deadlineAt;entry.deadlineAt=Date.now()-1;
    db.prepare('UPDATE tab_message_loop_waits SET value=? WHERE questionId=?').run(JSON.stringify(entry),${JSON.stringify(timeoutQ)});
    console.log(JSON.stringify({questionId:${JSON.stringify(timeoutQ)},before,after:entry.deadlineAt,controlled:'private offline wait-clock input; production deadline and native receipts unchanged'}));db.close();`;
  const { spawnSync } = await import('node:child_process');
  const aged = spawnSync(require('electron'), ['-e', clockScript], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(aged.status, 0, aged.stderr); await fs.writeFile(path.join(root, 'TIMEOUT-CLOCK-FIXTURE.json'), aged.stdout);
  await boot();
  for (const id of [q1, q2, q3, ...ids]) {
    const stored = await api('/api/tab-messages/' + id);
    assert(stored.reply && returnIds.includes(stored.reply.messageId), 'reopen preserves exact common links');
  }
  assert((await api('/api/tab-messages/' + q3)).message.sourceDismissedAt);
  assert((await api('/api/tab-messages/' + ids[0])).message.targetDismissedAt);
  const reopenedHost = await select(a.tabId);
  for (const id of [q1, q2, q3, ...ids]) assert.equal(await reopenedHost.locator('[data-tab-message-tracker] [data-tab-message-row="' + id + '"]').count(), 0);
  await reopenedHost.locator('[data-orchestration-history-button]').click();
  const q2Row = page.locator('[data-orchestration-history-panel] [data-tab-message-history-row="' + q2 + '"]');
  await q2Row.waitFor(); await q2Row.locator('[data-tab-message-open]').click();
  const preview = page.locator('[data-tab-message-preview="' + q2 + '"]'); await preview.waitFor();
  await preview.locator('[data-tab-message-body="' + pair2.reply.messageId + '"] > summary').click();
  await preview.locator('[data-tab-message-source="' + b.tabId + '"]').click();
  await page.locator('[data-split-pane-tab-chip][data-tab-id="' + b.tabId + '"][data-chip-shown="1"]').first().waitFor();
  await preview.waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(root, 'reopened-navigation.png') });
  const timed = await api('/api/tab-messages/' + timeoutQ);
  assert.equal(timed.message.loopWait.state, 'settled'); assert.equal(timed.message.loopWait.disposition, 'reply_timeout');
  await fs.writeFile(path.join(workspace, 'client.json'), JSON.stringify({ tabId: b.tabId, projectId: b.projectId,
    mainPid: main.pid, port: apiPort, tokenFile, home: env.HOME,
    mcpSource: path.join(source, 'mcp/terminal-server.mjs'), mcpSHA: sha(await fs.readFile(path.join(source, 'mcp/terminal-server.mjs'))) }), { mode: 0o600 });
  const late = await commit([timeoutQ], 'ONE-LATE-ANSWER', 'own-B-commit-late');
  const lateStored = await api('/api/tab-messages/' + timeoutQ);
  assert.equal(lateStored.reply.messageId, late.result.messages[0].messageId);
  assert.equal(lateStored.message.loopWait.settlement.kind, 'reply-delivered');
  const organization = await api('/api/workflow-organization');
  const workflowId = 'own-batch-' + randomUUID();
  const otherDefault = path.join(root, 'data/other-workflow-default'); await fs.mkdir(otherDefault);
  await api('/api/workflows', { mutationId: 'create-' + workflowId, expectedRevision: organization.publication.revision,
    workflow: { id: workflowId, name: 'Batch Other', defaultCwd: otherDefault, layout: {} } });
  const afterCreate = await api('/api/workflow-organization');
  const member = afterCreate.tabs.find(tab => tab.tabId === b.tabId).membership;
  await api('/api/workflow-organization/mutations', { kind: 'moveTab', request: {
    mutationId: 'move-' + workflowId, expectedRevision: afterCreate.publication.revision,
    tabId: b.tabId, workflowId, expectedMembershipRevision: member.revision } });
  await page.locator('[data-workflow-chip="' + workflowId + '"]').first().click();
  const sidebarB = page.locator('[data-workflow-tab-sidebar="' + workflowId + '"] [data-workflow-reserve-tab="' + b.tabId + '"]');
  await sidebarB.click();
  await page.locator('[data-split-pane-tab-chip][data-tab-id="' + b.tabId + '"][data-chip-shown="1"]').first().waitFor();
  const crossQ = await ask('Q-CROSS-WORKFLOW');
  const cross = await commit([crossQ], 'ONE-CROSS-WORKFLOW-ANSWER', 'own-B-commit-cross-workflow');
  const stable = await api('/api/terminal-tabs/inspect?tabIds=' + encodeURIComponent(JSON.stringify([a.tabId, b.tabId])) + '&maxPreviewChars=0');
  assert.equal(stable.tabs.find(tab => tab.tabId === a.tabId).sessionId, pair2.reply.targetSessionId);
  assert.equal(stable.tabs.find(tab => tab.tabId === b.tabId).sessionId, pair2.reply.sourceSessionId);
  const moved = await api('/api/workflow-organization');
  for (const id of [a.tabId, b.tabId]) assert.equal(moved.tabs.find(tab => tab.tabId === id).executionSubject.cwd, workspace);
  const targetHost = await select(b.tabId);
  await targetHost.locator('[data-orchestration-history-button]').click();
  const incomingCrossRow = page.locator('[data-orchestration-history-panel] [data-tab-message-history-row="' + crossQ + '"]');
  await incomingCrossRow.locator('[data-tab-message-source="' + a.tabId + '"]').click();
  await page.locator('[data-split-pane-tab-chip][data-tab-id="' + a.tabId + '"][data-chip-shown="1"]').first().waitFor();
  const sourceHost = await select(a.tabId);
  await sourceHost.locator('[data-orchestration-history-button]').click();
  const crossRow = page.locator('[data-orchestration-history-panel] [data-tab-message-history-row="' + crossQ + '"]');
  await crossRow.locator('[data-tab-message-open]').click();
  const crossPreview = page.locator('[data-tab-message-preview="' + crossQ + '"]');
  await crossPreview.locator('[data-tab-message-body="' + cross.result.messages[0].messageId + '"] > summary').click();
  await crossPreview.locator('[data-tab-message-source="' + b.tabId + '"]').click();
  await crossPreview.waitFor({ state: 'hidden' });
  await page.locator('[data-workflow-tab-sidebar="' + workflowId + '"]').waitFor();
  await page.locator('[data-split-pane-tab-chip][data-tab-id="' + b.tabId + '"][data-chip-shown="1"]').first().waitFor();
  const trace = await page.evaluate(() => window.batchAcceptance);
  await fs.writeFile(path.join(root, 'SCENARIO-RESULT.json'), JSON.stringify({ status: 'PASS',
    branch: 'full built unpackaged', a, b, questionIds: [q1, q2, q3, ...ids, timeoutQ, crossQ],
    returnIds: [...returnIds, lateStored.reply.messageId, cross.result.messages[0].messageId], apiInputs, forwardProof: proof, restartedProof: trace,
    workReleaseAt, workFinished, sourceTurn,
    cases: { mixed: true, threeWaiting: true, outOfOrder: true, sourceBusyAtSettlement: true,
      localOutgoingX: true, localIncomingX: true, greenHistory: true, automaticHide: true, restart: true,
      timeoutLateReply: true, loopOnce: true, popupEscapeNoStop: true, sameSourceNaturalCause: true, reopenedHiddenCards: true,
      reopenedSourceNavigation: true, twoWindows: true, crossWorkflow: true, sidebarNavigation: true, executionIdentityPreserved: true },
    sourceNavigationBoundary: 'participant-tab links; exact MCP source-jump is covered by separate real parser/facade finite controls, not this exec-client carrier',
    controlledPorts: ['MCP instance/token lookup binds the native client to its own private App, not the shared hub',
      'private offline wait clock aged for timeout/restart; no change to production30min limit or native receipts'],
    realParticipants: ['full frozen Noted Main/renderer/SQLite/FIFO', 'two authenticated native Codex actors',
      'native B exec tool -> actual MCP dispatcher -> actual authenticated HTTP -> native A user audit', 'actual trusted CDP X/navigation/history/Loop'],
    loadedUserApp: false, packagedAcceptance: false }, null, 2) + '\n');
}

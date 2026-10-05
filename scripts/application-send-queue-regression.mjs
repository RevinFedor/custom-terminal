#!/usr/bin/env node
// Private actual History/composer + AgentSendQueue/SQLite acceptance. Provider
// execution/presence/audit is controlled; no production, PTY or provider exists.
// Run only after the source owner declares the checkpoint ready:
//   node scripts/application-send-queue-regression.mjs
// --build-only prepares immutable source/bundle without starting Electron.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-application-send-queue-'));
const snapshot = path.join(artifact, 'source');
const freezeFrom = process.env.NOTED_APPLICATION_QUEUE_SOURCE || repo;
const buildOnly = process.argv.includes('--build-only');
const result = { artifact, status: 'preparing', checks: [], errors: [], visualProblems: [], providers: {},
  frozenFrom: freezeFrom,
  boundary: { actual: ['private Electron trusted UI', 'HistoryPanel and composer', 'agentScenarios physical path',
    'AgentSendQueue and durable receipt store on private SQLite', 'receipt hydration/cancel/reopen'],
  controlled: ['busy provider presence', 'physical provider transport result', 'exact canonical audit event',
    'small canonical History fixture'], excluded: ['real provider/TUI/PTY', 'production state', 'real tab mutations'] } };
let app, page;
const rendererLogs = [];

function startFixtureMain(config) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const Database = require(config.modules + '/better-sqlite3');
  const { AgentSendQueue } = require(config.source + '/src/main/agent-send-queue');
  const { createAgentSendReceiptStore } = require(config.source + '/src/main/agent-send-receipt-store');
  const { fingerprintAgentSendRequest } = require(config.source + '/src/main/agent-send-receipt-registry');
  const { promptAuditFingerprint } = require(config.source + '/src/main/prompt-audit-fingerprint');
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  const state = { requests: [], sends: [], events: [], calls: [], unknown: [], forbidden: [],
    cancellations: [], audits: [], dispatchErrors: [], startup: [], ready: false };
  const pending = new Map();
  const heldCanonical = new Map();
  const holdCanonical = new Set();
  const histories = new Map(['codex', 'claude'].map(provider => [provider, [
    { uuid: provider + '-fixture-user', role: 'user', sessionId: 'application-queue-session-' + provider,
      timestamp: '2026-10-04T00:00:00.000Z', content: 'Synthetic original user prompt.' },
    { uuid: provider + '-fixture-answer', role: 'assistant', sessionId: 'application-queue-session-' + provider,
      timestamp: '2026-10-04T00:00:01.000Z', content: 'Provider is streaming. Add messages while this response remains busy.' },
  ]]));
  let window, db, store, queue;
  const providerOf = tabId => String(tabId).endsWith('claude') ? 'claude' : 'codex';
  const sid = provider => 'application-queue-session-' + provider;
  const notify = (channel, detail) => { if (window && !window.isDestroyed()) window.webContents.send(channel, detail); };
  const identity = request => ({ operationKey: request.sendOperationKey, surface: 'desktop-history',
    tabId: request.tabId, handoffId: request.handoffId, provider: request.toolType,
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(request.prompt),
    promptLength: request.prompt.length, sessionId: sid(request.toolType) });
  function openQueue() {
    db = new Database(config.database);
    store = createAgentSendReceiptStore(db);
    queue = new AgentSendQueue({ store, ready: () => state.ready,
      publish: record => {
        state.events.push({ operationKey: record.operationKey, state: record.state,
          queueState: record.applicationQueue?.state, attemptId: record.attemptId });
        notify('agent:send-queue-receipt', record);
      },
      execute: request => {
        const begun = store.beginAttempt(identity(request));
        assert.equal(begun.action, 'attempt-started');
        return new Promise((resolve, reject) => {
          pending.set(request.sendOperationKey, { resolve, reject });
          notify('fixture:dispatch', { ...request, sendAttemptId: begun.attemptId,
            sendOperationKey: request.sendOperationKey });
        });
      },
    });
  }
  openQueue();
  ipcMain.on('fixture:dispatch-result', (_event, payload) => {
    const item = pending.get(payload.operationKey); if (!item) throw Error('unknown dispatch result');
    pending.delete(payload.operationKey);
    if (payload.result?.success === false) state.dispatchErrors.push(payload.result);
    item.resolve(payload.result);
  });
  const sendTarget = provider => ({ toolType: provider, sessionId: sid(provider),
    lifecycleGeneration: 'queue-fixture-generation', terminalInstanceId: 'queue-fixture-terminal-' + provider,
    launchId: 'queue-fixture-launch-' + provider, turnId: 'queue-fixture-current-turn' });
  function providerTransport(provider, tabId, text, options) {
    const record = store.get(options.sendOperationKey);
    assert.equal(record.tabId, tabId); assert.equal(record.provider, provider);
    assert.equal(record.attemptId, options.sendAttemptId);
    assert.equal(record.promptHash, promptAuditFingerprint(text));
    state.sends.push({ tabId, provider, text, options: JSON.parse(JSON.stringify(options)),
      operationKey: record.operationKey, handoffId: record.handoffId, attemptId: record.attemptId,
      countWhileBusy: state.sends.filter(send => send.provider === provider).length + 1 });
    notify('fixture:provider-write', { operationKey: record.operationKey, provider, handoffId: record.handoffId });
    store.markAttemptState(record.operationKey, record.attemptId, 'enter-armed');
    store.settleAttempt(record.operationKey, record.attemptId,
      { success: true, accepted: true, submitted: true, pasteWritten: true, enterWritten: true,
        status: 'audit-pending', auditPending: true });
    store.markProviderQueueAccepted(record.operationKey, record.attemptId, { provider, sessionId: sid(provider),
      sourceIdentity: provider + '-fixture-provider-queue:' + record.handoffId });
    return { ...store.get(record.operationKey).receipt, success: true, accepted: true, submitted: true,
      pasteWritten: true, enterWritten: true, status: 'audit-pending', auditPending: true,
      sendOperationKey: record.operationKey, sendAttemptId: record.attemptId };
  }
  async function invoke(channel, args) {
    state.calls.push(channel); const input = args[0];
    if (channel === 'agent:enqueue-prompt') {
      const request = JSON.parse(JSON.stringify({ ...input,
        sendOperationKey: 'history:' + input.tabId + ':' + input.handoffId }));
      state.requests.push(request);
      const admitted = queue.enqueue({ identity: identity(request), request });
      assert.equal(admitted.ok, true); return admitted.receipt;
    }
    if (channel === 'agent:send-queue-ready') { state.ready = input === true; if (state.ready) queue.resume(); return { success: true }; }
    if (channel === 'agent:cancel-queued-send') {
      const answer = queue.cancelWaiting(input.tabId, input.handoffId, { dismiss: true });
      state.cancellations.push({ ...input, ...answer }); return answer;
    }
    if (channel === 'agent:list-send-receipts' || channel === 'agent:get-send-receipts') {
      return { success: true, records: store.list(input || {}).map(record => queue.projectRecord(record)) };
    }
    if (channel === 'agent:acknowledge-send-receipt-presentation') return store.acknowledgePresentation(input);
    if (channel === 'codex:send-command') return providerTransport('codex', input, args[1], args[2]);
    if (channel === 'terminal:paste') return providerTransport('claude', input.tabId, input.content, input);
    if (channel === 'codex:get-runtime-projection' || channel === 'codex:get-runtime-session') return {
      success: true, projectId: 'application-queue-project', sessionStatus: 'busy', busy: true, inputReady: true,
      liveLifecycle: true, sessionId: sid('codex'), readSessionId: sid('codex'), readIdentitySource: 'live-writer',
      savedSessionId: sid('codex'), conversationMaterialized: true, timelineCount: 1,
      materializationReason: 'fixture', canCopySessionId: true, hasTerm: true, lastNotReady: null,
      startupFailed: false, startupError: null, manualActionRequired: false, manualActionType: null, lifecycleWarning: null,
      hasWatcher: true, catchUpPending: false, outcomeKnown: false, lastOutcomeReason: null,
      writerConfirmed: true, writerStatus: 'adopted', writerUsableForMutation: true,
      provenWriterSessionId: sid('codex'), writerProof: 'controlled-fixture', sendTarget: sendTarget('codex') };
    if (channel === 'claude:get-presence') return { status: 'busy', hasBridge: true, isBusy: true,
      hasTerm: true, inputReady: true, sessionId: sid('claude'), sendTarget: sendTarget('claude'),
      conversationMaterialized: true, canCopySessionId: true, timelineCount: 1,
      providerProcessAlive: true, startupDefaultsReady: true };
    if (channel === 'codex:get-draft-state' || channel === 'claude:get-draft-state') return {
      success: true, hasDraft: false, preview: '', source: 'fixture-main', proofOutcome: 'absent',
      proofReason: 'fixture-controlled-empty' };
    if (channel === 'claude:get-pending-question') return null;
    if (channel === 'tab-work-context:prepare') return { success: true, prompt: input.prompt, prefix: '' };
    if (channel === 'tab-work-context:get') return { success: true, updates: [] };
    if (/^tab-work-context:(activate|settle|release)/.test(channel)) return { success: true };
    if (channel === 'agent-activity:get-tab-timing') {
      const provider = providerOf(input.tabId); return { success: true, timing: { state: 'running', intervalId: null,
        toolType: provider, sessionId: sid(provider), startTs: Date.now() - 5000, endTs: null, durationMs: null } };
    }
    if (channel === 'agent-transcript:get-history') {
      const provider = providerOf(input.tabId); return { success: true, entries: histories.get(provider),
        payloadGeneration: 'queue-fixture-' + provider, revision: { sources: [{ sessionId: sid(provider),
          fileIdentity: 'queue-fixture-' + provider, linkKind: 'end' }] } };
    }
    if (channel === 'agent-session:get-availability-batch') return { success: true,
      results: (input.sessions || []).map(item => ({ ...item, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
    if (/^agent-transcript:(subscribe|unsubscribe)$/.test(channel)) return { success: true };
    if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
    if (channel === 'fixture:image-path') return config.imagePath;
    if (channel === 'prompt-queue:materialize-image-refs') {
      assert.ok(input.refs.every(ref => ref.path === config.imagePath && fs.existsSync(ref.path)), 'only the owned fixture image is readable');
      return { success: true, refs: input.refs.map(ref => ({ ...ref, availability: 'available' })), available: input.refs.length, missing: 0 };
    }
    if (channel === 'prompt-queue:get-image-preview-data-url') {
      assert.equal(input.path, config.imagePath);
      return { success: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(config.imagePath).toString('base64') };
    }
    if (channel === 'file:exists-batch') return Object.fromEntries(input.map(file => [file, fs.existsSync(file)]));
    if (channel === 'app:getState') return null;
    if (channel === 'terminal:getCommandStates') return {};
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'terminal:getCommandState') return null;
    if (/^(terminal:(create|input|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:run|agent:(stop|rewind)|shell:|app:(open|select))/.test(channel)) {
      state.forbidden.push(channel); throw Error('Fixture forbids ' + channel);
    }
    if (/list|catalog|get-models|get-prompts|project:getGroups/.test(channel)) return [];
    if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
    if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
    state.unknown.push(channel); return { success: true };
  }
  ipcMain.handle('fixture:invoke', (_event, { channel, args }) => invoke(channel, args));
  const snapshotState = () => ({ ...state, items: db.prepare('SELECT * FROM agent_send_queue ORDER BY id').all(),
    records: store.list().map(record => queue.projectRecord(record)) });
  const publishCanonical = (record, entry) => {
    const rows = histories.get(record.provider);
    if (!rows.some(row => row.uuid === entry.uuid)) rows.push(entry);
    notify('agent-transcript:changed', { tabId: record.tabId, toolType: record.provider, sessionId: sid(record.provider) });
  };
  global.applicationSendQueueHarness = {
    snapshot: snapshotState,
    holdHistory: operationKey => holdCanonical.add(operationKey),
    releaseHistory(operationKey) {
      holdCanonical.delete(operationKey);
      const entry = heldCanonical.get(operationKey);
      if (entry) { heldCanonical.delete(operationKey); publishCanonical(store.get(operationKey), entry); }
    },
    confirm(operationKey, kind = 'exact') {
      const record = store.get(operationKey); const provider = record.provider;
      const timestamp = new Date().toISOString(), entryUuid = provider + '-canonical-' + record.handoffId;
      const proof = { success: true, operationKey, attemptId: kind === 'wrong-attempt' ? 'foreign-attempt' : record.attemptId,
        provider, sessionId: sid(provider), promptHash: record.promptHash, actualHash: record.promptHash,
        expectedHash: record.promptHash, entryUuid, sourceIdentity: provider + '-canonical-source-' + record.handoffId,
        auditTimestamp: timestamp, transcriptBoundary: { byteOffset: 100 + state.audits.length } };
      const answer = store.promoteFromAudit(proof);
      state.audits.push({ operationKey, kind, promoted: answer.promoted });
      if (answer.promoted) {
        const request = JSON.parse(queue.item(operationKey).request_json);
        const entry = { uuid: entryUuid, role: 'user', sessionId: sid(provider), timestamp,
          content: request.prompt, sourceIdentity: proof.sourceIdentity,
          imagePaths: request.presentationSnapshot?.imagePaths || [], promptChips: request.presentationSnapshot?.promptChips || [] };
        if (holdCanonical.has(operationKey)) heldCanonical.set(operationKey, entry);
        else publishCanonical(record, entry);
      }
      return answer;
    },
    reopen() {
      assert.equal(pending.size, 0, 'reopen must not destroy a dispatched bridge');
      queue.dispose(); db.close(); openQueue(); store.reconcileStartup(); queue.resume();
      state.startup.push({ at: Date.now(), items: db.prepare('SELECT count(*) n FROM agent_send_queue').get().n });
      for (const record of store.list()) notify('agent:send-queue-receipt', queue.projectRecord(record));
      return snapshotState();
    },
  };
  app.whenReady().then(() => {
    app.dock?.hide(); window = new BrowserWindow({ show: false, focusable: false, width: 1000, height: 1050,
      webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false,
        backgroundThrottling: false, preload: config.preload } });
    window.webContents.on('paint', () => {}); window.loadFile(config.html);
  });
  app.on('before-quit', () => { queue.dispose(); db.close(); });
  app.on('window-all-closed', () => app.quit());
}

try {
  await fs.mkdir(snapshot, { recursive: true });
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(freezeFrom, name), path.join(snapshot, name),
    { recursive: true, filter: value => !value.includes('/node_modules') && !value.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/application-send-queue.tsx'), path.join(snapshot, 'scripts/fixtures/application-send-queue.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'shared');
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name),
    { recursive: true, filter: value => !value.includes('/node_modules') });
  const bundled = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/application-send-queue.tsx')],
    bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120',
    logLevel: 'silent', metafile: true, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const hashes = {}, sourceRoot = await fs.realpath(snapshot), inputFiles = [];
  // macOS resolves /var to /private/var inside esbuild's input graph. Resolve
  // both sides before relative() so renderer sources cannot silently drop out.
  for (const file of Object.keys(bundled.metafile.inputs)) {
    const real = await fs.realpath(path.resolve(file)).catch(() => null);
    if (!real) continue;
    const relative = path.relative(sourceRoot, real);
    if (relative.startsWith('src/') || relative.startsWith('packages/')) inputFiles.push(relative);
  }
  for (const name of new Set(['src/main/agent-send-queue.js', 'src/main/agent-send-receipt-store.js',
    'src/renderer/components/Workspace/HistoryPanel.tsx', 'src/renderer/utils/agentScenarios.ts',
    'src/renderer/utils/historyPromptHandoffs.ts', ...inputFiles])) {
    hashes[name] = createHash('sha256').update(await fs.readFile(path.join(snapshot, name))).digest('hex');
  }
  assert.ok(Object.keys(hashes).length > 10, 'manifest must include actual bundled renderer sources');
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  await fs.writeFile(path.join(artifact, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ddd}button{cursor:pointer}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  await fs.mkdir(path.join(artifact, 'user-data'));
  await fs.writeFile(path.join(artifact, 'fixture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  await fs.writeFile(path.join(artifact, 'preload.cjs'), "const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});");
  const config = { source: snapshot, modules: path.join(repo, 'node_modules'), userData: path.join(artifact, 'user-data'),
    database: path.join(artifact, 'queue.sqlite'), imagePath: path.join(artifact, 'fixture.png'),
    preload: path.join(artifact, 'preload.cjs'), html: path.join(artifact, 'index.html') };
  await fs.writeFile(path.join(artifact, 'main.cjs'), '(' + startFixtureMain.toString() + ')(' + JSON.stringify(config) + ');');
  if (buildOnly) { result.status = 'BUILD-PASS'; }
  else {
    const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: config.userData };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[key];
    app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'), args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
    result.pid = app.process().pid;
    await fs.writeFile(path.join(artifact, 'process-lease.json'), JSON.stringify({ pid: result.pid, cwd: artifact,
      executable: path.join(repo, 'node_modules/.bin/electron'), main: path.join(artifact, 'main.cjs'), userData: config.userData }, null, 2));
    page = await app.firstWindow(); page.setDefaultTimeout(12000);
    page.on('console', message => rendererLogs.push(message.text())); page.on('pageerror', error => result.errors.push(error.stack));
    await page.waitForFunction(() => window.applicationQueueFixture?.ready.codex);
    await page.screenshot({ path: path.join(artifact, 'initial.png') });
    const state = () => app.evaluate(() => global.applicationSendQueueHarness.snapshot());
    const audit = (operationKey, kind = 'exact') => app.evaluate((_electron, request) => global.applicationSendQueueHarness.confirm(request.operationKey, request.kind), { operationKey, kind });
    const editor = () => page.locator('[data-history-composer-tab-id] .cm-content[contenteditable="true"],.cm-content[data-history-composer-tab-id][contenteditable="true"]').last();
    for (const provider of ['codex', 'claude']) {
      await page.locator('[data-fixture-provider="' + provider + '"]').click();
      await page.waitForFunction(provider => window.applicationQueueFixture?.ready[provider], provider);
      const names = [provider + ' Q1', provider + ' Q2', provider + ' CANCEL Q3', provider + ' ATTACH Q4', provider + ' Q5', 'Same repeat', 'Same repeat'];
      for (let index = 0; index < names.length; index++) {
        if (index === 3) { await page.locator('[data-fixture-attach]').click(); await page.waitForSelector('.cm-composer-token--image[data-composer-token-id="image:1:0"]'); }
        await editor().click(); await page.keyboard.insertText(names[index]); await editor().press('Enter');
        await page.waitForFunction(() => [...document.querySelectorAll('.cm-content[contenteditable="true"]')].at(-1)
          ?.querySelector('.cm-placeholder')?.textContent === 'Send a prompt...');
        await page.waitForFunction(({ provider, count }) => window.applicationQueueFixture.receipts
          .filter(record => record.operationKey.includes('application-queue-' + provider + ':')).length >= count, { provider, count: index + 1 });
      }
      await page.waitForFunction(provider => window.applicationQueueFixture.writes.filter(write => write.provider === provider).length === 1, provider);
      const after = await state(), records = after.records.filter(record => record.provider === provider);
      assert.equal(records.length, 7); assert.equal(after.sends.filter(send => send.provider === provider).length, 1);
      assert.equal(after.items.filter(item => item.tab_id.endsWith(provider) && item.state === 'waiting').length, 6);
      await page.waitForFunction(() => document.body.textContent.split('IN APP QUEUE').length - 1 >= 6);
      await page.screenshot({ path: path.join(artifact, provider + '-seven-queued.png') });
      const geometry = await page.evaluate(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const entries = [...document.querySelectorAll('[data-uuid^="local-prompt-"]')].map(element => ({
          id: element.getAttribute('data-uuid'), status: element.querySelector('.hp-user-message-status'),
          column: element.querySelector('.cb-user-col'),
        })).filter(entry => entry.status && entry.column);
        return entries.map((entry, index) => {
          const status = rect(entry.status), next = entries[index + 1]?.column ? rect(entries[index + 1].column) : null;
          return { id: entry.id, status, next, overlap: !!next && status.bottom > next.y + 0.5
            && status.y < next.bottom && status.right > next.x && status.x < next.right };
        });
      });
      await fs.writeFile(path.join(artifact, provider + '-queue-geometry.json'), JSON.stringify(geometry, null, 2));
      if (geometry.some(row => row.overlap)) result.visualProblems.push(provider + ': status overlaps next queued message');
      const first = records[0], cancel = records[2], attachment = records[3];
      const bad = await audit(first.operationKey, 'wrong-attempt'); assert.equal(bad.promoted, false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await state()).sends.filter(send => send.provider === provider).length, 1);
      const cancelRow = page.locator('[data-uuid="local-prompt-application-queue-' + provider + '-' + cancel.handoffId + '"]');
      await cancelRow.getByRole('button', { name: 'Отменить отправку из очереди', exact: true }).click();
      await page.waitForFunction(id => !document.querySelector('[data-uuid="' + id + '"]'), 'local-prompt-application-queue-' + provider + '-' + cancel.handoffId);
      assert.equal((await state()).records.find(record => record.operationKey === cancel.operationKey).attemptId, null);
      await page.locator('[data-fixture-hide]').click(); await page.locator('[data-fixture-hide]').click();
      await page.waitForSelector('[data-virtuoso-scroller]');
      await page.locator('[data-fixture-remount]').click(); await page.waitForSelector('[data-virtuoso-scroller]');
      await page.waitForFunction(() => document.body.textContent.split('IN APP QUEUE').length - 1 >= 5);
      assert.equal((await state()).sends.filter(send => send.provider === provider).length, 1);
      await app.evaluate(() => global.applicationSendQueueHarness.reopen());
      const reopened = await state(); assert.equal(reopened.sends.filter(send => send.provider === provider).length, 1);
      await page.waitForFunction(() => document.body.textContent.split('IN APP QUEUE').length - 1 >= 5);
      const expected = records.filter(record => record.operationKey !== cancel.operationKey);
      let sentExpiryGeometry;
      for (let index = 0; index < expected.length; index++) {
        if (index === 0) await app.evaluate((_electron, operationKey) => global.applicationSendQueueHarness.holdHistory(operationKey), expected[index].operationKey);
        const answer = await audit(expected[index].operationKey); assert.equal(answer.promoted, true);
        const nextCount = Math.min(index + 2, expected.length);
        await page.waitForFunction(({ provider, count }) => window.applicationQueueFixture.writes
          .filter(write => write.provider === provider).length >= count, { provider, count: nextCount });
        await app.evaluate(() => new Promise(resolve => setImmediate(resolve)));
        const current = await state();
        assert.equal(current.sends.filter(send => send.provider === provider).length, nextCount);
        if (index === 0) {
          const firstRow = page.locator('[data-uuid="local-prompt-application-queue-' + provider + '-' + expected[index].handoffId + '"]');
          await firstRow.locator('.cb-message-status-label').filter({ hasText: 'SENT' }).waitFor();
          const geometry = element => ({ height: element.getBoundingClientRect().height,
            footerHeight: element.querySelector('.hp-user-message-status')?.getBoundingClientRect().height || 0 });
          const before = await firstRow.evaluate(geometry);
          await firstRow.locator('.cb-message-status-label').filter({ hasText: 'SENT' }).waitFor({ state: 'detached' });
          const after = await firstRow.evaluate(geometry);
          assert.equal(after.height, before.height, 'SENT expiry cannot shrink an unadopted local row');
          assert.ok(after.footerHeight >= 20, 'expired local row retains reserved status slot');
          sentExpiryGeometry = { before, after };
          await app.evaluate((_electron, operationKey) => global.applicationSendQueueHarness.releaseHistory(operationKey), expected[index].operationKey);
          // Repeated proof of an older operation is not consumption of the new
          // provider head. Keep its original exact identity, never match text.
          await audit(expected[0].operationKey);
          await app.evaluate(() => new Promise(resolve => setImmediate(resolve)));
          assert.equal((await state()).sends.filter(send => send.provider === provider).length, nextCount);
        }
      }
      const final = await state(), sent = final.sends.filter(send => send.provider === provider);
      assert.deepEqual(sent.map(send => send.operationKey), expected.map(record => record.operationKey));
      assert.equal(sent.filter(send => send.text === 'Same repeat').length, 2);
      const attached = sent.find(send => send.operationKey === attachment.operationKey);
      assert.equal(attached.options.presentationSnapshot.imagePaths.length, 1);
      assert.equal(attached.options.presentationSnapshot.promptChips[0].text, 'IMMUTABLE QUEUE CONTEXT ' + provider);
      const attachedRequest = JSON.parse(final.items.find(item => item.operation_key === attachment.operationKey).request_json);
      assert.equal(attachedRequest.authoringSnapshot.imagePaths.length, 1);
      assert.equal(attachedRequest.authoringSnapshot.chips[0].text, 'IMMUTABLE QUEUE CONTEXT ' + provider);
      assert.ok(attachedRequest.authoringSnapshot.editorText.includes(provider + ' ATTACH Q4'));
      result.providers[provider] = { admitted: 7, sent: sent.length, cancelled: cancel.handoffId,
        firstPendingOperation: first.operationKey, imagePath: attachedRequest.authoringSnapshot.imagePaths[0].path, sentExpiryGeometry };
      result.checks.push(provider + ': seven trusted Sends while busy, one provider pending, exact FIFO, wrong/stale audit blocked, X cancel, hide/remount/SQLite reopen, same-text occurrence identity, image/chip snapshot, no badge overlap or SENT expiry height change');
      await page.screenshot({ path: path.join(artifact, provider + '-complete.png') });
    }
    result.main = await state();
    result.renderer = await page.evaluate(() => ({ errors: window.applicationQueueFixture.errors,
      trusted: window.applicationQueueFixture.trusted, receipts: window.applicationQueueFixture.receipts }));
    assert.deepEqual(result.main.forbidden, []); assert.deepEqual(result.main.dispatchErrors, []);
    assert.deepEqual(result.renderer.errors, []); assert.deepEqual(result.errors, []);
    assert.deepEqual(result.visualProblems, []);
    assert.ok(result.renderer.trusted.filter(event => event.type === 'keydown' && event.key === 'Enter' && event.trusted).length >= 14);
    result.status = 'PASS';
  }
} catch (error) {
  result.status = 'FAIL'; result.error = String(error.stack || error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
  if (page) result.domFailure = await page.evaluate(() => ({
    editors: [...document.querySelectorAll('.cm-content')].map(el => el.outerHTML),
    localRows: [...document.querySelectorAll('[data-uuid^="local-prompt-"]')].map(el => ({ uuid: el.getAttribute('data-uuid'), text: el.textContent })),
  })).catch(() => null);
  if (app) result.main = await app.evaluate(() => global.applicationSendQueueHarness?.snapshot()).catch(() => null);
} finally {
  if (app) { try { await app.close(); result.processClosed = true; } catch (error) { result.cleanupError = String(error); process.exitCode = 1; } }
  await fs.writeFile(path.join(artifact, 'renderer.log'), rendererLogs.join('\n'));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, checks: result.checks, error: result.error, pid: result.pid, processClosed: result.processClosed }));
}

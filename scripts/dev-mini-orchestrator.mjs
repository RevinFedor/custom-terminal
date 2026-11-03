#!/usr/bin/env node
// Human-started DEV, never an automated model test. Historical replay uses a
// separately prepared private JSONL copy. --basic explicitly opts in
// to a separate fresh UI prototype; it is not the requested historical case.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { miniReplayLaunchGate } from './lib/mini-replay-launch.mjs';
const require = createRequire(import.meta.url), WebSocket = require('ws');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const replayDir = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay');
// Main/Rewind is the selected demonstration. RAM is retained separately and
// cannot silently replace Main (or block a prepared Main in a future launcher).
const mainReplayDir = path.join(replayDir, 'main');
const replay = JSON.parse(await fs.readFile(path.join(mainReplayDir, 'REPLAY.json'), 'utf8'));
const admission = miniReplayLaunchGate(replay, { basic: process.argv.includes('--basic') });
if (!admission.allowLaunch) {
  console.error('[MiniDEV] Replay не подготовлен: ' + admission.reason);
  console.error('[MiniDEV] Оригинал не запускается. Пустой чат вместо копии НЕ открывается.');
  console.error('[MiniDEV] Main/Rewind: ' + path.join(mainReplayDir, 'REPLAY-STATUS.md'));
  console.error('[MiniDEV] Точный запрос и Image #1: ' + path.join(mainReplayDir, 'ВСТАВКА.md'));
  console.error('[MiniDEV] Инструкция: ' + path.join(mainReplayDir, replay.instruction.file));
  console.error('[MiniDEV] Отдельный простой UI-прототип (НЕ replay): npm run dev:mini -- --basic');
  process.exit(2);
}
// The explicit basic prototype uses the API-derived SystemPrompt verbatim.
// Verify the linked-file assembly BEFORE making a profile or reading keys.
const reviewerDefinitionPath = replay.systemPromptFile || path.join(mainReplayDir, 'SYSTEM-PROMPT.json');
const reviewerDefinition = JSON.parse(await fs.readFile(reviewerDefinitionPath, 'utf8'));
if (process.env.NOTED_MINI_REVIEW_PROMPT_FILE && !reviewerDefinition.filePaths.includes(path.resolve(process.env.NOTED_MINI_REVIEW_PROMPT_FILE)))
  throw Error('Instruction snapshot pins its linked files; an override needs explicit new preparation.');
const { resolveMiniOrchestratorInstruction } = require('../src/main/mini-orchestrator-runtime');
const resolvedReviewer = await resolveMiniOrchestratorInstruction({ prompt: reviewerDefinition, settings: reviewerDefinition, automaticCorrections: admission.replayPrepared });
if (require('node:crypto').createHash('sha256').update(resolvedReviewer.text).digest('hex') !== replay.instruction.sha256)
  console.warn('[MiniDEV] Новые проверки используют текущую связанную инструкцию; сохранённые результаты и snapshots не переписываются.');
const replayProfilePath = replay.privateProfile?.profileFile && path.isAbsolute(replay.privateProfile.profileFile)
  ? replay.privateProfile.profileFile : path.join(mainReplayDir, 'PROFILE.json');
const replayProfile = admission.replayPrepared
  ? JSON.parse(await fs.readFile(replayProfilePath, 'utf8')) : null;
const root = await fs.realpath(replayProfile ? replayProfile.root : await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-dev-')));
if (replayProfile) {
  if (root !== replay.privateProfile.root || root !== replayProfile.root || !path.basename(root).startsWith('noted-mini-dev-')
    || replayProfile.sessionId !== replay.targetSessionId || replayProfile.tabId !== replay.targetTabId
    || !replayProfile.sessionFile.startsWith(root + path.sep)
    || await fs.realpath(replayProfile.sessionFile) !== replayProfile.sessionFile) throw Error('Private replay physical identity mismatch');
  const owner = JSON.parse(await fs.readFile(path.join(root, 'REPLAY-OWNER.json'), 'utf8'));
  if (owner.sessionId !== replayProfile.sessionId || owner.tabId !== replayProfile.tabId) throw Error('Private replay owner mismatch');
}
// Only one human DEV per prepared profile; never reset/reseed a live instance.
const lockPath = path.join(root, 'DEV-LOCK.json');
const lockBody = JSON.stringify({ pid: process.pid, root });
try { await fs.writeFile(lockPath, lockBody, { flag: 'wx', mode: 0o600 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const previous = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  if (previous.root !== root || !Number.isInteger(previous.pid)) throw Error('Private DEV lock is unknown');
  let running = true;
  try { process.kill(previous.pid, 0); } catch (lookup) { if (lookup.code === 'ESRCH') running = false; else throw lookup; }
  if (running) { console.log('[MiniDEV] Этот private DEV уже открыт: ' + root); process.exit(0); }
  await fs.unlink(lockPath); await fs.writeFile(lockPath, lockBody, { flag: 'wx', mode: 0o600 });
}
process.once('exit', () => {
  try { if (fss.readFileSync(lockPath, 'utf8') === lockBody) fss.unlinkSync(lockPath); } catch {}
});
const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const devCli = path.join(repo, 'node_modules/.bin/electron-vite');
const promptFile = process.env.NOTED_MINI_REVIEW_PROMPT_FILE || path.join(os.homedir(), 'Global-Templates/🧩 Code-Patterns/документация/мини-оркестратор-проверка-ответа.prompt.md');
if (!fss.existsSync(electron) || !fss.existsSync(devCli)) throw Error('Run npm install / the normal macOS setup first.');
if (!fss.existsSync(promptFile)) throw Error('Reviewer instruction file is missing; set NOTED_MINI_REVIEW_PROMPT_FILE.');
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const rendererPort = await port(), apiPort = await port(), cdpPort = await port();
if (new Set([rendererPort, apiPort, cdpPort]).size !== 3) throw Error('A free-port collision occurred before launch; run the command again.');
for (const p of ['data', 'discovery', 'codex', 'claude', 'fixture', 'tmp']) await fs.mkdir(path.join(root, p), { mode: 0o700, recursive: true });
const sharedEnv = require('dotenv').parse(await fs.readFile(path.join(os.homedir(), '.noted-terminal/.env')).catch(() => Buffer.from('')));
const miniKey = sharedEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
if (!miniKey) console.warn('[MiniDEV] GEMINI_API_KEY is missing; the window will still open, reviewer will report the configuration error.');
// Reuse the same login locally; never copy histories, user config, MCP server
// settings or account/profile directories. These values are never printed.
for (const name of ['auth.json', 'models_cache.json']) {
  const bytes = await fs.readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (bytes) try { await fs.writeFile(path.join(root, 'codex', name), bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const cwd = path.join(root, 'fixture');
// The isolated profile isolates the APP (user data, Claude/Codex config,
// ports) — not the file system. A tab on this stand reads the real repo for
// its task, and nothing in its own cwd stops it from WRITING there.
//
// Scar 01Nov: a synthetic task ("background shells do not count — make them
// count like subagents"), meant only to produce a bad answer for the reviewer,
// was taken literally and patched the live repository, reverting another tab's
// agreed design. Say in words that the repo is reference material.
await fs.writeFile(path.join(cwd, 'AGENTS.md'), [
  '# Тестовый стенд мини-оркестратора',
  '',
  'Работай только в этом каталоге.',
  '',
  '`' + repo + '` — ТОЛЬКО ДЛЯ ЧТЕНИЯ. Читай его файлы, если задача просит',
  'разобраться в коде, но НИКОГДА не правь, не создавай и не удаляй в нём файлы:',
  'это живой репозиторий пользователя, в котором параллельно работают другие',
  'сессии. Задача вида «исправь X» на этом стенде означает «объясни, как это',
  'исправить».',
  '',
].join('\n'), { mode: 0o600 }).catch(() => {});
// A private CLAUDE_CONFIG_DIR starts with no decisions recorded, so the Claude
// CLI opens its first-run dialogs (theme, folder trust, auto-mode) and never
// reaches an input-ready TUI: every Send then fails with a readiness timeout.
// Its OAuth tokens also live in the macOS Keychain here, not in a file.
await prepareIsolatedClaudeProfile(root, cwd);
try { await fs.writeFile(path.join(root, 'codex/config.toml'), 'model_reasoning_effort = "low"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n\n[projects.' + JSON.stringify(cwd) + ']\ntrust_level = "trusted"\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const env = { ...process.env, NODE_ENV: 'development',
  // Isolation is independent of macOS presentation. A human DEV needs normal
  // Dock/Cmd+Tab activation, not the accessory/no-Dock E2E presentation.
  NOTED_E2E_TEST: 'true', NOTED_E2E_WINDOWED: '0', NOTED_E2E_VISIBLE: '1', NOTED_E2E_FILE_LOG: '1',
  NOTED_E2E_CLI_ISOLATION_ROOT: root, NOTED_USER_DATA_DIR: path.join(root, 'data'), NOTED_DISCOVERY_DIR: path.join(root, 'discovery'),
  NOTED_SHARED_FILE_EXPLORER_DB_PATH: path.join(root, 'shared-layout.db'),
  CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), TMPDIR: path.join(root, 'tmp'),
  NOTED_RENDERER_HOST: '127.0.0.1', NOTED_RENDERER_PORT: String(rendererPort), NOTED_WEB_PORT: String(apiPort), NOTED_CDP_PORT: String(cdpPort),
  NOTED_MINI_REVIEW_PROMPT_FILE: promptFile, NOTED_MINI_GEMINI_API_KEY: miniKey,
  NOTED_MINI_AUTOMATIC_CORRECTIONS: admission.replayPrepared ? '1' : '0',
  NOTED_MINI_READ_ONLY_CODEX: '1' };
if (replayProfile) env.NOTED_MINI_REPLAY_PROFILE = replayProfilePath;
else delete env.NOTED_MINI_REPLAY_PROFILE;
// This profile uses the trusted Main-only mini credential, not a renderer or
// PTY inherited GEMINI_API_KEY. Electron isolates the mini key before children.
delete env.GEMINI_API_KEY;
env.NOTED_MINI_SYSTEM_PROMPT_SNAPSHOT = reviewerDefinitionPath;
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NOTED_E2E_USE_BUILT_RENDERER',
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'NOTED_PARENT_TAB_ID', 'NOTED_PARENT_PROJECT_ID',
  'NOTED_MAIN_PID', 'NOTED_MCP_INSTANCE_ROUTE', 'NOTED_MCP_CLIENT_TOKEN', 'NOTED_SOURCE_TAB_ID', 'NOTED_SOURCE_PROJECT_ID']) delete env[key];
const run = (bin, args, options = {}) => new Promise((resolve, reject) => { const child = spawn(bin, args, { cwd: repo, stdio: 'inherit', ...options });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Preparation exited ' + code))); });
await run(process.execPath, [path.join(repo, 'scripts/prepare-node-pty-write-trace.mjs')]);
await run(electron, [path.join(repo, 'scripts/seed-mini-orchestrator-dev.cjs'), root], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
await fs.writeFile(path.join(root, 'DEV.json'), JSON.stringify({ root, rendererPort, apiPort, cdpPort,
  mode: 'Vite DEV', keyConfigured: !!miniKey, automaticModelPrompts: false }, null, 2), { mode: 0o600 });
console.log('[MiniDEV] Profile: ' + root);
console.log('[MiniDEV] Vite http://127.0.0.1:' + rendererPort + ' · API ' + apiPort + ' · CDP ' + cdpPort);
// Scar 01Nov: killing only this launcher left `electron-vite` and its
// Electron children alive, each with its own Dock icon (three piled up).
// `pkill -f <profile>` cannot find them: the profile name lives in their env,
// not in argv. So the launcher leads its own process group and the whole group
// dies together.
const child = spawn(devCli, ['dev'], { cwd: repo, env, stdio: ['inherit', 'pipe', 'pipe'], detached: true });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
let debuggerResolve, debuggerReject;
const debuggerReady = new Promise((resolve, reject) => { debuggerResolve = resolve; debuggerReject = reject; });
let outputTail = '';
const forward = (stream, output) => stream.on('data', chunk => {
  output.write(chunk); outputTail = (outputTail + chunk.toString()).slice(-4096);
  const found = outputTail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
  if (found && new URL(found[1]).port === String(cdpPort)) debuggerResolve(found[1]);
});
forward(child.stdout, process.stdout); forward(child.stderr, process.stderr);
child.once('error', debuggerReject);
child.once('exit', () => debuggerReject(Error('DEV exited before preparation')));
let groupStopped = false;
const stopGroup = (signal) => {
  if (groupStopped || child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  groupStopped = true;
  // The group, not the single PID: the launcher's Electron children are what
  // keeps a stale DEV instance (and its Dock icon) alive.
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') try { child.kill(signal); } catch { /* already gone */ } }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopGroup(signal); });
process.on('exit', () => stopGroup('SIGTERM'));

function cdpClient(url) {
  const ws = new WebSocket(url), pending = new Map(), listeners = new Set(); let id = 0;
  const open = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.id && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(Error(message.error.message)) : p.resolve(message.result); }
    else for (const listener of [...listeners]) listener(message);
  });
  return { open,
    call(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(Error('DEV preparation deadline: ' + method)); }, 60000);
      pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Preparation closed')); } pending.clear(); ws.close(); },
  };
}
function privateFile(name) {
  const file = path.join(root, 'discovery', name);
  return new Promise((resolve, reject) => {
    let checking = false;
    const finish = (error, bytes) => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(bytes); };
    const inspect = async () => {
      if (checking) return; checking = true;
      try { const bytes = await fs.readFile(file); if (bytes.length) finish(null, bytes); }
      catch (error) { if (error.code !== 'ENOENT') finish(error); }
      finally { checking = false; }
    };
    const watcher = fss.watch(path.dirname(file), (_event, changed) => { if (String(changed) === name) void inspect(); });
    const timer = setTimeout(() => finish(Error('Private API discovery unavailable')), 60000);
    void inspect();
  });
}
// The target URL becomes visible before Vite has finished its initial
// navigation. A read evaluated in the discarded about:blank context is not a
// failed workspace restore. Re-arm only on a real load/context event, never by
// polling or repeating the later create-tab mutation.
function waitForWorkspace(client, sessionId) {
  return new Promise((resolve, reject) => {
    let busy = false, again = false, done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); off(); error ? reject(error) : resolve(); };
    const check = async () => {
      if (done) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const ready = await client.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
          expression: `new Promise((resolve,reject)=>{let off;const timer=setTimeout(()=>{off?.();reject(Error('Workspace restore unavailable'))},55000);const arm=()=>{const store=window.useWorkspaceStore;if(!store){clearTimeout(timer);resolve(false);return;}const check=()=>{const s=store.getState();if(s.organizationReady&&!s.isRestoring&&s.view==='workspace'){off?.();clearTimeout(timer);resolve(true);}};off=store.subscribe(check);check();};if(document.readyState==='complete')arm();else window.addEventListener('load',arm,{once:true});})` }, sessionId);
        if (ready.exceptionDetails) throw Error(ready.exceptionDetails.exception?.description || ready.exceptionDetails.text || 'Workspace restore failed');
        if (ready.result?.value === true) finish();
      } catch (error) {
        if (!/context.*destroyed|Cannot find context|Inspected target navigated|Cannot find default execution context/i.test(String(error.message))) finish(error);
      } finally { busy = false; if (again && !done) { again = false; void check(); } }
    };
    const off = client.subscribe(message => {
      if (message.sessionId === sessionId && (message.method === 'Page.loadEventFired'
          || (message.method === 'Runtime.executionContextCreated' && message.params?.context?.auxData?.isDefault))) void check();
    });
    const timer = setTimeout(() => finish(Error('Workspace restore deadline; no Codex tab was created')), 65000);
    void check();
  });
}
let client;
let preparationStage = 'ожидание DEV/CDP';
const startupTimer = setTimeout(() => debuggerReject(Error('DEV startup deadline; no model prompt was sent.')), 120000);
try {
  client = cdpClient(await debuggerReady); await client.open;
  const targetPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(Error('Renderer target unavailable')); }, 60000);
    const off = client.subscribe(message => { const info = message.params?.targetInfo;
      if (info?.type === 'page' && info.url?.startsWith('http://127.0.0.1:' + rendererPort)) { clearTimeout(timer); off(); resolve(info.targetId); } });
  });
  // A transport failure before the await below must not leave an unrelated
  // unhandled target-deadline rejection while the user's DEV remains open.
  void targetPromise.catch(() => {});
  await client.call('Target.setDiscoverTargets', { discover: true });
  const targetId = await targetPromise;
  const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
  preparationStage = 'восстановление рабочей области';
  // Arm before enabling Page/Runtime so no initial load/context event is lost.
  const workspaceReady = waitForWorkspace(client, sessionId);
  void workspaceReady.catch(() => {});
  await client.call('Page.enable', {}, sessionId); await client.call('Runtime.enable', {}, sessionId);
  // This is setup only: subscribe to the actual store's restore publication,
  // not timed polling, synthetic clicks or a test assertion.
  await workspaceReady;
  preparationStage = 'проверка собственного Main/API';
  const processInfo = await client.call('SystemInfo.getProcessInfo');
  const mainPid = processInfo.processInfo?.find(process => process.type === 'browser')?.id;
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) throw Error('Own Main identity unavailable');
  const discovery = JSON.parse((await privateFile('web-server-' + mainPid + '.json')).toString('utf8'));
  if (discovery.pid !== mainPid || discovery.port !== apiPort) throw Error('Private API identity mismatch');
  const token = (await privateFile('web-token.txt')).toString('utf8').trim();
  // A reviewer tab answers its source through Terminal MCP. This private
  // instance owns no shared hub, and its own HTTP port serves /terminal/tabs,
  // not JSON-RPC; the real client is the stdio server pointed at THIS
  // instance's discovery dir, so it never reaches the user's app.
  await wireIsolatedTerminalMcp(root, cwd, mainPid);
  const api = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + apiPort + route, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(70000) });
    const value = await response.json(); if (!response.ok) throw Error(value.error || 'API ' + response.status); return value;
  };
  if (replayProfile?.presentationOnly) {
    const fixture = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'));
    if (!fixture.presentationOnly || fixture.guide !== replayProfile.tabId || !Array.isArray(fixture.cases)
      || fixture.cases.length < 1 || fixture.cases.length > 4 || fixture.cases.length !== replayProfile.cases?.length
      || fixture.cases.some((item, index) => item.tabId !== replayProfile.cases[index].tabId || item.sessionId !== replayProfile.cases[index].sessionId))
      throw Error('Prepared read-only result tabs are unavailable');
    // Presentation-only setup. This opens the existing Mini popup; it never
    // starts a provider, sends a prompt or claims a tested native gesture.
    await client.call('Runtime.evaluate', { returnByValue: true,
      expression: `window.dispatchEvent(new CustomEvent('mini-orchestrator:open',{detail:{tabId:${JSON.stringify(replayProfile.tabId)}}}))` }, sessionId);
    console.log('\n[MiniDEV] Готовые вкладки (' + fixture.cases.length + '): ' + fixture.cases.map(item => item.name).join(' / '));
    console.log('[MiniDEV] Сохранённые ответы Codex и реальные Gemini review уже подготовлены. Откройте робота1, если чат закрыт.');
    console.log('[MiniDEV] Новые модельные запросы не отправлялись; повтор сохраняет ваши изменения.\n');
  } else {
  preparationStage = 'выбор Luna из каталога';
  const catalog = await api('/api/agent-models');
  const luna = (catalog.codex || []).filter(model => /luna/i.test(model.id + ' ' + model.label))
    .sort((a, b) => Number(/6\.1/.test(b.id)) - Number(/6\.1/.test(a.id)) || Number(/gpt-6-/.test(b.id)) - Number(/gpt-6-/.test(a.id)))[0];
  if (!luna) throw Error('No Luna is offered by the current catalog; no substitute model was started.');
  const efforts = luna.supportedEfforts || luna.efforts || [];
  const effort = efforts.includes('low') ? 'low' : luna.defaultEffort;
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'));
  if (replayProfile) {
    if (!fixture.replay || fixture.guide !== replayProfile.tabId || fixture.replaySessionId !== replayProfile.sessionId)
      throw Error('Prepared replay tab was not seeded in this profile');
    const firstStart = path.join(root, 'FIRST-START.json');
    const previousStart = await fs.readFile(firstStart, 'utf8').then(JSON.parse)
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!previousStart) {
      preparationStage = 'однократный Resume подготовленной копии';
      const observed = await client.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
        expression: `window.require('electron').ipcRenderer.invoke('codex:get-runtime-session', ${JSON.stringify(replayProfile.tabId)})` }, sessionId);
      if (observed.exceptionDetails) throw Error('Private runtime inspection failed');
      const runtime = observed.result?.value;
      if (runtime?.liveLifecycle === false && runtime.sessionId === replayProfile.sessionId) {
        // Durable intent precedes the only native launch call. An unknown ACK
        // is never retried by restarting this command.
        await fs.writeFile(firstStart, JSON.stringify({ state: 'attempted', tabId: replayProfile.tabId,
          sourceSessionId: replayProfile.sessionId, model: luna.id, effort, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        const payload = { tabId: replayProfile.tabId, command: 'codex-c', sessionId: replayProfile.sessionId,
          cwd: replayProfile.cwd, model: luna.id, effort, modelSource: 'explicit', effortSource: 'explicit' };
        const launched = await client.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
          expression: `window.require('electron').ipcRenderer.invoke('codex:run-command', ${JSON.stringify(payload)})` }, sessionId);
        if (launched.exceptionDetails) throw Error('Resume outcome unknown; use existing native controls, no automatic retry');
        const result = launched.result?.value;
        await fs.writeFile(firstStart, JSON.stringify({ state: result?.success === false ? 'refused' : 'returned',
          tabId: replayProfile.tabId, sourceSessionId: replayProfile.sessionId, model: luna.id, effort,
          launchAccepted: result?.accepted ?? null, sessionId: result?.sessionId ?? null, error: result?.error ?? null }), { mode: 0o600 });
        if (result?.success === false) throw Error('Resume refused: ' + String(result.error || result.reason || 'see native controls'));
      } else if (runtime?.liveLifecycle !== true) throw Error('Private replay runtime is not proven stopped; no launch attempted');
    } else {
      console.log('[MiniDEV] Существующие изменения копии сохранены. Если Codex остановлен, нажмите обычное «Продолжить».');
    }
    console.log('\n[MiniDEV] Main · Rewind replay: ' + replayProfile.tabId + ' · initial SID ' + replayProfile.sessionId);
    console.log('[MiniDEV] 1. Включите 🤖 On в полосе History / Run After.');
    console.log('[MiniDEV] 2. Добавьте Image #1: ' + replayProfile.images[0].exported);
    console.log('[MiniDEV] 3. Вставьте и вручную отправьте: ' + path.join(mainReplayDir, 'REPLAY-PROMPT.txt'));
    console.log('[MiniDEV] Копия находится ПЕРЕД первым запросом 30Oct19:50; автоматического Send нет.\n');
  } else {
  preparationStage = 'однократное создание вкладки Codex';
  const created = await api('/api/agent-tabs', { toolType: 'codex', name: 'Мини-оркестратор · Luna',
    workflowId: fixture.workflowId, sourceTabId: fixture.guide, cwd: fixture.cwd,
    modelSelection: { kind: 'catalog', id: luna.id }, effort, placement: 'root', background: false,
    windowTarget: { anchor: 'source', mode: 'same-window' } });
  console.log('\n[MiniDEV] Вкладка подготовлена: ' + (created.tabId || 'смотрите окно') + ' · ' + luna.label + ' / ' + effort);
  console.log('[MiniDEV] 1. Нажмите «🤖 Off» в полосе History / Run After — станет On.');
  console.log('[MiniDEV] 2. Отправьте: «В двух коротких предложениях объясни, почему 2+2=4. Без инструментов».');
  console.log('[MiniDEV] 3. Нажмите зелёного бота под Play — там появятся запрос, ответ и рецензия.');
  console.log('[MiniDEV] Никакой запрос автоматически не отправлялся. Ctrl+C останавливает этот DEV.\n');
  }
  }
} catch (error) {
  console.error('[MiniDEV] Автоподготовка, этап «' + preparationStage + '»: ' + String(error.message).slice(0, 240));
  console.error('[MiniDEV] Уже принятый запуск не повторяю. Окно DEV оставлено для ручной проверки; Ctrl+C — остановка.');
} finally { clearTimeout(startupTimer); client?.close(); }
const result = await exited; process.exitCode = result.code || 0;

// Seed the "already decided" state a fresh private Claude profile is missing.
// Copies only dialog flags and the login token; never histories or MCP config.
async function prepareIsolatedClaudeProfile(root, cwd) {
  const target = path.join(root, 'claude', '.claude.json');
  const hostConfigPath = path.join(os.homedir(), '.claude.json');
  const host = await fs.readFile(hostConfigPath, 'utf8').then(JSON.parse).catch(() => ({}));
  const current = await fs.readFile(target, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const key of Object.keys(host)) {
    if (/^has(Completed|Seen|Ide|Reset)|Onboarding|^theme$|^installMethod$|KeyBindingInstalled$|^optionAsMetaKeyInstalled$|Nudge$|Warning$|DialogBeenShown$/.test(key)) {
      current[key] = host[key];
    }
  }
  current.hasCompletedOnboarding ??= true;
  current.theme ??= 'dark';
  current.projects ??= {};
  current.projects[cwd] = { ...(current.projects[cwd] || {}), hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true, allowedTools: [] };
  await fs.writeFile(target, JSON.stringify(current, null, 2), { mode: 0o600 });
  const credentials = await new Promise(resolve => {
    const child = spawn('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; });
    child.once('exit', code => resolve(code === 0 ? out.trim() : ''));
    child.once('error', () => resolve(''));
  });
  const hostCredentials = await fs.readFile(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8').catch(() => '');
  const payload = credentials || hostCredentials;
  if (payload) await fs.writeFile(path.join(root, 'claude', '.credentials.json'), payload, { mode: 0o600 });
  else console.warn('[MiniDEV] No Claude credentials found; its tabs will ask for /login.');
}

// Give the private profile a terminal MCP bound to its own discovery dir.
async function wireIsolatedTerminalMcp(root, cwd, mainPid) {
  const record = path.join(root, 'discovery', 'mcp-port-' + mainPid);
  if (!fss.existsSync(record)) { console.warn('[MiniDEV] No MCP discovery record yet; reviewer tabs may lack send_prompt.'); return; }
  const target = path.join(root, 'claude', '.claude.json');
  const current = await fs.readFile(target, 'utf8').then(JSON.parse).catch(() => ({}));
  const server = { type: 'stdio', command: process.execPath,
    args: [path.join(repo, 'mcp/terminal-server.mjs')],
    env: { NOTED_DISCOVERY_DIR: path.join(root, 'discovery') } };
  current.mcpServers = { ...(current.mcpServers || {}), terminal: server };
  current.projects ??= {};
  current.projects[cwd] = { ...(current.projects[cwd] || {}), mcpServers: { terminal: server },
    enabledMcpjsonServers: ['terminal'] };
  await fs.writeFile(target, JSON.stringify(current, null, 2), { mode: 0o600 });
  console.log('[MiniDEV] Terminal MCP wired for this private profile only.');
}

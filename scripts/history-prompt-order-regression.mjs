#!/usr/bin/env node
// Actual HistoryPanel/composer/live projection, private offscreen Electron 28.
// node scripts/history-prompt-order-regression.mjs
// node scripts/history-prompt-order-regression.mjs --source=/absolute/frozen/source --cases=codex-incident
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
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const freezeFrom = path.resolve(argument('source') || repo);
const cases = (argument('cases') || 'codex-incident,codex-fifo,claude-incident,codex-own-answer').split(',');
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-prompt-order-'));
const snapshot = path.join(artifact, 'source'), shared = path.join(artifact, 'shared');
const result = { artifact, freezeFrom, cases: [], checks: [], errors: [], cleanup: {},
  boundary: 'Actual offscreen Electron/HistoryPanel/composer/handoff hydration/live projection. Synthetic IPC and transcript; no provider/PTY/live mutation.' };
const logs = [];
let app, page;

function privateMain(config) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  const unknown = [], forbidden = [];
  global.promptOrderMain = { unknown, forbidden };
  ipcMain.handle('fixture:invoke', (_event, { channel, args }) => {
    if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:(send-command|run)|agent:(stop|rewind))/.test(channel)) {
      forbidden.push(channel); throw Error('Private fixture forbids ' + channel);
    }
    if (channel === 'file:exists-batch') return Object.fromEntries(args[0].map(file => [file, false]));
    if (channel === 'app:getState') return null;
    if (channel === 'terminal:getCommandStates') return {};
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'terminal:getCommandState') return null;
    if (/list|catalog|get-models|get-prompts|project:getGroups/.test(channel)) return [];
    if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
    if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
    unknown.push(channel); return { success: true };
  });
  app.whenReady().then(() => {
    app.dock?.hide();
    const window = new BrowserWindow({ show: false, focusable: false, width: 1100, height: 1100,
      webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false,
        backgroundThrottling: false, preload: config.preload } });
    window.webContents.on('paint', () => {}); window.loadFile(config.html);
  });
  app.on('window-all-closed', () => app.quit());
}

function check(name, condition, evidence) {
  result.checks.push({ name, pass: Boolean(condition), ...(evidence === undefined ? {} : { evidence }) });
}

// Verify IDs and actual geometric order independently of text. Samples continue
// through all states, even in RED, so a later correction cannot hide the jump.
function inspectFrames(name, frames, context) {
  const violations = [], appearances = new Map(), phaseCounts = {};
  const firstIds = ['local-prompt-' + context.tabId + '-first-sent', context.first.uuid];
  for (const frame of frames) {
    phaseCounts[frame.phase] = (phaseCounts[frame.phase] || 0) + 1;
    const rows = frame.rows.filter((row, index, all) => all.findIndex(item => item.uuid === row.uuid) === index);
    const indexOf = aliases => rows.findIndex(row => aliases.includes(row.uuid));
    const first = indexOf(firstIds);
    const answers = context.answers.map(item => indexOf([item.uuid]));
    for (const request of context.requests) {
      const indexes = rows.flatMap((row, index) => [request.localUuid, request.canonical.uuid].includes(row.uuid) ? [index] : []);
      const index = indexes[0] ?? -1;
      if (index >= 0) appearances.set(request.handoffId, true);
      if (!appearances.has(request.handoffId)) continue;
      if (indexes.length !== 1) violations.push({ at: frame.at, handoffId: request.handoffId,
        kind: indexes.length ? 'duplicate-exact-prompt' : 'prompt-missing-after-appearance', rows: rows.map(row => row.uuid) });
      if (index < 0) continue;
      if (first < 0 || answers.some(answer => answer < 0)) violations.push({ at: frame.at,
        kind: 'preceding-context-missing', rows: rows.map(row => row.uuid) });
      for (const preceding of [first, ...answers]) if (preceding >= 0 && (preceding >= index || rows[preceding].top >= rows[index].top)) {
        violations.push({ at: frame.at, handoffId: request.handoffId, kind: 'prompt-before-existing-answer',
          phase: frame.phase, status: frame.handoffs.find(item => item.handoffId === request.handoffId),
          rows: rows.map(row => ({ uuid: row.uuid, top: row.top })) });
      }
      if (request.ownAnswer) {
        const own = indexOf([request.ownAnswer.uuid]);
        if (own >= 0 && (own <= index || rows[own].top <= rows[index].top)) violations.push({ at: frame.at,
          handoffId: request.handoffId, kind: 'own-answer-before-its-prompt', phase: frame.phase });
      }
    }
    const shownRequests = context.requests.map(request => ({ handoffId: request.handoffId,
      index: indexOf([request.localUuid, request.canonical.uuid]) })).filter(item => item.index >= 0);
    for (let index = 1; index < shownRequests.length; index++) if (shownRequests[index - 1].index >= shownRequests[index].index) {
      violations.push({ at: frame.at, kind: 'fifo-inversion', shownRequests });
    }
  }
  return { name, frames: frames.length, phaseCounts, appeared: [...appearances.keys()], violations,
    wrongFrames: new Set(violations.map(item => item.at)).size,
    wrongDurationMs: violations.length ? Math.max(...violations.map(item => item.at)) - Math.min(...violations.map(item => item.at)) : 0 };
}

try {
  await fs.mkdir(snapshot, { recursive: true });
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(freezeFrom, name), path.join(snapshot, name), {
    recursive: true, filter: value => !value.includes('/node_modules') && !value.includes('/.git'),
  });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/history-prompt-order.tsx'), path.join(snapshot, 'scripts/fixtures/history-prompt-order.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), {
    recursive: true, filter: value => !value.includes('/node_modules') && !value.includes('/.git'),
  });
  const bundled = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/history-prompt-order.tsx')],
    bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120',
    logLevel: 'silent', metafile: true, sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const sourceRoot = await fs.realpath(snapshot), hashes = {};
  for (const file of Object.keys(bundled.metafile.inputs)) {
    const real = await fs.realpath(path.resolve(file)).catch(() => null);
    if (!real) continue;
    const relative = path.relative(sourceRoot, real);
    if (/^(src|packages|scripts)\//.test(relative)) hashes[relative] = createHash('sha256').update(await fs.readFile(real)).digest('hex');
  }
  hashes['src/renderer/styles/globals.css'] = createHash('sha256').update(await fs.readFile(path.join(snapshot, 'src/renderer/styles/globals.css'))).digest('hex');
  hashes['scripts/history-prompt-order-regression.mjs'] = createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
  assert.ok(Object.keys(hashes).length > 30, 'source manifest must contain actual bundled renderer sources');
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  result.sourceHashes = hashes;
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  await fs.writeFile(path.join(artifact, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ddd}button{cursor:pointer}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  const config = { userData: path.join(artifact, 'user-data'), preload: path.join(artifact, 'preload.cjs'), html: path.join(artifact, 'index.html') };
  await fs.mkdir(config.userData);
  await fs.writeFile(config.preload, "const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});");
  await fs.writeFile(path.join(artifact, 'main.cjs'), '(' + privateMain.toString() + ')(' + JSON.stringify(config) + ');');
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: config.userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[key];
  app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'), args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.pid = app.process().pid;
  await fs.writeFile(path.join(artifact, 'process-lease.json'), JSON.stringify({ pid: result.pid, cwd: artifact,
    executable: path.join(repo, 'node_modules/.bin/electron'), main: path.join(artifact, 'main.cjs'), userData: config.userData }, null, 2));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('console', message => logs.push(message.text())); page.on('pageerror', error => result.errors.push(error.stack));
  result.electron = await app.evaluate(() => process.versions.electron);
  for (const name of cases) {
    await page.locator('[data-order-case="' + name + '"]').click();
    await page.waitForFunction(name => window.promptOrderFixture?.state.ready[name], name);
    await page.evaluate(() => window.promptOrderFixture.seedLive());
    await page.waitForFunction(() => window.promptOrderFixture.snapshot().ids.answers.every(uuid =>
      document.querySelector('[data-uuid="' + uuid + '"]')));
    await page.screenshot({ path: path.join(artifact, name + '-before.png') });
    await page.evaluate(() => window.promptOrderFixture.observe(true));
    const texts = name.endsWith('fifo') ? ['SECOND PROMPT — queue item', 'Same repeated prompt', 'Same repeated prompt'] : ['SECOND PROMPT — sent through Enter'];
    const editor = () => page.locator('[data-history-composer-tab-id] .cm-content[contenteditable="true"],.cm-content[data-history-composer-tab-id][contenteditable="true"]').last();
    for (let index = 0; index < texts.length; index++) {
      await editor().click(); await page.keyboard.insertText(texts[index]); await editor().press('Enter');
      await page.waitForFunction(({ name, index }) => window.promptOrderFixture.state.requests.filter(item => item.case === name).length > index, { name, index });
      await page.waitForFunction(({ name, index }) => {
        const s = window.promptOrderFixture.state, request = s.requests.filter(item => item.case === name)[index];
        return s.events.some(event => event.handoffId === request.handoffId && event.kind === 'preparing');
      }, { name, index });
      // First appearance through receipt reset is sampled on every real RAF.
      await page.waitForTimeout(140);
      await page.screenshot({ path: path.join(artifact, name + '-attempt-' + index + '.png') });
      await page.waitForFunction(({ name, index }) => {
        const s = window.promptOrderFixture.state, request = s.requests.filter(item => item.case === name)[index];
        return s.events.some(event => event.handoffId === request.handoffId && (event.kind === 'queued' || event.kind === 'confirmed'));
      }, { name, index });
      await page.waitForTimeout(90);
    }
    await page.evaluate(() => window.promptOrderFixture.confirm());
    await page.waitForTimeout(160);
    await page.screenshot({ path: path.join(artifact, name + '-sent.png') });
    await page.evaluate(() => window.promptOrderFixture.materialize());
    await page.waitForFunction(() => window.promptOrderFixture.snapshot().ids.prompts.every(item =>
      document.querySelector('[data-uuid="' + item.canonical + '"]')));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.promptOrderFixture.observe(false));
    await page.screenshot({ path: path.join(artifact, name + '-canonical.png') });
    const data = await page.evaluate(() => window.promptOrderFixture.summary());
    const context = data.contexts.find(item => item.name === name), frames = data.frames.filter(item => item.case === name);
    const proof = inspectFrames(name, frames, context);
    const events = data.events.filter(item => item.case === name), keys = data.trusted.filter(item => item.case === name && item.type === 'keydown' && item.key === 'Enter');
    result.cases.push({ ...proof, events, requests: context.requests, final: await page.evaluate(() => window.promptOrderFixture.snapshot()) });
    check(name + ': real trusted composer Enter', keys.length === texts.length && keys.every(item => item.trusted), keys);
    check(name + ': every prompt appeared once by identity', proof.appeared.length === texts.length, proof.appeared);
    check(name + ': continuous row/FIFO/own-answer order', proof.violations.length === 0,
      { frames: proof.frames, wrongFrames: proof.wrongFrames, firstViolation: proof.violations[0] });
    check(name + ': actual first-attempt receipt hydration', events.filter(item => item.kind === 'preparing').length === texts.length
      && events.filter(item => item.kind === 'preparing').every(item => item.hydrated), events.filter(item => item.kind === 'preparing'));
    check(name + ': canonical adoption removes local duplicates', result.cases.at(-1).final.ids.prompts.every(item =>
      result.cases.at(-1).final.rows.some(row => row.uuid === item.canonical)
      && !result.cases.at(-1).final.rows.some(row => row.uuid === item.local)));
    if (texts.length > 1) check(name + ': equal text has distinct handoff/canonical IDs', context.requests[1].text === context.requests[2].text
      && context.requests[1].handoffId !== context.requests[2].handoffId
      && context.requests[1].canonical.uuid !== context.requests[2].canonical.uuid);
  }
  const data = await page.evaluate(() => window.promptOrderFixture.summary());
  const main = await app.evaluate(() => global.promptOrderMain);
  await fs.writeFile(path.join(artifact, 'frames.json'), JSON.stringify(data.frames));
  await fs.writeFile(path.join(artifact, 'fixture-state.json'), JSON.stringify(data, null, 2));
  result.unknownIPC = [...new Set(main.unknown)]; result.totalFrames = data.frames.length;
  check('no provider/PTY/lifecycle mutation', !data.forbidden.length && !main.forbidden.length, { renderer: data.forbidden, main: main.forbidden });
  check('no renderer errors', result.errors.length === 0, result.errors);
  result.status = result.checks.every(item => item.pass) ? 'PASS' : 'FAIL';
  if (result.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
    await page.evaluate(() => window.promptOrderFixture?.summary()).then(data =>
      fs.writeFile(path.join(artifact, 'fixture-state.json'), JSON.stringify(data, null, 2))).catch(() => {});
  }
} finally {
  if (app) {
    await app.close().catch(error => { result.cleanup.closeError = String(error); });
    try { process.kill(result.pid, 0); result.cleanup.processExited = false; }
    catch { result.cleanup.processExited = true; }
  }
  for (const [key, target] of [['snapshotRemoved', snapshot], ['sharedRemoved', shared], ['userDataRemoved', path.join(artifact, 'user-data')]]) {
    await fs.rm(target, { recursive: true, force: true }); result.cleanup[key] = true;
  }
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, checks: result.checks.length,
    failed: result.checks.filter(item => !item.pass), cases: result.cases.map(item => ({ name: item.name,
      frames: item.frames, wrongFrames: item.wrongFrames, wrongDurationMs: item.wrongDurationMs })),
    error: result.error, cleanup: result.cleanup }));
}

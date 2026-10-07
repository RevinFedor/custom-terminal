#!/usr/bin/env node
// Actual HistoryPanel/CodeMirror trusted typing, synthetic IPC/retained content.
// Two frozen renderer bundles differ only in the accepted R04 presentation.
// No OS clipboard, focus, provider, production connection or full app launch.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const arg = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const baseline = arg('baseline'); assert.ok(baseline, '--baseline is the frozen pre-R04 source directory');
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-r04-input-'));
const snapshot = path.join(artifact, 'source'), shared = path.join(artifact, 'shared');
const result = { artifact, samples: [], checks: [], errors: [], cleanup: {}, inputs: {},
  boundary: 'Actual frozen HistoryPanel/composer + synthetic IPC and 60k retained nodes. EventTiming is censored below16ms, not a complete latency histogram. No installed/OS input acceptance.' };
const hash = value => createHash('sha256').update(value).digest('hex');
let app, page;
const logs = [];

function privateMain(config) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  global.r04Main = { forbidden: [], unknown: [], focus: [], paints: 0 };
  ipcMain.handle('r04:invoke', (_event, { channel, args }) => {
    if (/send-command|send-prompt|enqueue-prompt|terminal:(create|input|paste|kill|restart|stop-ai)|orchestration.*create/.test(channel)) {
      global.r04Main.forbidden.push(channel); throw Error('Forbidden private operation: ' + channel);
    }
    if (channel === 'file:exists-batch') return Object.fromEntries(args[0].map(file => [file, false]));
    if (channel === 'terminal:getCommandStates') return {};
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'terminal:getCommandState' || /getState|get-state/.test(channel)) return null;
    if (/list|List|catalog|get-models|get-prompts|project:getGroups/.test(channel)) return [];
    if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
    global.r04Main.unknown.push(channel); return { success: true };
  });
  app.whenReady().then(() => {
    app.dock?.hide();
    const window = global.r04Window = new BrowserWindow({ show: false, focusable: false, width: 1120, height: 800,
      frame: false, webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false,
        backgroundThrottling: false, preload: config.preload } });
    window.on('focus', () => global.r04Main.focus.push(Date.now()));
    window.webContents.on('paint', () => global.r04Main.paints++);
    window.webContents.setFrameRate(60); window.loadFile(config.html);
  });
  app.on('window-all-closed', () => app.quit());
}
function privatePreload() {
  const electron = require('electron'), invoke = electron.ipcRenderer.invoke.bind(electron.ipcRenderer);
  electron.ipcRenderer.invoke = (channel, ...args) => invoke('r04:invoke', { channel, args });
  let text = '';
  const clipboard = { writeText(value) { text = String(value); }, readText() { return text; },
    availableFormats() { return ['text/plain']; }, readBuffer() { return Buffer.alloc(0); },
    readImage() { return electron.nativeImage.createEmpty(); }, clear() { text = ''; } };
  const realRequire = window.require;
  window.require = name => name === 'electron' ? { ...electron, clipboard } : realRequire(name);
}

try {
  for (const file of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, file), path.join(snapshot, file), {
    recursive: true, filter: item => !item.includes('/node_modules') && !item.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/history-renderer-input-paint.tsx'), path.join(snapshot, 'scripts/fixtures/history-renderer-input-paint.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  for (const file of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', file), path.join(shared, file), {
    recursive: true, filter: item => !item.includes('/node_modules') && !item.includes('/.git') });
  const switched = ['src/renderer/components/Workspace/HistoryPanel.tsx', 'src/renderer/styles/globals.css'];
  const current = new Map(await Promise.all(switched.map(async file => [file, await fs.readFile(path.join(snapshot, file))])));
  for (const arm of ['baseline', 'product']) {
    for (const file of switched) await fs.writeFile(path.join(snapshot, file), arm === 'baseline'
      ? await fs.readFile(path.join(baseline, file)) : current.get(file));
    const out = path.join(artifact, arm); await fs.mkdir(out);
    const compiled = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/history-renderer-input-paint.tsx')],
      bundle: true, outfile: path.join(out, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120',
      logLevel: 'silent', metafile: true, sourcemap: true, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
      alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
        '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
        react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
      loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
    const hashes = {}, realSnapshot = await fs.realpath(snapshot);
    for (const file of Object.keys(compiled.metafile.inputs)) {
      if (file.startsWith('<')) continue;
      const absolute = await fs.realpath(path.resolve(file)), relative = path.relative(realSnapshot, absolute);
      if (!relative.startsWith('..')) hashes[relative] = hash(await fs.readFile(absolute));
    }
    hashes['src/renderer/styles/globals.css'] = hash(await fs.readFile(path.join(snapshot, 'src/renderer/styles/globals.css')));
    assert.ok(hashes['src/renderer/components/Workspace/HistoryPanel.tsx'], 'manifest must contain the actual bundled History source');
    if (arm === 'product') assert.ok(hashes['src/renderer/components/UI/CompositedTextShimmer.tsx'], 'manifest must include the product mask helper');
    result.inputs[arm] = hashes;
    execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
      '-o', path.join(out, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
    await fs.writeFile(path.join(out, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#18181b;color:#ddd;font:14px Arial;overflow:hidden}.r04-title{height:40px;display:flex;align-items:center;gap:5px;background:#303033;position:relative;z-index:5}button{color:#ddd;background:#444}</style><style id="pause"></style><div id="root"></div><script type="module" src="bundle.js"></script>');
  }
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(result.inputs, null, 2));
  const config = { userData: path.join(artifact, 'profile'), preload: path.join(artifact, 'preload.cjs'), html: path.join(artifact, 'baseline/index.html') };
  await fs.mkdir(config.userData);
  await fs.writeFile(config.preload, '(' + privatePreload.toString() + ')();');
  await fs.writeFile(path.join(artifact, 'main.cjs'), '(' + privateMain.toString() + ')(' + JSON.stringify(config) + ');');
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: config.userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  result.pid = app.process().pid;
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => result.errors.push(error.message)); page.on('console', message => logs.push(message.text()));
  for (const [index, mode] of ['baseline', 'control', 'product', 'baseline', 'product'].entries()) {
    const arm = mode === 'control' ? 'baseline' : mode;
    await page.goto('file://' + path.join(artifact, arm, 'index.html'));
    await page.waitForFunction(() => window.r04Input?.ready);
    const editor = page.locator('.cm-content[contenteditable="true"]').last(); await editor.waitFor();
    await page.locator('.hp-history-response-tail[data-state="running"]').waitFor();
    if (mode === 'control') await page.evaluate(() => { document.getElementById('pause').textContent = '* ,*::before,*::after{animation-play-state:paused!important}'; });
    // The private renderer deliberately persists drafts across reload. Reset
    // through the real editor before each paired arm, rather than assuming an
    // empty draft or bypassing its normal state owner.
    await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
    await page.waitForFunction(() => !window.r04Input.snapshot().draft);
    await page.keyboard.type('warmup');
    await page.waitForFunction(() => window.r04Input.snapshot().draft === 'warmup');
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
    await page.waitForFunction(() => !window.r04Input.snapshot().draft);
    await page.evaluate(() => { window.r04Input.clearMeasurements(); window.r04SavedEditor = document.querySelector('.cm-content[contenteditable="true"]'); });
    for (const part of ['alpha', 'bravo', 'charl']) { await editor.click(); await page.keyboard.type(part, { delay: 85 }); }
    await page.waitForFunction(() => window.r04Input.snapshot().draft === 'alphabravocharl');
    await page.waitForTimeout(200); // Allow buffered browser EventTiming publication; not the readiness gate.
    const sample = await page.evaluate(() => ({ ...window.r04Input.snapshot(), input: window.r04Input.input,
      eventTiming: window.r04Input.eventTiming, supported: window.r04Input.supported,
      animationCount: document.getAnimations().filter(animation => animation.playState === 'running').length }));
    assert.equal(sample.editor, 'alphabravocharl'); assert.ok(sample.nodes >= 60000);
    assert.ok(sample.input.filter(event => event.type === 'keydown' && event.editor).length >= 15);
    assert.ok(sample.input.every(event => event.trusted));
    result.samples.push({ index, mode, ...sample });
    await page.locator('#r04-hide').click(); await page.locator('#r04-hide').click();
    assert.equal(await page.evaluate(() => window.r04SavedEditor === document.querySelector('.cm-content[contenteditable="true"]')), true);
    assert.equal(await editor.innerText(), 'alphabravocharl');
    await page.screenshot({ path: path.join(artifact, index + '-' + mode + '.png') });
    console.log(JSON.stringify({ mode, events: sample.eventTiming.length, nodes: sample.nodes }));
  }
  result.main = await app.evaluate(() => global.r04Main);
  assert.deepEqual(result.main.forbidden, []); assert.deepEqual(result.main.focus, []);
  assert.deepEqual(result.errors, []); result.status = 'PASS';
  result.checks.push('actual History trusted input preserved', 'retained60k tree', 'same editor/draft after hide/show',
    'separate browser input/handler/presentation timings where reported', 'no provider/production/OS focus');
} catch (error) {
  result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1;
  await page?.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
} finally {
  if (app) { await app.close(); result.cleanup.electronClosed = true; }
  for (const folder of [snapshot, shared, path.join(artifact, 'profile')]) await fs.rm(folder, { recursive: true, force: true });
  result.cleanup.ownedFilesRemoved = true;
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, error: result.error, cleanup: result.cleanup }));
}

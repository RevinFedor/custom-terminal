#!/usr/bin/env node
// Actual History/Virtuoso; owned private Electron, no live IPC or provider.
// --control=observer-only is the previous observer-only library on the SAME
// product source. --actual=<bounded API JSON> is private input, never a fixture
// checked into the repository. Native PNGs must be inspected, not just rAF.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const arg = key => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
const source = path.resolve(arg('source') || repo);
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-upward-'));
const snapshot = path.join(artifact, 'source'), shared = path.join(artifact, 'shared');
const result = { artifact, source, control: arg('control') || null, checks: [], errors: [], cleanup: {},
  boundary: 'Actual HistoryPanel/Virtuoso, private synthetic IPC, optional bounded API copy; trusted input, offscreen native paints. No production input, PTY/provider, or installation.' };
const logs = []; let app, page;
const hash = data => createHash('sha256').update(data).digest('hex');
const check = (name, pass, evidence) => { result.checks.push({ name, pass: !!pass, evidence }); assert.ok(pass, name); };

function privateMain(config) {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
  const fs = require('node:fs'), path = require('node:path');
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  const state = global.historyMeasureMain = { calls: [], unknown: [], forbidden: [], paints: [], latest: null, capture: false, focusEvents: 0 };
  const buffers = [];
  global.flushHistoryMeasurePaints = () => {
    buffers.forEach((pixels, i) => fs.writeFileSync(path.join(config.artifact, state.paints[i].file),
      nativeImage.createFromBitmap(pixels, state.paints[i].size).toPNG()));
    buffers.length = 0;
  };
  const readNull = new Set(['app:getState', 'terminal:getCommandState', 'timeline:get-session-history-events',
    'timeline-prompt-summaries:get', 'timeline-outline:get', 'timeline-turn-action-overrides:get', 'claude:get-pending-question']);
  const readArray = new Set(['timeline:get-notes', 'timeline:get-rewind-markers', 'project:getGroups']);
  ipcMain.handle('fixture:invoke', (_event, { channel, args }) => {
    state.calls.push(channel);
    if (/^(terminal:(create|input|paste|kill|restart|stop)|claude-sdk:|codex:(send|run)|agent:(stop|rewind|send))/.test(channel)) {
      state.forbidden.push(channel); throw Error('Forbidden private transport ' + channel);
    }
    if (readNull.has(channel)) return null;
    if (readArray.has(channel)) return [];
    if (['app:setState', 'history-preparation:subscribe', 'history-preparation:unsubscribe'].includes(channel)) return { success: true };
    if (channel === 'agent:list-background-work') return { success: true, items: [] };
    if (channel === 'agent:get-operational-phase') return { success: true, phase: null };
    if (channel === 'prompt-queue:get-image-preview-data-url') return { success: false, error: 'private fixture has no image assets' };
    if (channel === 'terminal:getCommandStates') return {};
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'file:exists-batch') return Object.fromEntries(args[0].map(p => [p, false]));
    state.unknown.push(channel); throw Error('Unknown private invoke ' + channel);
  });
  ipcMain.on('fixture:sample', (_event, value) => { state.latest = value; });
  ipcMain.on('fixture:send', (_event, { channel }) => {
    if (['renderer:log', 'renderer:warn', 'renderer:error', 'perf:renderer-log', 'perf:ui-action'].includes(channel)) return;
    state.unknown.push('send:' + channel);
  });
  app.whenReady().then(() => {
    app.dock?.hide();
    const win = global.historyMeasureWindow = new BrowserWindow({ show: false, focusable: false, frame: false,
      width: config.width, height: config.height,
      webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, preload: config.preload } });
    win.on('focus', () => state.focusEvents++);
    win.webContents.setFrameRate(60);
    global.waitHistoryMeasureReadyPaint = () => new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); win.webContents.removeListener('paint', painted);
        error ? reject(error) : resolve(true);
      };
      const painted = (_event, _dirty, image) => {
        const raster = image.resize({ width: config.width, quality: 'good' });
        const bytes = raster.toBitmap(); let bright = 0;
        for (let y = 100; y < config.height - 80; y += 4)
          for (let x = 30; x < Math.min(config.width - 30, 720); x += 4) {
            const offset = (y * config.width + x) * 4;
            if (Math.max(bytes[offset], bytes[offset + 1], bytes[offset + 2]) > 85) bright++;
          }
        if (bright > 100) finish();
      };
      const timer = setTimeout(() => finish(Error('Initial History native content paint missing')), 4000);
      win.webContents.on('paint', painted); win.webContents.invalidate();
    });
    win.webContents.on('paint', (_event, dirty, image) => {
      if (!state.capture) return;
      if (state.paints.length >= 210) { state.paintLimit = true; return; }
      const index = state.paints.length, file = 'paint-' + String(index).padStart(3, '0') + '.png';
      // Preserve CSS-pixel geometry in a bounded LEFT crop. No synchronous PNG
      // encoding/disk writes during input. The whole viewport width is unchanged.
      const raster = image.resize({ width: config.width, quality: 'good' })
        .crop({ x: 0, y: 0, width: Math.min(config.width, 720), height: config.height });
      buffers.push(raster.toBitmap());
      state.paints.push({ index, abs: Date.now(), dirty, originalSize: image.getSize(), size: raster.getSize(), file, sample: state.latest });
    });
    win.loadFile(config.html);
  });
  app.on('window-all-closed', () => app.quit());
}

try {
  await fs.mkdir(snapshot);
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(source, name), path.join(snapshot, name), {
    recursive: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git'),
  });
  for (const name of ['tailwind.config.ts', 'tailwind.config.cjs', 'postcss.config.js'])
    await fs.copyFile(path.join(source, name), path.join(snapshot, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.mkdir(path.join(snapshot, 'scripts/lib'), { recursive: true });
  for (const name of ['scripts/fixtures/history-upward-measurement.tsx', 'scripts/lib/history-virtuoso-measurement.mjs'])
    await fs.copyFile(path.join(source, name), path.join(snapshot, name));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, name), {
    recursive: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git'),
  });
  const adapter = await import(pathToFileURL(path.join(snapshot, 'scripts/lib/history-virtuoso-measurement.mjs')).href);
  assert.ok(!result.control || result.control === 'observer-only', 'known paired control only');
  const bundle = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/history-upward-measurement.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic',
    logLevel: 'silent', metafile: true, sourcemap: true,
    plugins: result.control ? [] : [adapter.historyVirtuosoMeasurementEsbuildPlugin()],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const hashes = {}, realRoot = await fs.realpath(snapshot);
  for (const file of Object.keys(bundle.metafile.inputs)) {
    if (file.startsWith('<') && file.endsWith('>')) continue; // esbuild define input, not a file.
    const real = await fs.realpath(path.resolve(file));
    const relative = path.relative(realRoot, real);
    if (/^(src|packages|scripts)\//.test(relative)) hashes[relative] = hash(await fs.readFile(real));
  }
  for (const name of ['src/renderer/styles/globals.css', 'scripts/lib/history-virtuoso-measurement.mjs'])
    hashes[name] = hash(await fs.readFile(path.join(snapshot, name)));
  assert.ok(hashes['src/renderer/components/Workspace/HistoryPanel.tsx']);
  result.sourceHashes = hashes;
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  const config = { width: Number(arg('width') || 1600), viewportHeight: 1063, fontSize: Number(arg('font') || 19), tailLines: 3 };
  if (arg('actual')) {
    const body = await fs.readFile(arg('actual'));
    config.entries = JSON.parse(body).entries;
    assert.ok(Array.isArray(config.entries) && config.entries.length);
    result.actualInput = { path: arg('actual'), bytes: body.length, sha256: hash(body), entries: config.entries.length };
  }
  result.config = { ...config, entries: undefined };
  await fs.writeFile(path.join(artifact, 'fixture-input.json'), JSON.stringify(config));
  await fs.writeFile(path.join(artifact, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc;overflow:hidden}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  const mainConfig = { artifact, userData: path.join(artifact, 'user-data'), preload: path.join(artifact, 'preload.cjs'),
    html: path.join(artifact, 'index.html'), width: config.width, height: config.viewportHeight + 32 };
  await fs.mkdir(mainConfig.userData);
  await fs.writeFile(mainConfig.preload, `const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer),send=ipcRenderer.send.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});ipcRenderer.send=(channel,...args)=>channel==='fixture:sample'?send(channel,...args):send('fixture:send',{channel,args});`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), '(' + privateMain.toString() + ')(' + JSON.stringify(mainConfig) + ');');
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: mainConfig.userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[key];
  app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'), args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.pid = app.process().pid;
  await fs.writeFile(path.join(artifact, 'process-lease.json'), JSON.stringify({ pid: result.pid, cwd: artifact, userData: mainConfig.userData }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.stack || error.message));
  page.on('console', message => logs.push(message.text()));
  await page.waitForFunction(() => window.historyUpwardFixture?.state.ready);
  await page.locator('[data-history-viewport-ready="1"]').waitFor();
  await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]'); return s && s.scrollHeight - s.scrollTop - s.clientHeight < 2; });
  // DOM-ready can precede the offscreen compositor's first delivered content
  // frame. The incident started in an already visible History; do not send a
  // wheel into a still-queued startup/empty paint and call that a scroll test.
  await app.evaluate(() => global.waitHistoryMeasureReadyPaint());
  result.initial = await page.evaluate(() => { window.savedHistoryScroller = document.querySelector('[data-virtuoso-scroller]'); return window.historyUpwardFixture.sample(); });
  const scroller = page.locator('[data-virtuoso-scroller]'), box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .65);
  const packets = arg('events') ? JSON.parse(await fs.readFile(arg('events'), 'utf8'))
    : [[0,-4],[35,-28],[70,-95],[110,-135],[155,-157],[195,-174],[340,-4],[375,-25],[405,-85],
      [440,-130],[475,-170],[515,-180],[740,-4],[785,-30],[820,-100],[860,-135],[905,-160],[955,-365],
      [1190,-4],[1235,-259],[1280,-335],[1325,-192]].map(([at,dy]) => ({ at, dy }));
  await page.evaluate(() => window.historyUpwardFixture.observe('upward'));
  await app.evaluate(() => { global.historyMeasureMain.capture = true; });
  const cdp = await page.context().newCDPSession(page), pending = [];
  result.dispatch = [];
  const start = performance.now();
  for (const event of packets) {
    const delay = event.at - (performance.now() - start); if (delay > 0) await page.waitForTimeout(delay);
    result.dispatch.push({ requestedAt: event.at, sentAt: performance.now() - start, deltaY: event.dy });
    pending.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x + box.width * .7,
      y: box.y + box.height * .65, deltaX: 0, deltaY: event.dy }));
  }
  await Promise.all(pending); await page.waitForTimeout(400);
  await app.evaluate(() => { global.historyMeasureMain.capture = false; });
  result.renderer = await page.evaluate(() => { const f = window.historyUpwardFixture; f.state.observing = false;
    return { state: f.state, final: f.sample(), sameScroller: window.savedHistoryScroller === document.querySelector('[data-virtuoso-scroller]') }; });
  await app.evaluate(() => global.flushHistoryMeasurePaints());
  result.main = await app.evaluate(() => global.historyMeasureMain);
  check('same History owner/scroller across upward gesture', result.renderer.sameScroller);
  check('real visible rows throughout', result.renderer.state.frames.every(f => f.rows.length && !f.seek && !f.shells));
  check('trusted negative wheel only', result.renderer.state.wheels.length > 0
    && result.renderer.state.wheels.every(e => e.trusted && e.deltaY < 0), { delivered: result.renderer.state.wheels.length, dispatched: packets.length });
  check('native capture covers full gesture', !result.main.paintLimit && result.main.paints.length > 10, result.main.paints.length);
  check('no focus/unknown IPC/provider actions', !result.main.focusEvents && !result.main.unknown.length && !result.main.forbidden.length,
    { focus: result.main.focusEvents, unknown: result.main.unknown, forbidden: result.main.forbidden });
  check('no renderer errors', !result.errors.length, result.errors);
  await page.screenshot({ path: path.join(artifact, 'final.png') });
  if (arg('adjacent') === '1') {
    const settledFrames = () => page.evaluate(() => new Promise(resolve => {
      let count = 0; const step = () => ++count >= 8 ? resolve(true) : requestAnimationFrame(step);
      requestAnimationFrame(step);
    }));
    const reading = async () => page.evaluate(() => {
      const f = window.historyUpwardFixture, sample = f.sample();
      const row = sample.rows.find(r => r.top >= 0 && r.top < sample.client - 100);
      if (!row) throw Error('Reading anchor missing');
      window.readingAnchorUuid = row.uuid;
      return { uuid: row.uuid, top: row.top, scrollTop: sample.top };
    });
    const anchorPosition = () => page.evaluate(() => {
      const f = window.historyUpwardFixture, sample = f.sample();
      return { row: sample.rows.find(r => r.uuid === window.readingAnchorUuid), top: sample.top,
        sameScroller: window.savedHistoryScroller === document.querySelector('[data-virtuoso-scroller]') };
    });
    const before = await reading();
    await page.locator('[data-toggle-shown]').click();
    await page.locator('[data-history-presented="0"]').waitFor();
    await settledFrames();
    const hidden = await anchorPosition();
    check('hidden owner preserves mounted scroller and position', hidden.sameScroller && Math.abs(hidden.top - before.scrollTop) <= 2, hidden);
    await page.locator('[data-toggle-shown]').click();
    await page.locator('[data-history-presented="1"]').waitFor();
    await settledFrames();
    const shown = await anchorPosition();
    check('warm return preserves reading anchor without remount', shown.sameScroller && shown.row && Math.abs(shown.row.top - before.top) <= 2, { before, shown });
    const currentBox = await scroller.boundingBox();
    await page.mouse.move(currentBox.x + currentBox.width * .7, currentBox.y + currentBox.height * .5);
    const beforeDown = await scroller.evaluate(s => s.scrollTop);
    await page.mouse.wheel(0, 180); await settledFrames();
    const afterDown = await scroller.evaluate(s => s.scrollTop);
    check('changing direction scrolls down normally', afterDown > beforeDown + 100, { beforeDown, afterDown });
    const beforeResize = await reading();
    const textAnchor = await page.evaluate(() => window.historyUpwardFixture.captureReader());
    await page.locator('[data-narrow]').click();
    await page.waitForFunction(() => document.querySelector('[data-virtuoso-scroller]').clientWidth <= 760);
    await page.locator('[data-history-resize-locked]').waitFor({ state: 'attached' });
    await page.locator('[data-history-resize-locked]').waitFor({ state: 'detached' });
    await page.locator('[data-history-viewport-loader]').waitFor({ state: 'detached' });
    await settledFrames();
    const narrow = await anchorPosition();
    const textAfterNarrow = await page.evaluate(() => window.historyUpwardFixture.measureReader());
    check('narrow pane keeps the frozen text reading point', textAfterNarrow && Math.abs(textAfterNarrow.drift) <= 2,
      { beforeResize, narrow, textAnchor, textAfterNarrow });
    await page.locator('[data-wide]').click();
    await page.locator('[data-history-resize-locked]').waitFor({ state: 'attached' });
    await page.locator('[data-history-resize-locked]').waitFor({ state: 'detached' });
    await page.locator('[data-history-viewport-loader]').waitFor({ state: 'detached' });
    await settledFrames();
    check('widening returns to readable History', await scroller.locator('[data-history-row-real]').count() > 0);
    await page.keyboard.press('Meta+f');
    await page.getByLabel('Поиск по чату', { exact: true }).fill('ROW 0013');
    await page.waitForFunction(() => {
      const s = document.querySelector('[data-virtuoso-scroller]');
      const row = s?.querySelector('[data-history-row-real][data-uuid="prior-13"]');
      if (!row) return false;
      const a = row.getBoundingClientRect(), b = s.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom;
    });
    check('search jumps to a cold exact message', true);
    await page.keyboard.press('Escape');
    await page.locator('[data-history-scroll-to-bottom]').click();
    await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; });
    await page.evaluate(() => window.historyUpwardFixture.appendTail());
    await page.locator('[data-history-row-real][data-uuid="new-tail-1"]').waitFor();
    await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]'); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; });
    check('explicit bottom and following appended response still work', true);
    // Model a NEW gesture after the shipping 450ms machine-scroll cooldown.
    // An immediate wheel after our search/bottom command is intentionally
    // excluded from seek; that is not a failure of fast-scroll capability.
    await page.waitForTimeout(600);
    await page.evaluate(() => window.historyUpwardFixture.observe('fast'));
    const fastBox = await scroller.boundingBox();
    await page.mouse.move(fastBox.x + fastBox.width * .7, fastBox.y + fastBox.height * .6);
    await page.mouse.wheel(0, -4);
    for (let packet = 0; packet < 4; packet++) {
      await page.waitForTimeout(60);
      await page.mouse.wheel(0, -4000);
    }
    // Bounded observation window, followed by an actual ready-state check.
    await page.waitForTimeout(700);
    await page.waitForFunction(() => { const s = window.historyUpwardFixture.sample(); return s?.rows.length && !s.seek && !s.shells && !s.bridge; });
    const fast = await page.evaluate(() => { const f = window.historyUpwardFixture; f.state.observing = false;
      return { frames: f.state.frames.filter(s => s.phase === 'fast'), final: f.sample() }; });
    check('genuine fast scroll still uses seek placeholders', fast.frames.some(f => f.seek > 0),
      { frames: fast.frames.length, seekFrames: fast.frames.filter(f => f.seek > 0).length });
    check('fast scroll returns to real rows without a stuck bridge', !fast.final.seek && !fast.final.shells && !fast.final.bridge);
    result.fast = fast;
    result.adjacentMain = await app.evaluate(() => global.historyMeasureMain);
    check('adjacent controls use no provider/unknown IPC', !result.adjacentMain.forbidden.length && !result.adjacentMain.unknown.length && !result.adjacentMain.focusEvents);
    check('adjacent controls have no renderer errors', !result.errors.length, result.errors);
  }
  result.status = 'MEASURED'; // Pixel analysis is a separate assertion, not rAF.
} catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1; }
finally {
  if (app) { await app.close().catch(() => {}); result.cleanup.appClosed = true; }
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  for (const name of ['user-data', 'source', 'shared']) {
    await fs.rm(path.join(artifact, name), { recursive: true, force: true });
    result.cleanup[name] = 'removed';
  }
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, error: result.error, checks: result.checks,
    errors: result.errors, frames: result.renderer?.state.frames.length, paints: result.main?.paints.length }));
}

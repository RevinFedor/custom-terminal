#!/usr/bin/env node
// Isolated actual HistoryPanel/Virtuoso. No Git operations, real API or PTY.
// No arguments: synthetic 22626-character row, expanded through actual search.
// Optional --body=<captured API JSON> uses its tall user body only in TMPDIR.
// --expand=none is only for historical sources that did not collapse this row.
// --source=<frozen checkout> preserves an independent pre-fix control.
// --control=disable-measurement-sync disables ONLY the new helper admission in
// the private current-source copy, for a paired RED with --expand=search.
// --prototype=microtask-flush|observer-flush|list-layer|measurement-scroll-sync
// changes only the private copy; no production files or node_modules are edited.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const arg = key => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
const expansionMode = arg('expand') || 'search';
const source = path.resolve(arg('source') || repo);
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-tall-row-'));
const snapshot = path.join(artifact, 'source'), shared = path.join(artifact, 'shared');
const result = { artifact, source, checks: [], errors: [], cleanup: {}, boundary: 'Actual HistoryPanel/Virtuoso in private offscreen Electron; synthetic IPC; optional private captured body, synthetic neighbors; no provider/PTY/live APIs.' };
const logs = []; let app, page;
const check = (name, pass, evidence) => result.checks.push({ name, pass: !!pass, evidence });

function privateMain(config) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path');
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  const state = global.tallRowMain = { calls: [], unknown: [], forbidden: [], paints: [], latest: null, capture: false, readingRoiTop: config.readingRoiTop };
  global.tallRowPaintBuffers = [];
  global.flushTallRowPaints = async () => {
    const { nativeImage } = require('electron');
    for (let i = 0; i < global.tallRowPaintBuffers.length; i++) {
      const pixels = global.tallRowPaintBuffers[i], meta = state.paints[i];
      const image = nativeImage.createFromBitmap(pixels, meta.size);
      fs.writeFileSync(path.join(config.artifact, meta.file), image.toPNG());
      let bright = 0, violet = 0, dark = 0, total = 0;
      // Use actual pixels, independent of rAF DOM geometry. Expected reading
      // content is neutral assistant prose; the giant service bubble is violet.
      for (let y = state.readingRoiTop; y < meta.size.height - 60; y += 2) for (let x = 35; x < meta.size.width - 35; x += 2) {
        const offset = (y * meta.size.width + x) * 4;
        const b = pixels[offset], g = pixels[offset + 1], r = pixels[offset + 2]; total++;
        if (Math.max(r, g, b) > 100) bright++;
        if (b > g + 7 && r > g + 2 && b < 100) violet++;
        if (r < 45 && g < 45 && b < 45) dark++;
      }
      meta.pixels = { bright: bright / total, violet: violet / total, dark: dark / total,
        roi: { left: 35, top: state.readingRoiTop, right: meta.size.width - 35, bottom: meta.size.height - 60 } };
      global.tallRowPaintBuffers[i] = null;
      await new Promise(resolve => setImmediate(resolve));
    }
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
    if (channel === 'app:setState') return { success: true }; // Memory-only fixture ACK.
    if (channel === 'history-preparation:subscribe' || channel === 'history-preparation:unsubscribe') return { success: true };
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
    const win = new BrowserWindow({ show: false, focusable: false, frame: false, width: config.width, height: config.height,
      webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, preload: config.preload } });
    win.webContents.setFrameRate(60);
    win.webContents.on('paint', (_event, dirty, image) => {
      if (!state.capture || state.paints.length >= 120) return;
      const index = state.paints.length, file = 'paint-' + String(index).padStart(3, '0') + '.png';
      // Avoid synchronous PNG compression or disk writes during the gesture.
      // Retain a 1x native paint buffer; encode only after capture has stopped.
      const captureAt = Date.now(), raster = image.resize({ width: config.width, quality: 'good' });
      global.tallRowPaintBuffers.push(raster.toBitmap());
      state.paints.push({ index, abs: captureAt, dirty, originalSize: image.getSize(), size: raster.getSize(), file, sample: state.latest });
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
  if (arg('control') === 'disable-measurement-sync') {
    assert.ok(!arg('prototype'), 'paired RED control must not combine prototype transforms');
    const file = path.join(snapshot, 'src/renderer/components/Workspace/HistoryPanel.tsx');
    const original = await fs.readFile(file, 'utf8');
    const needle = 'historyMeasurementViewportSync.schedule(element);';
    const replacement = 'void element; /* private paired RED: measurement viewport sync disabled */';
    assert.equal(original.split(needle).length - 1, 1, 'exactly one production helper admission must be disabled');
    const changed = original.replace(needle, replacement);
    result.control = { name: 'disable-measurement-sync', replacements: 1, needle, replacement,
      beforeSha256: createHash('sha256').update(original).digest('hex'),
      afterSha256: createHash('sha256').update(changed).digest('hex') };
    await fs.writeFile(file, changed);
    await fs.writeFile(path.join(artifact, 'paired-control.json'), JSON.stringify(result.control, null, 2));
  }
  if (['microtask-flush', 'measurement-scroll-sync'].includes(arg('prototype'))) {
    // Explicitly requested investigation in the PRIVATE snapshot only.
    const file = path.join(snapshot, 'src/renderer/components/Workspace/HistoryPanel.tsx');
    let text = await fs.readFile(file, 'utf8');
    const start = text.indexOf('  const measureHistoryVirtuosoItemSize = useCallback(');
    const end = text.indexOf('    return actualSize;', start);
    assert.ok(start > 0 && end > start && text.slice(start, end).includes('const knownSize ='));
    result.prototype = { name: arg('prototype'), beforeSha256: createHash('sha256').update(text).digest('hex') };
    const callback = arg('prototype') === 'measurement-scroll-sync'
      ? `const capturedScroller = virtuosoScrollerRef.current;
      queueMicrotask(() => {
        privateMeasurementFlushRef.current = false;
        if (capturedScroller?.isConnected && virtuosoScrollerRef.current === capturedScroller) {
          capturedScroller.dispatchEvent(new Event('scroll'));
        }
      });`
      : 'queueMicrotask(() => { privateMeasurementFlushRef.current = false; flushSync(() => {}); });';
    text = text.slice(0, end) + `    if (field === 'offsetHeight' && Number.isFinite(knownSize) && actualSize !== knownSize
      && !privateMeasurementFlushRef.current) {
      privateMeasurementFlushRef.current = true;
      ${callback}
    }
` + text.slice(end);
    text = text.slice(0, start) + '  const privateMeasurementFlushRef = useRef(false);\n' + text.slice(start);
    result.prototype.afterSha256 = createHash('sha256').update(text).digest('hex');
    await fs.writeFile(file, text);
  }
  for (const name of ['tailwind.config.ts', 'tailwind.config.cjs', 'postcss.config.js'])
    await fs.copyFile(path.join(source, name), path.join(snapshot, name)).catch(() => {});
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/history-tall-row.tsx'), path.join(snapshot, 'scripts/fixtures/history-tall-row.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), {
    recursive: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git'),
  });
  const extraAliases = {};
  if (arg('prototype') === 'observer-flush') {
    const library = path.join(repo, 'node_modules/react-virtuoso/dist/index.mjs');
    const original = await fs.readFile(library, 'utf8'), needle = 'n ? l() : requestAnimationFrame(l);';
    assert.equal(original.split(needle).length - 1, 1, 'private Virtuoso prototype must match one exact RO publication');
    assert.ok(original.includes('import So from "react-dom";'));
    const copy = path.join(snapshot, 'private-virtuoso.mjs');
    const changed = original.replace(needle, 'n ? So.flushSync(l) : requestAnimationFrame(l);');
    await fs.writeFile(copy, changed); extraAliases['react-virtuoso'] = copy;
    result.prototype = { name: 'observer-flush', source: library,
      beforeSha256: createHash('sha256').update(original).digest('hex'),
      afterSha256: createHash('sha256').update(changed).digest('hex'), replacements: 1 };
  }
  const bundled = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/history-tall-row.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120', logLevel: 'silent',
    metafile: true, sourcemap: true, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom'), ...extraAliases },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const hashes = {};
  for (const file of Object.keys(bundled.metafile.inputs)) {
    const real = await fs.realpath(path.resolve(file)).catch(() => null); if (!real) continue;
    const relative = path.relative(await fs.realpath(snapshot), real);
    if (/^(src|packages|scripts)\//.test(relative)) hashes[relative] = createHash('sha256').update(await fs.readFile(real)).digest('hex');
  }
  hashes['src/renderer/styles/globals.css'] = createHash('sha256').update(await fs.readFile(path.join(snapshot, 'src/renderer/styles/globals.css'))).digest('hex');
  result.sourceHashes = hashes;
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  const config = { width: Number(arg('width') || 1100), viewportHeight: 1063, fontSize: Number(arg('font') || 24), tailLines: Number(arg('tail-lines') || 38),
    seedLayout: arg('seed') !== 'none', seedTailHeight: Number(arg('tail-height') || 1688), searchQuery: 'Ответ' };
  if (arg('body')) {
    const data = JSON.parse(await fs.readFile(arg('body'), 'utf8'));
    const tall = data.entries.find(row => row.role === 'user' && row.content?.length > 20000);
    config.body = tall?.content; config.semanticTags = tall?.semanticTags;
    assert.ok(config.body, 'captured JSON must contain its tall user body');
    result.body = { source: arg('body'), chars: config.body.length, lines: config.body.split('\n').length, sha256: createHash('sha256').update(config.body).digest('hex') };
  }
  if (arg('tail')) {
    config.entries = JSON.parse(await fs.readFile(arg('tail'), 'utf8'));
    assert.ok(Array.isArray(config.entries) && config.entries.length >= 7);
    result.tail = { source: arg('tail'), entries: config.entries.length,
      sha256: createHash('sha256').update(JSON.stringify(config.entries)).digest('hex') };
  }
  result.config = { ...config, body: undefined, semanticTags: undefined, entries: undefined };
  await fs.writeFile(path.join(artifact, 'fixture-input.json'), JSON.stringify(config));
  const prototypeCss = arg('prototype') === 'list-layer' ? '.hp-history-transcript [data-testid="virtuoso-item-list"]{transform:translateZ(0)}' : '';
  if (prototypeCss) result.prototype = { name: 'list-layer', css: prototypeCss, privateOnly: true };
  await fs.writeFile(path.join(artifact, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc;overflow:hidden}' + prototypeCss + '</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  const mainConfig = { artifact, userData: path.join(artifact, 'user-data'), preload: path.join(artifact, 'preload.cjs'),
    html: path.join(artifact, 'index.html'), width: config.width, height: config.viewportHeight + 32,
    readingRoiTop: expansionMode === 'search' ? 110 : 44 };
  await fs.mkdir(mainConfig.userData);
  await fs.writeFile(mainConfig.preload, `const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer),send=ipcRenderer.send.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});ipcRenderer.send=(channel,...args)=>channel==='fixture:sample'?send(channel,...args):send('fixture:send',{channel,args});`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), '(' + privateMain.toString() + ')(' + JSON.stringify(mainConfig) + ');');
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: mainConfig.userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[key];
  app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'), args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.pid = app.process().pid;
  await fs.writeFile(path.join(artifact, 'process-lease.json'), JSON.stringify({ pid: result.pid, cwd: artifact, userData: mainConfig.userData }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message)); page.on('console', message => logs.push(message.text()));
  await page.waitForFunction(() => window.tallRowFixture?.state.ready);
  await page.locator('[data-history-viewport-ready="1"]').waitFor();
  await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]'); return s && s.scrollHeight - s.scrollTop - s.clientHeight < 2; });
  if (expansionMode === 'search') {
    await page.keyboard.press('Meta+f');
    await page.getByLabel('Поиск по чату', { exact: true }).fill(config.searchQuery);
    await page.waitForFunction(() => window.tallRowFixture.state.searches.length > 0);
    await page.waitForFunction(() => document.querySelector('[data-history-search-count]')?.textContent.includes('/'));
    result.expansion = { kind: 'actual-search', query: config.searchQuery, firstMatch: 'outside-current-window',
      reason: 'Current user rows collapse by default; real search expands matches while this row stays unmounted.' };
  }
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const tick = () => ++frames >= 20 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick); }));
  await page.screenshot({ path: path.join(artifact, 'before.png') });
  result.initial = await page.evaluate(() => window.tallRowFixture.sample());
  result.syntheticBody = await page.evaluate(() => window.tallRowFixture.state.syntheticBody);
  result.readingRoiTop = await page.evaluate(() => {
    const search = document.querySelector('[data-history-search-panel]');
    return Math.max(44, search ? Math.ceil(search.getBoundingClientRect().bottom) + 8 : 0);
  });
  await app.evaluate((_electron, top) => { global.tallRowMain.readingRoiTop = top; }, result.readingRoiTop);
  check('native pixel ROI excludes the floating search UI', result.readingRoiTop < result.initial.box.y + result.initial.client - 200, result.readingRoiTop);
  result.listLayer = await page.evaluate(() => {
    const list = document.querySelector('.hp-history-transcript [data-testid="virtuoso-item-list"]');
    return list ? { exists: true, transform: getComputedStyle(list).transform } : { exists: false };
  });
  if (arg('prototype') === 'list-layer') check('private list-layer prototype is applied',
    result.listLayer.exists && result.listLayer.transform !== 'none', result.listLayer);
  check('1063px History viewport', result.initial.client === 1063, result.initial.client);
  check('tall row starts unmounted/unmeasured', !result.initial.tall, result.initial.rows);
  result.tallMountsBefore = await page.evaluate(() => window.tallRowFixture.state.tallMounts);
  check('tall row never mounted during setup', !result.tallMountsBefore.length, result.tallMountsBefore);
  const scroller = page.locator('[data-virtuoso-scroller]');
  const box = await scroller.boundingBox(); await page.mouse.move(box.x + box.width * .7, box.y + box.height * .75);
  await app.evaluate(() => { global.tallRowMain.capture = true; });
  if (arg('pending') === 'hide') await page.evaluate(() => { window.tallRowFixture.state.holdMeasurements = true; });
  await page.evaluate(() => window.tallRowFixture.observe('first-up'));
  // Incident's three upward bursts. Delays reproduce their relative spacing;
  // every stimulus remains a trusted wheel, never a scripted scrollTop write.
  const packets = [[0,-4],[32,-25.7],[48,-195.6],[120,-142.7],[428,-4],[456,-26.2],[471,-89.7],
    [489,-129.2],[512,-151.6],[561,-166.2],[833,-4],[882,-118.9],[936,-130]];
  const gesture = async (canBreak = false) => {
    const start = performance.now(); let sent = 0;
    for (const [at, dy] of packets) {
      const delay = at - (performance.now() - start); if (delay > 0) await page.waitForTimeout(delay);
      await page.mouse.wheel(0, dy); sent++;
      if (canBreak && await page.evaluate(() => window.tallRowFixture.state.heldMeasurements > 0)) break;
    }
    return sent;
  };
  const firstPackets = await gesture(arg('pending') === 'hide');
  if (arg('pending') !== 'hide') await page.waitForTimeout(650);
  else await page.waitForFunction(() => window.tallRowFixture.state.heldMeasurements > 0);
  await page.evaluate(() => { window.tallRowFixture.state.observing = false; });
  await app.evaluate(() => { global.tallRowMain.capture = false; });
  result.final = await page.evaluate(() => window.tallRowFixture.sample());
  if (arg('pending') === 'hide') {
    const before = await page.evaluate(() => ({ pending: window.tallRowFixture.state.heldMeasurements,
      synthetic: window.tallRowFixture.state.scrollEvents.filter(e => !e.trusted).length,
      writers: window.tallRowFixture.state.writers.length }));
    await page.locator('[data-toggle-shown]').click();
    await page.locator('[data-history-presented="0"]').waitFor({ state: 'attached' });
    const released = await page.evaluate(() => window.tallRowFixture.releaseMeasurements());
    const after = await page.evaluate(() => ({ synthetic: window.tallRowFixture.state.scrollEvents.filter(e => !e.trusted).length,
      writers: window.tallRowFixture.state.writers.length }));
    result.pendingCancellation = { before, after, released };
    check('actual hidden pane rejects its already queued measurement callback', before.pending > 0 && released > 0
      && after.synthetic === before.synthetic && after.writers === before.writers, result.pendingCancellation);
    await page.locator('[data-toggle-shown]').click();
    await page.locator('[data-history-presented="1"]').waitFor();
  }
  if (arg('adjacent') === '1') {
    const atBottom = () => page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]');
      return s && s.scrollHeight - s.scrollTop - s.clientHeight < 2; });
    const bottom = async () => {
      await page.evaluate(() => { window.tallRowFixture.state.phase = 'repeat-setup'; });
      await page.locator('[data-history-scroll-to-bottom]').click(); await atBottom(); await page.waitForTimeout(220);
      await page.mouse.move(box.x + box.width * .7, box.y + box.height * .75);
    };
    await bottom();
    result.repeatInitial = await page.evaluate(() => window.tallRowFixture.sample());
    await app.evaluate(() => { global.tallRowMain.capture = true; });
    await page.evaluate(() => window.tallRowFixture.observe('measured-repeat'));
    await gesture(); await page.waitForTimeout(350);
    await page.evaluate(() => { window.tallRowFixture.state.observing = false; });
    await app.evaluate(() => { global.tallRowMain.capture = false; });
    result.repeatFinal = await page.evaluate(() => window.tallRowFixture.sample());
    const repeat = await page.evaluate(() => ({
      writers: window.tallRowFixture.state.writers.filter(e => e.phase === 'measured-repeat'),
      synthetic: window.tallRowFixture.state.scrollEvents.filter(e => e.phase === 'measured-repeat' && !e.trusted),
      frames: window.tallRowFixture.state.frames.filter(e => e.phase === 'measured-repeat') }));
    result.repeat = { ...repeat, frames: repeat.frames.length };
    check('measured repeat keeps the anchor without extra JS scroll writes or synthetic scrolls',
      !repeat.writers.length && !repeat.synthetic.length && Math.abs(result.repeatFinal.top - result.final.top) <= 1
      && repeat.frames.every(f => f.tail && f.tail.top < f.client && f.tail.bottom > 0), result.repeat);
    await bottom();
    await app.evaluate(() => { global.tallRowMain.capture = true; });
    await page.evaluate(() => { window.tallRowFixture.observe('tail-growth'); window.tallRowFixture.appendTail(); });
    await page.locator('[data-uuid="new-tail-1"][data-history-row-real]').waitFor(); await atBottom();
    await page.waitForTimeout(220);
    await page.evaluate(() => { window.tallRowFixture.state.observing = false; });
    await app.evaluate(() => { global.tallRowMain.capture = false; });
    result.tailGrowth = await page.evaluate(() => {
      const f = window.tallRowFixture, sample = f.sample();
      return { sample, gap: sample.height - sample.top - sample.client,
        synthetic: f.state.scrollEvents.filter(e => e.phase === 'tail-growth' && !e.trusted) };
    });
    check('new tail remains followed and measurement sync stays suppressed at the tail',
      result.tailGrowth.gap < 2 && !result.tailGrowth.synthetic.length, result.tailGrowth);
  }
  await app.evaluate(() => global.flushTallRowPaints());
  result.renderer = await page.evaluate(() => window.tallRowFixture.state);
  result.main = await app.evaluate(() => global.tallRowMain);
  await page.screenshot({ path: path.join(artifact, 'after.png') });
  check('trusted wheel only', result.renderer.wheels.length === firstPackets + (arg('adjacent') === '1' ? packets.length : 0)
    && result.renderer.wheels.every(e => e.trusted));
  check('no transport, unknown IPC or renderer errors', !result.main.unknown.length && !result.main.forbidden.length && !result.errors.length,
    { unknown: result.main.unknown, forbidden: result.main.forbidden, errors: result.errors });
  result.wrongRaf = result.renderer.frames.filter(f => !f.tail || f.tail.top > f.client || f.tail.bottom < 0);
  result.measurement = { mounts: result.renderer.tallMounts,
    largestHeight: Math.max(0, ...result.renderer.frames.map(f => f.tall?.height || 0)),
    largeCompensations: result.renderer.writers.filter(w => w.method === 'scrollBy' && Math.abs(w.args[0]?.top || 0) > 5000) };
  check('large first measurement actually exercised', result.measurement.largestHeight > 8000
    && result.measurement.mounts.some(m => m.phase === 'first-up' && Number(m.known) < 400), result.measurement);
  check('ordinary path stays ready without seek/shell replacement', result.renderer.frames.every(f => f.ready && !f.seek && !f.shells));
  result.wrongPaints = result.main.paints.filter(p => (p.pixels.bright < 0.001 && p.pixels.dark > 0.995) || p.pixels.violet > .85);
  for (const paint of result.wrongPaints) paint.untilNextPaintMs = result.main.paints[paint.index + 1]?.abs - paint.abs;
  if (arg('pending') !== 'hide') check('native paints preserve the reading surface', !result.wrongPaints.length,
    result.wrongPaints.map(p => ({ file: p.file, abs: p.abs, pixels: p.pixels, lastSampleFrame: p.sample?.frame })));
  result.status = result.checks.every(c => c.pass) ? 'PASS' : 'RED';
  if (result.status === 'RED') process.exitCode = 1;
} catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1;
  if (page) { await page.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
    result.renderer = await page.evaluate(() => window.tallRowFixture?.state).catch(() => null); }
  if (app) result.main = await app.evaluate(() => global.tallRowMain).catch(() => null);
} finally {
  if (app) { await app.close().catch(() => {}); result.cleanup.appClosed = true; }
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.rm(path.join(artifact, 'user-data'), { recursive: true, force: true }); result.cleanup.profileRemoved = true;
  await fs.rm(snapshot, { recursive: true, force: true });
  await fs.rm(shared, { recursive: true, force: true }); result.cleanup.snapshotRemoved = true;
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, checks: result.checks, initial: result.initial,
    final: result.final, wrongRaf: result.wrongRaf?.length, wrongPaints: result.wrongPaints?.length, paints: result.main?.paints?.length, error: result.error }));
}

// Private source-snapshot Electron acceptance for History Cmd-hover record time.
// The fixture is synthetic and network-blocked; this script never reads or
// writes production JSONL/SQLite and never changes the user's application.
import test, { after } from 'node:test';
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
const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-record-time-'));
const results = [];

after(async () => {
  await fs.writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({
    pass: results.length === 3 && results.every((result) => result.pass),
    executor: { model: 'Codex delegated E2E executor', effort: 'standard' },
    results,
  }, null, 2));
  console.log('History record-time private artifacts:', artifactRoot);
});

const widths = (process.env.HISTORY_RECORD_TIME_WIDTHS || '350,500,1000').split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
const fonts = [8, 14, 24];
const callAt = '2026-10-07T07:46:18.647Z';
const resultAt = '2026-10-07T07:46:23.699Z';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rounded(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function rectOf(rect) {
  if (!rect) return null;
  return { x: rounded(rect.x), y: rounded(rect.y), width: rounded(rect.width), height: rounded(rect.height),
    top: rounded(rect.top), right: rounded(rect.right), bottom: rounded(rect.bottom), left: rounded(rect.left) };
}

function intersects(a, b, gap = 0) {
  if (!a || !b) return false;
  return a.left < b.right - gap && a.right > b.left + gap
    && a.top < b.bottom - gap && a.bottom > b.top + gap;
}

async function geometry(page) {
  return page.evaluate(() => {
    const r = (node) => node ? (() => {
      const x = node.getBoundingClientRect();
      const n = (v) => Math.round(v * 1000) / 1000;
      return { x: n(x.x), y: n(x.y), width: n(x.width), height: n(x.height), top: n(x.top), right: n(x.right), bottom: n(x.bottom), left: n(x.left) };
    })() : null;
    const lineRects = (node) => {
      if (!node) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map((x) => ({
        x: Math.round(x.x * 1000) / 1000, y: Math.round(x.y * 1000) / 1000,
        width: Math.round(x.width * 1000) / 1000, height: Math.round(x.height * 1000) / 1000,
        top: Math.round(x.top * 1000) / 1000, right: Math.round(x.right * 1000) / 1000,
        bottom: Math.round(x.bottom * 1000) / 1000, left: Math.round(x.left * 1000) / 1000,
      }));
    };
    const panel = document.querySelector('[data-history-test-panel]');
    const scroller = document.querySelector('[data-history-test-scroller],[data-testid="virtuoso-scroller"]');
    return {
      panel: r(panel), scroller: r(scroller), scrollTop: scroller?.scrollTop ?? null,
      rows: [...document.querySelectorAll('[data-history-test-row]')].map((node) => ({
        kind: node.getAttribute('data-history-test-row'), rect: r(node),
        lines: lineRects(node.querySelector('.cb-msg-text, [data-history-time-kind], [data-history-test-row-label]') || node),
      })),
      composer: r(document.querySelector('[data-history-test-composer]')),
      controls: r(document.querySelector('[data-history-controls]')),
      chips: r(document.querySelector('[data-history-composer-prompt-band]')),
      status: r(document.querySelector('[data-history-composer-floating-status]')),
      dock: r(document.querySelector('[data-history-agent-dock]')),
      overlay: [...document.querySelectorAll('[data-history-record-time-overlay]')].map((node) => ({
        rect: r(node), placement: node.getAttribute('data-placement'), key: node.getAttribute('data-history-time-key'),
        at: node.getAttribute('data-source-at'), scope: node.getAttribute('data-scope'),
        owner: node.getAttribute('data-owner'), text: node.textContent,
      })),
    };
  });
}

function assertStableGeometry(before, after, label) {
  assert.deepEqual(after.panel, before.panel, `${label}: panel moved`);
  assert.deepEqual(after.scroller, before.scroller, `${label}: scroller moved`);
  assert.equal(after.scrollTop, before.scrollTop, `${label}: scrollTop changed`);
  assert.deepEqual(after.composer, before.composer, `${label}: composer moved`);
  assert.deepEqual(after.controls, before.controls, `${label}: controls moved`);
  assert.deepEqual(after.chips, before.chips, `${label}: prompt band moved`);
  assert.deepEqual(after.status, before.status, `${label}: floating status moved`);
  assert.deepEqual(after.dock, before.dock, `${label}: agent dock moved`);
  assert.deepEqual(after.rows.map((row) => ({ kind: row.kind, rect: row.rect, lines: row.lines })),
    before.rows.map((row) => ({ kind: row.kind, rect: row.rect, lines: row.lines })), `${label}: row/wrap geometry changed`);
}

async function resolveHoverPoint(page, target, kind, label) {
  const key = await target.getAttribute('data-history-time-key');
  const point = await page.evaluate(({ key: targetKey, kind: targetKind }) => {
    const target = [...document.querySelectorAll('[data-history-time-key]')]
      .find((node) => node.getAttribute('data-history-time-key') === targetKey);
    if (!target) return { error: 'target missing' };
    const rectOf = (node) => {
      if (!node) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    };
    let surface = target;
    if (targetKind === 'tool') surface = target.querySelector('.cb-tool-head-inner') || target;
    else if (targetKind === 'user') {
      const chips = [...target.querySelectorAll('.cb-composer-chip-label,.cb-composer-chip')];
      surface = chips.at(-1) || target.querySelector('.cb-msg-text') || target;
    } else surface = target.querySelector('.cb-msg-text') || target;
    const rects = rectOf(surface);
    const visibleRects = rects.filter((rect) => rect.bottom >= 0 && rect.top <= innerHeight && rect.right >= 0 && rect.left <= innerWidth);
    const obstacleRects = [...document.querySelectorAll('[data-history-controls],[data-history-composer-prompt-band],[data-history-composer-floating-status],[data-history-agent-dock],[data-history-side-surface-toggle]')]
      .map((node) => node.getBoundingClientRect());
    const clearRects = visibleRects.filter((rect) => !obstacleRects.some((obstacle) => (
      rect.left < obstacle.right && rect.right > obstacle.left && rect.top < obstacle.bottom && rect.bottom > obstacle.top
    )));
    const rect = clearRects.at(-1) || visibleRects.at(-1) || rects.at(-1) || surface.getBoundingClientRect();
    const x = rect.left + Math.max(4, Math.min(rect.width / 2, rect.width - 4));
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const blocked = hit?.closest?.('.cb-msg-actions,.cb-row-copy,[role="menu"],[role="dialog"],button[data-history-collapse],.cb-collapse-top,.cb-collapse-bottom');
    return {
      x, y,
      targetKey: target.getAttribute('data-history-time-key'),
      hitTarget: hit?.closest?.('[data-history-time-key]')?.getAttribute('data-history-time-key') || null,
      blocked: blocked?.className || blocked?.getAttribute?.('data-testid') || null,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    };
  }, { key, kind });
  assert.equal(point.error, undefined, `${label}: ${point.error || 'hover target missing'}`);
  assert.equal(point.blocked, null, `${label}: hover point landed on control ${point.blocked}`);
  assert.equal(point.hitTarget, key, `${label}: hover point hit ${point.hitTarget}, expected ${key}: ${JSON.stringify(point)}`);
  return point;
}

async function writeSourceSnapshot(artifact) {
  const snapshot = path.join(artifact, 'source');
  execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
  for (const name of ['src', 'packages/claude-blocks']) {
    await fs.cp(path.join(repo, name), path.join(snapshot, name), {
      recursive: true,
      filter: (p) => !p.includes('/node_modules') && !p.includes('/.git'),
    });
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/history-record-time.tsx'), path.join(snapshot, 'scripts/fixtures/history-record-time.tsx'));
  return snapshot;
}

async function makePrivateApp(artifact, width) {
  const snapshot = await writeSourceSnapshot(artifact);
  const sharedRoot = path.join(artifact, 'noted-shared/packages');
  await fs.mkdir(sharedRoot, { recursive: true });
  for (const name of ['structured-dnd', 'file-explorer']) {
    await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(sharedRoot, name), {
      recursive: true,
      filter: (p) => !p.includes('/node_modules'),
    });
  }
  const hashes = {};
  for (const file of [
    'src/renderer/components/Workspace/HistoryPanel.tsx',
    'src/renderer/components/Workspace/HistoryRecordTimeOverlay.tsx',
    'src/renderer/utils/historyRecordTimePresentation.mjs',
    'src/shared/history-record-time.cjs',
    'src/main/ipc/codex-data.js',
    'scripts/fixtures/history-record-time.tsx',
  ]) {
    hashes[file] = createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex');
  }
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  await build({
    entryPoints: [path.join(snapshot, 'scripts/fixtures/history-record-time.tsx')],
    bundle: true,
    outfile: path.join(artifact, 'bundle.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: {
      '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(sharedRoot, 'structured-dnd/src'),
      '@noted/file-explorer': path.join(sharedRoot, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'),
      'react-dom': path.join(repo, 'node_modules/react-dom'),
    },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' },
    plugins: [{
      name: 'private-history-record-time-exports',
      setup(plugin) {
        plugin.onLoad({ filter: /\/HistoryPanel\.tsx$/ }, async (args) => {
          const source = await fs.readFile(args.path, 'utf8');
          const suffix = source.includes('export { HistoryUserEntry') ? ''
            : '\nexport { HistoryUserEntry, HistoryAssistantEntry, HistoryToolCallPart };\n';
          return { contents: source + suffix, loader: 'tsx', resolveDir: path.dirname(args.path) };
        });
      },
    }],
  });
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), [
    '-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify',
  ], { cwd: snapshot, stdio: 'pipe' });
  const shim = function shim() {
    const listeners = new Map();
    const crypto = window.require('node:crypto');
    const fixture = window.fixture = { controlClicks: 0, violations: [], calls: [] };
    fixture.observerStats = { resizeObserve: 0, resizeUnobserve: 0, resizeDisconnect: 0, mutationObserve: 0, mutationDisconnect: 0 };
    const deny = (name) => { fixture.violations.push(name); throw Error('Forbidden private fixture operation: ' + name); };
    const ipc = fixture.ipc = {
      invoke(channel, ...args) { fixture.calls.push({ channel, args }); return Promise.resolve(null); },
      send(channel, ...args) { fixture.calls.push({ channel, args }); return undefined; },
      sendSync(channel, ...args) { fixture.calls.push({ channel, args }); return null; },
      on(channel, callback) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(callback); return ipc; },
      once(channel, callback) { const fn = (...args) => { ipc.off(channel, fn); callback(...args); }; return ipc.on(channel, fn); },
      off(channel, callback) { listeners.get(channel)?.delete(callback); return ipc; },
      removeListener(channel, callback) { return ipc.off(channel, callback); },
      removeAllListeners(channel) { listeners.delete(channel); return ipc; },
      emit(channel, ...args) { for (const callback of listeners.get(channel) || []) callback(...args); },
    };
    window.require = (name) => {
      if (name === 'electron') return {
        ipcRenderer: ipc,
        clipboard: { readText: () => '', writeText: (value) => { fixture.copied = value; } },
        webFrame: { getZoomFactor: () => 1 },
      };
      if (name === 'node:crypto' || name === 'crypto') return crypto;
      if (name === 'process') return {
        platform: 'darwin', env: {}, version: 'v20.0.0',
        listenerCount: () => 0, on() { return this; }, once() { return this; },
        addListener() { return this; }, removeListener() { return this; }, off() { return this; },
        nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
      };
      if (name === 'path') return { sep: '/', basename: (s) => String(s).split('/').pop(), dirname: (s) => String(s).slice(0, String(s).lastIndexOf('/')) || '/', join: (...s) => s.join('/'), extname: (s) => String(s).includes('.') ? '.' + String(s).split('.').pop() : '', isAbsolute: (s) => String(s).startsWith('/'), resolve: (...s) => s.join('/'), relative: (a, b) => String(b).replace(String(a) + '/', '') };
      if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
      return deny('require:' + name);
    };
    window.process = window.require('process');
    window.fetch = () => Promise.reject(Error('Private fixture network disabled'));
    window.WebSocket = class { constructor() { deny('WebSocket'); } };
    window.EventSource = class { constructor() { deny('EventSource'); } };
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    if (window.ResizeObserver) {
      const NativeResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeResizeObserver {
        observe(...args) { fixture.observerStats.resizeObserve += 1; return super.observe(...args); }
        unobserve(...args) { fixture.observerStats.resizeUnobserve += 1; return super.unobserve(...args); }
        disconnect(...args) { fixture.observerStats.resizeDisconnect += 1; return super.disconnect(...args); }
      };
    } else window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    if (window.MutationObserver) {
      const NativeMutationObserver = window.MutationObserver;
      window.MutationObserver = class extends NativeMutationObserver {
        observe(...args) { fixture.observerStats.mutationObserve += 1; return super.observe(...args); }
        disconnect(...args) { fixture.observerStats.mutationDisconnect += 1; return super.disconnect(...args); }
      };
    }
    window.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  };
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#121212;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}button{color:#ddd;background:#242424;border:1px solid #444;border-radius:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><div id="root"></div><script>(${shim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));const w=new BrowserWindow({show:true,focusable:true,width:${width},height:720,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  return { app, page, snapshot };
}

for (const width of widths) test(`History record-time Cmd-hover geometry at ${width}px`, { timeout: 180000 }, async () => {
  const artifact = path.join(artifactRoot, String(width));
  await fs.mkdir(artifact);
  let app;
  let snapshot;
  const errors = [];
  try {
    ({ app, page: globalThis.__historyRecordPage, snapshot } = await makePrivateApp(artifact, width));
    const page = globalThis.__historyRecordPage;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.screenshot({ path: path.join(artifact, 'baseline.png') });
    await page.waitForFunction(() => typeof window.fixture?.setConfig === 'function');
    assert.equal(await page.evaluate(() => window.innerWidth), width);
    assert.deepEqual(await page.evaluate(() => window.fixture.violations), []);
    const styleProof = await page.evaluate(() => {
      const tool = document.querySelector('.cb-tool-head-inner');
      const actions = document.querySelector('.cb-msg-actions');
      const chip = document.querySelector('.cb-composer-chip');
      const style = (node) => node ? getComputedStyle(node) : null;
      return {
        toolHeadCount: document.querySelectorAll('.cb-tool-head-inner').length,
        toolHeadDisplay: style(tool)?.display || null,
        actionsCount: document.querySelectorAll('.cb-msg-actions').length,
        actionsPosition: style(actions)?.position || null,
        chipCount: document.querySelectorAll('.cb-composer-chip').length,
        chipDisplay: style(chip)?.display || null,
        chipHeight: chip?.getBoundingClientRect().height || 0,
      };
    });
    assert.equal(styleProof.toolHeadDisplay, 'flex', `private CSS proof failed for tool header: ${JSON.stringify(styleProof)}`);
    assert.equal(styleProof.actionsPosition, 'absolute', `private CSS proof failed for action rail: ${JSON.stringify(styleProof)}`);
    assert.ok(styleProof.chipCount > 0 && ['flex', 'inline-flex'].includes(styleProof.chipDisplay) && styleProof.chipHeight > 0,
      `private CSS proof failed for composer chip: ${JSON.stringify(styleProof)}`);

    const sourceTimes = await page.evaluate(() => [...document.querySelectorAll('[data-history-time-kind]')].map((node) => ({
      kind: node.getAttribute('data-history-time-kind'), at: node.getAttribute('data-history-time-at'),
      scope: node.getAttribute('data-history-time-scope'), key: node.getAttribute('data-history-time-key'),
    })));
    assert.ok(sourceTimes.some((item) => item.kind === 'tool' && item.at === callAt && item.at !== resultAt), `tool uses call timestamp, not result timestamp: ${JSON.stringify(sourceTimes)}`);
    assert.ok(sourceTimes.some((item) => item.kind === 'tool' && item.scope === 'container'), `nested exec keeps shared container scope: ${JSON.stringify(sourceTimes)}`);
    assert.ok(sourceTimes.some((item) => item.kind === 'user' && item.at === '2026-10-07T07:43:15.599Z'), `user uses canonical source timestamp: ${JSON.stringify(sourceTimes)}`);
    await page.evaluate(() => { const node = document.querySelector('[data-testid="virtuoso-scroller"]'); if (node) node.scrollTop = 700; });
    await wait(160);
    const scrolledSourceTimes = await page.evaluate(() => [...document.querySelectorAll('[data-history-time-kind]')].map((node) => ({
      kind: node.getAttribute('data-history-time-kind'), at: node.getAttribute('data-history-time-at'),
      scope: node.getAttribute('data-history-time-scope'), key: node.getAttribute('data-history-time-key'),
    })));
    assert.ok(scrolledSourceTimes.some((item) => item.kind === 'text' && item.at === '2026-10-07T07:47:01.000Z'), `assistant uses source record timestamp: ${JSON.stringify(scrolledSourceTimes)}`);
    await page.evaluate(() => { const node = document.querySelector('[data-testid="virtuoso-scroller"]'); if (node) node.scrollTop = 0; });
    await wait(160);

    // Once the overlay is settled, its cached chrome/target observers must stay
    // idle. This is a bounded 30-RAF check, not a production polling loop.
    await page.evaluate(() => window.fixture.setConfig({ font: 14, chipCount: 1, chipOnly: false, imageOnly: false, owner: 'owner-a' }));
    await wait(160);
    const idleTarget = page.locator('[data-history-time-kind="tool"]').first();
    await idleTarget.scrollIntoViewIfNeeded();
    const idlePoint = await resolveHoverPoint(page, idleTarget, 'tool', `${width}px/idle`);
    await page.mouse.move(idlePoint.x, idlePoint.y);
    await page.keyboard.down('Meta');
    await page.waitForSelector('[data-history-record-time-overlay]', { state: 'visible' });
    const observerBefore = await page.evaluate(() => ({ ...window.fixture.observerStats }));
    await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const tick = () => { frames += 1; frames >= 30 ? resolve() : requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }));
    const observerAfter = await page.evaluate(() => ({ ...window.fixture.observerStats }));
    assert.ok(observerAfter.resizeObserve - observerBefore.resizeObserve <= 8,
      `idle overlay repeatedly added ResizeObserver targets: ${JSON.stringify({ observerBefore, observerAfter })}`);
    assert.equal(observerAfter.resizeDisconnect - observerBefore.resizeDisconnect, 0,
      `idle overlay disconnected ResizeObserver after settle: ${JSON.stringify({ observerBefore, observerAfter })}`);
    await page.keyboard.up('Meta');
    await page.mouse.move(2, 2);
    await page.waitForSelector('[data-history-record-time-overlay]', { state: 'detached' });

    const checkOverlay = async (kind, label) => {
      const target = page.locator(`[data-history-time-kind="${kind}"]`).first();
      await target.waitFor();
      const box = await target.boundingBox();
      assert.ok(box, `${label}: target has no box`);
      const point = await resolveHoverPoint(page, target, kind, label);
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down('Meta');
      const targetKey = await target.getAttribute('data-history-time-key');
      await page.waitForSelector('[data-history-record-time-overlay]', { state: 'visible' }).catch(async (error) => {
        const diag = await page.evaluate((key) => {
          const target = [...document.querySelectorAll('[data-history-time-key]')].find((node) => node.getAttribute('data-history-time-key') === key);
          const range = document.createRange();
          if (target) range.selectNodeContents(target);
          const rect = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }; })() : null;
          return {
            target: rect(target), text: target?.textContent?.slice(-260),
            textRects: target ? [...range.getClientRects()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left })) : [],
            panel: rect(document.querySelector('[data-history-test-panel]')),
            scroller: rect(document.querySelector('[data-history-test-scroller],[data-testid="virtuoso-scroller"]')),
            chrome: [...document.querySelectorAll('[data-history-controls],[data-history-composer-prompt-band],[data-history-composer-floating-status],[data-history-agent-dock],[data-history-side-surface-toggle]')].map(rect),
            targetControls: [...(target?.closest('.cb-row') || target || document).querySelectorAll?.('button,.cb-row-copy,.cb-msg-actions,.cb-collapse-top,.cb-collapse-bottom') || []].map(rect),
            meta: { body: document.body.getAttribute('data-meta'), active: document.activeElement?.tagName },
          };
        }, targetKey).catch((diagError) => ({ diagError: String(diagError) }));
        throw Error(`${label}: overlay did not appear: ${error.message}; diag=${JSON.stringify(diag)}`);
      });
      const before = await geometry(page);
      const overlay = before.overlay[0];
      assert.ok(overlay, `${label}: overlay missing`);
      assert.ok(['inline', 'fallback'].includes(overlay.placement), `${label}: unknown placement ${overlay.placement}`);
      assert.equal(overlay.at, await target.getAttribute('data-history-time-at'), `${label}: wrong source timestamp`);
      assert.equal(overlay.scope, await target.getAttribute('data-history-time-scope'), `${label}: wrong source scope`);
      assert.equal(overlay.key, await target.getAttribute('data-history-time-key'), `${label}: wrong stable key`);
      assert.equal(before.overlay.length, 1, `${label}: more than one overlay`);
      const obstacles = [before.controls, before.chips, before.status, before.dock, before.composer].filter(Boolean);
      for (const obstacle of obstacles) assert.equal(intersects(overlay.rect, obstacle), false, `${label}: overlay intersects obstacle`);
      const panel = before.panel;
      assert.ok(overlay.rect.left >= panel.left - 0.5 && overlay.rect.right <= panel.right + 0.5, `${label}: overlay escapes panel horizontally`);
      assert.ok(overlay.rect.top >= panel.top - 0.5 && overlay.rect.bottom <= panel.bottom + 0.5, `${label}: overlay escapes panel vertically`);
      const after = await geometry(page);
      assertStableGeometry(await page.evaluate(() => window.fixture.__beforeGeometry), after, `${label} after Cmd-hover`);
      await page.keyboard.up('Meta');
      await page.waitForSelector('[data-history-record-time-overlay]', { state: 'detached' });
      await page.mouse.move(2, 2);
      return before;
    };

    for (const font of fonts) {
      await page.evaluate((value) => window.fixture.setConfig({ font: value, chipCount: 1, chipOnly: false, imageOnly: false, owner: 'owner-a' }), font);
      await wait(120);
      for (const kind of ['tool', 'text', 'user']) {
        await page.evaluate((value) => { const node = document.querySelector('[data-history-test-scroller],[data-testid="virtuoso-scroller"]'); if (node) node.scrollTop = value === 'text' ? 700 : 0; }, kind);
        await wait(60);
        await page.locator(`[data-history-time-kind="${kind}"]`).first().scrollIntoViewIfNeeded();
        await wait(60);
        const before = await geometry(page);
        await page.evaluate((value) => { window.fixture.__beforeGeometry = value; }, before);
        await checkOverlay(kind, `${width}px/${font}px/${kind}`);
      }
    }

    for (const variant of [
      { chipCount: 0, chipOnly: false, imageOnly: false, name: 'user-no-chips' },
      { chipCount: 1, chipOnly: true, imageOnly: false, name: 'user-one-chip-only' },
      { chipCount: 5, chipOnly: true, imageOnly: false, name: 'user-many-chips' },
      { chipCount: 0, chipOnly: false, imageOnly: true, name: 'user-image-only' },
    ]) {
      await page.evaluate((value) => window.fixture.setConfig({ ...value, font: 14, owner: 'owner-a' }), variant);
      await wait(120);
      const userSurface = page.locator('[data-history-time-kind="user"]').first();
      const visiblePromptChips = await userSurface.locator('.cb-composer-chip').count();
      if (variant.chipCount > 0) {
        assert.ok(visiblePromptChips >= variant.chipCount, `${width}px/${variant.name}: canonical prompt wrappers did not render all chips (${visiblePromptChips}/${variant.chipCount})`);
      }
      if (variant.name === 'user-many-chips') {
        assert.ok(await userSurface.locator('.hp-history-user-prompt-chip-slot').count() >= 1, `${width}px/${variant.name}: context update chip band missing`);
      }
      if (variant.imageOnly) {
        assert.ok(await userSurface.locator('[data-history-composer-token="image"]').count() >= 1, `${width}px/${variant.name}: canonical image marker did not render image token`);
      }
      await page.locator('[data-history-time-kind="user"]').first().scrollIntoViewIfNeeded();
      await wait(60);
      const before = await geometry(page);
      await page.evaluate((value) => { window.fixture.__beforeGeometry = value; }, before);
      await checkOverlay('user', `${width}px/${variant.name}`);
    }

    // Hovering real action controls must suppress the annotation while the
    // controls themselves remain clickable. The target hover is tested above.
    await page.evaluate(() => window.fixture.setConfig({ font: 14, chipCount: 1, chipOnly: false, imageOnly: false, owner: 'owner-a' }));
    await wait(120);
    const userActions = page.locator('[data-history-time-kind="user"] .cb-msg-actions button');
    const actionCount = await userActions.count();
    assert.ok(actionCount >= 2, `expected real Copy/Rewind/Delete action rail, got ${actionCount}`);
    for (let index = 0; index < Math.min(actionCount, 3); index += 1) {
      const action = userActions.nth(index);
      const actionBox = await action.boundingBox();
      assert.ok(actionBox, `action ${index} has no box`);
      const actionPoint = { x: actionBox.x + actionBox.width / 2, y: actionBox.y + actionBox.height / 2 };
      await page.mouse.move(actionPoint.x, actionPoint.y);
      await page.keyboard.down('Meta');
      await wait(80);
      assert.equal(await page.locator('[data-history-record-time-overlay]').count(), 0, `control hover ${index} opened record-time overlay`);
      await page.keyboard.up('Meta');
      await page.mouse.click(actionPoint.x, actionPoint.y);
      await wait(50);
      await page.keyboard.press('Escape');
      await wait(50);
    }
    const collapse = page.locator('[data-history-time-kind="tool"] button[data-history-collapse]').first();
    if (await collapse.count()) {
      const collapseBox = await collapse.boundingBox();
      assert.ok(collapseBox, 'collapse control has no box');
      const collapsePoint = { x: collapseBox.x + collapseBox.width / 2, y: collapseBox.y + collapseBox.height / 2 };
      await page.mouse.move(collapsePoint.x, collapsePoint.y);
      await page.keyboard.down('Meta');
      await wait(80);
      assert.equal(await page.locator('[data-history-record-time-overlay]').count(), 0, 'collapse control hover opened record-time overlay');
      await page.keyboard.up('Meta');
      await page.mouse.click(collapsePoint.x, collapsePoint.y);
      await wait(80);
    }
    const menuButton = page.locator('[data-history-test-menu]');
    const menuBox = await menuButton.boundingBox();
    assert.ok(menuBox, 'test menu has no box');
    await page.mouse.click(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
    assert.equal(await page.locator('[data-history-record-time-overlay]').count(), 0, 'menu click left a record-time overlay');

    // Stationary pointer + owner/remount/stream changes must not retain a stale overlay.
    await page.evaluate(() => window.fixture.setConfig({ font: 14, chipCount: 1, chipOnly: false, imageOnly: false, owner: 'owner-a' }));
    await wait(120);
    const textTarget = page.locator('[data-history-time-kind="tool"]').first();
    await textTarget.scrollIntoViewIfNeeded();
    await wait(60);
    const stationaryPoint = await resolveHoverPoint(page, textTarget, 'tool', `${width}px/stationary`);
    await page.mouse.move(stationaryPoint.x, stationaryPoint.y);
    await page.keyboard.down('Meta');
    await page.waitForSelector('[data-history-record-time-overlay]', { state: 'visible' });
    const stationary = await geometry(page);
    await page.evaluate(() => window.fixture.switchOwner());
    await page.waitForSelector('[data-history-record-time-overlay]', { state: 'detached' });
    await page.keyboard.up('Meta');
    await page.evaluate(() => window.fixture.remount());
    await wait(100);
    assert.equal(await page.locator('[data-history-record-time-overlay]').count(), 0, 'owner/remount left stale overlay');
    await page.evaluate(() => window.fixture.setConfig({ owner: 'owner-a', chipCount: 1, chipOnly: false, imageOnly: false }));
    await wait(100);
    await page.evaluate(() => window.fixture.updateStream());
    await wait(100);
    assert.equal(await page.locator('[data-history-record-time-overlay]').count(), 0, 'stream update revived stale overlay');

    // Scroll and viewport edge clamp; no old overlay may survive a new owner.
    await page.evaluate(() => { const node = document.querySelector('[data-history-test-scroller],[data-testid="virtuoso-scroller"]'); node.scrollTop = 280; });
    await wait(100);
    const edge = await geometry(page);
    assert.equal(edge.overlay.length, 0, 'scroll left overlay without Cmd-hover');
    await page.locator('[data-history-test-copy]').click();
    assert.ok(await page.evaluate(() => window.fixture.controlClicks) >= 1, 'controls remain usable after overlay lifecycle');
    assert.deepEqual(await page.evaluate(() => window.fixture.violations), []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(artifact, 'final.png') });
    results.push({ width, pass: true, artifact, errors, checks: [
      'call timestamp 07:46:18 is distinct from result timestamp 07:46:23',
      'message and nested container source metadata',
      'tool/text/user inline-or-fallback overlay',
      '350/500/1000 geometry matrix',
      'font 8/14/24 (Settings bounds)',
      'Markdown list/code/table and long title/last line',
      '0/1/many prompt chips and image-only user',
      'obstacle clamp and pointer-events-none controls',
      'real Copy/Rewind/Delete/collapse/menu control hover and clicks',
      '30-RAF idle ResizeObserver lifecycle check',
      'Cmd release, owner switch, stream update, remount and scroll cleanup',
      'zero row/wrap/composer/scrollTop delta',
    ] });
  } catch (error) {
    const page = globalThis.__historyRecordPage;
    if (page) {
      await page.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
      await page.evaluate(() => ({ html: document.body.innerHTML.slice(0, 20000), text: document.body.innerText, fixture: window.fixture })).then((dump) => fs.writeFile(path.join(artifact, 'dom-dump.json'), JSON.stringify(dump, null, 2))).catch(() => {});
    }
    const failure = { width, pass: false, artifact, errors, error: String(error?.stack || error) };
    results.push(failure);
    throw error;
  } finally {
    const page = globalThis.__historyRecordPage;
    try { if (app) await app.close(); } catch {}
    globalThis.__historyRecordPage = null;
    const cleanup = { removed: [], errors: [] };
    try {
      if (snapshot && await fs.stat(path.join(snapshot, '.git')).catch(() => null)) {
        execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
        cleanup.removed.push('source');
      }
    } catch (error) { cleanup.errors.push(String(error)); }
    for (const name of ['noted-shared', 'user-data', 'bundle.js', 'globals.css', 'index.html', 'main.cjs']) {
      try { await fs.rm(path.join(artifact, name), { recursive: true, force: true }); cleanup.removed.push(name); }
      catch (error) { cleanup.errors.push(String(error)); }
    }
    await fs.writeFile(path.join(artifact, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
    assert.deepEqual(cleanup.errors, [], 'private test cleanup failed');
  }
});

#!/usr/bin/env node
// node scripts/display-workspace-regression.mjs [--build-only]
// Harness-only retry: add --source-snapshot=<previous artifact directory>.
// All outputs go to a fresh OS temp directory. No Noted main, dev server,
// production/CDP attachment, native OS input, clipboard, DB, PTY or live API.
// Playwright launches its own Electron 28 with a private debugging pipe; the
// offscreen BrowserWindow is never shown/focused. Only that process is closed.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-display-workspace-'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const json = async (name, data) => fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2));
const displays = {
  big: { key: 'fixture-external', label: 'Fixture 32-inch', internal: false, width: 2560, height: 1440, scaleFactor: 1 },
  small: { key: 'fixture-laptop', label: 'Fixture laptop', internal: true, width: 1440, height: 900, scaleFactor: 2 },
};
const windowControls=process.argv.includes('--window-controls');
const boot = { projectId: 'display-fixture-project', spaceId: 'display-fixture-space', cwd: path.join(dir, 'project'), displays,windowControls };
await fs.mkdir(boot.cwd);
const report = {
  artifacts: dir, started: new Date().toISOString(), checks: [], errors: [], launches: [],
  scope: {
    actual: ['useWorkspaceStore', 'useUIStore', 'TerminalArea', 'SplitPaneAttachRow', 'HiddenWindowPicker', 'HistoryPanel',
      'paneGridRects', 'paneColumns', 'buildSessionSnapshot', 'restoreSession', 'installSurfaceFontShortcuts', 'commitDisplayProfileChange'],
    isolated: ['all IPC in renderer memory', '8 active fixture file tabs + 1 dormant fixture tab', 'fixture Markdown/transcript responses'],
    excluded: ['PTY lifecycle', 'physical monitor detection', 'full App shortcut context selection', 'native OS input'],
  },
};

// Runs in a nodeIntegration:false renderer before any actual application code.
// There is deliberately no bridge to ipcMain and no fallback to a live API.
function installShim(boot) {
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const f = window.__displayFixture = { boot, calls: [], unknown: [], violations: [], inputs: [], fontActions: [], frames: 0 };
  const listeners = new Map(), saved = new Map();
  if (boot.restart) {
    saved.set('workspace-session', boot.restart.session);
    for (const [key, value] of Object.entries(boot.restart.localStorage)) localStorage.setItem(key, value);
  }
  const deny = (kind, detail) => { f.violations.push({ kind, detail }); throw new Error(`Fixture forbids ${kind}: ${detail}`); };
  const entries = [
    { uuid: 'fixture-user-row', role: 'user', content: 'DISPLAY FIXTURE USER: ' + 'A wide message should use the available row width and leave room for both action columns. '.repeat(18) },
    { uuid: 'fixture-assistant-row', role: 'assistant', content: 'DISPLAY FIXTURE ANSWER: a real History row, with four pixel horizontal padding.' },
    // One long wrapping paragraph, not 1,600 short cards or a repeated glyph.
    // A caret/text offset identifies a unique place far below its card top.
    { uuid: 'fixture-reading-row', role: 'assistant', content: Array.from({ length: 1600 }, (_, i) => `reading${String(i).padStart(4, '0')}`).join(' ') },
  ].map((entry, i) => ({ ...entry, sessionId: 'fixture-history-session', timestamp: new Date(1700000000000 + i * 1000).toISOString() }));
  function result(channel, payload) {
    if (channel === 'app:getState') return copy(saved.get(payload) ?? null);
    if (channel === 'app:setState' || channel === 'app:setStateSync') {
      saved.set(payload.key, copy(payload.value)); return { success: true };
    }
    if (channel === 'file:read') {
      if (!String(payload).startsWith(boot.cwd + '/fixture-')) return deny('foreign file', payload);
      return { success: true, content: `# ${String(payload).split('/').pop()}\n\nFixture window content. Two tabs belong to each stable window.\n\nNo process or disk document is attached.` };
    }
    if (channel === 'agent-transcript:get-history') {
      if (payload.sessionId !== 'fixture-history-session') return deny('foreign transcript', payload.sessionId);
      return { success: true, entries, revision: { token: 'fixture-history-v1', sessionId: payload.sessionId, cwd: boot.cwd }, payloadGeneration: 'fixture-immutable' };
    }
    if (channel === 'agent-transcript:subscribe' || channel === 'agent-transcript:unsubscribe'
      || channel === 'agent-transcript:refresh') return { success: true };
    if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
    if (channel === 'agent-session:get-availability-batch') return {
      success: true, results: (payload?.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })),
    };
    if (channel === 'project:list') return [{ id: boot.projectId, name: 'Display fixture', path: boot.cwd }];
    if (channel === 'project:getById') return { id: boot.projectId, path: boot.cwd, tabs: [], tabGroups: [] };
    if (channel === 'display-profiles:get-context') return { current: boot.displays.big, displays: Object.values(boot.displays) };
    if (/^(project:(save-|layout-changed|order-changed)|tab:|tab-task-plan:)/.test(channel)) return { success: true };
    if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|app:(open|select)|shell:)/.test(channel)) return deny('process or external action', channel);
    if (/git.*(status|diff|branch)/.test(channel)) return { success: true, isGitRepo: false, files: [], branches: [] };
    if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
    if (/list|catalog|get-models|get-prompts|get-task-plan/.test(channel)) return [];
    if (/settings:get|config:get/.test(channel)) return {};
    if (channel.startsWith('log:') || channel.startsWith('renderer:')) return undefined;
    // Explicitly recorded unsupported reads; they cannot escape this fixture.
    f.unknown.push(channel);
    return null;
  }
  const ipc = {
    invoke(channel, ...args) { f.calls.push({ method: 'invoke', channel, args: copy(args) }); return Promise.resolve().then(() => result(channel, args[0])); },
    send(channel, ...args) { f.calls.push({ method: 'send', channel, args: copy(args) }); return result(channel, args[0]); },
    sendSync(channel, ...args) { f.calls.push({ method: 'sendSync', channel, args: copy(args) }); return result(channel, args[0]); },
    on(channel, fn) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); return ipc; },
    once(channel, fn) { const once = (...args) => { ipc.removeListener(channel, once); fn(...args); }; return ipc.on(channel, once); },
    removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return ipc; },
    off(channel, fn) { return ipc.removeListener(channel, fn); },
    removeAllListeners(channel) { listeners.delete(channel); return ipc; },
    emit(channel, ...args) { for (const fn of listeners.get(channel) || []) fn(...args); },
  };
  const fakePath = { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')) || '/',
    join: (...s) => s.join('/').replace(/\/+/g, '/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '',
    isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (from, to) => to.replace(from + '/', '') };
  window.require = name => {
    if (name === 'electron') return {
      ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [], readImage: () => ({ isEmpty: () => true }), writeText: () => deny('clipboard write', '') },
      shell: { openExternal: url => deny('external URL', url), openPath: value => deny('external path', value) },
      webFrame: { getZoomFactor: () => 1, setZoomFactor: () => deny('page zoom', '') },
    };
    if (name === 'path') return fakePath;
    if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: boot.cwd } };
    if (name === 'fs') return { promises: new Proxy({}, { get: (_, method) => () => deny('filesystem', method) }) };
    return deny('require', name);
  };
  window.process = window.require('process');
  window.fetch = (...args) => Promise.reject(new Error('Fixture network denied: ' + args[0]));
  window.WebSocket = class { constructor(url) { deny('WebSocket', url); } };
  window.EventSource = class { constructor(url) { deny('EventSource', url); } };
  for (const type of ['pointerdown', 'click', 'keydown', 'wheel']) window.addEventListener(type, event => {
    f.inputs.push({ type, trusted: event.isTrusted, key: event.key, code: event.code, meta: event.metaKey,
      deltaY: event.deltaY,
      target: event.target?.outerHTML?.slice(0, 650), at: performance.now() });
  }, true);
  window.addEventListener('error', event => {
    // Chromium reports deferred ResizeObserver delivery as an ErrorEvent
    // without a JS exception. Preserve it separately, never silence the event.
    if (!event.error && event.message === 'ResizeObserver loop completed with undelivered notifications.') {
      f.browserWarnings ||= []; f.browserWarnings.push({ message: event.message, at: performance.now() }); return;
    }
    f.runtimeErrors ||= []; f.runtimeErrors.push(String(event.error?.stack || event.message));
  });
  window.addEventListener('unhandledrejection', event => { f.runtimeErrors ||= []; f.runtimeErrors.push(String(event.reason?.stack || event.reason)); });
}

let app, page, launchIndex = 0;
const allLogs = [];
async function launch(restart) {
  const index = ++launchIndex;
  const dataDir = path.join(dir, `user-data-${index}`);
  const htmlPath = path.join(dir, `index-${index}.html`);
  const mainPath = path.join(dir, `main-${index}.cjs`);
  await fs.writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><title>Display workspace isolated fixture ${index}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'">
    <link rel="stylesheet" href="renderer.css"><style>body{margin:0;background:#19191b;color:#ddd;font:13px sans-serif}#fixture-controls button,#fixture-sidebar button{background:#353538;border:1px solid #666;padding:5px 8px;border-radius:4px;cursor:pointer}</style>
    <div id="root"></div><script>(${installShim.toString()})(${JSON.stringify({ ...boot, restart })})</script><script src="renderer.js"></script>`);
  await fs.writeFile(mainPath, `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(dataDir)});
    app.setActivationPolicy?.('accessory');app.disableHardwareAcceleration();
    app.whenReady().then(()=>{app.dock?.hide();global.focusEvents=[];global.network=[];
      session.defaultSession.webRequest.onBeforeRequest((details,reply)=>{
        const allowed=/^(file:|data:|blob:)/.test(details.url);if(!allowed)global.network.push(details.url);reply({cancel:!allowed});
      });
      session.defaultSession.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
      const win=new BrowserWindow({width:1440,height:940,show:false,focusable:false,
        webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
      global.fixture=win;win.on('focus',()=>global.focusEvents.push(Date.now()));
      win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      win.loadFile(${JSON.stringify(htmlPath)});
    });app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [mainPath], cwd: dir, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push({ launch: index, error: error.stack || error.message }));
  page.on('console', message => allLogs.push({ launch: index, type: message.type(), text: message.text() }));
  const meta = await app.evaluate(({ app, BrowserWindow }) => ({ electron: process.versions.electron, chrome: process.versions.chrome,
    pid: process.pid, userData: app.getPath('userData'), argv: process.argv,
    windows: BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused(), offscreen: win.webContents.isOffscreen() })) }));
  report.launches.push(meta);
  assert.match(meta.electron, /^28\./);
  assert.equal(meta.userData, dataDir);
  assert.ok(meta.windows.every(win => !win.visible && !win.focused && win.offscreen));
  await page.waitForFunction(() => window.__displayFixture?.ready || window.__displayFixture?.bootError);
  assert.equal(await page.evaluate(() => window.__displayFixture.bootError), undefined);
  await page.waitForFunction(() => window.__displayFixture.frames >= 3);
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'offscreen paints/rAF must be active');
}
async function close() {
  if (!app) return;
  const current = app;
  try {
    if (page && !page.isClosed()) {
      const transport = await page.evaluate(() => {
      const f = window.__displayFixture;
      return { calls: f.calls, unknown: [...new Set(f.unknown)], violations: f.violations, inputs: f.inputs, fontActions: f.fontActions, runtimeErrors: f.runtimeErrors || [], browserWarnings: f.browserWarnings || [] };
      });
      await json(`transport-${launchIndex}.json`, transport);
      report.launches.at(-1).transport = { inputs: transport.inputs.length,
        untrusted: transport.inputs.filter(input => !input.trusted).length, violations: transport.violations,
        runtimeErrors: transport.runtimeErrors, browserWarnings: transport.browserWarnings,
        warningBursts: coalesceWarnings(transport.browserWarnings), unsupportedReads: transport.unknown };
    }
    report.launches.at(-1).finalIsolation = await current.evaluate(() => ({ focused: global.fixture.isFocused(), visible: global.fixture.isVisible(), focusEvents: global.focusEvents, network: global.network }));
  } finally { app = null; await current.close(); }
}
const frames = async (n = 3) => page.evaluate(n => new Promise(resolve => {
  const tick = () => --n <= 0 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick);
}), n);
async function scrollHistoryToTop() {
  const scroller = page.locator('#fixture-history [data-virtuoso-scroller]');
  await scroller.waitFor();
  await page.waitForSelector('#fixture-history [data-history-viewport-ready="1"]');
  // Source payload arrival is not measured layout readiness. Wait for the
  // long real row and Virtuoso's initial measurement before delivering wheel.
  await page.waitForFunction(() => {
    const el = document.querySelector('#fixture-history [data-virtuoso-scroller]');
    const list = el?.querySelector('[data-testid="virtuoso-item-list"]');
    return el?.scrollHeight > 2000 && list && getComputedStyle(list).visibility === 'visible';
  });
  await frames(8);
  const point = await scroller.evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.left + 80, y: r.top + 70 };
  });
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -100_000);
  await page.waitForFunction(() => document.querySelector('#fixture-history [data-virtuoso-scroller]')?.scrollTop < 2);
  await frames(8);
}
function coalesceWarnings(warnings) {
  const bursts = [];
  for (const warning of warnings) {
    const last = bursts.at(-1);
    if (last && last.message === warning.message && warning.at - last.lastAt <= 200) {
      last.lastAt = warning.at; last.count++;
    } else bursts.push({ message: warning.message, firstAt: warning.at, lastAt: warning.at, count: 1 });
  }
  return bursts;
}
async function snapshot(name) {
  await frames();
  const state = await page.evaluate(() => window.__displayFixture.snapshot());
  await json(`${name}.json`, state);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  return state;
}
async function click(selector) {
  const element = page.locator(selector);
  assert.equal(await element.count(), 1, `unique target: ${selector}`);
  const hit = await element.evaluate(el => {
    const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    return { x, y, reachable: el.contains(document.elementFromPoint(x, y)) };
  });
  assert.ok(hit.reachable, `actual hit test: ${selector}`);
  await page.mouse.click(hit.x, hit.y);
  await frames();
}
const visible = state => state.panes.filter(p => !p.hidden);
// Horizontal layouts omit column by contract. Compare the observable grid
// plus contents/IDs, not two equivalent encodings of that grid.
const semanticPanes = state => state.panes.map(({ column, ...pane }) => pane);
const chrome = (state, id) => state.chrome.find(node => node.owner === `${boot.spaceId}:${id}`);
const picker = id => `[data-terminal-pane-chrome-host="${boot.spaceId}:${id}"] [data-hidden-window-picker-button]`;
function inventory(state) {
  assert.equal(state.panes.length, 4, 'hidden windows remain in splitPanes');
  assert.equal(new Set(state.panes.map(p => p.windowId)).size, 4, 'unique window IDs');
  const tabs = state.panes.flatMap(p => p.tabs);
  assert.equal(tabs.length, 8, 'all durable chips survive');
  assert.equal(new Set(tabs).size, 8, 'no duplicate tab placements');
  const domIds = state.surfaces.map(n => n.tabId).filter(id => id !== 'empty');
  assert.equal(new Set(domIds).size, domIds.length, 'one actual TerminalArea owner per tab');
  for (const pane of state.panes) {
    const actual = chrome(state, pane.windowId);
    if (pane.shown) {
      assert.ok(actual, `actual chrome for ${pane.windowId}`);
      assert.equal(Number(actual.opacity), pane.hidden ? 0 : 1, `${pane.windowId} chrome presentation`);
      assert.deepEqual(actual.tabs, pane.tabs, 'actual strip contains the whole window');
    }
    if (!pane.hidden && pane.shown) {
      const surface = state.surfaces.find(n => n.tabId === pane.shown);
      assert.ok(surface, 'shown tab has an actual TerminalArea wrapper');
      assert.equal(surface.presented, '1', 'shown tab is presented');
      assert.equal(Number(surface.opacity), 1);
    }
  }
}
function geometry(state, expected) {
  for (const [id, percentages] of Object.entries(expected)) {
    const pane = state.panes.find(p => p.windowId === id);
    assert.ok(pane && !pane.hidden, `${id} visible`);
    for (const [key, value] of Object.entries(percentages)) assert.ok(Math.abs(pane.rect[key] - value) < 0.001, `${id} ${key}`);
    const box = chrome(state, id)?.rect;
    assert.ok(box && box.width > 0, 'actual pane has nonzero geometry');
    assert.ok(Math.abs(box.width - (1440 - 160) * pane.rect.widthPct / 100) <= 2, `${id} DOM width matches geometry`);
    assert.ok(Math.abs(box.height - (940 - 52) * pane.rect.heightPct / 100) <= 2, `${id} DOM height matches geometry`);
  }
}
async function check(name, action) {
  try { const detail = await action(); report.checks.push({ name, status: 'pass', detail }); }
  catch (error) {
    report.checks.push({ name, status: 'fail', error: error.stack || String(error) });
    if (page && !page.isClosed()) await snapshot(`failure-${name}`).catch(() => {});
  }
  console.log(JSON.stringify(report.checks.at(-1)));
}

try {
  const sources = new Map();
  const rawSources = {};
  const frozenDir = process.argv.find(arg => arg.startsWith('--source-snapshot='))?.slice('--source-snapshot='.length);
  const frozen = frozenDir ? JSON.parse(await fs.readFile(path.join(frozenDir, 'source-contents.json'), 'utf8')) : null;
  const scanner = new Scanner({ sources: [{ base: path.join(root, 'src'), pattern: '**/*.{ts,tsx,js,jsx}', negated: false }] });
  const candidates = scanner.scan();
  const sourcePlugin = { name: 'immutable-source-audit', setup(builder) {
    builder.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs|css)$/ }, async args => {
      if (args.path.includes('/node_modules/')) return;
      const isHarness = args.path === path.join(root, 'scripts/fixtures/display-workspace.tsx');
      if (frozen && !isHarness && !Object.hasOwn(frozen, args.path)) throw new Error(`Source missing from frozen snapshot: ${args.path}`);
      const content = frozen && !isHarness ? Buffer.from(frozen[args.path], 'base64') : await fs.readFile(args.path);
      rawSources[args.path] = content.toString('base64');
      const extension = path.extname(args.path).slice(1);
      sources.set(args.path, { sha256: sha(content), bytes: content.length });
      let contents = content.toString();
      if (args.path === path.join(root, 'src/renderer/styles/globals.css')) {
        const compiler = await compile(contents, { base: path.dirname(args.path), onDependency() {} });
        contents = compiler.build(candidates);
      }
      return { contents, resolveDir: path.dirname(args.path), loader: ['mjs', 'cjs'].includes(extension) ? 'js' : extension };
    });
  } };
  const bundle = await build({ entryPoints: [path.join(root, 'scripts/fixtures/display-workspace.tsx')],
    bundle: true, format: 'iife', platform: 'browser', write: false, sourcemap: 'external', metafile: true,
    outfile: path.join(dir, 'renderer.js'), plugins: [sourcePlugin],
    // Same real source aliases/deduplication as electron.vite.config.js.
    alias: {
      '@noted/claude-blocks': path.join(root, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.resolve(root, 'vendor/noted-shared/packages/structured-dnd/src'),
      react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom'),
    },
    // This authored font URL is absent in the repo; Vite also leaves it for
    // runtime. The fixture uses History's real sans-serif fallback, no PTY font.
    external: ['../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf'],
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    logLevel: 'silent',
  });
  for (const output of bundle.outputFiles) await fs.writeFile(output.path, output.contents);
  const changedDuringBuild = [];
  for (const [file, metadata] of sources) if (sha(await fs.readFile(file)) !== metadata.sha256) changedDuringBuild.push(file);
  report.snapshot = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    builtAt: new Date().toISOString(), frozenSourceDirectory: frozenDir || null, changedDuringBuild,
    sources: Object.fromEntries([...sources].sort()),
    outputs: bundle.outputFiles.map(file => ({ name: path.basename(file.path), sha256: sha(file.contents), bytes: file.contents.length })),
  };
  await json('source-manifest.json', report.snapshot);
  await json('source-contents.json', rawSources);
  await json('esbuild-metafile.json', bundle.metafile);
  if (!frozen) assert.deepEqual(changedDuringBuild, [], 'snapshot source must not change during compilation');
  assert.ok(Object.keys(bundle.metafile.inputs).some(p => p.endsWith('store/useWorkspaceStore.ts')), 'actual store must be bundled');
  if (!process.argv.includes('--build-only')) {
    await launch();
    if(windowControls){
      const baseline=await snapshot('01-window-controls');
      const windowOf=id=>baseline.panes.find(p=>p.tabs.includes(`fixture-${id}-1`)).windowId;
      const menu=id=>`[data-terminal-pane-chrome-host="${boot.spaceId}:${id}"] [data-split-strip-menu-button]`;
      await click('[data-fixture-display="small"]');
      await check('minimize-second-item-retains-window',async()=>{
        await click(menu(windowOf('a')));
        const labels=await page.locator('[data-split-strip-menu] > button').allTextContents();
        assert.match(labels[0],/Expand/);assert.equal(labels[1].trim(),'Minimize');
        await click('[data-split-strip-menu-item="minimize-window"]');
        const state=await snapshot('02-minimized');
        assert.equal(state.panes.find(p=>p.windowId===windowOf('a')).hidden,true);
        assert.deepEqual(state.panes.find(p=>p.windowId===windowOf('a')).tabs,['fixture-a-1','fixture-a-2']);
        assert.deepEqual(visible(state).map(p=>p.windowId),[windowOf('b')]);
      });
      await check('expand-control-outside-card-area',async()=>{
        await click(picker(windowOf('b')));
        const action=await page.locator(`[data-hidden-window-alongside="${windowOf('a')}"]`).boundingBox();
        const group=await page.locator(`[data-hidden-window-id="${windowOf('a')}"]`).boundingBox();
        assert.ok(action.x+action.width<=group.x+.1);assert.ok(Math.abs(action.y-group.y)<.1);
        await snapshot('03-expand-outside');await click(`[data-hidden-window-alongside="${windowOf('a')}"]`);
        const state=await snapshot('04-expanded');assert.deepEqual(new Set(visible(state).map(p=>p.windowId)),new Set([windowOf('a'),windowOf('b')]));
      });
      await check('hidden-file-chip-click-reveals-owner-without-hover-menu',async()=>{
        await click(picker(windowOf('b')));
        const file=page.locator(`[data-hidden-window-id="${windowOf('c')}"] [data-tab-linked-files="fixture-c-1"]`);
        await file.hover();await frames();
        assert.equal(await page.locator('[data-tab-linked-files-popup]').count(),0);
        assert.equal((await page.evaluate(()=>window.__displayFixture.snapshot())).panes.find(p=>p.windowId===windowOf('c')).hidden,true);
        await file.locator('[data-linked-file-short-name]').click();
        await page.waitForFunction(()=>window.__displayFixture.preview()?.sourceTabId==='fixture-linked-note');
        const state=await snapshot('05-file-revealed');assert.equal(state.panes.find(p=>p.windowId===windowOf('c')).hidden,false);
        assert.equal(state.panes.find(p=>p.windowId===windowOf('c')).shown,'fixture-c-1');
      });
      await check('last-window-minimize-keeps-restore-access',async()=>{
        let state=await page.evaluate(()=>window.__displayFixture.snapshot());
        const shownIds=visible(state).map(p=>p.windowId);
        for(const id of shownIds){await click(menu(id));await click('[data-split-strip-menu-item="minimize-window"]');}
        state=await snapshot('06-last-minimized');const vacant=visible(state);assert.equal(vacant.length,1);assert.equal(vacant[0].shown,'');
        await click(`#fixture-workspace [data-terminal-pane-chrome-host^="vacant:"] [data-hidden-window-picker-button]`);
        assert.equal(await page.locator('[data-hidden-window-id]').count(),4);
        await click(`[data-hidden-window-id="${windowOf('a')}"] [data-hidden-window-tab-id="fixture-a-2"]`);
        state=await snapshot('07-restored-selected');assert.equal(visible(state)[0].windowId,windowOf('a'));assert.equal(visible(state)[0].shown,'fixture-a-2');
      });
    }else{
    const baseline = await snapshot('01-big-baseline');
    const windows = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [
      id, baseline.panes.find(pane => pane.tabs.includes(`fixture-${id}-1`))?.windowId,
    ]));
    report.windowIds = windows;
    await check('big-baseline', () => {
      inventory(baseline);
      for (const id of Object.values(windows)) assert.match(id, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i, 'production assigns UUID window IDs');
      assert.deepEqual(baseline.columns, [[windows.a], [windows.b], [windows.c, windows.d]]);
      geometry(baseline, {
        [windows.a]: { leftPct: 0, widthPct: 27, topPct: 0, heightPct: 100 },
        [windows.b]: { leftPct: 27, widthPct: 31, topPct: 0, heightPct: 100 },
        [windows.c]: { leftPct: 58, widthPct: 42, topPct: 0, heightPct: 37 },
        [windows.d]: { leftPct: 58, widthPct: 42, topPct: 37, heightPct: 63 },
      });
    });
    await click('[data-fixture-display="small"]');
    await check('laptop-two-visible', async () => {
      const small = await snapshot('02-laptop'); inventory(small);
      assert.deepEqual(visible(small).map(p => p.windowId), [windows.a, windows.b]);
      assert.deepEqual(small.columns, [[windows.a], [windows.b]]);
      geometry(small, { [windows.a]: { leftPct: 0, widthPct: 50, heightPct: 100 }, [windows.b]: { leftPct: 50, widthPct: 50, heightPct: 100 } });
    });
    await check('drag-body-zones-only-visible-windows', async () => {
      const before = await page.evaluate(() => window.__displayFixture.snapshot());
      try {
        await page.evaluate(() => window.__displayFixture.beginDragProbe());
        await frames();
        const drag = await page.evaluate(() => window.__displayFixture.dragProbe());
        await json('drag-body-zones.json', drag); await snapshot('02-laptop-drag-zones');
        assert.ok(drag.active, 'real drag bridge is active');
        assert.equal(drag.zones.length, 5, 'four actual workflow chrome owners plus one dormant owner');
        const eligible = drag.zones.filter(zone => zone.zone === 'body');
        assert.equal(eligible.length, 2);
        assert.ok(eligible.every(zone => zone.pointerEvents === 'auto' && zone.hitReady));
        assert.deepEqual(eligible.map(zone => zone.owner).sort(), [windows.a, windows.b].map(id => `${boot.spaceId}:${id}`).sort());
        const disabled = drag.zones.filter(zone => zone.zone !== 'body');
        assert.equal(disabled.length, 3);
        assert.ok(disabled.some(zone => zone.space === `${boot.spaceId}-dormant`), 'dormant TerminalArea passes its exact owning space');
        assert.ok(disabled.every(zone => zone.pointerEvents === 'none' && !zone.hitReady), 'hidden/dormant zones cannot intercept a drag');
        assert.equal(drag.strips.length, 5, 'probe the actual retained strips as well as their bodies');
        const acceptedStrips = drag.strips.filter(strip => strip.target !== null);
        assert.equal(acceptedStrips.length, 2);
        assert.ok(acceptedStrips.every(strip => !strip.isolated && strip.containsPoint));
        assert.deepEqual(acceptedStrips.map(strip => strip.owner).sort(), eligible.map(zone => zone.owner).sort());
        assert.ok(drag.strips.filter(strip => strip.isolated).every(strip => strip.target === null),
          'actual pointer resolver rejects hidden/dormant strips even when explicitly handed their DOM element');
      } finally {
        await page.evaluate(() => window.__displayFixture.endDragProbe()); await frames();
      }
      const ended = await page.evaluate(() => window.__displayFixture.dragProbe());
      assert.equal(ended.active, false); assert.ok(ended.zones.every(zone => zone.pointerEvents === 'none'));
      assert.deepEqual((await page.evaluate(() => window.__displayFixture.snapshot())).panes, before.panes, 'probe commits no drop');
    });
    await check('first-click-and-whole-strip', async () => {
      const before = await page.evaluate(() => window.__displayFixture.snapshot());
      assert.equal(before.focus, 0, 'right target begins unfocused');
      await click(picker(windows.b));
      const dialog = page.locator('[data-hidden-window-picker]');
      assert.equal(await dialog.count(), 1, 'first click opens the picker with no focus click');
      assert.deepEqual(await dialog.locator('[data-hidden-window-id]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-hidden-window-id'))), [windows.c, windows.d]);
      await snapshot('03-first-click-menu');
      await click(`[data-hidden-window-id="${windows.d}"]`);
      const chosen = await snapshot('04-window-d-chosen'); inventory(chosen);
      assert.deepEqual(visible(chosen).map(p => p.windowId), [windows.a, windows.d]);
      assert.equal(chosen.focus, 1);
      assert.deepEqual(chrome(chosen, windows.d).tabs, ['fixture-d-1', 'fixture-d-2']);
      assert.equal(chrome(chosen, windows.d).node, chrome(before, windows.d).node, 'window keeps its actual DOM owner');
      assert.equal(chrome(chosen, windows.b).node, chrome(before, windows.b).node, 'outgoing owner remains mounted');
      return { beforeOwner: chrome(before, windows.d).node, afterOwner: chrome(chosen, windows.d).node };
    });
    await check('sidebar-reveals-whole-window', async () => {
      await click('[data-fixture-sidebar-tab="fixture-c-2"]');
      const chosen = await snapshot('05-sidebar-reveal'); inventory(chosen);
      assert.deepEqual(visible(chosen).map(p => p.windowId), [windows.a, windows.c]);
      assert.equal(chosen.panes[1].shown, 'fixture-c-2');
      assert.deepEqual(chrome(chosen, windows.c).tabs, ['fixture-c-1', 'fixture-c-2']);
    });
    await check('ratios-and-monitor-restore', async () => {
      const divider = page.locator('#fixture-workspace [data-split-divider]').first();
      const point = await divider.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x - 140, point.y, { steps: 8 }); await page.mouse.up(); await frames(6);
      const resized = await snapshot('06-laptop-ratio');
      assert.ok(Math.abs(visible(resized)[0].rect.widthPct - 50) > 5, 'trusted divider drag changes laptop ratio');
      await click('[data-fixture-display="big"]');
      const big = await snapshot('07-big-restored'); inventory(big);
      assert.deepEqual(big.sizes, baseline.sizes);
      assert.deepEqual(big.columns, baseline.columns);
      for (const pane of baseline.panes) assert.deepEqual(big.panes.find(p => p.windowId === pane.windowId).rect, pane.rect);
      await click('[data-fixture-display="small"]');
      const small = await snapshot('08-small-restored'); inventory(small);
      assert.deepEqual(visible(small).map(p => p.windowId), [windows.a, windows.c]);
      assert.deepEqual(small.sizes, resized.sizes);
    });
    await check('picker-cancel-and-repeat', async () => {
      const before = await page.evaluate(() => window.__displayFixture.snapshot());
      await click(picker(windows.c)); await page.keyboard.press('Escape'); await frames();
      assert.equal(await page.locator('[data-hidden-window-picker]').count(), 0);
      assert.deepEqual((await page.evaluate(() => window.__displayFixture.snapshot())).panes, before.panes);
      for (const target of [windows.d, windows.c, windows.d, windows.c]) {
        const state = await page.evaluate(() => window.__displayFixture.snapshot());
        await click(picker(visible(state)[1].windowId)); await click(`[data-hidden-window-id="${target}"]`);
        inventory(await page.evaluate(() => window.__displayFixture.snapshot()));
      }
      await snapshot('09-repeated-selection');
    });
    await check('chooser-and-vacancy', async () => {
      await click('[data-fixture-chooser]');
      const chooser = await snapshot('10-chooser'); inventory(chooser);
      const target = visible(chooser)[1];
      assert.equal(target.shown, ''); assert.equal(target.chooser.length, 1);
      assert.equal(target.selectedSlotId, target.chooser[0].slotId);
      assert.ok(chooser.chrome.some(node => node.owner?.startsWith('vacant:')), 'real TerminalArea renders the vacant chooser host');
      await click('#fixture-workspace [data-terminal-pane-chrome-host^="vacant:"] [data-hidden-window-picker-button]');
      await click(`[data-hidden-window-id="${windows.d}"]`);
      await click(picker(windows.d));
      const chooserCandidate = page.locator(`[data-hidden-window-id="${target.windowId}"]`);
      assert.ok((await chooserCandidate.textContent()).includes('Новая вкладка'), 'hidden window preview includes its real chooser chip');
      await snapshot('10-hidden-chooser-preview');
      await click(`[data-hidden-window-id="${target.windowId}"]`);
      assert.equal((await page.evaluate(() => window.__displayFixture.snapshot())).panes[1].selectedSlotId,
        target.selectedSlotId, 'whole-window reveal preserves the selected chooser');
      await click('[data-fixture-display="big"]'); await click('[data-fixture-display="small"]');
      const restored = await page.evaluate(() => window.__displayFixture.snapshot());
      assert.deepEqual(restored.panes.find(p => p.windowId === target.windowId).chooser, target.chooser);
      await click('[data-fixture-close-chooser]');
      const vacant = await snapshot('11-vacancy'); inventory(vacant);
      assert.equal(visible(vacant)[1].shown, '');
      assert.deepEqual(visible(vacant)[1].chooser, []);
      await click('[data-fixture-sidebar-tab="fixture-c-2"]');
      inventory(await page.evaluate(() => window.__displayFixture.snapshot()));
    });
    await check('history-spacing-and-shortcuts', async () => {
      await click('[data-fixture-history]');
      await scrollHistoryToTop();
      await page.waitForSelector('#fixture-history .cb-user-bubble');
      const metrics = await page.evaluate(() => window.__displayFixture.historyMetrics());
      await json('history-css.json', metrics);
      assert.ok(metrics.some(row => row.text.includes('DISPLAY FIXTURE USER')), 'actual fixture transcript row is rendered');
      for (const row of metrics) { assert.equal(row.paddingLeft, '4px'); assert.equal(row.paddingRight, '4px'); }
      const user = metrics.find(row => row.bubblePaddingLeft);
      assert.ok(user.visibleInViewport, 'user bubble is physically inside the viewport');
      assert.ok(metrics.find(row => row.text.includes('DISPLAY FIXTURE ANSWER'))?.visibleInViewport, 'assistant row is physically inside the viewport');
      assert.equal(user.bubblePaddingLeft, '4px'); assert.equal(user.bubblePaddingRight, '4px');
      assert.ok(user.collapseLeft.length > 0, 'actual collapse control is rendered');
      assert.ok(user.collapseLeft.every(left => left === '4px'), 'collapse control shares the real 4px spacing');
      assert.match(user.colMaxWidth, /calc\(100% - /, 'message width reserves actions dynamically');
      assert.ok(user.colWidth > user.width * 0.85, 'long message uses more than the old 85% ceiling');
      const original = await page.evaluate(() => window.__displayFixture.snapshot().fonts);
      await click('#fixture-history .cb-user-bubble'); await page.keyboard.press('Meta+='); await frames(8);
      const larger = await page.evaluate(() => window.__displayFixture.snapshot().fonts);
      for (const key of ['historyFontSize', 'historyComposerFontSize', 'aiSecondaryFontSize', 'timelineFontSize', 'timelineSummaryFontSize']) assert.equal(larger[key], original[key] + 1, key);
      assert.equal(larger.terminalFontSize, original.terminalFontSize);
      assert.equal(larger.filePreviewFontSize, original.filePreviewFontSize);
      const largerMetrics = await page.evaluate(() => window.__displayFixture.historyMetrics());
      assert.equal(parseFloat(largerMetrics[0].fontSize), parseFloat(metrics[0].fontSize) + 1, 'actual History text grows');
      await snapshot('12-history-larger');
      await page.keyboard.press('Meta+-'); await frames(8);
      assert.deepEqual(await page.evaluate(() => window.__displayFixture.snapshot().fonts), original);
      await page.keyboard.press('Meta+='); await frames(8);
      await click('[data-fixture-history]');
      await click('[data-fixture-display="big"]');
      assert.deepEqual(await page.evaluate(() => window.__displayFixture.snapshot().fonts), original, 'big profile retains original sizes');
      await click('[data-fixture-display="small"]');
      assert.deepEqual(await page.evaluate(() => window.__displayFixture.snapshot().fonts), larger, 'small profile restores its own sizes');
      return { metrics, largerMetrics };
    });
    await check('history-reading-through-monitor-and-font-changes', async () => {
      // This setup uses real profile actions before establishing a reading
      // position. Subsequent monitor signals use App's atomic commit boundary
      // without clicking a button that would naturally dismiss text selection.
      await page.evaluate(() => {
        const f = window.__displayFixture; f.prepareReadingProfiles(); f.setDisplay('big');
      });
      if (!await page.locator('#fixture-history').count()) await click('[data-fixture-history]');
      await scrollHistoryToTop();
      const reader = page.locator('#fixture-history [data-uuid="fixture-reading-row"]');
      await reader.waitFor();
      const setup = await page.evaluate(() => {
        const scroller = document.querySelector('#fixture-history [data-virtuoso-scroller]');
        const row = document.querySelector('#fixture-history [data-uuid="fixture-reading-row"]');
        const r = row.getBoundingClientRect(), s = scroller.getBoundingClientRect();
        return { x: s.left + 90, y: s.top + 70, height: r.height, before: scroller.scrollTop,
          delta: r.top - s.top + r.height * 0.45 };
      });
      assert.ok(setup.height > 2000, 'actual wrapping paragraph is long enough for middle-of-message reading');
      await page.mouse.move(setup.x, setup.y); await page.mouse.wheel(0, setup.delta);
      await page.waitForFunction(before => Math.abs(document.querySelector('#fixture-history [data-virtuoso-scroller]').scrollTop - before) > 600, setup.before);
      await frames(24); // Let the trusted wheel's existing gesture/anchor writer settle.
      const point = await reader.evaluate(row => {
        const scroller = row.closest('[data-virtuoso-scroller]'), paragraph = row.querySelector('p');
        const x = paragraph.getBoundingClientRect().left + 90, y = scroller.getBoundingClientRect().top + 65;
        const caret = document.caretRangeFromPoint(x, y);
        return { x, y, inReader: !!caret && paragraph.contains(caret.startContainer) };
      });
      assert.ok(point.inReader, 'selection hit-test reaches the actual long message');
      await page.mouse.dblclick(point.x, point.y); await frames();
      const reference = await page.evaluate(() => window.__displayFixture.captureReading());
      assert.ok(reference.rowTop < -600, 'reading position is far inside the message');
      assert.equal(reference.hostWidth, 820); assert.equal(reference.fontSize, 16);
      assert.ok(reference.sameScroller && reference.sameSelection && reference.exactText);
      const reading = { reference, setup, transitions: [], tolerancePx: 2 };
      await json('reading-proof.json', reading);
      await snapshot('16-reading-big-baseline');
      const transition = async (name, action, width, fontSize) => {
        const warningsBefore = await page.evaluate(() => window.__displayFixture.browserWarnings?.length || 0);
        await page.evaluate(() => window.__displayFixture.startReadingSamples());
        let after, quiet, samples;
        try {
          await action();
          await frames(3);
          after = await page.evaluate(() => window.__displayFixture.settleReading());
          await frames(20); // A bounded quiet window catches a continuing observer loop.
          quiet = await page.evaluate(() => window.__displayFixture.measureReading());
        } finally {
          samples = await page.evaluate(() => {
            const f = window.__displayFixture; f.readingRecording = false; return f.readingSamples;
          });
          const warnings = await page.evaluate(start => (window.__displayFixture.browserWarnings || []).slice(start), warningsBefore);
          const visibleSamples = samples.filter(sample => sample.phase === 'post-paint' && sample.painted);
          const drift = sample => sample.screenTop === null ? Infinity : Math.abs(sample.screenTop - reference.screenTop);
          const observation = { name, after, quiet, samples, warnings, warningBursts: coalesceWarnings(warnings),
            expected: { width, fontSize }, maxPaintedDrift: Math.max(0, ...visibleSamples.map(drift)) };
          reading.transitions.push(observation);
          await json('reading-proof.json', reading);
          await snapshot(`reading-${name}`);
        }
        const observation = reading.transitions.at(-1);
        assert.equal(after.hostWidth, width, `${name}: actual History host width`);
        assert.equal(after.width, reference.width + width - reference.hostWidth, `${name}: real scroller changes by the same width delta`);
        assert.equal(after.fontSize, fontSize, `${name}: real text font`);
        for (const measurement of [after, quiet]) {
          assert.ok(measurement.sameScroller, `${name}: same physical scroller`);
          assert.ok(measurement.sameRow, `${name}: same physical long message row`);
          assert.ok(measurement.sameSelection, `${name}: same selected text and native selection endpoints`);
          assert.ok(measurement.exactText, `${name}: exact paragraph text, not a look-alike`);
          assert.equal(measurement.glyph, reference.glyph); assert.equal(measurement.offset, reference.offset);
          assert.ok(Math.abs(measurement.screenTop - reference.screenTop) <= 2, `${name}: exact glyph screen Y drift ${measurement.screenTop - reference.screenTop}px`);
          assert.ok(Math.abs(measurement.viewportOffset - reference.viewportOffset) <= 2, `${name}: exact glyph viewport offset`);
        }
        assert.ok(observation.samples.some(sample => sample.phase === 'post-paint' && sample.painted), 'observer measured actual painted text');
        assert.ok(observation.maxPaintedDrift <= 2, `${name}: uncovered glyph must not jump between endpoints (${observation.maxPaintedDrift}px)`);
        assert.ok(observation.warnings.length <= 2, `${name}: at most two deferred ResizeObserver notifications per resize`);
        assert.equal(quiet.warningCount, after.warningCount, `${name}: ResizeObserver notifications stop after settling`);
      };
      const failures = [];
      try {
        for (const [name, action, width, fontSize] of [
          ['big-to-small', () => page.evaluate(() => window.__displayFixture.setDisplay('small')), 520, 18],
          ['small-to-big', () => page.evaluate(() => window.__displayFixture.setDisplay('big')), 820, 16],
          ['command-plus', () => page.keyboard.press('Meta+='), 820, 17],
          ['command-minus', () => page.keyboard.press('Meta+-'), 820, 16],
        ]) {
          try { await transition(name, action, width, fontSize); }
          catch (error) { failures.push({ name, error: error.stack || String(error) }); }
        }
      } finally {
        await page.evaluate(() => { window.__displayFixture.readingRecording = false; });
        if (await page.locator('#fixture-history').count()) await click('[data-fixture-history]');
        await click('[data-fixture-display="small"]');
      }
      reading.failures = failures;
      await json('reading-proof.json', reading);
      assert.deepEqual(failures, [], 'every monitor/font transition must preserve the captured reading glyph');
      return { reference, transitions: reading.transitions.map(({ name, after, quiet, maxPaintedDrift, warnings, warningBursts }) => ({
        name, after, quiet, maxPaintedDrift, warnings, warningBursts,
      })) };
    });
    await check('serialized-restart', async () => {
      await click('[data-fixture-display="small"]');
      const before = await snapshot('13-before-restart');
      const serialized = await page.evaluate(() => window.__displayFixture.serialize());
      await json('serialized-restart.json', serialized);
      await close(); await launch(serialized);
      const after = await snapshot('14-after-restart'); inventory(after);
      assert.deepEqual(semanticPanes(after), semanticPanes(before));
      assert.deepEqual(after.sizes, before.sizes);
      assert.deepEqual(after.fonts, before.fonts);
      await click('[data-fixture-display="big"]');
      const big = await page.evaluate(() => window.__displayFixture.snapshot());
      assert.deepEqual(big.sizes, baseline.sizes); assert.deepEqual(big.columns, baseline.columns);
      await click('[data-fixture-display="small"]');
      const back = await snapshot('15-restart-small-return'); inventory(back);
      assert.deepEqual(semanticPanes(back), semanticPanes(before)); assert.deepEqual(back.sizes, before.sizes);
      const target = visible(back)[1].windowId;
      await click(picker(target)); await click(`[data-hidden-window-id="${windows.d}"]`);
      inventory(await page.evaluate(() => window.__displayFixture.snapshot()));
    });
    await check('trusted-input-and-isolation', async () => {
      const data = await page.evaluate(() => ({ inputs: window.__displayFixture.inputs, violations: window.__displayFixture.violations, runtimeErrors: window.__displayFixture.runtimeErrors || [] }));
      assert.ok(data.inputs.length > 0); assert.ok(data.inputs.every(event => event.trusted));
      assert.deepEqual(data.violations, []); assert.deepEqual(data.runtimeErrors, []); assert.deepEqual(report.errors, []);
      const isolation = await app.evaluate(() => ({ focus: global.focusEvents, network: global.network, shown: global.fixture.isVisible() }));
      assert.deepEqual(isolation, { focus: [], network: [], shown: false });
      for (const previous of report.launches.slice(0, -1)) {
        assert.equal(previous.transport.untrusted, 0);
        assert.deepEqual(previous.transport.violations, []);
        assert.deepEqual(previous.transport.runtimeErrors, []);
        assert.deepEqual(previous.finalIsolation, { focused: false, visible: false, focusEvents: [], network: [] });
      }
    });
    }
  }
} catch (error) {
  report.errors.push({ phase: 'harness', error: error.stack || String(error), detail: error.errors });
  if (page && !page.isClosed()) await snapshot('harness-failure').catch(() => {});
} finally {
  await close().catch(error => report.errors.push({ phase: 'cleanup', error: String(error) }));
  report.finished = new Date().toISOString();
  report.status = report.errors.length || report.checks.some(check => check.status === 'fail') ? 'fail'
    : process.argv.includes('--build-only') ? 'built-only' : 'pass';
  await json('result.json', report); await json('renderer-log.json', allLogs);
  console.log(JSON.stringify({ status: report.status, artifacts: dir, checks: report.checks.map(({ name, status }) => ({ name, status })), errors: report.errors }));
  process.exitCode = report.status === 'fail' ? 1 : 0;
}

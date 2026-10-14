#!/usr/bin/env node
// Bounded real Electron/Workspace/xterm UI regression. The IPC boundary is
// synthetic: no app main, real PTY, provider, saved tab, or OS input is used.
// Run only after the product owner declares source ready:
//   node scripts/terminal-full-view-regression.mjs
// Build the fixture while implementation is in progress:
//   node scripts/terminal-full-view-regression.mjs --build-only
// Run the same no-resize contract with a 360px side panel after the 600px run:
//   node scripts/terminal-full-view-regression.mjs --side-width=360
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
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-terminal-full-view-'));
const snapshot = path.join(artifact, 'source');
const buildOnly = process.argv.includes('--build-only');
const overlayOnly = process.argv.includes('--overlay-only');
const singleOverlay = process.argv.includes('--single-overlay');
const sideWidth = Number(process.argv.find(a => a.startsWith('--side-width='))?.split('=')[1] || 600);
assert.ok(Number.isFinite(sideWidth) && sideWidth >= 360 && sideWidth <= 1200, 'side width must be 360..1200');
const A = 'full-view-narrow', B = 'full-view-neighbor', C = 'full-view-other';
const result = {
  artifact, mode: buildOnly ? 'build-only' : 'ui', sideWidth, pass: false, checks: [], errors: [], checkpoints: [], traces: [],
  contract: 'Lift the existing side rectangle; preserve frame/content/xterm dimensions, cols/rows, buffer and resize IPC across toggles and composer growth.',
  boundary: {
    actual: ['private offscreen Electron', 'Workspace / split windows / workflow navigation',
      'FloatingTerminalFrame / TerminalArea / Terminal', 'xterm buffer, renderer and input focus',
      'trusted CDP button clicks, wheel, Escape'],
    synthetic: ['IPC snapshot and numbered output (420 lines + bounded updates)',
      'small Codex transcript / availability projection', 'external draft growth and external navigation via real store actions'],
    excluded: ['real PTY process and main/headless mirror', 'provider execution / transcript files',
      'production app / persisted user state', 'OS focus and native keyboard',
      'provider TUI behavior', 'display migration and multiple native Electron windows'],
  },
};
let app, page, worktreeCreated = false;
const logs = [];

// Runs before the actual renderer bundle. All IPC lives in memory and every
// launch/input side effect is rejected. Protocol reports are counted as input
// too: Escape must produce zero terminal:input calls, not just zero commands.
function installShim(sideWidth, singleOverlay) {
  const listeners = new Map(), rows = new Map(), saved = new Map(), sequences = new Map();
  const f = window.fullViewFixture = {
    calls: [], unknown: [], violations: [], writes: [], resizes: [], hydrates: {},
    listenerAdds: {}, listenerRemoves: {}, emitted: [], trustedEvents: [],
    generation: 'full-view-fixed-generation', sideWidth, singleOverlay,
  };
  const deny = (kind) => { f.violations.push(kind); throw Error('Fixture forbids ' + kind); };
  f.line = (id, n) => `${id.endsWith('narrow') ? 'A' : id.endsWith('neighbor') ? 'B' : 'C'} ${String(n).padStart(4, '0')} ${n === 0 ? 'TOP' : n === 419 ? 'BOTTOM' : 'numbered output'}${n >= 20 && n < 60 ? ' wrapped'.repeat(10) : ''}`;
  f.rowsFor = (sid) => {
    if (!rows.has(sid)) rows.set(sid, Array.from({ length: 16 }, (_, i) => ({
      uuid: sid + '-row-' + i, sessionId: sid, role: i % 2 ? 'assistant' : 'user',
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      content: `Synthetic history row ${i}. No provider was started.`,
    })));
    return rows.get(sid);
  };
  const answer = (channel, payload) => {
    if (channel === 'codex:get-runtime-projection') {
      const sid = 'session-' + payload.tabId;
      return { success: true, projectId: 'full-view-project', sessionStatus: 'active', busy: false,
        inputReady: true, liveLifecycle: true, sessionId: sid, readSessionId: sid,
        readIdentitySource: 'live-writer', savedSessionId: sid, conversationMaterialized: true,
        timelineCount: 8, materializationReason: 'user-history-present', canCopySessionId: true,
        hasTerm: true, lastNotReady: null, startupFailed: false, startupError: null,
        manualActionRequired: false, manualActionType: null, lifecycleWarning: null,
        hasWatcher: true, catchUpPending: false, outcomeKnown: false, lastOutcomeReason: null };
    }
    if (channel === 'terminal:get-headless-buffer-snapshot') {
      const id = payload.tabId;
      f.hydrates[id] = (f.hydrates[id] || 0) + 1;
      return { success: true, serialized: Array.from({ length: 420 }, (_, i) => f.line(id, i)).join('\r\n') + '\r\n',
        generation: f.generation, generationOrdinal: 1, writeSeq: 0, cols: 80, rows: 24, promptBoundaries: [] };
    }
    if (channel === 'project:list') return [{ id: 'full-view-project', name: 'Synthetic full view', path: '/synthetic-full-view' }];
    if (channel === 'system:get-dashboard-processes') return { claude: [], codex: [], gemini: [], mcp: [], electronDev: [] };
    if (channel === 'project:get-tab-history-count') return 0;
    if (channel === 'terminal:getCwd') return '/synthetic-full-view';
    if (channel === 'app:getState') return saved.get(payload) ?? null;
    if (channel === 'app:setState' || channel === 'app:setStateSync') {
      saved.set(payload.key, payload.value); return { success: true };
    }
    if (channel === 'agent-transcript:get-history') return { success: true, entries: f.rowsFor(payload.sessionId),
      payloadGeneration: 'fixture-source', revision: { sources: [{ sessionId: payload.sessionId, fileIdentity: 'fixture-source', linkKind: 'end' }] } };
    if (channel === 'agent-transcript:get-timeline') return { success: true,
      entries: f.rowsFor(payload.sessionId).filter(x => x.role === 'user').map(x => ({ ...x, type: 'user' })) };
    if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
    if (/^agent-transcript:(subscribe|unsubscribe|refresh)$/.test(channel)) return { success: true };
    if (channel === 'agent-session:get-availability-batch') return { success: true,
      results: (payload.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'terminal:getCommandState') return null;
    if (channel === 'terminal:getCommandStates') return {};
    if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:run|agent:(send|stop|rewind)|shell:|app:(open|select))/.test(channel)) return deny(channel);
    if (/^(tab:|tab-task-plan:|project:(save|layout|order)|terminal:(resize|subscribe|unsubscribe|remember))/.test(channel)) return { success: true };
    if (channel === 'agent:get-send-receipts' || channel === 'agent:list-send-receipts') return { success: true, records: [] };
    if (/git.*(status|diff|branch)/.test(channel)) return { success: true, isGitRepo: false, files: [], branches: [] };
    if (/list|catalog|get-models|get-prompts|get-task-plan/.test(channel)) return [];
    if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
    if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
    f.unknown.push(channel); return null;
  };
  const recordCall = (channel, args) => {
    f.calls.push(channel);
    if (channel === 'terminal:resize') {
      const [first, cols, rows] = args;
      f.resizes.push({ tabId: typeof first === 'string' ? first : first?.tabId,
        cols: typeof first === 'string' ? cols : first?.cols,
        rows: typeof first === 'string' ? rows : first?.rows, at: performance.now() });
    }
  };
  const ipc = f.ipc = {
    invoke(c, ...a) { recordCall(c, a); return Promise.resolve().then(() => structuredClone(answer(c, a[0]))); },
    send(c, ...a) {
      recordCall(c, a);
      if (c === 'terminal:input') { f.writes.push({ tabId: a[0], data: a[1] }); return; }
      return answer(c, a[0]);
    },
    sendSync(c, ...a) { recordCall(c, a); return answer(c, a[0]); },
    on(c, cb) {
      if (!listeners.has(c)) listeners.set(c, new Set());
      listeners.get(c).add(cb); f.listenerAdds[c] = (f.listenerAdds[c] || 0) + 1; return ipc;
    },
    once(c, cb) { const fn = (...a) => { ipc.off(c, fn); cb(...a); }; return ipc.on(c, fn); },
    off(c, cb) {
      if (listeners.get(c)?.delete(cb)) f.listenerRemoves[c] = (f.listenerRemoves[c] || 0) + 1;
      return ipc;
    },
    removeListener(c, cb) { return ipc.off(c, cb); },
    removeAllListeners(c) {
      f.listenerRemoves[c] = (f.listenerRemoves[c] || 0) + (listeners.get(c)?.size || 0);
      listeners.delete(c); return ipc;
    },
    emit(c, ...a) { for (const fn of listeners.get(c) || []) fn(...a); },
  };
  f.append = (id, label, count = 5) => {
    const seq = (sequences.get(id) || 0) + 1; sequences.set(id, seq);
    const data = Array.from({ length: count }, (_, i) => `${id.endsWith('narrow') ? 'A' : id.endsWith('neighbor') ? 'B' : 'C'} ${label} ${i}`).join('\r\n') + '\r\n';
    const payload = { tabId: id, data, headlessWriteSeq: seq,
      headlessGeneration: f.generation, headlessGenerationOrdinal: 1 };
    f.emitted.push({ tabId: id, label, count, seq });
    ipc.emit('terminal:data', {}, payload);
    return seq;
  };
  f.stats = () => ({ hydrates: { ...f.hydrates },
    terminalData: { adds: f.listenerAdds['terminal:data'] || 0,
      removes: f.listenerRemoves['terminal:data'] || 0, live: listeners.get('terminal:data')?.size || 0 },
    terminalSubscriptions: f.calls.filter(c => /^terminal:(subscribe|unsubscribe)$/.test(c)),
    resizeIPCCount: f.resizes.length, resizes: [...f.resizes],
    violations: [...f.violations], writes: [...f.writes] });
  for (const name of ['click', 'wheel', 'keydown']) window.addEventListener(name, event => {
    if (name === 'keydown' && event.key !== 'Escape') return;
    const target = event.target instanceof Element ? event.target : null;
    f.trustedEvents.push({ type: name, trusted: event.isTrusted, key: event.key || null,
      target: target && { tag: target.tagName, className: target.className },
      deltaX: event.deltaX, deltaY: event.deltaY,
      terminal: target?.closest('[data-terminal-layer-tab-id]')?.getAttribute('data-terminal-layer-tab-id') || null,
      toggle: target?.closest('[data-terminal-full-view-toggle]')?.getAttribute('data-terminal-full-view-toggle') ?? null,
      open: target?.closest('[data-terminal-full-view-open]')?.getAttribute('data-terminal-full-view-open') ?? null,
      entryKind: target?.closest('[data-terminal-full-view-open]')
        ? (target.closest('[data-split-pane-actions]') ? 'pane-header'
          : target.closest('[data-floating-terminal]') ? 'clipped-notice' : 'other') : null });
  }, true);
  const fakePath = { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')) || '/',
    join: (...s) => s.join('/').replace(/\/+/g, '/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '',
    isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (from, to) => to.replace(from + '/', '') };
  window.require = (name) => {
    if (name === '@emotion/is-prop-valid') return () => true;
    if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [],
      readImage: () => ({ isEmpty: () => true }), writeText: () => deny('clipboard') },
      shell: { openExternal: () => deny('shell'), openPath: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
    if (name === 'path') return fakePath;
    if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true' } };
    if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
    if (name === 'node:v8' || name === 'node:buffer') return {}; // no binary IPC envelope in this fixture
    return deny('require:' + name);
  };
  window.process = window.require('process');
  window.fetch = () => Promise.reject(Error('Fixture network denied'));
  window.WebSocket = class { constructor() { deny('WebSocket'); } };
  window.EventSource = class { constructor() { deny('EventSource'); } };
}

try {
  execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
  worktreeCreated = true;
  result.sourceSnapshotAt = new Date().toISOString();
  result.baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/terminal-full-view.tsx'), path.join(snapshot, 'scripts/fixtures/terminal-full-view.tsx'));
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(snapshot, 'scripts/terminal-full-view-regression.mjs'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, name),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  const bundled = await build({ nodePaths: [path.join(repo, 'node_modules')], sourcemap: true, metafile: true,
    entryPoints: [path.join(snapshot, 'scripts/fixtures/terminal-full-view.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const hashes = {};
  const canonicalSnapshot = await fs.realpath(snapshot);
  for (const input of Object.keys(bundled.metafile.inputs)) {
    const absolute = await fs.realpath(path.resolve(input)).catch(() => null);
    if (!absolute?.startsWith(canonicalSnapshot + path.sep)) continue;
    hashes[path.relative(canonicalSnapshot, absolute)] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
  }
  assert.ok(hashes['src/renderer/components/Workspace/Terminal.tsx'], 'record the actual frozen product source, including macOS /private aliases');
  for (const name of ['scripts/terminal-full-view-regression.mjs', 'src/renderer/styles/globals.css', 'package.json']) {
    hashes[name] = createHash('sha256').update(await fs.readFile(path.join(snapshot, name))).digest('hex');
  }
  result.sourceHashes = hashes;
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script>(${installShim.toString()})(${sideWidth},${singleOverlay})</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
      const w=new BrowserWindow({show:false,focusable:false,width:${singleOverlay ? 800 : 1600},height:1000,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  if (buildOnly) {
    result.checks.push('fixture bundles against current source; UI intentionally not run');
    result.pass = true;
  } else {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
    result.electronPid = app.process().pid;
    page = await app.firstWindow(); page.setDefaultTimeout(12000);
    page.on('pageerror', e => result.errors.push(e.stack || e.message));
    page.on('console', m => logs.push(m.text()));
    const frames = (count = 2) => page.evaluate(count => new Promise(resolve => {
      const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next);
      requestAnimationFrame(next);
    }), count);
    const pane = id => page.locator(`[data-terminal-pane-wrapper="${id}"]`);
    const composer = id => page.locator(`[data-history-composer-tab-id="${id}"]`);
    const host = id => page.locator(`[data-terminal-full-view-host][data-terminal-full-view-tab-id="${id}"]`);
    const inspect = id => page.evaluate(id => window.fullViewFixture.inspect(id), id);
    const stats = () => page.evaluate(() => window.fullViewFixture.stats());
    const assertSnapshot = (before, after, label, anchor = true) => {
      for (const key of ['dimensions', 'rows', 'cols', 'length', 'baseY', 'generation', 'generationOrdinal',
        'instanceId', 'writeSeq', 'resizeIPC', 'resizeEvents', 'identity']) {
        assert.deepEqual(after[key], before[key], `${label}: unchanged ${key}`);
      }
      if (anchor) for (const key of ['viewportY', 'viewportScrollTop', 'first', 'atBottom']) {
        assert.deepEqual(after[key], before[key], `${label}: unchanged reading ${key}`);
      }
    };
    const unchangedDuring = async (name, id, action, { peers = [], focused = true } = {}) => {
      await page.evaluate(ids => window.fullViewFixture.beginTrace(ids), [id, ...peers]);
      let trace;
      try { await action(); await frames(8); }
      finally {
        trace = await page.evaluate(() => window.fullViewFixture.endTrace());
        result.traces.push({ name, ...trace });
      }
      assert.ok(trace.samples.length >= 9, name + ': observe the initial snapshot and consecutive RAF frames');
      const baseline = trace.samples[0].terminals;
      for (const sample of trace.samples) for (const after of sample.terminals) {
        const before = baseline.find(s => s.id === after.id);
        assertSnapshot(before, after, `${name} ${after.id} @${sample.at}`);
      }
      const latest = trace.samples.at(-1).terminals.find(s => s.id === id);
      if (focused) assert.equal(latest.focused, true, name + ': the same xterm retains keyboard focus');
      for (const key of ['hydrates', 'terminalData', 'terminalSubscriptions', 'writes', 'violations']) {
        assert.deepEqual(trace.statsAfter[key], trace.statsBefore[key], name + ': unchanged ' + key);
      }
      // Other terminals may respond to a real viewport resize; the target's
      // per-tab resize IPC and onResize counts above must always stay fixed.
      return latest;
    };
    const ready = async (id) => {
      await page.waitForFunction(id => {
        const s = window.fullViewFixture.inspect(id);
        return s && s.generation === window.fullViewFixture.generation && s.length >= 420 && s.cols > 0 && s.rows > 0;
      }, id);
      await frames();
    };
    const checkpoint = async (name, id = A) => {
      const state = await inspect(id);
      const { allLines, visible, ...compact } = state || {};
      result.checkpoints.push({ name, id, ...compact, visibleFirst: visible?.[0], visibleLast: visible?.at(-1) });
      await page.screenshot({ path: path.join(artifact, name + '.png') });
      return state;
    };
    // Intersect with the real pane in side mode. A cropped xterm's own rect
    // can extend outside that pane; sending input at its center is misleading.
    const hitPoint = id => page.evaluate(id => {
      const layer = document.querySelector(`[data-terminal-layer-tab-id="${id}"]`);
      const screen = layer?.querySelector('.xterm-screen');
      if (!screen) throw Error('No terminal screen ' + id);
      const r = screen.getBoundingClientRect();
      let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      if (!screen.closest('[data-terminal-full-view-host]')) {
        const p = document.querySelector(`[data-terminal-pane-wrapper="${id}"]`).getBoundingClientRect();
        left = Math.max(left, p.left); right = Math.min(right, p.right);
        top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom);
      }
      for (const fy of [0.4, 0.6, 0.2]) for (const fx of [0.6, 0.8, 0.4]) {
        const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
        if (document.elementFromPoint(x, y)?.closest(`[data-terminal-layer-tab-id="${id}"]`)) return { x, y };
      }
      throw Error('Terminal is covered, no physical hit point: ' + id);
    }, id);
    const focusTerminal = async id => {
      const p = await hitPoint(id); await page.mouse.click(p.x, p.y);
      await page.waitForFunction(id => window.fullViewFixture.inspect(id)?.focused, id);
      assert.equal((await inspect(id)).inputSurface, 'terminal', 'focused terminal must own the input surface');
    };
    const wheel = async (id, delta, predicate) => {
      const p = await hitPoint(id);
      const diagnostic = await page.evaluate(({ id, p }) => {
        const target = document.elementFromPoint(p.x, p.y);
        const viewport = document.querySelector(`[data-terminal-layer-tab-id="${id}"] .xterm-viewport`);
        const r = viewport?.getBoundingClientRect();
        return { eventStart: window.fullViewFixture.trustedEvents.length, viewportY: window.fullViewFixture.inspect(id)?.viewportY,
          target: target && { tag: target.tagName, className: target.className },
          viewport: viewport && { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight, rect: { x: r.x, y: r.y, width: r.width, height: r.height } } };
      }, { id, p });
      const action = { id, delta, predicate, point: p, before: diagnostic };
      (result.wheels ||= []).push(action);
      await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, delta);
      if (predicate === 'top') await page.waitForFunction(id => window.fullViewFixture.inspect(id)?.viewportY === 0, id);
      else if (predicate === 'bottom') await page.waitForFunction(id => window.fullViewFixture.inspect(id)?.atBottom, id);
      else if (typeof predicate === 'number') await page.waitForFunction(({ id, prior }) => window.fullViewFixture.inspect(id)?.viewportY !== prior, { id, prior: predicate });
      await frames();
      action.events = await page.evaluate(start => window.fullViewFixture.trustedEvents.slice(start), diagnostic.eventStart);
      return inspect(id);
    };
    const geometry = id => page.evaluate(id => {
      const root = document.querySelector(`[data-terminal-full-view-host][data-terminal-full-view-tab-id="${id}"]`);
      if (!root) return null;
      const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const screen = root.querySelector('.xterm-screen');
      const frame = root.querySelector('[data-floating-terminal]');
      const content = root.querySelector('[data-terminal-view-content]');
      const title = root.querySelector('[data-floating-terminal-titlebar]');
      const button = [...root.querySelectorAll('button')].find(e => (e.textContent + ' ' + e.getAttribute('aria-label') + ' ' + e.getAttribute('title')).includes('Вернуть терминал в окно'));
      const r = screen?.getBoundingClientRect();
      const frameRect = frame?.getBoundingClientRect();
      const x = r && frameRect ? Math.max(0, r.left, frameRect.left) + Math.max(0,
        Math.min(innerWidth, r.right, frameRect.right) - Math.max(0, r.left, frameRect.left)) / 2 : 0;
      return { host: rect(root), frame: frame && rect(frame), content: content && rect(content),
        directBodyChild: root.parentElement === document.body,
        screen: screen && rect(screen), title: title && rect(title), button: button && rect(button),
        viewport: { width: innerWidth, height: innerHeight },
        hitTop: !!r && !!document.elementFromPoint(x, r.top + 4)?.closest(`[data-terminal-layer-tab-id="${id}"]`),
        hitBottom: !!r && !!document.elementFromPoint(x, r.bottom - 4)?.closest(`[data-terminal-layer-tab-id="${id}"]`) };
    }, id);
    const assertFullGeometry = async id => {
      const g = await geometry(id); assert.ok(g, 'global full-view host exists');
      assert.ok(g.directBodyChild, 'the existing portal host is above workspace and pane clips');
      for (const key of ['host', 'frame', 'content', 'title', 'button']) {
        const r = g[key]; assert.ok(r && r.width > 0 && r.height > 0, key + ' is visible');
        assert.ok(r.x >= -1 && r.y >= -1 && r.right <= g.viewport.width + 1 && r.bottom <= g.viewport.height + 1,
          key + ' is fully within the Electron viewport: ' + JSON.stringify(g));
      }
      assert.ok(g.hitTop && g.hitBottom, 'both terminal edges are physically reachable');
      return g;
    };
    const assertIdentity = async id => {
      const s = await inspect(id);
      assert.deepEqual(s.identity, { terminal: true, xterm: true, textarea: true, layer: true, frame: true, host: true, buffer: true }, id + ' retains the same live component DOM, portal host and xterm buffer');
      assert.equal(s.generation, 'full-view-fixed-generation'); assert.equal(s.generationOrdinal, 1);
      assert.equal(s.numberedRows, 420, 'all numbered output lines remain in the original buffer');
      assert.equal(s.numberedSequenceIntact, true, 'numbered output has no gaps, duplicates, or reorder');
    };
    const clickEntry = async (id, requireHeader = false) => {
      // The clipped notice and pane-header control deliberately share their
      // public selector. Identify the physical candidates before choosing; a
      // :visible titlebar can still sit above the pane's clipping boundary.
      const selector = `button[data-terminal-full-view-open="${id}"], button[data-terminal-full-view-toggle="${id}"]`;
      const buttons = page.locator(selector);
      const candidates = await buttons.evaluateAll((nodes, id) => nodes.map((e, index) => {
        const r = e.getBoundingClientRect();
        const pane = document.querySelector(`[data-terminal-pane-wrapper="${id}"]`);
        const chrome = e.closest('[data-terminal-pane-chrome-host]');
        const header = e.closest('[data-split-attach-row]');
        const margin = Math.min(3, r.width / 4, r.height / 4);
        const hitRegion = [r.x + margin, r.x + r.width / 2, r.right - margin].flatMap(x =>
          [r.y + margin, r.y + r.height / 2, r.bottom - margin].map(y => ({ x, y,
            owned: e.contains(document.elementFromPoint(x, y)) })));
        return { index,
          kind: e.hasAttribute('data-terminal-full-view-open')
            ? (e.closest('[data-split-pane-actions]') ? 'pane-header'
              : e.closest('[data-floating-terminal]') ? 'clipped-notice' : 'other') : 'titlebar',
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          reachable: r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0
            && r.right <= innerWidth && r.bottom <= innerHeight
            && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
          inOriginPane: !!pane && (pane.contains(e) || (!!chrome
            && chrome.getAttribute('data-split-pane-index') !== null
            && chrome.getAttribute('data-split-pane-index') === pane.getAttribute('data-pane-event-index'))),
          headerContainsTab: !!header?.querySelector(`[data-strip-tab-id="${id}"]`),
          insideOwnSideFrame: !!e.closest(`[data-floating-terminal-tab-id="${id}"][data-floating-terminal-side="1"]`),
          hitRegion, wholeHitRegion: hitRegion.every(p => p.owned),
        };
      }), id);
      const kinds = requireHeader ? ['pane-header'] : ['clipped-notice', 'pane-header', 'titlebar'];
      const candidate = kinds.map(kind => candidates.find(c => c.kind === kind && c.reachable)).find(Boolean);
      assert.ok(candidate, (requireHeader ? 'pane-header control' : 'full-view entry') + ' must be physically reachable: ' + JSON.stringify(candidates));
      if (requireHeader) {
        assert.equal(candidate.inOriginPane, true, 'first entry belongs to the narrow origin pane');
        assert.equal(candidate.headerContainsTab, true, 'header shows the same terminal tab as its expansion control');
        assert.equal(candidate.insideOwnSideFrame, false, 'header entry is outside its own cropped side-terminal frame');
        assert.equal(candidate.wholeHitRegion, true, 'the entire header button hit region is reachable');
      }
      const eventsBefore = await page.evaluate(() => window.fullViewFixture.trustedEvents.length);
      await buttons.nth(candidate.index).click();
      const click = await page.evaluate(({ id, eventsBefore }) => window.fullViewFixture.trustedEvents.slice(eventsBefore)
        .find(event => event.type === 'click' && (event.open === id || event.toggle === id)), { id, eventsBefore });
      assert.ok(click?.trusted, 'full view is entered by a trusted physical button click');
      if (requireHeader) assert.equal(click.entryKind, 'pane-header', 'first click really hit the pane-header expansion control');
      (result.entryClicks ||= []).push({ id, requiredHeader: requireHeader, candidate, alternatives: candidates, click });
    };
    const enter = async (id, requireHeader = false) => {
      await unchangedDuring('open-' + id, id, async () => {
        await clickEntry(id, requireHeader);
        await host(id).waitFor({ state: 'visible' });
      });
      await assertIdentity(id); await assertFullGeometry(id);
    };
    const leave = async id => {
      await unchangedDuring('return-' + id, id, async () => {
        await host(id).getByRole('button', { name: 'Вернуть терминал в окно', exact: true }).click();
        await host(id).waitFor({ state: 'hidden' });
      });
      await assertIdentity(id);
    };
    const append = async (id, label, count = 5) => {
      const seq = await page.evaluate(({ id, label, count }) => window.fullViewFixture.append(id, label, count), { id, label, count });
      await page.waitForFunction(({ id, label, seq }) => {
        const s = window.fullViewFixture.inspect(id);
        return s?.writeSeq >= seq && s.allLines.some(line => line.includes(label));
      }, { id, label, seq });
      return seq;
    };

    if (overlayOnly) {
      await composer(A).waitFor(); await ready(A);
      await page.locator(`[data-side-surface-toggle="terminal"]`).first().click();
      await page.locator(`[data-floating-terminal-tab-id="${A}"][data-floating-terminal-open="1"]`).waitFor();
      await frames(8);
      result.overlay = await page.evaluate(id => {
        const frame = document.querySelector(`[data-floating-terminal-tab-id="${id}"]`);
        const sidebar = document.querySelector('[data-sidebar-presented="1"]');
        const r = frame.getBoundingClientRect(), s = sidebar.getBoundingClientRect();
        const left = Math.max(2, r.left, s.left), right = Math.min(r.right, s.right, innerWidth - 2);
        const top = Math.max(r.top + 40, s.top + 40), bottom = Math.min(r.bottom, s.bottom, innerHeight - 2);
        const samples = Array.from({length: 5}, (_, index) => {
          const x = left + (right-left) * (index+0.5)/5, y = top + (bottom-top)*0.45;
          const hit = document.elementFromPoint(x,y);
          return {x,y,terminal:frame.contains(hit),hit:hit?.tagName,attributes:hit?.getAttributeNames()};
        });
        const parents = [];
        for (let e=frame;e;e=e.parentElement) {
          const css = getComputedStyle(e);
          parents.push({tag:e.tagName,attributes:e.getAttributeNames(),z:css.zIndex,overflowX:css.overflowX,overflowY:css.overflowY,contain:css.contain});
        }
        return {overlap:right-left,height:bottom-top,samples,parents};
      }, A);
      await checkpoint('overlay-sidebar');
      assert.ok(result.overlay.overlap > 20 && result.overlay.height > 20, 'side terminal really intersects sidebar');
      assert.ok(result.overlay.samples.every(sample => sample.terminal), 'terminal covers sidebar and receives hits across overlap');
      const before = await stats();
      await page.mouse.click(result.overlay.samples[2].x,result.overlay.samples[2].y);
      await frames();
      assert.equal((await inspect(A)).focused,true,'click over sidebar belongs to existing terminal');
      assert.deepEqual((await stats()).writes,before.writes);
      assert.deepEqual((await stats()).violations,[]); assert.deepEqual(result.errors,[]);
      result.checks.push('actual ordinary side terminal covers tab sidebar; trusted overlap click focuses xterm; zero input/provider calls');
      result.pass = true;
    } else {
    await composer(A).waitFor(); await composer(B).waitFor();
    await ready(A); await ready(B);
    await page.locator('[data-space-chip="full-other"]').click();
    await composer(C).waitFor(); await ready(C);
    await page.locator('[data-space-chip="full-main"]').click(); await composer(A).waitFor();
    // Exercise the actual ordinary-side control before the full-view control.
    await pane(A).locator('[data-side-surface-toggle="terminal"]').click();
    await pane(A).locator('[data-floating-terminal][data-floating-terminal-open="1"]').waitFor();
    await focusTerminal(A); await frames();
    await page.evaluate(ids => ids.forEach(id => window.fullViewFixture.hold(id)), [A, B, C]);
    const baseline = await stats(); result.baseline = baseline;
    assert.deepEqual(baseline.writes, []); assert.deepEqual(baseline.violations, []);
    assert.ok(baseline.terminalData.live >= 3, 'all three retained xterms receive synthetic IPC');
    const sizes = await pane(A).evaluate(e => ({ pane: e.getBoundingClientRect().width,
      terminal: e.querySelector('[data-floating-terminal]').getBoundingClientRect().width }));
    assert.ok(sizes.pane < sizes.terminal && sizes.pane < 450, 'fixture really has a clipped narrow pane');
    result.narrowGeometry = sizes;
    let state = await inspect(A);
    assert.ok(state.length > state.rows * 5, 'enough scrollback for a meaningful anchor test');
    state = await wheel(A, -1400, state.viewportY);
    const sideAnchor = state.first;
    const sideSnapshot = state;
    assert.ok(sideSnapshot.viewportY > 0 && sideSnapshot.viewportScrollTop > 0,
      'reading starts with matching nonzero buffer and DOM scroll positions');
    for (const [name, size] of Object.entries(sideSnapshot.dimensions)) {
      assert.ok(size?.width > 0 && size?.height > 0, name + ': baseline dimensions are observable');
    }
    assert.ok(baseline.resizes.some(entry => entry.tabId === A), 'resize IPC instrumentation observed the initial real xterm fit');
    await checkpoint('01-narrow-side-reading');
    await enter(A, true);
    assertSnapshot(sideSnapshot, await inspect(A), 'first header open');
    await checkpoint('02-full-reading');
    result.checks.push('first trusted click uses the origin pane header; same frame/content/xterm/grid/buffer with no resize IPC across RAF frames; global title and terminal edges accessible');
    // Prove the ordinary round trip before any draft growth or viewport
    // change, so those independent stimuli cannot hide a broken return.
    await leave(A);
    assertSnapshot(sideSnapshot, await inspect(A), 'plain open/return');
    await enter(A, true);

    const originalComposerHeight = await composer(A).evaluate(e => e.getBoundingClientRect().height);
    const fullBeforeGrowth = await geometry(A);
    let expectedDraft;
    await unchangedDuring('composer-growth', A, async () => {
      expectedDraft = await page.evaluate(id => window.fullViewFixture.growComposer(id, 18), A);
      await page.waitForFunction(({ id, before }) => document.querySelector(`[data-history-composer-tab-id="${id}"]`).getBoundingClientRect().height > before + 40,
        { id: A, before: originalComposerHeight });
    }, { peers: [B] });
    const fullAfterGrowth = await assertFullGeometry(A);
    for (const key of ['host', 'frame', 'content', 'screen', 'title']) assert.deepEqual(fullAfterGrowth[key], fullBeforeGrowth[key], key + ' is unaffected by original composer growth');
    assert.equal((await inspect(A)).first, sideAnchor, 'composer growth leaves the terminal reading line alone');
    assert.equal((await inspect(A)).focused, true, 'external draft growth cannot steal terminal focus');
    result.composerGrowth = { before: originalComposerHeight, after: await composer(A).evaluate(e => e.getBoundingClientRect().height),
      fullBefore: fullBeforeGrowth, fullAfter: fullAfterGrowth };
    await checkpoint('03-full-composer-grown');
    await append(A, 'FULL-LIVE', 7);
    assert.equal((await inspect(A)).first, sideAnchor, 'new output while reading full view preserves anchor');
    await assertIdentity(A);
    result.checks.push('growing original History composer does not crop or refocus full view; ongoing output preserves reading anchor');

    state = await wheel(A, -100000, 'top');
    assert.equal(state.first, 'A 0000 TOP'); await checkpoint('04-full-top');
    state = await wheel(A, 100000, 'bottom');
    assert.ok(state.visible.includes('A 0419 BOTTOM') && state.visible.includes('A FULL-LIVE 6'), 'bottom and ongoing output are visible');
    await checkpoint('05-full-bottom');
    // Shrink this SAME owned offscreen BrowserWindow below the captured panel
    // size. Only the outer viewport may shrink; no refit or 60x24 reset is
    // allowed. Discover actual outer scroll owners rather than prescribing
    // the parent's wrapper structure or a fixed titlebar implementation.
    const ordinarySize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const tinySize = { width: Math.min(420, sideWidth - 40), height: 300 };
    const outerMetrics = element => element.evaluate(e => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height, clientWidth: e.clientWidth, clientHeight: e.clientHeight,
        scrollWidth: e.scrollWidth, scrollHeight: e.scrollHeight, left: e.scrollLeft, top: e.scrollTop,
        overflowX: getComputedStyle(e).overflowX, overflowY: getComputedStyle(e).overflowY };
    });
    const outerScroller = async axis => {
      const handle = await page.evaluateHandle(({ id, axis }) => {
        const root = document.querySelector(`[data-terminal-full-view-host][data-terminal-full-view-tab-id="${id}"]`);
        const terminal = root?.querySelector('.xterm');
        const candidates = [];
        for (let e = terminal?.parentElement; e && root?.contains(e); e = e.parentElement) {
          const css = getComputedStyle(e);
          const overflow = axis === 'x' ? css.overflowX : css.overflowY;
          const excess = axis === 'x' ? e.scrollWidth - e.clientWidth : e.scrollHeight - e.clientHeight;
          if (/^(auto|scroll)$/.test(overflow) && excess > 1) candidates.push(e);
        }
        return candidates.at(-1) || null;
      }, { id: A, axis });
      const element = handle.asElement();
      assert.ok(element, 'physical viewport exposes an outer ' + axis + ' scroll owner without resizing the panel');
      return element;
    };
    const wheelOuter = async (element, axis, end) => {
      const point = await element.evaluate(e => {
        const r = e.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        // Prefer the outer border/gutter/title. Wheel over xterm would test
        // its scrollback instead of exposure of the unchanged rectangle.
        for (const y of [top + 1, bottom - 1, top + 12, top + (bottom - top) / 2]) {
          for (const x of [right - 1, left + 1, left + (right - left) / 2]) {
            const hit = document.elementFromPoint(x, y);
            if (hit && e.contains(hit) && !hit.closest('.xterm')) return { x, y };
          }
        }
        return null;
      });
      assert.ok(point, 'outer scroll owner has a physical wheel target outside xterm');
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(axis === 'x' ? (end ? 10000 : -10000) : 0, axis === 'y' ? (end ? 10000 : -10000) : 0);
      await page.waitForFunction(({ element, axis, end }) => {
        const value = axis === 'x' ? element.scrollLeft : element.scrollTop;
        const max = axis === 'x' ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
        return end ? value >= max - 1 : value <= 1;
      }, { element, axis, end });
      await frames();
    };
    const beforeTiny = await inspect(A);
    try {
      await unchangedDuring('physical-viewport-shrink', A, async () => {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), tinySize);
        await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, tinySize);
      });
      await assertIdentity(A);
      const horizontal = await outerScroller('x'), vertical = await outerScroller('y');
      result.tinyViewport = { size: tinySize, before: { horizontal: await outerMetrics(horizontal), vertical: await outerMetrics(vertical) } };
      await unchangedDuring('outer-scroll-top', A, async () => {
        await wheelOuter(horizontal, 'x', false);
        await wheelOuter(vertical, 'y', false);
      });
      assert.equal((await geometry(A)).hitTop, true, 'outer scrolling exposes the top row of the unchanged xterm grid');
      await checkpoint('05a-small-full-top');
      await unchangedDuring('outer-scroll-bottom-right', A, async () => {
        await wheelOuter(horizontal, 'x', true);
        await wheelOuter(vertical, 'y', true);
      });
      await assertIdentity(A);
      result.tinyViewport.after = { horizontal: await outerMetrics(horizontal), vertical: await outerMetrics(vertical) };
      result.tinyViewport.scrolledGeometry = await geometry(A);
      assert.equal(result.tinyViewport.scrolledGeometry.hitBottom, true, 'outer scrolling exposes the actual bottom row without changing xterm scrollback');
      await checkpoint('05b-small-full-bottom-right');
      await unchangedDuring('outer-scroll-return-control', A, async () => { await wheelOuter(vertical, 'y', false); });
      assert.equal(await host(A).getByRole('button', { name: 'Вернуть терминал в окно', exact: true }).evaluate(e => {
        const r = e.getBoundingClientRect();
        return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true, 'outer scroll exposes the existing return control in a physically smaller viewport');
      await horizontal.dispose(); await vertical.dispose();
    } catch (error) {
      result.tinyViewportFailure = String(error);
      await page.screenshot({ path: path.join(artifact, 'small-viewport-failure.png') });
      throw error;
    } finally {
      await unchangedDuring('physical-viewport-restore', A, async () => {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), ordinarySize);
        await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, ordinarySize);
      });
    }
    await assertFullGeometry(A); await assertIdentity(A);
    state = await inspect(A);
    assertSnapshot(beforeTiny, state, 'viewport round trip');
    assert.equal(state.atBottom, true, 'restoring the ordinary window size preserves tail-following');
    result.checks.push('physically smaller owned viewport uses trusted outer scrolling for top/bottom and return; captured frame/content/grid/buffer/resize count stay fixed throughout shrink, scroll and restore');
    state = await wheel(A, -1700, state.viewportY);
    const userFullAnchor = state.first;
    assert.notEqual(userFullAnchor, sideAnchor, 'the user selected a different reading position while expanded');
    await leave(A);
    assert.equal((await inspect(A)).first, userFullAnchor, 'return uses the latest full-view reading line');
    assert.equal(await pane(A).locator('[data-floating-terminal]').getAttribute('data-floating-terminal-open'), '1');
    state = await inspect(A); state = await wheel(A, -240, state.viewportY);
    const sideScrolledAnchor = state.first;
    await checkpoint('06-return-user-scroll');
    await enter(A);
    assert.equal((await inspect(A)).first, sideScrolledAnchor, 'scrolling after return is retained on the next expansion');
    const inputBeforeEscape = (await stats()).writes;
    await unchangedDuring('escape-return', A, async () => {
      await page.keyboard.press('Escape');
      await host(A).waitFor({ state: 'hidden' });
    });
    assert.deepEqual((await stats()).writes, inputBeforeEscape, 'Escape does not reach terminal input');
    assert.equal((await inspect(A)).first, sideScrolledAnchor, 'Escape preserves the latest reading line');
    await assertIdentity(A);
    result.checks.push('trusted wheel reaches numbered top/bottom; full and returned user scroll anchors survive; Escape returns without PTY input');

    await pane(B).locator('[data-side-surface-toggle="terminal"]').click();
    await focusTerminal(B); await enter(B);
    assert.equal((await inspect(B)).inputSurface, 'terminal');
    assert.equal((await inspect(A)).focused, false, 'neighbor full view owns keyboard focus exclusively');
    assert.equal(await page.locator('[data-terminal-full-view-host]:visible').count(), 1, 'one full view at a time across workspace windows');
    await append(B, 'NEIGHBOR-LIVE', 3); await assertIdentity(A); await assertIdentity(B);
    await checkpoint('07-neighbor-full', B);
    await leave(B);
    result.checks.push('second workspace window lifts its own existing terminal with exclusive input focus and no resize');

    await focusTerminal(A); await enter(A);
    await unchangedDuring('hide-terminal', A, async () => {
      await host(A).getByRole('button', { name: 'Hide terminal', exact: true }).click();
      await host(A).waitFor({ state: 'hidden' });
      await pane(A).locator('[data-floating-terminal][data-floating-terminal-open="0"]').waitFor({ state: 'attached' });
    }, { focused: false });
    assert.equal((await inspect(A)).focused, false, 'Hide removes focus from the retained terminal');
    assert.equal((await inspect(A)).inputSurface, 'history', 'Hide returns input ownership to History');
    assert.equal(await pane(A).locator('[data-floating-terminal]').evaluate(e => e.inert), true, 'hidden terminal subtree is inert');
    await composer(A).locator('.cm-content').click(); await page.keyboard.press('Tab'); await frames();
    assert.equal((await inspect(A)).focused, false, 'Tab cannot enter the hidden terminal');
    await pane(A).locator('[data-side-surface-toggle="terminal"]').click();
    await focusTerminal(A); await assertIdentity(A);
    result.checks.push('Hide keeps the retained terminal inert and transfers input to History without resize or remount; ordinary side toggle reopens it');

    await focusTerminal(A); await enter(A);
    await page.evaluate(() => window.fullViewFixture.navigate('full-other'));
    await composer(C).waitFor(); await host(A).waitFor({ state: 'hidden' }); await frames();
    assert.equal((await inspect(A)).focused, false, 'inactive workflow cannot keep full-view focus');
    await append(A, 'WORKFLOW-BACKGROUND', 4);
    await checkpoint('08-background-workflow');
    await page.locator('[data-space-chip="full-main"]').click(); await composer(A).waitFor(); await frames();
    assert.equal(await host(A).isVisible(), false, 'old modal does not reappear on workflow return');
    await assertIdentity(A);
    await focusTerminal(A); await enter(A);
    await page.evaluate(() => window.fullViewFixture.navigate('home'));
    await page.locator('[data-fixture-home]').waitFor(); await host(A).waitFor({ state: 'hidden' }); await frames();
    assert.equal((await inspect(A)).focused, false, 'Home cannot retain focus in the hidden full view');
    await append(A, 'HOME-BACKGROUND', 4);
    await checkpoint('09-background-home');
    await page.locator('#fixture-home').click(); await composer(A).waitFor(); await frames();
    assert.equal(await host(A).isVisible(), false, 'Home return leaves ordinary side presentation');
    await assertIdentity(A);
    result.checks.push('external workflow/Home navigation cancels stale full view; same retained xterm receives background output');

    // A true pair of trusted pointer clicks, with no wait for focus frames in
    // between, catches an open callback that refocuses after immediate close.
    await focusTerminal(A);
    await unchangedDuring('rapid-open-return', A, async () => {
      await clickEntry(A);
      await host(A).getByRole('button', { name: 'Вернуть терминал в окно', exact: true }).click();
    });
    assert.equal(await host(A).isVisible(), false);
    await composer(A).locator('.cm-content').click(); await frames();
    assert.equal((await inspect(A)).focused, false, 'closed full view has no deferred focus steal');
    assert.equal(await composer(A).locator('.cm-content').textContent(), expectedDraft.replaceAll('\n', ''), 'unsent composer draft survives full-view transitions');
    await assertIdentity(A); await assertIdentity(B); await assertIdentity(C);
    const final = await stats(); result.final = final;
    assert.deepEqual(final.hydrates, baseline.hydrates, 'no extra snapshot hydration');
    assert.deepEqual(final.terminalData, baseline.terminalData, 'terminal:data subscriptions do not churn');
    assert.deepEqual(final.terminalSubscriptions, baseline.terminalSubscriptions, 'no terminal stream resubscribe');
    assert.deepEqual(final.writes, []); assert.deepEqual(final.violations, []); assert.deepEqual(result.errors, []);
    result.trustedEvents = await page.evaluate(() => window.fullViewFixture.trustedEvents);
    assert.ok(result.trustedEvents.some(e => e.type === 'wheel') && result.trustedEvents.some(e => e.key === 'Escape'));
    assert.ok(result.trustedEvents.every(e => e.trusted), 'all recorded click/wheel/Escape interactions are trusted');
    result.unknownIpc = await page.evaluate(() => [...new Set(window.fullViewFixture.unknown)]);
    result.emitted = await page.evaluate(() => window.fullViewFixture.emitted);
    result.nativeWindow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
      visible: w.isVisible(), focused: w.isFocused(), focusable: w.isFocusable() })));
    assert.ok(result.nativeWindow.every(w => !w.visible && !w.focused && !w.focusable));
    await checkpoint('10-final');
    result.checks.push('rapid return cancels deferred focus; same xterm/DOM/generation, fixed hydrate/subscription counts, zero provider/create/restart/input calls');
    result.pass = true;
    }
  }
} catch (error) {
  result.failure = error.stack || String(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: path.join(artifact, 'failure.png'), timeout: 5000 }); } catch {}
    try { result.failureState = await page.evaluate(() => ({ state: window.fullViewFixture.state?.(), stats: window.fullViewFixture.stats(),
      trustedEvents: window.fullViewFixture.trustedEvents,
      entries: [...document.querySelectorAll('[data-terminal-full-view-toggle], [data-terminal-full-view-open]')].map(e => {
        const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { toggle: e.getAttribute('data-terminal-full-view-toggle'), open: e.getAttribute('data-terminal-full-view-open'),
          x: r.x, y: r.y, width: r.width, height: r.height, reachable: e.contains(hit), visibility: getComputedStyle(e).visibility };
      }),
      unknown: [...new Set(window.fullViewFixture.unknown)], terminals: window.fullViewFixture.tabs.map(id => {
        const s = window.fullViewFixture.inspect(id); if (!s) return { id }; const { allLines, ...rest } = s;
        const layer = document.querySelector(`[data-terminal-layer-tab-id="${id}"]`);
        const parents = [];
        for (let e = layer?.closest('[data-floating-terminal]'), depth = 0; e && depth < 7; e = e.parentElement, depth++) {
          const r = e.getBoundingClientRect(), css = getComputedStyle(e);
          parents.push({ tag: e.tagName, className: e.className, inline: e.getAttribute('style'),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            computed: { position: css.position, top: css.top, right: css.right, bottom: css.bottom, left: css.left,
              height: css.height, width: css.width, display: css.display, overflow: css.overflow } });
        }
        return { id, ...rest, parents };
      }) })); } catch {}
  }
} finally {
  result.cleanup = { worktreeRemoved: false, electronExited: !app };
  if (app) {
    const child = app.process();
    try {
      await Promise.race([app.close(), new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('owned Electron close timeout')), 10000); timer.unref();
      })]);
    } catch (error) {
      result.cleanup.closeError = String(error);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    result.cleanup.electronExited = child.exitCode !== null || child.signalCode !== null;
  }
  if (worktreeCreated) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
      result.cleanup.worktreeRemoved = true;
    } catch (error) { result.cleanup.worktreeError = String(error); }
  }
  if (result.cleanup.electronExited) {
    try {
      await fs.rm(path.join(artifact, 'user-data'), { recursive: true, force: true });
      result.cleanup.privateProfileRemoved = true;
    } catch (error) { result.cleanup.profileError = String(error); }
  }
  if (!result.cleanup.electronExited || (worktreeCreated && !result.cleanup.worktreeRemoved)) {
    result.pass = false; process.exitCode = 1;
  }
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
}
console.log(JSON.stringify({ artifact, pass: result.pass, mode: result.mode, sideWidth,
  checks: result.checks, failure: result.failure, cleanup: result.cleanup }));

#!/usr/bin/env node
// Bounded offscreen Electron28: actual Workspace/SplitPaneChrome/HiddenWindowPicker
// and real store actions, synthetic file IPC. No live app/PTY/provider/native input.
// Optional RED: --source-root=/absolute/frozen/source --red
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
const sourceRoot = process.argv.find(arg => arg.startsWith('--source-root='))?.slice(14) || repo;
const red = process.argv.includes('--red');
const buildOnly = process.argv.includes('--build-only');
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-window-split-reveal-'));
const snapshot = path.join(artifact, 'source');
const result = { artifact, sourceRoot, red, pass: false, checks: [], errors: [], checkpoints: [], traces: [],
  boundary: { actual: ['Workspace', 'SplitPaneChrome', 'HiddenWindowPicker', 'real Zustand actions', 'trusted CDP split/picker/workflow clicks'],
    synthetic: ['seeded layouts and file bodies', 'IPC persistence in memory', 'monitor-change stimulus through real store action'],
    excluded: ['production user state', 'PTY/provider', 'OS/native input', 'production build install', 'actual multi-monitor hardware'] } };
let app, page, worktreeCreated = false;
const logs = [];
function installShim() {
  const listeners = new Map(), saved = new Map();
  const f = window.splitRevealFixture = { calls: [], unknown: [], violations: [], events: [], earlyErrors: [] };
  window.addEventListener('error', event => f.earlyErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => f.earlyErrors.push(String(event.reason)));
  for (const name of ['click','contextmenu','keydown']) document.addEventListener(name, event => {
    const el = event.target instanceof Element ? event.target : null;
    f.events.push({ type: name, trusted: event.isTrusted, key: event.key,
      split: !!el?.closest('[data-split-button]:not([data-hidden-window-picker-button])'),
      direction: el?.closest('[data-split-direction-item]')?.getAttribute('data-split-direction-item'),
      hidden: el?.closest('[data-hidden-window-id]')?.getAttribute('data-hidden-window-id'),
      chip: el?.closest('[data-hidden-window-tab-id]')?.getAttribute('data-hidden-window-tab-id') });
  }, true);
  const deny = kind => { f.violations.push(kind); throw Error('Fixture forbids ' + kind); };
  const answer = (channel, payload) => {
    if (channel === 'file:read') return { success: true, content: '# Document ' + payload.split('/').pop() + '\n\nSynthetic file body. No terminal process exists.' };
    if (channel === 'file:exists-batch') return Object.fromEntries(payload.map(file => [file,true]));
    if (channel === 'agent:get-stopping-state') return { stopping: false };
    if (channel === 'project:list') return [{ id: 'split-reveal-project', name: 'Split fixture', path: '/synthetic-window-split' }];
    if (channel === 'project:get-tab-history-count') return 0;
    if (channel === 'app:getState') return saved.get(payload) ?? null;
    if (channel === 'app:setState' || channel === 'app:setStateSync') { saved.set(payload.key,payload.value); return { success: true }; }
    if (channel === 'terminal:getCommandState') return null;
    if (channel === 'terminal:getCommandStates') return {};
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'terminal:getCwd') return '/synthetic-window-split';
    if (channel === 'tab-work-context:get') return { success: true, context: { tabId: payload.tabId, revision: 1, files: [], updates: [], pendingCount: 0, responsibility: '' } };
    if (channel === 'tab:get-context-pct') return { pct: null };
    if (channel === 'agent:get-send-receipts' || channel === 'agent:list-send-receipts') return { success: true, records: [] };
    if (channel === 'system:get-dashboard-processes') return { claude: [], codex: [], gemini: [], mcp: [], electronDev: [] };
    if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:run|agent:(send|stop|rewind)|shell:|app:(open|select)|file:(write|delete))/.test(channel)) return deny(channel);
    if (/^(tab:|tab-task-plan:|project:(save|layout|order)|terminal:(subscribe|unsubscribe|remember))/.test(channel)) return { success: true };
    if (/git.*(status|diff|branch)/.test(channel)) return { success: true, isGitRepo: false, files: [], branches: [] };
    if (/list|catalog|get-models|get-prompts|get-task-plan/.test(channel)) return [];
    if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
    if (/^(log:|renderer:|perf:)/.test(channel)) return undefined;
    f.unknown.push(channel); return null;
  };
  const ipc = f.ipc = {
    invoke(c,...a) { f.calls.push(c); return Promise.resolve().then(() => structuredClone(answer(c,a[0]))); },
    send(c,...a) { f.calls.push(c); return answer(c,a[0]); },
    sendSync(c,...a) { f.calls.push(c); return answer(c,a[0]); },
    on(c,cb) { if (!listeners.has(c)) listeners.set(c,new Set()); listeners.get(c).add(cb); return ipc; },
    once(c,cb) { const fn = (...a) => { ipc.off(c,fn); cb(...a); }; return ipc.on(c,fn); },
    off(c,cb) { listeners.get(c)?.delete(cb); return ipc; }, removeListener(c,cb) { return ipc.off(c,cb); },
    removeAllListeners(c) { listeners.delete(c); return ipc; }, emit(c,...a) { for (const fn of listeners.get(c) || []) fn(...a); },
  };
  const fakePath = { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0,s.lastIndexOf('/')) || '/',
    join: (...s) => s.join('/').replace(/\/+/g,'/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '',
    isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (from,to) => to.replace(from+'/','') };
  window.require = name => {
    if (name === '@emotion/is-prop-valid') return () => true;
    if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [],
      readImage: () => ({ isEmpty: () => true }), writeText: () => deny('clipboard') },
      shell: { openExternal: () => deny('shell'), openPath: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
    if (name === 'path') return fakePath;
    if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true' } };
    if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
    if (name === 'node:v8' || name === 'node:buffer') return {};
    return deny('require:'+name);
  };
  window.process = window.require('process');
  window.fetch = () => Promise.reject(Error('Fixture network denied'));
  window.WebSocket = class { constructor() { deny('WebSocket'); } };
  window.EventSource = class { constructor() { deny('EventSource'); } };
}

try {
  execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{ cwd: repo, stdio: 'pipe' }); worktreeCreated = true;
  result.snapshotAt = new Date().toISOString();
  for (const name of ['src','packages/claude-blocks']) {
    await fs.rm(path.join(snapshot,name),{ recursive: true, force: true });
    await fs.cp(path.join(sourceRoot,name),path.join(snapshot,name),{ recursive: true,
      filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  }
  await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{ recursive: true });
  await fs.copyFile(path.join(repo,'scripts/fixtures/window-split-reveal.tsx'),path.join(snapshot,'scripts/fixtures/window-split-reveal.tsx'));
  await fs.copyFile(fileURLToPath(import.meta.url),path.join(snapshot,'scripts/window-split-reveal-regression.mjs'));
  await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  const shared = path.join(artifact,'noted-shared/packages');
  for (const name of ['structured-dnd','file-explorer']) await fs.cp(path.join(repo,'vendor/noted-shared/packages',name),path.join(shared,name),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  const bundled = await build({ nodePaths: [path.join(repo,'node_modules')], sourcemap: true, metafile: true,
    entryPoints: [path.join(snapshot,'scripts/fixtures/window-split-reveal.tsx')], bundle: true,
    outfile: path.join(artifact,'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot,'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared,'structured-dnd/src'), '@noted/file-explorer': path.join(shared,'file-explorer/src'),
      react: path.join(repo,'node_modules/react'), 'react-dom': path.join(repo,'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const hashes = {}, canonicalSnapshot = await fs.realpath(snapshot);
  for (const input of Object.keys(bundled.metafile.inputs)) {
    const absolute = await fs.realpath(path.resolve(input)).catch(() => null);
    if (!absolute?.startsWith(canonicalSnapshot + path.sep)) continue;
    hashes[path.relative(canonicalSnapshot,absolute)] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
  }
  for (const file of ['scripts/window-split-reveal-regression.mjs','src/renderer/styles/globals.css'])
    hashes[file] = createHash('sha256').update(await fs.readFile(path.join(snapshot,file))).digest('hex');
  result.sourceHashes = hashes;
  assert.ok(hashes['src/renderer/components/Workspace/Workspace.tsx']);
  assert.ok(hashes['src/renderer/store/useWorkspaceStore.ts']);
  await fs.writeFile(path.join(artifact,'source-hashes.json'),JSON.stringify(hashes,null,2));
  execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],
    { cwd: snapshot, stdio: 'pipe' });
  await fs.writeFile(path.join(artifact,'index.html'),`<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
      const w=new BrowserWindow({show:false,focusable:false,width:1600,height:900,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  if (buildOnly) { result.pass = true; }
  else {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [path.join(artifact,'main.cjs')], env, cwd: artifact });
    result.electronPid = app.process().pid;
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror',e => result.errors.push(e.stack || e.message));
    page.on('console',m => logs.push(m.text()));
    const frames = (count = 5) => page.evaluate(count => new Promise(resolve => {
      const tick = () => --count <= 0 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick);
    }),count);
    const state = () => page.evaluate(() => window.splitRevealFixture.state());
    const geometry = () => page.evaluate(() => window.splitRevealFixture.geometry());
    const pane = index => page.locator(`[data-terminal-pane-chrome-host][data-split-pane-index="${index}"]`);
    const split = index => pane(index).locator('[data-split-button]:not([data-hidden-window-picker-button])');
    const popup = page.locator('[data-hidden-window-picker]');
    const reset = async kind => { await page.keyboard.press('Escape'); await page.locator(`[data-reset="${kind}"]`).click(); await frames(); };
    const checkpoint = async name => {
      const data = { name, state: await state(), geometry: await geometry() };
      result.checkpoints.push(data); await page.screenshot({ path: path.join(artifact,name+'.png') }); return data;
    };
    const check = (name, fn) => {
      try { fn(); result.checks.push({ name, pass: true }); }
      catch (error) { result.checks.push({ name, pass: false, failure: String(error) }); }
    };
    const traceAction = async (name, action) => {
      await page.evaluate(() => window.splitRevealFixture.startTrace());
      try { await action(); await frames(12); }
      finally { result.traces.push({ name, frames: await page.evaluate(() => window.splitRevealFixture.stopTrace()) }); }
    };
    const splitDirection = async side => {
      if (side === 'right') await split(0).click();
      else { await split(0).click({ button: 'right' }); await page.locator(`[data-split-direction-item="${side}"]`).click(); }
    };
    const openPicker = async index => {
      // Escape leaves the pointer on the trigger. A real leave/re-entry is
      // required to open another hover preview; do not fake mouseenter.
      await page.mouse.move(800,15);
      await pane(index).locator('[data-hidden-window-picker-button]').hover();
      await popup.waitFor(); await frames(2);
    };
    const pickWindow = async (target, exact) => {
      await openPicker(target);
      if (exact) await popup.locator(`[data-hidden-window-tab-id="${exact}"]`).click();
      else {
        const hit = await popup.locator('[data-hidden-window-id="B"]').evaluate(el => {
          const r = el.getBoundingClientRect();
          for (let y=r.top+2;y<r.bottom-1;y+=3) for (let x=r.right-2;x>r.left;x-=3)
            if (document.elementFromPoint(x,y) === el) return { x,y };
          throw Error('No physical window-background hit');
        });
        await page.mouse.click(hit.x,hit.y);
      }
      await frames();
    };
    const requireTwo = (snapshot, selected = 'b3', direction = 'right') => {
      const panes = snapshot.state.panes;
      assert.equal(panes.length,2,'no extra empty or duplicate window inventory');
      assert.equal(panes.filter(p => p.hidden).length,0,'hidden inventory empty after reveal');
      assert.deepEqual([...panes.map(p => p.id)].sort(),['A','B']);
      const b = panes.find(p => p.id === 'B'); assert.equal(b.shown,selected);
      assert.deepEqual(b.slots,['b1','b2','b3']);
      assert.equal(new Set(panes.flatMap(p => p.slots)).size,5,'unique owners of all five tabs');
      assert.equal(snapshot.geometry.length,2,'two actual pane headers');
      const ga = snapshot.geometry.find(g => g.paneIndex === panes.find(p => p.id === 'A').index);
      const gb = snapshot.geometry.find(g => g.paneIndex === b.index);
      assert.ok(ga && gb && ga.width > 50 && gb.width > 50);
      if (direction === 'right') assert.ok(gb.x > ga.x + ga.width - 2,'B appears as right column');
      if (direction === 'left') assert.ok(gb.x + gb.width <= ga.x + 2,'B appears as left column');
      if (direction === 'above') assert.ok(gb.y + gb.height <= ga.y + 2,'B appears above A');
      if (direction === 'below') assert.ok(gb.y >= ga.y + ga.height - 2,'B appears below A');
    };

    await split(0).waitFor(); await frames(); await checkpoint('01-before-split');
    for (const side of red ? ['right'] : ['right','left','above','below']) {
      await reset('hidden');
      await traceAction('split-'+side,() => splitDirection(side));
      const after = await checkpoint('split-'+side);
      check('trusted '+side+' split reveals entire hidden B, preserves selected b3 and no placeholder',() => requireTwo(after,'b3',side));
      check('split '+side+' never paints a newly-created blank placeholder',() => {
        const trace = result.traces.at(-1).frames;
        assert.ok(trace.length > 2);
        assert.ok(trace.every(frame => frame.state.panes.every(p => p.id === 'A' || p.id === 'B')));
      });
      if (side === 'right' && !red) {
        const before = after.state.panes;
        await page.locator('[data-space-chip="other"]').click(); await frames();
        await page.locator('[data-space-chip="main"]').click(); await frames();
        const returned = await checkpoint('workflow-return');
        check('actual workflow roundtrip preserves A and revealed B',() => {
          requireTwo(returned); assert.deepEqual(returned.state.panes,before);
        });
        await page.locator('[data-monitor="small"]').click(); await frames();
        const alternate = await checkpoint('other-monitor');
        check('existing alternate display profile keeps its B-left / A-right placement',() => {
          requireTwo(alternate,'b3','left'); assert.equal(alternate.state.display,'fixture-small');
        });
        await page.locator('[data-monitor="large"]').click(); await frames();
        const monitorReturn = await checkpoint('large-monitor-return');
        check('return to original monitor restores repaired two columns',() => {
          requireTwo(monitorReturn); assert.equal(monitorReturn.state.display,'fixture-large');
        });
      }
    }
    for (const exact of [null,'b1']) {
      await reset('bad');
      await openPicker(1); await checkpoint('bad-before-'+(exact || 'background')); await page.keyboard.press('Escape');
      await traceAction('recover-bad-'+(exact || 'background'),() => pickWindow(1,exact));
      const after = await checkpoint('bad-after-'+(exact || 'background'));
      check('existing A + bare C + hidden B: '+(exact || 'background')+' consumes C without ghost',() => requireTwo(after,exact || 'b3'));
      check('recovered blank slot no longer exposes hidden-window popup',() => assert.equal(after.state.panes.filter(p => p.hidden).length,0));
      if (red) { await openPicker(1); await checkpoint('ghost-popup-'+(exact || 'background')); }
    }
    await reset('filled'); await traceAction('filled-swap',() => pickWindow(1,null));
    const filled = await checkpoint('filled-swap');
    check('filled target still swaps whole window into hidden inventory',() => {
      const p = filled.state.panes; assert.equal(p.length,3);
      assert.deepEqual(p.filter(x => !x.hidden).map(x => x.id),['A','B']);
      assert.deepEqual(p.find(x => x.id === 'C').slots,['c1']); assert.equal(p.find(x => x.id === 'C').hidden,true);
      assert.deepEqual(p.find(x => x.id === 'B').slots,['b1','b2','b3']);
    });
    if (!red) {
      for (const target of [0,1]) {
        await reset('bad');
        // Focus-only controls in an unfocused pane appear after entering that
        // pane, just as in the production header. Use the real body click.
        if (target) await pane(target).click({ position: { x: 80, y: 100 } });
        await traceAction('split-existing-empty-'+target,() => split(target).click());
        const repaired = await checkpoint('split-existing-empty-'+target);
        check('split from '+(target ? 'bare' : 'filled')+' header fills existing bare C with whole B',() => requireTwo(repaired));
      }
      await reset('no-hidden'); await traceAction('empty-fallback',() => split(0).click());
      const fallback = await checkpoint('empty-fallback');
      check('no hidden content still creates a usable empty second column',() => {
        assert.equal(fallback.state.panes.length,2); assert.equal(fallback.geometry.length,2);
        assert.equal(fallback.state.panes.filter(p => p.slots.length === 0).length,1);
        assert.ok(fallback.state.panes.every(p => !p.hidden));
      });
      for (const kind of ['chooser','history']) {
        await reset(kind); await traceAction(kind+'-target-swap',() => pickWindow(1,null));
        const retained = await checkpoint(kind+'-target-swap');
        check('user-owned '+kind+' target is preserved in hidden inventory',() => {
          const c = retained.state.panes.find(p => p.id === 'C'); assert.ok(c?.hidden);
          if (kind === 'chooser') { assert.deepEqual(c.slots,['user-choice']); assert.equal(c.selectedSlotId,'user-choice'); }
          else assert.deepEqual(c.history,[{ projectId: 'split-reveal-project',tabId: 'c1' }]);
        });
      }
    }
    result.runtime = await page.evaluate(() => {
      const f=window.splitRevealFixture;
      return { calls:f.calls, unknown:[...new Set(f.unknown)], violations:f.violations, events:f.events, earlyErrors:f.earlyErrors };
    });
    check('all split and picker inputs are trusted',() => {
      assert.ok(result.runtime.events.some(e => e.split));
      assert.ok(result.runtime.events.some(e => e.hidden));
      assert.ok(result.runtime.events.every(e => e.trusted));
    });
    check('renderer and IPC boundary are clean',() => {
      assert.deepEqual(result.errors,[]); assert.deepEqual(result.runtime.earlyErrors,[]);
      assert.deepEqual(result.runtime.violations,[]); assert.deepEqual(result.runtime.unknown,[]);
    });
    result.pass = result.checks.every(check => check.pass);
    if (!result.pass) process.exitCode = red ? 0 : 1;
    if (red) result.expectedRegressionObserved = result.checks.some(check => !check.pass && /reveals entire|consumes C/.test(check.name));
  }
} catch (error) {
  result.failure = String(error?.stack || error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(artifact,'failure.png') }).catch(() => {});
  if (page) result.failedState = await page.evaluate(() => window.splitRevealFixture?.state?.()).catch(() => null);
  if (page) result.failedRuntime = await page.evaluate(() => { const f=window.splitRevealFixture;
    return { unknown:[...new Set(f?.unknown)], violations:f?.violations, errors:f?.earlyErrors }; }).catch(() => null);
} finally {
  if (app) await app.close();
  if (worktreeCreated) execFileSync('git',['worktree','remove','--force',snapshot],{ cwd: repo, stdio: 'pipe' });
  await fs.rm(path.join(artifact,'user-data'),{ recursive: true, force: true });
  result.cleanup = { electronClosed: !!app, snapshotRemoved: worktreeCreated, profileRemoved: true };
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));
  console.log(JSON.stringify({ artifact, pass: result.pass, checks: result.checks, failure: result.failure,
    cleanup: result.cleanup, expectedRegressionObserved: result.expectedRegressionObserved }));
}

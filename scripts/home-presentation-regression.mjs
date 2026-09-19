#!/usr/bin/env node
// Isolated Electron: actual Home boundary + pane keyboard owners, with retained
// fixture content. No Noted main, PTY, production data, native focus or ports.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-home-presentation-'));
const entry = `import React,{memo,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Boundary from ${JSON.stringify(path.join(repo, 'src/renderer/components/Workspace/WorkspacePresentationBoundary.tsx'))};
import {createPaneFocusIsolationManager} from ${JSON.stringify(path.join(repo, 'src/renderer/utils/paneFocusIsolation.ts'))};
const old=new URLSearchParams(location.search).get('variant')==='old';
window.actions={dashboard:0,hidden:0};window.states=[];
// Previous App boundary, captured before replacing its native inert walk.
function OldBoundary({view,children}){return <div data-workspace-presentation={view} aria-hidden={view!=='workspace'} inert={view!=='workspace'} className="boundary" style={{visibility:view==='workspace'?'visible':'hidden',opacity:view==='workspace'?1:0,position:view==='workspace'?'relative':'absolute',...(view!=='workspace'?{inset:0,pointerEvents:'none'}:{})}}>{children}</div>}
const Content=memo(()=> <>
  <aside><button id="sidebar" tabIndex={3}>Sidebar</button></aside>
  <div id="pane-area">{Array.from({length:40},(_,i)=><section key={i} data-terminal-pane-wrapper={'pane-'+i} data-pane-focus-isolated={i?'1':'0'} aria-hidden={i?true:undefined} style={{position:'absolute',inset:'35px 0 0',opacity:i?0:1,zIndex:i?0:2,visibility:'visible',pointerEvents:i?'none':'auto',contain:'layout paint style'}}>
    <textarea data-composer={i} defaultValue={'draft '+i}/>
    <button data-pane-action={i} tabIndex={i===0?2:4}>Pane action</button>
    <div data-scroller={i} style={{height:220,overflow:'auto'}}><div style={{height:1500}}>history position</div></div>
    <div data-history={i}>{Array.from({length:750},(_,j)=><span key={j}><b>retained line </b></span>)}</div>
  </section>)}</div>
  <div id="workspace-overlay" style={{position:'fixed',inset:'80px 0 0',zIndex:999999,pointerEvents:'auto',visibility:'visible'}} onClick={()=>window.actions.hidden++}>retained popup</div>
</>);
function App(){const[view,setView]=useState('workspace');const root=useRef(null);const manager=useRef(null);window.fixtureSetView=setView;
 useLayoutEffect(()=>{manager.current=createPaneFocusIsolationManager(root.current);manager.current.sync();return()=>manager.current.dispose()},[]);
 useLayoutEffect(()=>{for(const [i,pane] of [...document.querySelectorAll('[data-terminal-pane-wrapper]')].entries()){
  const shown=view==='workspace'&&i===0;pane.dataset.paneFocusIsolated=shown?'0':'1';pane.style.opacity=shown?'1':'0';pane.style.pointerEvents=shown?'auto':'none';pane.setAttribute('aria-hidden',String(!shown));
 } manager.current?.sync();window.fixtureView=view;},[view]);
 const Wrap=old?OldBoundary:Boundary;
 return <div ref={root}><button id="home" onClick={()=>setView(v=>v==='workspace'?'dashboard':'workspace')}>Home</button><main>
 {view==='dashboard'&&<article data-dashboard-root><button id="dashboard-action" onClick={()=>window.actions.dashboard++}>Dashboard action</button><input id="dashboard-input"/></article>}
 <Wrap view={view}><Content/></Wrap></main></div>}
createRoot(document.getElementById('root')).render(<App/>);`;
await build({ stdin: { contents: entry, resolveDir: repo, loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'bundle.js'),
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><style>
body{margin:0;background:#161616;color:#ccc;font-family:Arial}#home{position:fixed;top:0;z-index:1000}
main{position:absolute;inset:40px 0 0;display:flex}main>[data-workspace-presentation]{flex:1;min-height:0}
article{flex:1;background:#222;position:relative}#dashboard-action{margin:90px 20px}aside{height:35px}
textarea{position:relative;z-index:10}button,input,textarea{color:#ccc;background:#444;border:1px solid #777}
</style><div id="root"></div><script src="bundle.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();global.fixture=new BrowserWindow({show:false,focusable:false,width:1200,height:800,
webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});
global.fixture.webContents.on('paint',()=>{});global.fixture.loadFile(${JSON.stringify(path.join(dir, 'index.html'))},{query:{variant:process.env.PROBE_VARIANT}})});
app.on('window-all-closed',()=>app.quit());`);

const result = { artifacts: dir, cases: [], errors: [] };
try {
  for (const variant of ['old', 'current']) {
    let app;
    try {
      const env = { ...process.env, PROBE_VARIANT: variant }; delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
      const page = await app.firstWindow(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      await page.waitForFunction(() => document.querySelector('[data-composer="39"]')?.getAttribute('tabindex') === '-1');
      await page.evaluate(() => {
        window.kept = [...document.querySelectorAll('[data-composer],[data-scroller]')];
        document.querySelector('[data-scroller="0"]').scrollTop = 280;
      });
      const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
      const samples = [];
      for (let i = 0; i < 8; i++) {
        const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        await page.locator('#home').click();
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        samples.push({ view: await page.evaluate(() => window.fixtureView),
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000 });
      }
      const checks = {};
      await page.locator('#home').click();
      await page.locator('#dashboard-action').click();
      assert.deepEqual(await page.evaluate(() => window.actions), { dashboard: 1, hidden: 0 });
      checks.hitTest = 'dashboard wins over child popup pointer-events:auto/z-index:999999';
      await page.waitForFunction(() => document.querySelector('[data-pane-action="0"]')?.getAttribute('tabindex') === '-1');
      if (variant === 'current') {
        await page.waitForFunction(() => document.querySelector('#sidebar')?.getAttribute('tabindex') === '-1');
        await page.evaluate(() => {
          const b = document.createElement('button'); b.id = 'late-control'; b.tabIndex = 5;
          document.querySelector('aside').append(b);
          const p = document.createElement('input'); p.id = 'late-pane-control'; p.tabIndex = 6;
          document.querySelector('[data-terminal-pane-wrapper="pane-0"]').append(p);
        });
        await page.waitForFunction(() => ['late-control','late-pane-control'].every(id => document.getElementById(id)?.tabIndex === -1));
        checks.lateControls = true;
      }
      checks.hiddenFocusRejected = await page.evaluate(() => {
        document.querySelector('[data-composer="0"]').focus();
        return !document.querySelector('[data-workspace-presentation]').contains(document.activeElement);
      });
      assert.equal(checks.hiddenFocusRejected, true);
      await page.locator('#dashboard-input').focus();
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.querySelector('[data-workspace-presentation]').contains(document.activeElement)), false);
      }
      checks.tabTraversal = true;
      await page.locator('#dashboard-input').fill('Home input stays usable');
      await page.locator('#home').click();
      await page.waitForFunction(() => document.querySelector('[data-pane-action="0"]').tabIndex === 2);
      if (variant === 'current') {
        await page.waitForFunction(() => document.querySelector('#sidebar').tabIndex === 3);
        assert.equal(await page.locator('#late-control').evaluate(e => e.tabIndex), 5);
        assert.equal(await page.locator('#late-pane-control').evaluate(e => e.tabIndex), 6);
        checks.authoredTabindexRestored = true;
      }
      checks.retention = await page.evaluate(() => ({ sameNodes: window.kept.every(e => e.isConnected),
        draft: document.querySelector('[data-composer="0"]').value,
        scrollTop: document.querySelector('[data-scroller="0"]').scrollTop,
        hiddenPaneTabindex: document.querySelector('[data-pane-action="1"]').tabIndex }));
      assert.deepEqual(checks.retention, { sameNodes: true, draft: 'draft 0', scrollTop: 280, hiddenPaneTabindex: -1 });
      // The synchronous guard also protects keyboard input before a deferred
      // tabindex pass, even when a programmatic navigation left a composer focused.
      await page.evaluate(() => { document.querySelector('[data-composer="0"]').focus(); window.fixtureSetView('dashboard'); });
      await page.waitForFunction(() => window.fixtureView === 'dashboard');
      await page.keyboard.type('must not reach hidden composer');
      assert.equal(await page.locator('[data-composer="0"]').inputValue(), 'draft 0');
      checks.hiddenTypingBlocked = true;
      result.cases.push({ variant, samples, checks, nodes: await page.locator('*').count() });
      assert.equal(await app.evaluate(() => global.fixture.isFocused()), false);
    } finally { await app?.close(); }
  }
  assert.deepEqual(result.errors, []); result.status = 'pass';
} catch (error) { result.status = 'fail'; result.error = error.stack; process.exitCode = 1; }
finally { await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }

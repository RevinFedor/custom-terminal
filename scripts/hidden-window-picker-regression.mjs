#!/usr/bin/env node
// Private offscreen Electron only; no live main, API, PTY or native input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-hidden-window-picker-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
let app;
const result = { artifact, samples: [], checks: [], errors: [], pass: false };
const logs = [];
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/hidden-window-picker.tsx'), path.join(snapshot, 'scripts/fixtures/hidden-window-picker.tsx'));
  result.sources = {};
  for (const file of ['TabCard.tsx', 'TabBar.tsx', 'TabSignals.tsx'].map(name=>'src/renderer/components/Workspace/'+name)
    .concat('scripts/fixtures/hidden-window-picker.tsx')) {
    result.sources[file] = createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex');
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', n), path.join(shared, n),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  await build({ sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/hidden-window-picker.tsx')], bundle: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  function installShim() {
    const listeners = new Map(), rows = new Map(), saved = new Map();
    const f = window.pickerFixture = { calls: [], unknown: [], violations: [], reads: 0,
      capabilities: ['synthetic structured-clone history', 'diagnostic socket unavailable'] };
    const pendingMenus=[];
    f.releaseMenus=()=>{while(pendingMenus.length)pendingMenus.shift()();};
    const deny = kind => { f.violations.push(kind); throw Error('Fixture forbids ' + kind); };
    f.rowsFor = sid => {
      if (!rows.has(sid)) rows.set(sid, Array.from({ length: 240 }, (_, i) => ({
        uuid: sid + '-row-' + i, sessionId: sid, role: i % 2 ? 'assistant' : 'user',
        timestamp: new Date(1700000000000 + i * 1000).toISOString(),
        content: 'Synthetic row ' + i + '\n\n' + 'Formatted response text. '.repeat(12),
      })));
      return rows.get(sid);
    };
    const result = (channel, payload) => {
      if (channel === 'tab:get-context-pct') return { pct: payload.tabId === 'c' ? 84 : 62 };
      if (channel === 'tab-work-context:get') return { success: true, context: { tabId: payload.tabId, revision: 1, files: [], updates: [], pendingCount: 0, responsibility: '' } };
      if (channel === 'terminal:getCommandState') return { isRunning: true, command: 'codex' };
      if (channel === 'terminal:getCommandStates') return Object.fromEntries(['a','b','c','d','e'].map(id => [id,{isRunning:true,command:'codex'}]));
      if (channel === 'app:getState') return saved.get(payload) ?? null;
      if (channel === 'app:setState' || channel === 'app:setStateSync') { saved.set(payload.key, payload.value); return { success: true }; }
      if (channel === 'agent-transcript:get-history') { f.reads++; return { success: true, entries: f.rowsFor(payload.sessionId),
        payloadGeneration: 'fixture-source', revision: { sources: [{ sessionId: payload.sessionId, fileIdentity: 'fixture-source', linkKind: 'end' }] } }; }
      if (channel === 'agent-transcript:get-timeline') return { success: true, entries: f.rowsFor(payload.sessionId).filter(x => x.role === 'user').map(x => ({ ...x, type: 'user' })) };
      if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
      if (/^agent-transcript:(subscribe|unsubscribe|refresh)$/.test(channel)) return { success: true };
      if (channel === 'agent-session:get-availability-batch') return { success: true,
        results: (payload.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
      if (channel === 'terminal:get-headless-buffer-snapshot') return { success: true, serialized: '', generation: 'fixture-gen', generationOrdinal: 1, writeSeq: 0, cols: 80, rows: 24, promptBoundaries: [] };
      if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
      if (channel === 'terminal:getCommandState') return null;
      if (channel === 'terminal:getCommandStates') return {};
      if (/^(terminal:(create|input|paste|kill|restart|stop-ai)|claude-sdk:(start|send)|codex:run|agent:(send|stop|rewind)|shell:|app:(open|select))/.test(channel)) return deny(channel);
      if (/^(tab:|tab-task-plan:|project:(save|layout|order)|terminal:(resize|subscribe|unsubscribe|remember))/.test(channel)) return { success: true };
      if (channel === 'agent:get-send-receipts' || channel === 'agent:list-send-receipts') return { success: true, records: [] };
      if (/git.*(status|diff|branch)/.test(channel)) return { success: true, isGitRepo: false, files: [], branches: [] };
      if (/list|catalog|get-models|get-prompts|get-task-plan/.test(channel)) return [];
      if (/get.*(busy|process-status|activity)|get-all-status/.test(channel)) return {};
      if (channel.startsWith('log:') || channel.startsWith('renderer:') || channel.startsWith('perf:')) return undefined;
      f.unknown.push(channel); return null;
    };
    const ipc = f.ipc = {
      invoke(c, ...a) { f.calls.push(c);
        if(c==='terminal:getCommandStates'&&a[0]?.caller==='TabBar.menuOpen'&&f.delayMenus)
          return new Promise(resolve=>pendingMenus.push(()=>resolve({states:{[a[0].tabs[0].tabId]:{isRunning:true}}})));
        return Promise.resolve().then(() => structuredClone(result(c, a[0]))); },
      send(c, ...a) { f.calls.push(c); return result(c, a[0]); }, sendSync(c, ...a) { return result(c, a[0]); },
      on(c, cb) { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb); return ipc; },
      once(c, cb) { const fn = (...a) => { ipc.off(c, fn); cb(...a); }; return ipc.on(c, fn); },
      off(c, cb) { listeners.get(c)?.delete(cb); return ipc; }, removeListener(c, cb) { return ipc.off(c, cb); },
      removeAllListeners(c) { listeners.delete(c); return ipc; }, emit(c, ...a) { for (const fn of listeners.get(c) || []) fn(...a); },
    };
    const fakePath = { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')) || '/',
      join: (...s) => s.join('/').replace(/\/+/g, '/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '',
      isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (from, to) => to.replace(from + '/', '') };
    window.require = name => {
      if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [],
        readImage: () => ({ isEmpty: () => true }), writeText: () => deny('clipboard') },
        shell: { openExternal: () => deny('shell'), openPath: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
      if (name === 'path') return fakePath;
      if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true' } };
      if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
      if (name === 'node:v8') return {}; // no binary envelope in the synthetic IPC
      if (name === 'node:buffer') return {}; // decoder remains unavailable explicitly
      return deny('require:' + name);
    };
    window.process = window.require('process');
    window.fetch = () => Promise.reject(Error('Fixture network denied'));
    window.WebSocket = class { constructor() { deny('WebSocket'); } };
    window.EventSource = class { constructor() { deny('EventSource'); } };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
    app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
      const w=new BrowserWindow({show:false,focusable:false,width:1000,height:650,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.electronPid = app.process().pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message)); page.on('console', m => logs.push(m.text()));

  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const trigger=page.locator('[data-hidden-window-picker-button]').first();
  const popup=page.locator('[data-hidden-window-picker]');
  const open=async()=>{await trigger.click();await popup.waitFor();await frames();};
  const reset=async()=>{await page.keyboard.press('Escape');await page.locator('[data-reset]').click();await frames();};
  const state=()=>page.evaluate(()=>window.pickerFixture.state());
  const card=tab=>popup.locator('[data-hidden-window-tab-id="'+tab+'"]');
  await trigger.waitFor();
  await open();
  const labelGeometry=()=>page.locator('[data-hidden-window-tab-id], [data-card-reference] [data-tab-card]').evaluateAll(cards=>cards.map(card=>{
    const label=card.querySelector('[data-tab-card-label]'),bar=card.querySelector('[data-tab-process-bar]');
    const r=card.getBoundingClientRect(),l=label.getBoundingClientRect(),b=bar?.getBoundingClientRect();
    const css=getComputedStyle(card),range=document.createRange();range.selectNodeContents(label);const text=range.getBoundingClientRect();
    return{tab:card.getAttribute('data-tab-card'),label:label.textContent,paddingLeft:css.paddingLeft,paddingRight:css.paddingRight,
      width:r.width,labelWidth:l.width,textWidth:text.width,rightGap:r.right-text.right,leftGap:text.left-r.left,
      barWidth:b?.width??0,barOnRight:!!b&&b.left>r.left+r.width/2,
      textUnderBar:b?Math.max(0,Math.min(text.right,b.right)-Math.max(text.left,b.left)):0};
  }));
  result.labelCases=[];
  for(const settings of [
    {fontSize:14,paddingX:6,position:'right',notification:'off'},
    {fontSize:22,paddingX:6,position:'right',notification:'armed'},
    {fontSize:22,paddingX:12,position:'right',notification:'armed'},
    {fontSize:22,paddingX:6,position:'right',notification:'persistent'},
    {fontSize:22,paddingX:6,position:'right',notification:'off'},
    {fontSize:22,paddingX:0,position:'right',notification:'off'},
    {fontSize:22,paddingX:0,position:'left',notification:'off'},
  ]){
    await page.evaluate(settings=>window.pickerFixture.cardLabelCase(settings),settings);await frames();
    const samples=await labelGeometry();result.labelCases.push({settings,samples});
    assert.ok(samples.some(s=>s.barWidth>0),'fixture must display a real process bar');
    for(const s of samples){
      assert.ok(s.textUnderBar<=0,JSON.stringify({settings,...s}));
      assert.ok(s.textWidth<=s.labelWidth+0.1,'intrinsic labels must not silently lose glyphs');
      if(settings.paddingX===6)assert.ok(Number.parseFloat(s.paddingRight)>=6,'configured right padding must survive initial mount and bell removal');
    }
    if(settings.position==='right'&&settings.notification==='off'&&settings.fontSize===22&&settings.paddingX===6)
      await page.screenshot({path:path.join(artifact,'tab-label-right-insets.png')});
  }
  await page.screenshot({path:path.join(artifact,'tab-label-insets.png')});
  result.checks.push('shared pane/popup cards keep full labels outside the process rail on initial render, bell removal and zero-padding/large-font settings');
  await reset();
  await page.evaluate(()=>window.pickerFixture.sidebar(true));
  await page.locator('[data-card-sidebar] [data-tab-item][data-tab-id="c"]').waitFor();
  await open();
  const notificationGeometry=()=>page.evaluate(()=>{
    const box=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const surfaces=[
      ['pane','[data-card-reference] [data-tab-card]'],
      ['picker','[data-hidden-window-tab-id]'],
      ['sidebar','[data-card-sidebar] [data-tab-item]'],
      ['run-after','[data-run-after-host] [data-tab-card]'],
    ];
    return {trigger:box(document.querySelector('[data-hidden-window-picker-button]')),
      popup:box(document.querySelector('[data-hidden-window-picker]')),
      cards:surfaces.flatMap(([surface,selector])=>Array.from(document.querySelectorAll(selector),card=>{
        const label=card.querySelector('[data-tab-card-label]')||card.querySelector('span.truncate.min-w-0');
        if(!label)throw Error('Missing actual label in '+surface);
        const range=document.createRange();range.selectNodeContents(label);
        const bell=card.querySelector('[data-tab-completion-notification-badge]');
        const bar=card.querySelector('[data-tab-process-bar]');
        const css=getComputedStyle(card),bellCss=bell&&getComputedStyle(bell),icon=bell?.querySelector('svg');
        return {surface,tab:card.getAttribute('data-tab-card')||card.getAttribute('data-tab-id'),
          layout:{card:box(card),label:box(label),text:box(range),padding:css.padding,paddingRight:css.paddingRight,
            // The sidebar map/actions and all the shared-card marks are neighbors too.
            neighbors:Array.from(card.querySelectorAll('[data-tab-pane-map], [data-tab-status-marker], [data-task-plan-tab-marker], [data-tab-context-usage], [data-tab-fast-badge], [data-tab-card-project-icon], button'),box)},
          label:label.textContent,bar:box(bar),
          frame:{boxShadow:css.boxShadow,borderColor:css.borderColor,outline:css.outline},
          rightEdge:card.getBoundingClientRect().right-Number.parseFloat(css.borderRightWidth),
          bell:bell?{...box(bell),position:bellCss.position,right:bellCss.right,top:bellCss.top,
            inkScaleX:icon?.getScreenCTM()?.a,inkScaleY:icon?.getScreenCTM()?.d,
            color:bellCss.color,mode:icon?.getAttribute('data-tab-notification-mode'),fill:icon?.getAttribute('fill')}:null,
          alert:!!card.querySelector('[data-tab-completion-notification-alert]'),
          dismissing:!!card.querySelector('.tab-completion-notification-alert--dismiss')};
      }))};
  });
  result.notificationCases=[];
  const notificationDrift=[];
  const layoutOnly=sample=>({trigger:sample.trigger,popup:sample.popup,cards:sample.cards.map(({surface,tab,layout,frame})=>({surface,tab,layout,frame}))});
  for(const settings of [
    {fontSize:14,paddingX:6,position:'right'},
    {fontSize:22,paddingX:6,position:'right'},
    {fontSize:22,paddingX:12,position:'right'},
    {fontSize:22,paddingX:0,position:'right'},
    {fontSize:22,paddingX:0,position:'left'},
  ]){
    let baseline,previousNotification;
    for(const notification of ['off','armed','persistent','persistent-fired','off','fired','off']){
      await page.evaluate(settings=>window.pickerFixture.cardLabelCase(settings),{...settings,notification});await frames();
      if(notification==='off'&&previousNotification?.endsWith('fired')){
        const sample=await notificationGeometry();result.notificationCases.push({settings,notification,phase:'cleared',sample});
        assert.ok(sample.cards.every(c=>!c.dismissing&&!c.bell&&!c.alert),'clearing removes bells immediately without a notification frame or fade');
        const geometry=layoutOnly(sample);
        if(JSON.stringify(geometry)!==JSON.stringify(baseline))notificationDrift.push({settings,notification,phase:'cleared',expected:baseline,actual:geometry});
      }
      if(notification==='off')await page.waitForFunction(()=>!document.querySelector('[data-tab-completion-notification-alert]'));
      const sample=await notificationGeometry();result.notificationCases.push({settings,notification,sample});
      assert.equal(sample.cards.filter(c=>c.surface==='sidebar').length,5,'exercise the actual vertical TabBar, including the active card');
      assert.equal(sample.cards.filter(c=>c.surface==='picker').length,4);
      assert.equal(sample.cards.filter(c=>c.surface==='pane').length,1);
      assert.equal(sample.cards.filter(c=>c.surface==='run-after').length,1);
      const geometry=layoutOnly(sample);
      baseline ||= geometry;
      if(JSON.stringify(geometry)!==JSON.stringify(baseline))notificationDrift.push({settings,notification,expected:baseline,actual:geometry});
      for(const c of sample.cards){
        const enabled=notification!=='off'&&c.tab!=='e',persistent=notification.startsWith('persistent'),fired=notification.endsWith('fired');
        assert.equal(!!c.bell,enabled,`${c.surface}/${c.tab}: ${notification} bell`);
        assert.equal(c.alert,false,`${c.surface}/${c.tab}: ${notification} must not add a notification frame`);
        assert.equal(c.dismissing,false,`${c.surface}/${c.tab}: no notification-frame fade`);
        const paddingRight=c.surface==='sidebar'?settings.paddingX:Math.max(settings.paddingX,settings.position==='right'?3:0);
        assert.equal(Number.parseFloat(c.layout.paddingRight),paddingRight,'only configured spacing and the existing process rail reserve space');
        if(enabled){
          assert.equal(c.bell.position,'absolute');assert.equal(c.bell.top,'-2px');
          assert.equal(c.bell.width,3);assert.equal(c.bell.height,11);
          assert.ok(Math.abs(c.bell.inkScaleX-11/24)<0.00001&&Math.abs(c.bell.inkScaleY-11/24)<0.00001,
            'the 11px SVG must not shrink into its 3px anchor viewport');
          const bellCenter=c.bell.x+c.bell.width/2;
          const edgeCenter=c.rightEdge-3/2;
          assert.ok(Math.abs(bellCenter-edgeCenter)<0.01,
            `${c.surface}/${c.tab}: bell must center on the right rail, offset=${bellCenter-edgeCenter}px`);
          if(c.bar&&settings.position==='right')assert.ok(Math.abs(bellCenter-(c.bar.x+c.bar.width/2))<0.01,
            `${c.surface}/${c.tab}: bell sits directly above the right process bar`);
          assert.equal(c.bell.mode,persistent?'persistent':'once');assert.equal(c.bell.fill,persistent?'currentColor':'none');
          assert.equal(c.bell.color,fired?'rgb(239, 68, 68)':'rgb(248, 113, 113)');
        }
        if(c.bar){
          assert.equal(c.bar.width,3,'the existing process rail stays 3px');
          const text=c.layout.text;
          assert.ok(text.x+text.width<=c.bar.x||text.x>=c.bar.x+c.bar.width,`${c.surface}/${c.tab}: label clears process rail`);
        }
        if(c.surface==='pane'||c.surface==='picker')assert.ok(c.layout.text.width<=c.layout.label.width+0.1,'intrinsic shared cards retain complete labels');
      }
      if(settings.fontSize===22&&settings.paddingX===6&&['off','armed','persistent-fired'].includes(notification))
        await page.screenshot({path:path.join(artifact,`notification-${notification}.png`)});
      previousNotification=notification;
    }
  }
  result.notificationDrift=notificationDrift;
  assert.equal(notificationDrift.length,0,'completion bells must not change card frames or move/resize cards, labels, adjacent chips or sidebar maps/actions');
  result.checks.push('off → armed → persistent → fired → off: no notification frame/shadow/fade and zero layout drift on pane/picker/sidebar/Run After; bell mode/color and process rail preserved; 14/22px text, 0/6/12px padding, both rail sides');
  await page.evaluate(()=>window.pickerFixture.sidebar(false));
  await reset();
  const leftRow=async()=>{
    const b=await trigger.boundingBox();
    const h=await page.locator('[data-split-attach-row]').first().boundingBox();
    return {x:h.x+8,y:b.y+b.height/2};
  };
  const left=await leftRow();await page.mouse.move(left.x,left.y);await frames();
  assert.equal(await popup.count(),0,'left corridor retains an existing popup but is not an opening trigger');
  await trigger.hover();await popup.waitFor();await page.mouse.move(left.x,left.y);await frames();
  assert.equal(await popup.count(),1,'leftward travel along the header keeps hover preview open');
  await page.mouse.move(980,620);await frames();assert.equal(await popup.count(),0,'leaving header and popup closes hover preview');
  await trigger.hover();await popup.waitFor();
  await page.evaluate(()=>window.pickerFixture.sidebarSelection());
  await card('b').click({button:'right'});
  const menu=page.locator('[data-tab-context-menu][data-tab-context-menu-host]');await menu.waitFor();await frames();
  let menuState=await state();assert.equal(menuState.panes[0].id,'visible');assert.equal(menuState.panes[0].shown,'a');
  const renameAction=menu.locator('[data-tab-context-action="rename"]');await renameAction.waitFor();
  assert.equal(await menu.locator('[data-tab-context-action="close-selected"]').count(),0,'a sidebar range never changes the picker menu target');
  assert.equal(await renameAction.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,
    'the shared context menu is above the hidden-window popup');
  await menu.hover();await frames();assert.equal(await popup.count(),1,'owned context menu keeps hover preview alive');
  await page.keyboard.press('Escape');await frames();
  await page.evaluate(()=>window.pickerFixture.shellCard());
  await trigger.hover();await popup.waitFor();await card('b').click({button:'right'});await menu.waitFor();
  const restartTrigger=menu.getByText('Restart after',{exact:true});
  await restartTrigger.hover();
  const nestedMenu=page.locator('[data-run-after-picker-menu][data-tab-context-menu-host]');
  await nestedMenu.waitFor();await nestedMenu.hover();await frames();
  assert.equal(await nestedMenu.getAttribute('data-tab-context-menu-host'),await menu.getAttribute('data-tab-context-menu-host'));
  assert.equal(await popup.count(),1,'a portal submenu remains part of this popup interaction');
  {
  const allButton=nestedMenu.locator('[data-run-after-select-all]');
  const visibleFilter=nestedMenu.locator('[data-run-after-visibility-filter]');
  const selection=()=>page.evaluate(()=>window.pickerFixture.restartSelection());
  const allRect=await allButton.boundingBox(),filterRect=await visibleFilter.boundingBox();
  assert.ok(Math.abs(filterRect.x-(allRect.x+allRect.width)-3)<0.5,'All sits 3px left of the existing count');
  assert.ok(Math.abs(filterRect.y-allRect.y)<0.5,'All and count share the header row');
  const row=nestedMenu.locator('[data-run-after-tab-row="c"]');
  await row.click();await frames();assert.deepEqual((await selection()).ids,['c']);
  await allButton.click();await frames();assert.equal(await allButton.getAttribute('aria-pressed'),'true');
  assert.deepEqual((await selection()).ids.sort(),['a','c','d','e']);
  await visibleFilter.click();await frames();assert.equal(await allButton.getAttribute('aria-pressed'),'true');
  assert.deepEqual((await selection()).ids.sort(),['a','c','d','e'],'visibility filter cannot modify ALL');
  await page.evaluate(()=>window.pickerFixture.restartFuture('all-future'));await frames();
  await nestedMenu.locator('[data-run-after-tab-row="all-future"]').waitFor();
  assert.deepEqual((await selection()).ids.sort(),['a','all-future','c','d','e']);
  await nestedMenu.screenshot({path:path.join(artifact,'restart-after-all.png')});
  await page.keyboard.press('Escape');await frames();await restartTrigger.hover();await nestedMenu.waitFor();
  assert.equal(await allButton.getAttribute('aria-pressed'),'true','reopening retains live ALL');
  await row.click();await frames();assert.equal(await allButton.getAttribute('aria-pressed'),'false');
  assert.deepEqual((await selection()).ids.sort(),['a','all-future','d','e']);
  await allButton.click();await allButton.click();await frames();
  assert.deepEqual(await selection(),{ids:[],workflows:[],explicit:[],paused:false});
  await row.click();await allButton.click();await allButton.click();await frames();
  assert.deepEqual((await selection()).ids,[],'second ALL clears the earlier partial selection as well');
  await page.evaluate(()=>window.pickerFixture.restartOtherScope(true));await frames();
  await nestedMenu.locator('[data-run-after-workflow-chip="restart-other-workflow"]').click();await frames();
  await allButton.click();await frames();assert.deepEqual((await selection()).ids,['other-ai']);
  assert.deepEqual((await selection()).workflows,['restart-other-workflow'],'scope comes from the picker, never from script owner');
  await page.evaluate(()=>window.pickerFixture.restartFuture('other-future','restart-other-project'));await frames();
  await nestedMenu.locator('[data-run-after-tab-row="other-future"]').waitFor();
  assert.deepEqual((await selection()).ids.sort(),['other-ai','other-future']);
  await nestedMenu.screenshot({path:path.join(artifact,'restart-after-all-other-workflow.png')});
  await allButton.click();await frames();assert.deepEqual((await selection()).ids,[]);
  await page.evaluate(()=>window.pickerFixture.restartOtherScope(false));await frames();
  await page.evaluate(()=>window.pickerFixture.restartRemoveFuture());await frames();
  result.checks.push('actual Restart after ALL: header position, partial/all/none, future AI tabs in owner and another selected workflow, filter independence, reopen and manual exception');
  }
  await page.keyboard.press('Escape');await frames();assert.equal(await nestedMenu.count(),0);
  assert.equal(await menu.count(),1,'first Escape belongs to the child submenu');
  await page.keyboard.press('Escape');await frames();assert.equal(await menu.count(),0,'Escape closes the child menu');
  await trigger.hover();await popup.waitFor();await card('b').click({button:'right'});await renameAction.click();
  const renameInput=popup.locator('[data-hidden-window-tab-rename]');await renameInput.waitFor();
  await renameInput.fill('Renamed from hidden picker');await page.keyboard.press('Enter');await frames();
  await trigger.hover();await popup.waitFor();await card('b').getByText('Renamed from hidden picker',{exact:true}).waitFor();
  menuState=await state();assert.equal(menuState.panes[0].id,'visible','rename does not reveal the hidden window');
  await card('b').click({button:'right'});await menu.locator('[data-tab-context-action="remove-from-window"]').click();await frames();
  menuState=await state();assert.deepEqual(menuState.panes.find(p=>p.id==='hidden-many').tabs,['c','d']);
  assert.equal(menuState.panes[0].id,'visible');
  result.checks.push('left header hover corridor; shared right-click menu above popup; Escape, inline rename and exact hidden placement removal without reveal');
  await reset();await page.evaluate(()=>{window.pickerFixture.coldMenus();window.pickerFixture.delayMenus=true;});await frames();
  await trigger.hover();await popup.waitFor();await card('b').click({button:'right'});await frames();
  assert.equal(await menu.count(),0,'controlled menu enrichment is still pending');
  await page.keyboard.press('Escape');await page.evaluate(()=>window.pickerFixture.releaseMenus());await frames();
  assert.equal(await menu.count(),0,'late menu enrichment cannot reopen a cancelled request');
  await trigger.hover();await popup.waitFor();await card('b').click({button:'right'});await card('c').click({button:'right'});
  await page.evaluate(()=>window.pickerFixture.releaseMenus());await menu.waitFor();await frames();
  assert.equal(await menu.count(),1);assert.ok((await menu.getAttribute('data-tab-context-menu-host')).endsWith(':c'),'last right-click owns the menu');
  await page.screenshot({path:path.join(artifact,'hidden-tab-context-menu.png')});
  await page.mouse.click(980,620);await frames();assert.equal(await menu.count(),0);assert.equal(await popup.count(),0);
  await page.evaluate(()=>window.pickerFixture.delayMenus=false);
  result.checks.push('pending context-menu cancellation and repeated right-click keep one exact owner; outside click dismisses both');
  await reset();await open();
  const row=popup.locator('[data-hidden-window-id="hidden-many"]');
  assert.equal(await row.locator('[data-tab-card]').count(),3);
  const geometry=await row.evaluate(el=>{const c=getComputedStyle(el);return {padding:c.padding,margin:c.margin,transition:c.transitionDuration};});
  assert.deepEqual(geometry,{padding:'0px',margin:'0px',transition:'0s'});
  assert.equal(await row.getByText('run after / run cmd',{exact:true}).count(),1,'window does not duplicate a tab title as its own heading');
  await card('c').locator('[data-tab-context-usage]').waitFor();
  const metrics=async locator=>locator.evaluate(el=>{const s=getComputedStyle(el);return{font:s.fontSize,radius:s.borderRadius,padding:s.padding,
    percentage:el.querySelector('[data-tab-context-usage]')?.textContent,marker:!!el.querySelector('[data-tab-status-marker]'),tasks:el.querySelectorAll('[data-task-plan-tab-marker]').length};});
  const paneMetrics=await metrics(page.locator('[data-card-reference] [data-tab-card="c"]'));
  const hiddenMetrics=await metrics(card('c'));assert.deepEqual(hiddenMetrics,paneMetrics);
  assert.equal(hiddenMetrics.percentage,'84');assert.equal(hiddenMetrics.marker,true);assert.equal(hiddenMetrics.tasks,1);
  assert.equal(await card('c').locator('[data-tab-card-project-icon]').count(),1);
  assert.equal(await page.locator('[data-card-reference] [data-tab-card-project-icon]').count(),0,'project icon can be hidden by the shared card caller');
  assert.ok(await popup.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'signal overhang must not create a spurious scrollbar');
  assert.ok(await card('c').locator('.tab-process-bar-ai-shimmer-overlay').count()>0);
  const normalBg=await card('c').evaluate(e=>getComputedStyle(e).backgroundColor);
  await card('c').hover();await frames();
  const hover=await card('c').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,transition:getComputedStyle(e).transitionDuration,
    parentBg:getComputedStyle(e.parentElement).backgroundColor}));
  assert.notEqual(hover.bg,normalBg);assert.equal(hover.transition,'0s');
  assert.notEqual(hover.parentBg,'rgba(0, 0, 0, 0)','entering a tab stays inside the window hover surface');
  const cardHoverColor=await card('c').evaluate(e=>getComputedStyle(e).color);
  await page.locator('[data-card-reference] [data-tab-card="c"]').hover();await frames();
  assert.equal(await page.locator('[data-card-reference] [data-tab-card="c"]').evaluate(e=>getComputedStyle(e).color),cardHoverColor,
    'pane and picker share the same hover text profile');
  const bounds=await row.boundingBox();await page.mouse.move(bounds.x+bounds.width-3,bounds.y+bounds.height-3);await frames();
  assert.equal(await row.evaluate(e=>getComputedStyle(e).backgroundColor),hover.parentBg,'background and nested card retain the same window highlight');
  await page.screenshot({path:path.join(artifact,'hidden-windows.png')});
  result.checks.push('shared size/status/context/tasks/icon/busy chrome; zero wrapper padding, instant card hover and persistent parent highlight');
  await card('b').click();await frames();
  let s=await state();assert.equal(s.panes[0].id,'hidden-many');assert.equal(s.panes[0].shown,'b');assert.deepEqual(s.panes[0].tabs,['b','c','d']);
  assert.equal(s.panes.find(x=>x.id==='visible').hidden,true);assert.equal(s.mru[0],'b');assert.notEqual(s.mru[0],'c');
  await page.waitForFunction(()=>document.querySelector('[data-terminal-pane-wrapper="b"]')?.getAttribute('data-terminal-surface-presented')==='1');
  result.checks.push('click a parked card reveals that window with that exact tab and retained order');
  await reset();await open();
  const marker=await card('b').locator('[data-task-plan-tab-marker]').boundingBox();
  await page.mouse.click(marker.x+marker.width/2,marker.y+marker.height-1);await frames();
  s=await state();assert.equal(s.panes[0].shown,'b','the signal overhang belongs to its tab, not the surrounding window background');
  result.checks.push('click on the task signal overhang selects the same card');
  await reset();await open();const bg=popup.locator('[data-hidden-window-id="hidden-many"]');await bg.focus();await page.keyboard.press('Enter');await frames();
  s=await state();assert.equal(s.panes[0].shown,'c');result.checks.push('window background keyboard activation preserves its existing selection');
  await reset();await open();await card('d').click({button:'middle'});await frames();
  s=await state();assert.equal(s.panes[0].id,'visible');assert.deepEqual(s.panes.find(x=>x.id==='hidden-many').tabs,['b','c']);assert.equal(await popup.count(),1);
  await page.keyboard.down('Meta');try{await card('b').click();}finally{await page.keyboard.up('Meta');}await frames();
  s=await state();assert.deepEqual(s.panes.find(x=>x.id==='hidden-many').tabs,['c']);assert.equal(s.panes[0].id,'visible');
  result.checks.push('middle and Cmd clicks remove only the named hidden chip without revealing the window');
  await reset();const slot=await page.evaluate(()=>window.pickerFixture.chooser());await open();
  await popup.locator('[data-hidden-window-slot-id="'+slot+'"]').click();await frames();
  s=await state();assert.equal(s.panes[0].slot,slot);assert.equal(s.panes[0].shown,'');assert.ok(!s.mru.includes('c'));
  result.checks.push('chooser card reveals its placeholder without activating the old AI tab');
  await reset();await open();await page.evaluate(()=>window.pickerFixture.rename());await card('c').getByText('Переименованная вкладка',{exact:true}).waitFor();
  await page.evaluate(()=>window.pickerFixture.busy(false));await page.waitForFunction(()=>!document.querySelector('[data-hidden-window-tab-id="c"] .tab-process-bar-ai-shimmer-overlay'));
  await page.evaluate(()=>window.pickerFixture.icon(false));assert.equal(await card('c').locator('[data-tab-card-project-icon]').count(),0);
  result.checks.push('live name/activity/icon updates use the shared card while popup stays open');
  await page.keyboard.press('Escape');await page.locator('[data-run-after-host] [data-run-after-tab-row]').click();
  const runMenu=page.locator('[data-run-after-picker-menu]');await runMenu.waitFor();
  const runCard=runMenu.locator('[data-run-after-tab-row="c"]');await runCard.waitFor();
  const runMetrics=await metrics(runCard);assert.equal(runMetrics.radius,paneMetrics.radius);assert.equal(runMetrics.font,paneMetrics.font);
  assert.equal(runMetrics.percentage,'84');assert.equal(runMetrics.marker,true);assert.equal(runMetrics.tasks,1);
  await runMenu.locator('[data-run-after-tab-row="d"]').click();await frames();s=await state();assert.equal(s.selected,'d');assert.equal(s.panes[0].id,'visible');
  result.checks.push('Run After uses the same card and still selects a dependency without navigating');
  await reset();
  await trigger.evaluate(button=>Object.assign(button.parentElement.style,{position:'fixed',right:'4px',bottom:'4px',zIndex:'9000'}));
  await open();await page.evaluate(()=>window.pickerFixture.geometry(22,0));await frames();
  await page.waitForFunction(()=>{const e=document.querySelector('[data-hidden-window-picker]');if(!e)return false;const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;});
  const resized=await metrics(card('c'));assert.equal(resized.font,'22px');
  await page.screenshot({path:path.join(artifact,'hidden-windows-edge.png')});
  result.checks.push('font-size and zero-gap changes keep the popup within the viewport at the bottom edge');
  assert.deepEqual(result.errors,[]);
  result.state=await page.evaluate(()=>({violations:window.pickerFixture.violations,unknown:[...new Set(window.pickerFixture.unknown)]}));
  assert.deepEqual(result.state.violations,[]);result.pass=true;
} catch (error) { result.failure = String(error); process.exitCode = 1; }
finally {
  if (app) await app.close();
  execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
  result.cleanup = { electronClosed: !!app, snapshotRemoved: true };
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
}
console.log(JSON.stringify(result));

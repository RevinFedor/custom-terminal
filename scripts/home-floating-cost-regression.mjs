#!/usr/bin/env node
// Private offscreen Electron only; no live main, API, PTY or native input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-home-floating-cost-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
let app;
const result = { artifact, samples: [], checks: [], errors: [], pass: false };
const logs = [];
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name),
    { recursive: true, force: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/home-floating-cost.tsx'), path.join(snapshot, 'scripts/fixtures/home-floating-cost.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const n of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', n), path.join(shared, n),
    { recursive: true, filter: p => !p.includes('/node_modules') });
  if (process.env.NOTED_HOME_BASELINE_BOUNDARY) await fs.copyFile(process.env.NOTED_HOME_BASELINE_BOUNDARY,
    path.join(snapshot, 'src/renderer/components/Workspace/WorkspacePresentationBoundary.tsx'));
  await build({ nodePaths: [path.join(repo, 'node_modules')], sourcemap: true, entryPoints: [path.join(snapshot, 'scripts/fixtures/home-floating-cost.tsx')], bundle: true,
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
    const f = window.workflowFixture = { calls: [], unknown: [], violations: [], writes: [], reads: 0,
      capabilities: ['synthetic structured-clone history', 'diagnostic socket unavailable'] };
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
      if (channel === 'codex:get-runtime-projection') {
        const sid = 'session-' + payload.tabId;
        return { success:true,projectId:'home-cost-project',sessionStatus:'active',busy:false,inputReady:true,liveLifecycle:true,
          sessionId:sid,readSessionId:sid,readIdentitySource:'live-writer',savedSessionId:sid,conversationMaterialized:true,
          timelineCount:120,materializationReason:'user-history-present',canCopySessionId:true,hasTerm:true,lastNotReady:null,
          startupFailed:false,startupError:null,manualActionRequired:false,manualActionType:null,lifecycleWarning:null,
          hasWatcher:true,catchUpPending:false,outcomeKnown:false,lastOutcomeReason:null };
      }

      if (channel === 'project:list') return [{id:'home-cost-project',name:'Synthetic',path:'/synthetic-workflow'}];
      if (channel === 'system:get-dashboard-processes') return {claude:[],codex:[],gemini:[],mcp:[],electronDev:[]};
      if (channel === 'project:get-tab-history-count') return 0;
      if (channel === 'terminal:getCwd') return '/synthetic-workflow';
      if (channel === 'app:getState') return saved.get(payload) ?? null;
      if (channel === 'app:setState' || channel === 'app:setStateSync') { saved.set(payload.key, payload.value); return { success: true }; }
      if (channel === 'agent-transcript:get-history') { f.reads++; return { success: true, entries: f.rowsFor(payload.sessionId),
        payloadGeneration: 'fixture-source', revision: { sources: [{ sessionId: payload.sessionId, fileIdentity: 'fixture-source', linkKind: 'end' }] } }; }
      if (channel === 'agent-transcript:get-timeline') return { success: true, entries: f.rowsFor(payload.sessionId).filter(x => x.role === 'user').map(x => ({ ...x, type: 'user' })) };
      if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
      if (/^agent-transcript:(subscribe|unsubscribe|refresh)$/.test(channel)) return { success: true };
      if (channel === 'agent-session:get-availability-batch') return { success: true,
        results: (payload.sessions || []).map(s => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
      if (channel === 'terminal:get-headless-buffer-snapshot') return { success: true, serialized: Array.from({length:180},(_,i)=>'Synthetic terminal screen '+i).join('\r\n')+'\r\n', generation: 'fixture-gen', generationOrdinal: 1, writeSeq: 0, cols: 80, rows: 24, promptBoundaries: [] };
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
      invoke(c, ...a) { f.calls.push(c); return Promise.resolve().then(() => structuredClone(result(c, a[0]))); },
      send(c, ...a) { f.calls.push(c); if(c==='terminal:input'){f.writes.push({tabId:a[0],data:a[1]});return;} return result(c, a[0]); }, sendSync(c, ...a) { return result(c, a[0]); },
      on(c, cb) { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb); return ipc; },
      once(c, cb) { const fn = (...a) => { ipc.off(c, fn); cb(...a); }; return ipc.on(c, fn); },
      off(c, cb) { listeners.get(c)?.delete(cb); return ipc; }, removeListener(c, cb) { return ipc.off(c, cb); },
      removeAllListeners(c) { listeners.delete(c); return ipc; }, emit(c, ...a) { for (const fn of listeners.get(c) || []) fn(...a); },
    };
    const fakePath = { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')) || '/',
      join: (...s) => s.join('/').replace(/\/+/g, '/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '',
      isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (from, to) => to.replace(from + '/', '') };
    window.require = name => {
      if (name === '@emotion/is-prop-valid') return () => true;
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
      const w=new BrowserWindow({show:false,focusable:false,width:1600,height:1000,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message)); page.on('console', m => logs.push(m.text()));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('[data-history-composer-tab-id="home-cost-tab-0"]').waitFor();
  await page.locator('[data-history-row-real]').first().waitFor();
  await page.screenshot({path:path.join(artifact,'initial.png')});
  await page.locator('[data-space-chip="cost-other"]').click();
  await page.locator('[data-history-composer-tab-id="home-cost-tab-4"]').waitFor();
  await page.locator('[data-space-chip="cost-main"]').click(); await frames();
  await page.waitForTimeout(600);
  await page.waitForFunction(()=>!!window.workflowFixture.terminal('home-cost-tab-0'));
  const composer = page.locator('[data-history-composer-tab-id="home-cost-tab-0"] .cm-content');
  await composer.click(); await composer.pressSequentially('kept draft');
  const scroller = page.locator('[data-terminal-pane-wrapper="home-cost-tab-0"] [data-testid="virtuoso-scroller"]').first();
  const priorTop=await scroller.evaluate(e=>e.scrollTop);
  await scroller.hover({position:{x:100,y:250}});await page.mouse.wheel(0,-200);
  await page.waitForFunction(top=>document.querySelector('[data-terminal-pane-wrapper="home-cost-tab-0"] [data-testid="virtuoso-scroller"]').scrollTop<top-100,priorTop);
  await frames();
  await scroller.evaluate(e=>{window.keptScroll=e;window.keptTop=e.scrollTop;});
  await page.evaluate(()=>{window.keptTerminal=window.workflowFixture.terminal('home-cost-tab-0');window.readsBefore=window.workflowFixture.reads;window.keptHomeNodes=[...document.querySelectorAll('[data-terminal-pane-wrapper],.cm-content,.xterm')];});
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
  await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordContinuously',includedCategories:['toplevel','devtools.timeline','blink','cc','blink.user_timing','disabled-by-default-devtools.timeline.invalidationTracking']}});
  for(let i=0;i<6;i++){
    const before=await cdp.send('Performance.getMetrics');
    const name='home-'+i;
    await page.evaluate(n=>performance.mark(n+'-start'),name);
    await page.locator('#home').click(); await frames();
    await page.evaluate(n=>performance.mark(n+'-end'),name);
    const measuredAfter=await cdp.send('Performance.getMetrics');
    if(i===0){
      await page.screenshot({path:path.join(artifact,'home-open.png')});
      assert.equal(await page.evaluate(()=>{
        document.querySelector('[data-history-composer-tab-id="home-cost-tab-0"] .cm-content').focus();
        return !!document.activeElement?.closest('[data-workspace-presentation]');
      }),false,'hidden workspace rejects programmatic focus');
      await page.keyboard.press('Meta+]');
      assert.equal(await page.locator('[data-terminal-pane-wrapper="home-cost-tab-0"] [data-floating-terminal]').getAttribute('data-floating-terminal-open'),'0','Home shortcut never opens hidden terminal');
      await page.evaluate(()=>window.workflowFixture.ipc.emit('terminal:data',{}, {tabId:'home-cost-tab-0',data:'Background screen update\r\n',headlessWriteSeq:1,headlessGeneration:'fixture-gen',headlessGenerationOrdinal:1}));
    }
    const after=measuredAfter;
    result.samples.push({name,metrics:Object.fromEntries(after.metrics.filter(m=>['ThreadTime','ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].includes(m.name)).map(m=>[m.name,m.value-before.metrics.find(b=>b.name===m.name).value]))});
  }
  await composer.click();
  const terminalFrame=page.locator('[data-terminal-pane-wrapper="home-cost-tab-0"] [data-floating-terminal]');
  await page.evaluate(()=>{window.keptTerminal=window.workflowFixture.terminal('home-cost-tab-0');window.keptXterm=document.querySelector('[data-terminal-pane-wrapper="home-cost-tab-0"] .xterm');});
  for(let i=0;i<6;i++){
    const before=await cdp.send('Performance.getMetrics');
    const name='terminal-'+i;
    await page.evaluate(n=>performance.mark(n+'-start'),name);
    await page.keyboard.press('Meta+]');
    await terminalFrame.locator(':scope').evaluate((e,want)=>{if(e.getAttribute('data-floating-terminal-open')!==want)throw Error('shortcut did not change panel');},i%2?'0':'1');
    await frames();
    const after=await cdp.send('Performance.getMetrics');
    result.samples.push({name,metrics:Object.fromEntries(after.metrics.filter(m=>['ThreadTime','ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].includes(m.name)).map(m=>[m.name,m.value-before.metrics.find(b=>b.name===m.name).value]))});
    await page.evaluate(n=>performance.mark(n+'-end'),name);
    if(i===0){
      await page.screenshot({path:path.join(artifact,'terminal-open.png')});
      await page.waitForFunction(()=>{
        const t=window.workflowFixture.terminal('home-cost-tab-0');
        return Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString()).join('\n').includes('Background screen update');
      });
      assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),true);
      await page.keyboard.insertText('z');
      await page.waitForFunction(()=>window.workflowFixture.writes.length===1);
    } else if(i%2) {
      assert.equal(await terminalFrame.evaluate(e=>{e.querySelector('.xterm-helper-textarea').focus();return e.contains(document.activeElement);}),false,'closed side terminal rejects focus');
    }
    assert.equal(await page.evaluate(()=>window.workflowFixture.terminal('home-cost-tab-0')===window.keptTerminal),true);
  }
  const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;
  let raw='';try{for(;;){const p=await cdp.send('IO.read',{handle:stream,size:1048576});raw+=p.base64Encoded?Buffer.from(p.data,'base64').toString('utf8'):p.data;if(p.eof)break;}}finally{await cdp.send('IO.close',{handle:stream});}
  await fs.writeFile(path.join(artifact,'trace.json'),raw);
  result.styleTraversal=JSON.parse(raw).traceEvents.filter(e=>e.ph==='X'&&e.name==='UpdateLayoutTree').map(e=>({ms:e.dur/1000,elements:e.args?.elementCount??null}));
  result.functional=await page.evaluate(()=>({retained:window.keptHomeNodes.every(n=>n.isConnected),sameTerminal:window.workflowFixture.terminal('home-cost-tab-0')===window.keptTerminal,sameXterm:window.keptXterm?.isConnected,reads:window.workflowFixture.reads,readsBefore:window.readsBefore,writes:window.workflowFixture.writes,scrollTop:window.keptScroll.scrollTop,expectedTop:window.keptTop,draft:document.querySelector('[data-history-composer-tab-id="home-cost-tab-0"] .cm-content')?.textContent, violations:window.workflowFixture.violations,unknown:[...new Set(window.workflowFixture.unknown)]}));
  assert.equal(result.functional.retained,true);assert.equal(result.functional.draft,'kept draft');assert.deepEqual(result.errors,[]);assert.deepEqual(result.functional.violations,[]);
  assert.equal(result.functional.scrollTop,result.functional.expectedTop);assert.equal(result.functional.sameTerminal,true);assert.equal(result.functional.sameXterm,true);
  assert.equal(result.functional.reads,result.functional.readsBefore);
  assert.deepEqual(result.functional.writes,[{tabId:'home-cost-tab-0',data:'z'}]);
  await composer.click();
  await page.keyboard.press('Meta+]');await page.keyboard.press('Meta+]');await frames();
  assert.equal(await terminalFrame.getAttribute('data-floating-terminal-open'),'0');
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('xterm-helper-textarea')),false,'cancelled open cannot take focus later');
  assert.equal(await composer.textContent(),'kept draft');
  result.checks=['actual Home/Workspace and store round trip six times', 'no whole retained visibility traversal',
    'same History DOM, scroll and draft; unchanged read count', 'hidden Home blocks focus and shortcut',
    'six actual Cmd+] toggles, no composer indentation', 'same xterm instance and DOM',
    'background terminal output arrives while hidden', 'only explicit terminal typing reaches synthetic input',
    'closed side panel rejects focus; rapid reopen/close cancels focus'];
  if(process.env.NOTED_HOME_EXPECT_FAST==='1')assert.ok(!result.styleTraversal.some(x=>x.elements>5000&&x.ms>30),'Home must not revisit retained descendants');

  result.eventTiming=logs.filter(l=>l.startsWith('[Perf:UIAction] ')).flatMap(l=>{
    try { const d=JSON.parse(l.slice('[Perf:UIAction] '.length).split(' appView=')[0]);return d.kind==='event-timing'?[d]:[]; } catch {return [];}
  });
  result.nodes=await page.locator('*').count();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isFocused())),false);
  result.pass = true;
} catch (error) { result.failure = String(error); process.exitCode = 1; }
finally {
  if (app) await app.close();
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.copyFile(path.join(snapshot, 'src/renderer/components/Workspace/HistoryPanel.tsx'), path.join(artifact, 'HistoryPanel.snapshot.tsx'));
  execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
}
console.log(JSON.stringify(result));

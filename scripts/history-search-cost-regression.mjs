#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-history-search-cost-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-search.tsx'),path.join(snapshot,'scripts/fixtures/history-search.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'vendor/noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
const historyFile=path.join(snapshot,'src/renderer/components/Workspace/HistoryPanel.tsx');
if(process.env.NOTED_SEARCH_BASELINE_HISTORY)await fs.copyFile(process.env.NOTED_SEARCH_BASELINE_HISTORY,historyFile);
if(process.env.NOTED_SEARCH_OMIT_DYNAMIC_STYLE==='1'){
 const text=await fs.readFile(historyFile,'utf8');
 const next=text.replace(/<style>\{`::highlight\(\$\{searchHighlightName\}\)[\s\S]*?<\/style>/,'');
 assert.notEqual(next,text,'control removes only the dynamic highlight stylesheet');
 await fs.writeFile(historyFile,next);
}
await fs.copyFile(historyFile,path.join(artifact,'HistoryPanel.snapshot.tsx'));
await build({sourcemap:true,entryPoints:[path.join(snapshot,'scripts/fixtures/history-search.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
 define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
 alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),'@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
 loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact,'user-data'));
await fs.writeFile(path.join(artifact,'preload.cjs'),`const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
await fs.writeFile(path.join(artifact,'main.cjs'),`const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');
ipcMain.handle('fixture:invoke',(_e,{channel,args})=>{
 if(channel==='agent:get-send-receipts')return {success:true,records:[]};
 if(channel==='file:read')return{success:true,content:'# File preview\\nBody of the document.',size:40};
 if(channel==='file:exists-batch')return Object.fromEntries(args[0].map(p=>[p,!p.includes('missing')]));
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return[];
 if(channel==='terminal:getCommandStates')return{};
 if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState')return null;
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:1100,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});

const result={artifact,omitDynamicStyle:process.env.NOTED_SEARCH_OMIT_DYNAMIC_STYLE==='1',samples:[],errors:[]};
let page;const logs=[];
try{
 page=await app.firstWindow();page.setDefaultTimeout(14000);
 page.on('pageerror',e=>result.errors.push(e.stack||e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.state.ready);
 await page.locator('[data-history-row-real]').first().waitFor();
 await page.evaluate(()=>{
  const root=document.createElement('div');root.id='retained-cost-fixture';root.style.cssText='position:absolute;inset:0;pointer-events:none;opacity:0;overflow:hidden;z-index:-1';
  let html='';for(let i=0;i<47;i++){
   html+='<section data-terminal-surface-presented="0" style="position:absolute;inset:0;overflow:hidden"><div class="cb-messages">';
   for(let j=0;j<180;j++)html+='<article class="cb-row cb-row-assistant group cb-message"><p>Retained response <b>formatted content</b> and <span>background data</span></p><pre><code>const answer = await work();</code></pre><footer>Response · Saved</footer></article>';
   html+='</div></section>';
  }
  root.innerHTML=html;document.body.appendChild(root);
  window.costState={styles:[],events:[],longTasks:[]};
  new MutationObserver(records=>{for(const record of records)for(const [kind,nodes] of [['add',record.addedNodes],['remove',record.removedNodes]])for(const node of nodes){
    const styles=node.nodeType===1?(node.tagName==='STYLE'?[node]:[...node.querySelectorAll('style')]):[];
    for(const style of styles)window.costState.styles.push({kind,time:performance.now(),text:style.textContent.slice(0,180)});
  }}).observe(document,{subtree:true,childList:true});
  new PerformanceObserver(list=>window.costState.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false});
  new PerformanceObserver(list=>window.costState.events.push(...list.getEntries().map(e=>({name:e.name,start:e.startTime,duration:e.duration,processingStart:e.processingStart,processingEnd:e.processingEnd})))).observe({type:'event',durationThreshold:16});
 });
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await frames();await frames();
 result.nodes=await page.evaluate(()=>document.querySelectorAll('*').length);
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
 await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:250});await cdp.send('Profiler.start');
 await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordContinuously',includedCategories:['toplevel','devtools.timeline','blink','cc','blink.user_timing','disabled-by-default-devtools.timeline.invalidationTracking']}});
 const measure=async(name,action)=>{
  const before=await cdp.send('Performance.getMetrics');
  await page.evaluate(name=>performance.mark(name+'-start'),name);
  const start=Date.now();await action();await frames();
  await page.evaluate(name=>performance.mark(name+'-end'),name);
  const after=await cdp.send('Performance.getMetrics');
  result.samples.push({name,elapsed:Date.now()-start,metrics:Object.fromEntries(after.metrics.filter(m=>['ThreadTime','ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].includes(m.name)).map(m=>[m.name,m.value-before.metrics.find(b=>b.name===m.name).value]))});
 };
 for(let i=0;i<3;i++){
  await page.locator('[data-split-strip-menu-button]').click();
  await measure('open-'+i,async()=>{await page.locator('[data-split-strip-menu-item="search-history"]').click();await page.locator('[data-history-search-panel]').waitFor();});
  await measure('close-'+i,async()=>{await page.getByLabel('Закрыть поиск по чату').click();await page.waitForFunction(()=>!document.querySelector('[data-history-search-panel]'));});
 }
 result.profile=(await cdp.send('Profiler.stop')).profile;
 const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;
 let raw='';try{for(;;){const part=await cdp.send('IO.read',{handle:stream,size:1048576});raw+=part.base64Encoded?Buffer.from(part.data,'base64').toString('utf8'):part.data;if(part.eof)break;}}finally{await cdp.send('IO.close',{handle:stream});}
 await fs.writeFile(path.join(artifact,'trace.json'),raw);await fs.writeFile(path.join(artifact,'renderer.cpuprofile'),JSON.stringify(result.profile));delete result.profile;
 result.observed=await page.evaluate(()=>window.costState);
 result.state=await page.evaluate(()=>({reads:window.fixture.state.reads,searches:window.fixture.state.searches.length}));
 if(process.env.NOTED_SEARCH_EXPECT_DYNAMIC_STYLES!=='1')assert.equal(result.observed.styles.filter(s=>s.text.includes('::highlight')).length,0,'opening an empty search must not replace document stylesheets');
 assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){result.failure=String(error);result.pass=false;process.exitCode=1;}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});}
console.log(JSON.stringify({artifact,pass:result.pass,nodes:result.nodes,samples:result.samples,state:result.state,failure:result.failure,errors:result.errors}));

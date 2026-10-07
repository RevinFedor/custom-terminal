#!/usr/bin/env node
// Two private renderers, actual components/store/HTTP navigation. No production
// app input, provider/extension calls, install, or OS foreground/keyboard.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {once} from 'node:events';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {build as bundle} from 'esbuild';import {_electron as electron} from 'playwright';import ts from 'typescript';
const noted=fileURLToPath(new URL('..',import.meta.url)),sc='/Users/fedor/Desktop/sc-desktop';
const artifact=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'noted-terminal-navigation-ui-')));
const report={artifact,checks:[],errors:[],console:[],source:{},pass:false,boundary:'Actual Noted Timeline/header/message rows, SC navigation binding/store/detail; private synthetic IO, actual HTTP/controller. No provider/production/OS input. Not whole app initialization.'};
let app;
const check=(name,value,evidence)=>{report.checks.push({name,pass:!!value,evidence});assert.ok(value,name)};
const astBlock=(source,name)=>{const ast=ts.createSourceFile('actual.js',source,ts.ScriptTarget.Latest,true);let found;
const walk=n=>{if(ts.isIfStatement(n)&&n.expression.getText(ast).includes("url.pathname === '"+name+"'"))found=n;ts.forEachChild(n,walk)};walk(ast);assert.ok(found,name);return found.getText(ast)};
function main(config){
  const {app,BrowserWindow,ipcMain,session}=require('electron'),http=require('node:http'),vm=require('node:vm');
  const {createResearchNavigation}=require(config.scController),{ScExternalResearchClient}=require(config.notedClient);
  app.setPath('userData',config.profile);app.setActivationPolicy?.('accessory');
  const state=global.navState={calls:[],unknown:[],forbidden:[],focus:[],holdDetails:true,reads:[],acks:[]};
  const jobId='noted_exact-job';
  const jobs=[{jobId,kind:'research',provider:'chatgpt',modelId:'6-astra',mode:'Chat',status:'done',stage:'done',updatedAt:10,
    fullPrompt:'Review the exact source.',responseText:'EXACT SAVED REVIEW\n\n'+'Reviewed source. '.repeat(80),
    inputFiles:Array.from({length:9},(_,i)=>({name:'source-'+i+'.js',path:'/synthetic/source-'+i+'.js'}))},
    {jobId:'noted_wrong-job',kind:'research',provider:'chatgpt',modelId:'6-astra',status:'done',updatedAt:9,responseText:'WRONG REVIEW'}];
  let scWindow,notedWindow;
  const nav=createResearchNavigation({readJob:id=>jobs.find(j=>j.jobId===id),getWindow:()=>({
    isDestroyed:()=>scWindow.isDestroyed(),isMinimized:()=>false,
    show:()=>state.focus.push('show'),focus:()=>state.focus.push('focus'),webContents:scWindow.webContents,
  })});
  const handler=vm.runInNewContext('(async(req,res,url)=>{'+config.capBlock+config.openBlock+'res.writeHead(404);res.end();})',{
    researchNavigation:nav,readBody:async req=>{let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text)},
    sendJson:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},
  });
  const server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost')).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}))}));
  const detailWaiters=[];
  global.releaseDetails=()=>{state.holdDetails=false;detailWaiters.splice(0).forEach(fn=>fn())};
  ipcMain.handle('fixture:sc-api',async(_event,{name,args})=>{
    state.calls.push('sc:'+name);
    if(name==='researchOpenReady')return nav.ready(scWindow.webContents.id);
    if(name==='researchOpenAck'){state.acks.push(args[0]);return nav.acknowledge(scWindow.webContents.id,args[0])}
    if(name==='aistudioListJobs'){
      const options=args[0]||{};state.reads.push(options);
      if(options.full&&state.holdDetails)await new Promise(resolve=>detailWaiters.push(resolve));
      return{jobs:jobs.filter(j=>!options.jobId||j.jobId===options.jobId).map(j=>options.full?j:{...j,responseText:undefined,fullPrompt:undefined})};
    }
    if(name==='aistudioClearJob')return{ok:true};
    state.forbidden.push('sc:'+name);throw Error('Forbidden SC API '+name);
  });
  ipcMain.handle('fixture:invoke',async(_event,{channel,args})=>{
    state.calls.push('noted:'+channel);
    if(channel==='orchestration:open-research-job')return global.openRun(args[0].runId);
    if(/^(agent:(send|stop)|codex:(send|run)|terminal:(create|kill|restart|input|paste))/.test(channel)){
      state.forbidden.push(channel);throw Error('Forbidden private transport '+channel);
    }
    if(channel==='app:getState'||channel==='codex:get-runtime-projection')return null;
    if(channel==='app:setState')return{success:true};
    if(channel==='timeline:get-notes')return{success:true,notes:{},positions:{}};
    if(channel==='timeline:get-rewind-markers'||channel==='project:getGroups')return[];
    if(channel==='timeline:get-session-history-events')return{events:[]};
    if(channel==='terminal:getCommandStates')return{};
    if(channel==='terminal:getCommandState')return null;
    if(channel==='terminal:hasRunningProcess')return{isRunning:false};
    if(channel==='file:exists-batch')return Object.fromEntries(args[0].map(p=>[p,false]));
    if(/timeline-(prompt-summaries|outline|turn-action-overrides):get/.test(channel))return null;
    state.unknown.push(channel);return null;
  });
  app.whenReady().then(async()=>{
    app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((req,done)=>done({cancel:!/^(file:|data:|blob:)/.test(req.url)}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=new ScExternalResearchClient({baseUrl:'http://127.0.0.1:'+server.address().port});
    global.openRun=vm.runInNewContext(config.openRun+'\nopenExternalResearchJob',{
      crypto:require('node:crypto'),getOrchestrationRunStore:()=>({get:async id=>id==='exact-run'?{runKind:'external-research',externalResearchJobId:jobId}:null}),
      getScExternalResearchClient:()=>client,
    });
    const prefs={offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false};
    notedWindow=new BrowserWindow({show:false,focusable:false,frame:false,width:500,height:900,webPreferences:{...prefs,preload:config.notedPreload}});
    scWindow=new BrowserWindow({show:false,focusable:false,frame:false,width:1400,height:900,webPreferences:{...prefs,preload:config.scPreload}});
    global.navWindows={noted:notedWindow,sc:scWindow};
    global.captureNav=(kind,file)=>new Promise((resolve,reject)=>{
      const win=global.navWindows[kind];let timer,lastHash=null,stable=0,attempts=0;
      const done=error=>{clearTimeout(timer);win.webContents.removeListener('paint',paint);error?reject(error):resolve(true)};
      const paint=(_e,_dirty,image)=>{
        const png=image.toPNG();
        if(kind==='sc'){
          const hash=require('crypto').createHash('sha256').update(png).digest('hex');
          stable=hash===lastHash?stable+1:0;lastHash=hash;attempts++;
          if(stable<2){if(attempts>=8)return done(Error('Native detail paints did not stabilize'));win.webContents.invalidate();return}
        }
        require('fs').writeFileSync(file,png);done();
      };
      timer=setTimeout(()=>done(Error('Native paint deadline')),3000);win.webContents.on('paint',paint);win.webContents.invalidate();
    });
    for(const win of [notedWindow,scWindow])win.webContents.on('paint',()=>{});
    await scWindow.loadFile(config.scHtml);await notedWindow.loadFile(config.notedHtml);
  });
  app.on('window-all-closed',()=>{nav.dispose();server.close();app.quit()});
}
try{
  const notedSnap=path.join(artifact,'noted'),scSnap=path.join(artifact,'sc');
  for(const [repo,snapshot,files]of [[noted,notedSnap,['src','packages/claude-blocks','scripts/lib','scripts/fixtures/terminal-navigation-ui.tsx']],
    [sc,scSnap,['src','electron/research-navigation.js','scripts/fixtures/research-navigation-ui.jsx','vite.config.js']]]){
    for(const file of files)await fs.cp(path.join(repo,file),path.join(snapshot,file),{recursive:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
    await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  }
  const shared=path.join(artifact,'noted-shared/packages');
  for(const name of ['structured-dnd','file-explorer'])await fs.cp(path.join(noted,'../noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p=>!p.includes('/node_modules')});
  const output=path.join(artifact,'noted-ui');await fs.mkdir(output);
  await bundle({entryPoints:[path.join(notedSnap,'scripts/fixtures/terminal-navigation-ui.tsx')],bundle:true,outfile:path.join(output,'bundle.js'),platform:'browser',format:'esm',jsx:'automatic',target:'chrome120',logLevel:'silent',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
    alias:{'@noted/claude-blocks':path.join(notedSnap,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),
      '@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(noted,'node_modules/react'),'react-dom':path.join(noted,'node_modules/react-dom')},
    loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl','.png':'file'}});
  await fs.mkdir(path.join(output,'styles'));await fs.cp(path.join(noted,'build-resources/assets/fonts'),path.join(output,'assets/fonts'),{recursive:true});
  execFileSync(path.join(noted,'node_modules/.bin/tailwindcss'),['-i',path.join(notedSnap,'src/renderer/styles/globals.css'),'-o',path.join(output,'styles/globals.css'),'--minify'],{cwd:notedSnap,stdio:'pipe'});
  await fs.writeFile(path.join(output,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="styles/globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#181818;overflow:hidden}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  const scHtml=path.join(scSnap,'fixture.html');await fs.writeFile(scHtml,'<meta charset="utf-8"><div id="root" style="height:100vh;background:#09090b"></div><script type="module" src="/scripts/fixtures/research-navigation-ui.jsx"></script>');
  const vite=await import(path.join(sc,'node_modules/vite/dist/node/index.js'));
  await vite.build({root:scSnap,configFile:path.join(scSnap,'vite.config.js'),logLevel:'error',build:{outDir:path.join(artifact,'sc-ui'),rollupOptions:{input:scHtml}}});
  const bridge=await fs.readFile(path.join(sc,'electron/browser-bridge.js'),'utf8'),web=await fs.readFile(path.join(noted,'src/main/web-server.js'),'utf8');
  const webAst=ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true),openRun=webAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='openExternalResearchJob').getText(webAst);
  const profile=path.join(artifact,'profile'),notedPreload=path.join(artifact,'noted-preload.cjs'),scPreload=path.join(artifact,'sc-preload.cjs');await fs.mkdir(profile);
  await fs.writeFile(notedPreload,"const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});");
  await fs.writeFile(scPreload,"const{ipcRenderer}=require('electron');window.api={onAistudioUpdate:()=>()=>{},onResearchOpenRequest:fn=>{const h=(_e,p)=>fn(p);ipcRenderer.on('research:open-job-request',h);return()=>ipcRenderer.removeListener('research:open-job-request',h)}};for(const name of ['aistudioListJobs','researchOpenReady','researchOpenAck','aistudioClearJob'])window.api[name]=(...args)=>ipcRenderer.invoke('fixture:sc-api',{name,args});");
  const config={profile,notedPreload,scPreload,notedHtml:path.join(output,'index.html'),scHtml:path.join(artifact,'sc-ui/fixture.html'),
    scController:path.join(scSnap,'electron/research-navigation.js'),notedClient:path.join(noted,'src/main/sc-external-research-client.js'),openRun,
    capBlock:astBlock(bridge,'/research-capabilities'),openBlock:astBlock(bridge,'/research-open')};
  await fs.writeFile(path.join(artifact,'main.cjs'),'('+main.toString()+')('+JSON.stringify(config)+');');
  const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.join(noted,'node_modules/.bin/electron'),args:[path.join(artifact,'main.cjs')],env,cwd:artifact,timeout:20000});report.pid=app.process().pid;
  const pages=await app.windows();let notedPage,scPage;
  for(const page of pages){page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')report.console.push(m.text())});await page.waitForURL(/file:/);if((await page.url()).includes('noted-ui'))notedPage=page;else scPage=page;}
  if(!notedPage){notedPage=await app.waitForEvent('window');notedPage.setDefaultTimeout(10000)}
  await notedPage.waitForFunction(()=>window.navigationFixture?.ready);
  await notedPage.locator('[data-timeline-entry-uuid="entry-2"]').waitFor();
  const capture=(kind,label)=>app.evaluate((_e,{kind,file})=>global.captureNav(kind,file),{kind,file:path.join(artifact,label+'.png')});
  const colors=['rgb(161, 161, 170)','rgb(96, 165, 250)','rgb(74, 222, 128)','rgb(251, 191, 36)','rgb(248, 113, 113)'];
  for(const width of [350,500,1100]){
    await app.evaluate((_e,width)=>global.navWindows.noted.setSize(width,900),width);
    await notedPage.waitForFunction(width=>innerWidth===width,width);
    const header=notedPage.locator('[data-timeline-entry-uuid="entry-2"]');
    const rail=header.locator('xpath=ancestor::*[@data-timeline-root]').first();
    const widthBefore=await header.evaluate(e=>e.getBoundingClientRect().width);
    check(width+' collapsed group hides children',await notedPage.locator('[data-timeline-entry-uuid="entry-3"]').count()===0);
    for(const count of [9,10,100,1000,10000]){
      const geometry=await notedPage.locator('[data-timeline-group-count]').first().evaluate((e,count)=>{
        e.textContent=String(count);const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();
        return{left:r.left,right:r.right,parentLeft:p.left,parentRight:p.right,scrollWidth:e.scrollWidth,width:r.width};
      },count);
      check(width+' count typography boundary '+count,geometry.left>=geometry.parentLeft&&geometry.right<=geometry.parentRight&&geometry.scrollWidth<=geometry.width+1,geometry);
    }
    await notedPage.locator('[data-timeline-group-count]').first().evaluate(e=>{e.textContent='10'});
    await header.click();await notedPage.locator('[data-timeline-entry-uuid="entry-11"]').waitFor();
    const rows=await notedPage.locator('[data-timeline-entry-uuid^="entry-"]').evaluateAll(nodes=>nodes.filter(n=>/entry-(?:[2-9]|10|11)$/.test(n.getAttribute('data-timeline-entry-uuid'))).map(n=>({id:n.getAttribute('data-timeline-entry-uuid'),...n.getBoundingClientRect().toJSON()})));
    check(width+' group unrolls down with unchanged rail width',rows.length===10&&rows.every(r=>Math.abs(r.width-widthBefore)<1)&&rows.slice(1).every((r,i)=>r.top>rows[i].top),rows);
    check(width+' group click does not set wide mode',await notedPage.evaluate(()=>window.navigationFixture.tree())===false);
    check(width+' group header is separate from its first real iteration',await notedPage.locator('[data-timeline-group-toggle][aria-expanded="true"]').count()===1
      &&await notedPage.locator('[data-timeline-entry-uuid="entry-2"]').count()===1);
    check(width+' SC leaf is a loaded app icon rather than a diamond',await notedPage.locator('[data-timeline-entry-uuid="entry-3"] [data-timeline-sc-desktop]').evaluate(e=>e.complete&&e.naturalWidth===32&&e.getBoundingClientRect().width===14));
    check(width+' normal MCP leaf retains its own type',await notedPage.locator('[data-timeline-entry-uuid="entry-4"]').getAttribute('data-timeline-marker-kind')==='terminal-mcp');
    const iconBox=await notedPage.locator('[data-timeline-sc-desktop]').first().boundingBox();
    const extras=await notedPage.locator('[data-timeline-entry-uuid="entry-3"] [data-timeline-badge-flow] svg').evaluateAll(nodes=>nodes.map(e=>e.getBoundingClientRect().toJSON()));
    check(width+' SC icon and metadata badges do not overlap',extras.every(b=>b.bottom<=iconBox.y||b.top>=iconBox.y+iconBox.height||b.right<=iconBox.x||b.left>=iconBox.x+iconBox.width));
    await capture('noted','group-open-'+width);
    await notedPage.locator('[data-timeline-group-collapse]').click();
    await notedPage.waitForFunction(()=>!document.querySelector('[data-timeline-entry-uuid="entry-3"]'));
    check(width+' collapse preserves narrow mode',await notedPage.evaluate(()=>window.navigationFixture.tree())===false);
    for(let i=0;i<5;i++)check(width+' delivery palette '+i,await notedPage.locator('[data-tab-message-row="message-'+i+'"] [data-tab-message-stage="send"]').evaluate(e=>getComputedStyle(e).color)===colors[i]);
    await capture('noted','palette-'+width);
  }
  const link=notedPage.locator('[data-external-research-source="exact-run"]');
  await link.click();await scPage.locator('[data-research-job-id="noted_exact-job"]').waitFor();
  check('exact SC detail opens instead of the same-label other job',await scPage.locator('[data-research-job-id="noted_wrong-job"]').count()===0);
  check('pending full hydration cannot produce a successful navigation ACK',await app.evaluate(()=>global.navState.acks.length)===0);
  check('Noted remains pending until SC view is loaded',await link.isDisabled());
  await app.evaluate(()=>global.releaseDetails());await notedPage.waitForFunction(()=>!document.querySelector('[data-external-research-source]').disabled);
  const state=await app.evaluate(()=>global.navState);report.state=state;
  check('exact rendered SC ACK completes the source action',state.acks.some(a=>a.jobId==='noted_exact-job'&&a.success===true));
  check('window reveal/focus commanded without a browser/provider action',state.focus.join(',')==='show,focus'&&state.forbidden.length===0);
  check('all private IO is declared',state.unknown.length===0,state.unknown);
  check('the saved answer is hydrated in the exact task page',(await scPage.locator('body').innerText()).includes('EXACT SAVED REVIEW'));
  await scPage.evaluate(()=>new Promise((resolve,reject)=>{
    let first,second;
    const timer=setTimeout(()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);reject(Error('Detail frame deadline'))},2000);
    first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)})});
  }));
  await capture('sc','research-job');
  await scPage.screenshot({path:path.join(artifact,'research-job-cdp.png')});
  check('full prompt and answer survive the native capture',(await scPage.locator('body').innerText()).includes('EXACT SAVED REVIEW')
    && (await scPage.locator('body').innerText()).includes('Review the exact source.'));
  check('no private renderer errors',report.errors.length===0&&report.console.length===0,{errors:report.errors,console:report.console});
  report.pass=true;
}catch(error){report.error=error.stack||String(error);throw error}
finally{
  if(app){const child=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Private close deadline')),5000)})])}
    catch(e){report.closeWarning=String(e);if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit',{signal:AbortSignal.timeout(5000)});child.kill('SIGKILL');await exit}}
    finally{clearTimeout(timer);report.closed=child.exitCode!==null||child.signalCode!==null}}
  await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});report.profileRemoved=true;
  await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({artifact,pass:report.pass,checks:report.checks.length,error:report.error}));
}

#!/usr/bin/env node
// Two private renderers, actual components/store/HTTP navigation. No production
// app input, provider/extension calls, install, or OS foreground/keyboard.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {once} from 'node:events';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {build as bundle} from 'esbuild';import {_electron as electron} from 'playwright';import ts from 'typescript';
const noted=fileURLToPath(new URL('..',import.meta.url)),sc='/Users/example/Desktop/sc-desktop';
const trackerOnly=process.argv.includes('--tracker-only');
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
  const state=global.navState={calls:[],unknown:[],forbidden:[],focus:[],holdDetails:true,reads:[],acks:[],navigationResults:[]};
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
    if(channel==='orchestration:open-research-job'){
      const result=await global.openRun(args[0].runId);
      state.navigationResults.push({runId:args[0].runId,...result});return result;
    }
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
        const hash=require('crypto').createHash('sha256').update(png).digest('hex');
        stable=hash===lastHash?stable+1:0;lastHash=hash;attempts++;
        if(stable<2){if(attempts>=8)return done(Error('Native paints did not stabilize: '+kind));win.webContents.invalidate();return}
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
  for(const file of ['src/renderer/components/Workspace/Timeline.tsx','src/renderer/components/Workspace/TabMessageSourceChip.tsx',
    'src/renderer/components/Workspace/TabMessageSourceChip.css','src/renderer/components/Workspace/OrchestrationStatusChip.tsx',
    'scripts/fixtures/terminal-navigation-ui.tsx']){
    report.source[file]=createHash('sha256').update(await fs.readFile(path.join(notedSnap,file))).digest('hex');
  }
  const shared=path.join(artifact,'noted-shared/packages');
  for(const name of ['structured-dnd','file-explorer'])await fs.cp(path.join(noted,'vendor/noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p=>!p.includes('/node_modules')});
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
  const capture=async(kind,label)=>{
    await (kind==='noted'?notedPage:scPage).evaluate(()=>new Promise((resolve,reject)=>{
      let first,second;const timer=setTimeout(()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);reject(Error('Frame deadline'))},2000);
      first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)})});
    }));
    return app.evaluate((_e,{kind,file})=>global.captureNav(kind,file),{kind,file:path.join(artifact,label+'.png')});
  };
  const colors=['rgb(161, 161, 170)','rgb(96, 165, 250)','rgb(74, 222, 128)','rgb(251, 191, 36)','rgb(248, 113, 113)'];
  for(const width of (trackerOnly?[]:[350,500,1100])){
    await app.evaluate((_e,width)=>global.navWindows.noted.setSize(width,900),width);
    await notedPage.waitForFunction(width=>innerWidth===width,width);
    for(const phase of ['question','reply']){
      const source=notedPage.locator('[data-source-hover-case="'+phase+'"]');
      const arrow=source.locator('[data-tab-message-source-jump]'),name=source.locator('[data-tab-message-source]');
      const presentation=()=>source.evaluate(e=>{
        const arrow=e.querySelector('[data-tab-message-source-jump]'),name=e.querySelector('[data-tab-message-source]');
        const css=getComputedStyle(arrow);
        return{background:css.backgroundColor,color:css.color,outline:css.outlineStyle,
          focused:document.activeElement===arrow,nameBackground:getComputedStyle(name).backgroundColor,
          trustedPress:arrow.dataset.fixtureTrustedPress==='1',
          rects:[e,arrow,name].map(n=>n.getBoundingClientRect().toJSON())};
      });
      await notedPage.mouse.move(100,880);
      const rest=await presentation();
      check(width+' '+phase+' arrow has its own resting background',rest.background==='rgba(167, 139, 250, 0.1)'
        &&rest.rects[1].width===24&&rest.rects[1].height===24,rest);
      await capture('noted','source-rest-'+phase+'-'+width);
      await arrow.hover();
      const hovered=await presentation();
      check(width+' '+phase+' arrow hover visibly changes only its surface',hovered.background==='rgba(167, 139, 250, 0.28)'
        &&hovered.color!==rest.color&&hovered.nameBackground===rest.nameBackground
        &&JSON.stringify(hovered.rects)===JSON.stringify(rest.rects),{rest,hovered});
      await capture('noted','source-hover-'+phase+'-'+width);
      await arrow.evaluate(e=>e.addEventListener('mousedown',event=>{
        e.dataset.fixtureTrustedPress=event.isTrusted&&event.buttons===1?'1':'0';
      },{once:true}));
      await notedPage.mouse.down();
      const pressed=await presentation();
      check(width+' '+phase+' pressed arrow remains in its fixed slot',pressed.trustedPress&&pressed.background==='rgba(167, 139, 250, 0.38)'
        &&JSON.stringify(pressed.rects)===JSON.stringify(rest.rects),pressed);
      await notedPage.mouse.move(100,880);await notedPage.mouse.up();
      await name.focus();await notedPage.keyboard.press('Shift+Tab');
      const focused=await presentation();
      check(width+' '+phase+' keyboard focus has its own non-shifting highlight',focused.focused&&focused.outline==='solid'
        &&focused.background==='rgba(167, 139, 250, 0.28)'&&JSON.stringify(focused.rects)===JSON.stringify(rest.rects),focused);
      await notedPage.keyboard.press('Tab');
      check(width+' '+phase+' leaving the arrow restores its background',(await presentation()).background===rest.background);
      await name.evaluate(e=>e.blur());
    }
    const header=notedPage.locator('[data-timeline-entry-uuid="entry-2"]');
    const rail=header.locator('xpath=ancestor::*[@data-timeline-root]').first();
    const widthBefore=await header.evaluate(e=>e.getBoundingClientRect().width);
    check(width+' collapsed group hides children',await notedPage.locator('[data-timeline-entry-uuid="entry-3"]').count()===0);
    for(const count of [2,9,10,100,1000,10000]){
      await notedPage.evaluate(count=>window.navigationFixture.setGroupSize(count),count);
      await notedPage.waitForFunction(count=>document.querySelector('[data-timeline-group-count]')?.textContent===String(count),count);
      const geometry=await notedPage.locator('[data-timeline-group-count]').first().evaluate(e=>{
        const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect(),a=e.parentElement.querySelector('svg').getBoundingClientRect();
        return{left:r.left,right:r.right,parentLeft:p.left,parentRight:p.right,scrollWidth:e.scrollWidth,width:r.width,
          arrowRight:a.right,arrowCenter:a.top+a.height/2,countCenter:r.top+r.height/2};
      });
      check(width+' count and arrow share one line inside the rail '+count,geometry.left>=geometry.parentLeft&&geometry.right<=geometry.parentRight
        &&geometry.scrollWidth<=geometry.width+1&&geometry.arrowRight<=geometry.left&&Math.abs(geometry.arrowCenter-geometry.countCenter)<1,geometry);
      check(width+' group header has no child badges '+count,await notedPage.locator('[data-timeline-group-header] [data-timeline-badge-flow]').count()===0
        &&await notedPage.locator('[data-timeline-group-header] svg').count()===1);
      if(count===2){
        await capture('noted','group-two-'+width);
        await notedPage.screenshot({path:path.join(artifact,'group-two-'+width+'-cdp.png')});
        check(width+' exact two-entry header survives native capture',await notedPage.locator('[data-timeline-group-count]').first().textContent()==='2');
      }
    }
    await notedPage.evaluate(()=>window.navigationFixture.setGroupSize(10));
    await notedPage.waitForFunction(()=>document.querySelector('[data-timeline-group-count]')?.textContent==='10');
    await header.click();await notedPage.locator('[data-timeline-entry-uuid="entry-11"]').waitFor();
    const rows=await notedPage.locator('[data-timeline-entry-uuid^="entry-"]').evaluateAll(nodes=>nodes.filter(n=>/entry-(?:[2-9]|10|11)$/.test(n.getAttribute('data-timeline-entry-uuid'))).map(n=>({id:n.getAttribute('data-timeline-entry-uuid'),...n.getBoundingClientRect().toJSON()})));
    check(width+' group unrolls down with unchanged rail width',rows.length===10&&rows.every(r=>Math.abs(r.width-widthBefore)<1)&&rows.slice(1).every((r,i)=>r.top>rows[i].top),rows);
    check(width+' group click does not set wide mode',await notedPage.evaluate(()=>window.navigationFixture.tree())===false);
    check(width+' group header is separate from its first real iteration',await notedPage.locator('[data-timeline-group-toggle][aria-expanded="true"]').count()===1
      &&await notedPage.locator('[data-timeline-entry-uuid="entry-2"]').count()===1);
    const guides=await notedPage.locator('[data-timeline-group-guide]').evaluateAll(nodes=>nodes.map(e=>({...e.getBoundingClientRect().toJSON(),pointerEvents:getComputedStyle(e).pointerEvents})));
    check(width+' child guide is continuous including the note strip',guides.length===11&&guides.every(g=>g.width===1&&g.height>0&&g.pointerEvents==='none')
      &&guides.slice(1).every((g,i)=>Math.abs(g.top-guides[i].bottom)<1&&g.left===guides[i].left),guides);
    const centers=await notedPage.locator('[data-timeline-group-child]').evaluateAll(nodes=>nodes.map(e=>{
      const marker=e.querySelector('[data-timeline-sc-desktop]')||e.querySelector(':scope > .shrink-0'),r=marker.getBoundingClientRect();
      return r.left+r.width/2;
    }));
    const ordinaryCenter=await notedPage.locator('[data-timeline-entry-uuid="entry-1"] > .shrink-0').evaluate(e=>{const r=e.getBoundingClientRect();return r.left+r.width/2});
    check(width+' MCP and SC children share the same left-of-axis column',centers.length===10&&centers.every(x=>Math.abs(x-ordinaryCenter+2)<1),{centers,ordinaryCenter});
    const openRow=await notedPage.locator('[data-timeline-group-toggle]').evaluate(e=>{
      const a=e.querySelector('svg').getBoundingClientRect(),c=e.querySelector('[data-timeline-group-count]').getBoundingClientRect();
      return{arrow:a.toJSON(),count:c.toJSON()};
    });
    check(width+' expanded disclosure remains one row',Math.abs(openRow.arrow.top+openRow.arrow.height/2-openRow.count.top-openRow.count.height/2)<1,openRow);
    check(width+' SC leaf is a loaded app icon rather than a diamond',await notedPage.locator('[data-timeline-entry-uuid="entry-3"] [data-timeline-sc-desktop]').evaluate(e=>e.complete&&e.naturalWidth===32));
    const scGlyph=notedPage.locator('[data-timeline-entry-uuid="entry-3"] [data-timeline-sc-desktop]');
    const mcpGlyph=notedPage.locator('[data-timeline-entry-uuid="entry-4"] > .shrink-0');
    const sameSize=async()=>{
      const s=await scGlyph.boundingBox(),d=await mcpGlyph.boundingBox();
      return{same:Math.abs(s.width-d.width)<0.03&&Math.abs(s.height-d.height)<0.03,sc:s,diamond:d};
    };
    const resting=await sameSize();check(width+' resting SC glyph matches the rotated diamond size',resting.same,resting);
    const rowBefore=await scGlyph.locator('xpath=..').evaluate(e=>({slot:e.getBoundingClientRect().toJSON(),row:e.parentElement.getBoundingClientRect().toJSON()}));
    await notedPage.locator('[data-timeline-entry-uuid="entry-3"]').hover();
    await notedPage.waitForFunction(()=>Math.abs(document.querySelector('[data-timeline-sc-desktop]').getBoundingClientRect().width-10*Math.SQRT2)<0.03);
    const hoveredSc=await scGlyph.boundingBox();
    await capture('noted','sc-hover-'+width);
    await notedPage.locator('[data-timeline-entry-uuid="entry-4"]').hover();
    await notedPage.waitForFunction(()=>{
      const e=document.querySelector('[data-timeline-entry-uuid="entry-4"] > .shrink-0');
      return e&&Math.abs(e.getBoundingClientRect().width-10*Math.SQRT2)<0.03;
    });
    const hoveredDiamond=await mcpGlyph.boundingBox();
    check(width+' SC hover glyph matches diamond hover size',Math.abs(hoveredSc.width-hoveredDiamond.width)<0.03&&Math.abs(hoveredSc.height-hoveredDiamond.height)<0.03,{sc:hoveredSc,diamond:hoveredDiamond});
    const rowAfter=await scGlyph.locator('xpath=..').evaluate(e=>({slot:e.getBoundingClientRect().toJSON(),row:e.parentElement.getBoundingClientRect().toJSON()}));
    check(width+' SC glyph resizing keeps its slot and row stable',JSON.stringify(rowBefore)===JSON.stringify(rowAfter),{before:rowBefore,after:rowAfter});
    await notedPage.mouse.move(100,10);
    await notedPage.waitForFunction(()=>{
      const s=document.querySelector('[data-timeline-sc-desktop]'),d=document.querySelector('[data-timeline-entry-uuid="entry-4"] > .shrink-0');
      return s&&d&&Math.abs(s.getBoundingClientRect().width-d.getBoundingClientRect().width)<0.25;
    });
    check(width+' normal MCP leaf retains its own type',await notedPage.locator('[data-timeline-entry-uuid="entry-4"]').getAttribute('data-timeline-marker-kind')==='terminal-mcp');
    const iconBox=await notedPage.locator('[data-timeline-sc-desktop]').first().boundingBox();
    const extras=await notedPage.locator('[data-timeline-entry-uuid="entry-3"] [data-timeline-badge-flow] svg').evaluateAll(nodes=>nodes.map(e=>e.getBoundingClientRect().toJSON()));
    check(width+' SC icon and metadata badges do not overlap',extras.every(b=>b.bottom<=iconBox.y||b.top>=iconBox.y+iconBox.height||b.right<=iconBox.x||b.left>=iconBox.x+iconBox.width));
    await capture('noted','group-open-'+width);
    await notedPage.locator('[data-timeline-group-collapse]').click();
    await notedPage.waitForFunction(()=>!document.querySelector('[data-timeline-entry-uuid="entry-3"]'));
    check(width+' collapse preserves narrow mode',await notedPage.evaluate(()=>window.navigationFixture.tree())===false);
    check(width+' collapse removes only the child guide',await notedPage.locator('[data-timeline-group-guide]').count()===0);
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
  await notedPage.evaluate(()=>window.navigationFixture.showTracker());
  // Freeze only the existing spinner for deterministic still captures.
  await notedPage.addStyleTag({content:'[data-orchestration-status] .noted-infinite-animation { animation-play-state: paused !important; }'});
  for(const width of [350,500,1100]){
    await app.evaluate((_e,width)=>global.navWindows.noted.setSize(width,900),width);
    await notedPage.waitForFunction(width=>innerWidth===width,width);
    const chip=notedPage.locator('button[data-orchestration-external-target]');
    await chip.waitFor({state:'visible'});
    const box=await chip.boundingBox();
    check(width+' running SC tracker is a bounded navigation button',box.width>0&&box.x>=0&&box.x+box.width<=width
      &&(await chip.getAttribute('aria-label')).includes('SC Desktop'),box);
    const beforeAck=await app.evaluate(()=>global.navState.navigationResults.length);
    const beforeOpen=await notedPage.evaluate(()=>window.navigationFixture.calls.filter(c=>c==='orchestration:open-research-job').length);
    await chip.click();
    await notedPage.waitForFunction(n=>window.navigationFixture.calls.filter(c=>c==='orchestration:open-research-job').length===n+1
      &&document.querySelector('[data-orchestration-external-target]')?.getAttribute('aria-busy')==='false',beforeOpen);
    const afterOpen=await app.evaluate(()=>global.navState);report.state=afterOpen;
    check(width+' tracker click opens and commits the same saved SC task',afterOpen.navigationResults.length===beforeAck+1
      &&afterOpen.navigationResults.at(-1).jobId==='noted_exact-job'&&afterOpen.navigationResults.at(-1).success===true,
      {acks:afterOpen.acks,navigationResults:afterOpen.navigationResults});
    await capture('noted','sc-tracker-'+width);
    await notedPage.locator('[data-orchestration-history-button]').click();
    const disclosure=notedPage.locator('[data-orchestration-run-id="exact-run"] button[aria-expanded]');
    if(await disclosure.getAttribute('aria-expanded')!=='true')await disclosure.click();
    const detail=notedPage.locator('[data-orchestration-run-details="exact-run"]');
    const detailAck=await app.evaluate(()=>global.navState.navigationResults.length);
    const receiptBefore=await notedPage.evaluate(()=>window.navigationFixture.calls.filter(c=>c==='orchestration:acknowledge').length);
    await detail.getByRole('button',{name:'Открыть задачу в SC Desktop',exact:true}).click();
    await notedPage.waitForFunction(n=>window.navigationFixture.calls.filter(c=>c==='orchestration:acknowledge').length===n+1,receiptBefore);
    await detail.waitFor({state:'hidden'});
    const detailState=await app.evaluate(()=>global.navState);report.state=detailState;
    check(width+' request history detail also opens the exact SC task',detailState.navigationResults.length===detailAck+1
      &&detailState.navigationResults.at(-1).jobId==='noted_exact-job'&&detailState.navigationResults.at(-1).success===true,
      detailState.navigationResults);
  }
  for(const width of [350,500,1100]){
    await app.evaluate((_e,width)=>global.navWindows.noted.setSize(width,900),width);
    await notedPage.waitForFunction(width=>innerWidth===width,width);
    await notedPage.evaluate(()=>window.navigationFixture.showObserver());
    const row=notedPage.locator('[data-orchestration-active-run="observed-run"]');
    await row.waitFor({state:'visible'});
    const bounds=await row.boundingBox();
    check(width+' passive wait has a static indicator within the request strip',bounds.x>=0&&bounds.x+bounds.width<=width
      &&await row.locator('.noted-infinite-animation').count()===0,bounds);
    await capture('noted','response-wait-'+width);
    const before=await notedPage.evaluate(()=>window.navigationFixture.actions.length);
    await row.hover();
    await notedPage.locator('[data-orchestration-action="detach"][data-orchestration-run-id="observed-run"]').click();
    await row.waitFor({state:'hidden'});
    const actions=await notedPage.evaluate(()=>window.navigationFixture.actions);
    check(width+' cancel detaches only the wait',actions.length===before+1&&actions.at(-1).runId==='observed-run'
      &&actions.at(-1).action==='detach'&&actions.at(-1).cancelSendAccepted===false,actions.at(-1));
  }
  const finalNav=await app.evaluate(()=>global.navState);
  check('tracker navigation does not create jobs or send provider input',finalNav.forbidden.length===0&&finalNav.unknown.length===0,finalNav.unknown);
  check('no private renderer errors',report.errors.length===0&&report.console.length===0,{errors:report.errors,console:report.console});
  for(const [file,hash]of Object.entries(report.source)){
    check('frozen source still matches '+file,createHash('sha256').update(await fs.readFile(path.join(noted,file))).digest('hex')===hash);
  }
  report.pass=true;
}catch(error){report.error=error.stack||String(error);throw error}
finally{
  if(app){const child=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Private close deadline')),5000)})])}
    catch(e){report.closeWarning=String(e);if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit',{signal:AbortSignal.timeout(5000)});child.kill('SIGKILL');await exit}}
    finally{clearTimeout(timer);report.closed=child.exitCode!==null||child.signalCode!==null}}
  await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});report.profileRemoved=true;
  await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({artifact,pass:report.pass,checks:report.checks.length,error:report.error}));
}

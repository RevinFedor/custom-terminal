#!/usr/bin/env node
// Private actual-component rendering; no production connection or OS input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-history-message-source-'));
const snapshot=path.join(artifact,'source'),shared=path.join(artifact,'shared');
const report={artifact,checks:[],runs:[],sourceHashes:{},pass:false,
  boundary:'Actual shared header/History/Virtuoso; synthetic IPC/placement, trusted private clicks/wheel; offscreen native captures, no production/provider/install.'};
let app;
const check=(name,pass,evidence) => {report.checks.push({name,pass:!!pass,evidence});assert.ok(pass,name);};
function privateMain(config) {
  const {app,BrowserWindow,ipcMain,session}=require('electron');
  app.setPath('userData',config.profile);app.setActivationPolicy?.('accessory');
  global.sourceFixtureState={unknown:[],forbidden:[],focus:0,console:[]};
  const s=global.sourceFixtureState;
  ipcMain.handle('fixture:invoke',(_event,{channel,args}) => {
    if (/^(terminal:(create|input|paste|kill|restart|stop)|claude-sdk:|codex:(run|send)|agent:(send|stop|rewind))/.test(channel)) {
      s.forbidden.push(channel);throw Error('Forbidden '+channel);
    }
    if (['app:getState','terminal:getCommandState','timeline:get-session-history-events','timeline-prompt-summaries:get',
      'timeline-outline:get','timeline-turn-action-overrides:get','claude:get-pending-question'].includes(channel)) return null;
    if (['timeline:get-notes','timeline:get-rewind-markers','project:getGroups'].includes(channel)) return [];
    if (['app:setState','history-preparation:subscribe','history-preparation:unsubscribe'].includes(channel)) return {success:true};
    if (channel==='agent:list-background-work') return {success:true,items:[]};
    if (channel==='agent:get-operational-phase') return {success:true,phase:null};
    if (channel==='terminal:getCommandStates') return {};
    if (channel==='terminal:hasRunningProcess') return {isRunning:false};
    if (channel==='file:exists-batch') return Object.fromEntries(args[0].map(p => [p,false]));
    if (channel==='prompt-queue:get-image-preview-data-url') return {success:false,error:'no synthetic images'};
    s.unknown.push(channel);throw Error('Unknown private IPC '+channel);
  });
  ipcMain.on('fixture:send',(_event,{channel}) => {
    if (['renderer:log','renderer:warn','renderer:error','perf:renderer-log','perf:ui-action'].includes(channel)) return;
    s.unknown.push('send:'+channel);
  });
  app.whenReady().then(() => {
    app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((request,done) => done({cancel:!/^(file:|data:|blob:)/.test(request.url)}));
    const win=global.sourceFixtureWindow=new BrowserWindow({show:false,focusable:false,frame:false,width:config.width,height:726,
      webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,preload:config.preload,backgroundThrottling:false}});
    win.on('focus',() => s.focus++);win.webContents.on('paint',() => {});
    win.webContents.on('console-message',(_event,level,message) => {if(level>=2)s.console.push(message);});
    global.captureSourceFixture=(file) => new Promise((resolve,reject) => {
      const finish=(error) => {clearTimeout(timer);win.webContents.removeListener('paint',paint);error?reject(error):resolve(true);};
      const paint=(_event,_dirty,image) => {require('fs').writeFileSync(file,image.toPNG());finish();};
      const timer=setTimeout(() => finish(Error('Native paint deadline')),3000);
      win.webContents.on('paint',paint);win.webContents.invalidate();
    });
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.loadFile(config.html,{query:{width:String(config.width)}});
  });
  app.on('window-all-closed',() => app.quit());
}
const cleanup=async(result) => {
  if (!app) return;
  const child=app.process();let timer;
  try {await Promise.race([app.close(),new Promise((_,reject) => {timer=setTimeout(() => reject(Error('Private close deadline')),5000);})]);}
  catch(error) {result.closeWarning=String(error);if(child.exitCode===null&&child.signalCode===null) {const stopped=once(child,'exit',{signal:AbortSignal.timeout(5000)});child.kill('SIGKILL');await stopped;}}
  finally {clearTimeout(timer);result.closed=child.exitCode!==null||child.signalCode!==null;app=null;}
  assert.equal(result.closed,true);await fs.rm(result.profile,{recursive:true,force:true});result.profileRemoved=true;
};
try {
  for(const name of ['src','packages/claude-blocks']) await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,filter:p => !p.includes('/node_modules')&&!p.includes('/.git')});
  for(const name of ['tailwind.config.ts','tailwind.config.cjs','postcss.config.js']) await fs.copyFile(path.join(repo,name),path.join(snapshot,name)).catch(e => {if(e.code!=='ENOENT')throw e;});
  for(const file of ['scripts/fixtures/history-message-source.tsx','scripts/lib/history-virtuoso-measurement.mjs']) {
    await fs.mkdir(path.dirname(path.join(snapshot,file)),{recursive:true});await fs.copyFile(path.join(repo,file),path.join(snapshot,file));
  }
  await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
  for(const name of ['structured-dnd','file-explorer']) await fs.cp(path.join(repo,'../noted-shared/packages',name),path.join(shared,name),{recursive:true,filter:p => !p.includes('/node_modules')});
  const {historyVirtuosoMeasurementEsbuildPlugin}=await import(pathToFileURL(path.join(snapshot,'scripts/lib/history-virtuoso-measurement.mjs')).href);
  const bundle=await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-message-source.tsx')],bundle:true,
    outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',jsx:'automatic',logLevel:'silent',metafile:true,
    plugins:[historyVirtuosoMeasurementEsbuildPlugin()],define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"DEV":false,"MODE":"test"}'},
    alias:{'@noted/claude-blocks':path.join(snapshot,'packages/claude-blocks/src'),'@noted/structured-dnd':path.join(shared,'structured-dnd/src'),
      '@noted/file-explorer':path.join(shared,'file-explorer/src'),react:path.join(repo,'node_modules/react'),'react-dom':path.join(repo,'node_modules/react-dom')},
    loader:{'.ttf':'file','.woff2':'file','.svg':'dataurl'}});
  for(const file of Object.keys(bundle.metafile.inputs)) {
    if(file.startsWith('<'))continue;const real=await fs.realpath(path.resolve(file)),relative=path.relative(snapshot,real);
    if(/^(src|packages|scripts)\//.test(relative)) report.sourceHashes[relative]=createHash('sha256').update(await fs.readFile(real)).digest('hex');
  }
  await fs.mkdir(path.join(artifact,'styles'));
  await fs.cp(path.join(repo,'build-resources/assets/fonts'),path.join(artifact,'assets/fonts'),{recursive:true});
  const fontPath='build-resources/assets/fonts/JetBrainsMonoNerdFont-Regular.ttf';
  report.sourceHashes[fontPath]=createHash('sha256').update(await fs.readFile(path.join(repo,fontPath))).digest('hex');
  execFileSync(path.join(repo,'node_modules/.bin/tailwindcss'),['-i',path.join(snapshot,'src/renderer/styles/globals.css'),'-o',path.join(artifact,'styles/globals.css'),'--minify'],{cwd:snapshot,stdio:'pipe'});
  await fs.writeFile(path.join(artifact,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="styles/globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc;overflow:hidden}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  for(const width of [350,500,1100]) {
    const result={width,profile:path.join(artifact,'profile-'+width),errors:[],console:[]};report.runs.push(result);
    await fs.mkdir(result.profile);
    const preload=path.join(artifact,'preload.cjs');
    await fs.writeFile(preload,"const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer),send=ipcRenderer.send.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});ipcRenderer.send=(channel,...args)=>send('fixture:send',{channel,args});");
    const main=path.join(artifact,'main-'+width+'.cjs');
    await fs.writeFile(main,'('+privateMain.toString()+')('+JSON.stringify({width,profile:result.profile,preload,html:path.join(artifact,'index.html')})+');');
    const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:result.profile};delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath:path.join(repo,'node_modules/.bin/electron'),args:[main],env,cwd:artifact,timeout:20000});result.pid=app.process().pid;
    let page;
    try {
      page=await app.firstWindow();page.setDefaultTimeout(12000);
      page.on('pageerror',e => result.errors.push(e.stack||e.message));page.on('console',m => {if(m.type()==='error')result.console.push(m.text());});
      const state=() => page.evaluate(() => JSON.parse(JSON.stringify(window.sourceJumpFixture.state)));
      const capture=async label => app.evaluate((_electron,file) => global.captureSourceFixture(file),path.join(artifact,width+'-'+label+'.png'));
      await page.waitForFunction(() => window.sourceJumpFixture?.state.ready);
      await page.locator('[data-history-viewport-ready="1"]').waitFor();await capture('before');
      const names=page.locator('[data-fixture-source-headers] [data-tab-message-source]');
      const arrow=page.locator('[data-tab-message-source-jump="question"]');
      await names.first().click();
      check(width+' name navigation without locator/seek/flash',(await state()).opens.length===1
        &&(await state()).calls.every(c => c.channel!=='tab-messages:source-location')&&(await state()).flashes.length===0);
      const geometry=await page.locator('[data-fixture-source-headers]').evaluate(node => [...node.querySelectorAll('button')].map(button => {
        const r=button.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,scroll:button.scrollWidth,client:button.clientWidth};}));
      check(width+' two separate controls fit long labels',geometry.length===4&&geometry.every(g => g.left>=0&&g.right<=width+1&&g.width>0&&g.scroll<=g.client+1),geometry);
      await arrow.click();await arrow.click();
      await page.waitForFunction(() => window.sourceJumpFixture.state.pendingLocate.length===2);
      await page.evaluate(() => window.sourceJumpFixture.releaseLocate(0));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(width+' old locator cannot seek',(await page.evaluate(() => window.sourceJumpFixture.ui())).generation===0);
      await page.evaluate(() => window.sourceJumpFixture.releaseLocate(1));
      await page.waitForFunction(() => window.sourceJumpFixture.state.pendingHydration.length>0);
      check(width+' no flash before hydration',(await state()).flashes.length===0);
      await page.evaluate(() => window.sourceJumpFixture.releaseHydration());
      await page.waitForFunction(() => window.sourceJumpFixture.state.flashes.length===1);
      await page.waitForFunction(() => document.querySelector('[data-history-tool-use-id="source-call:canonical:0"] .cb-tool-head')
        ?.getAnimations().some(animation => animation.id.startsWith('history-source:')
          &&Number(animation.effect?.getComputedTiming().progress)>=.18&&Number(animation.effect?.getComputedTiming().progress)<.3));
      await capture('arrived');
      const settled=await state(),flash=settled.flashes[0];
      check(width+' exact call visible after expansion',flash.toolUseId==='source-call:canonical:0'&&flash.uuid==='target-row'
        &&flash.top>=-1&&flash.bottom<=flash.client+1,flash);
      check(width+' flash after successful convergence',settled.done.some(d => d.found&&d.reason==='stable-source-tool'&&d.toolUseId===flash.toolUseId&&d.at>=flash.at));
      check(width+' preceding actual rect samples stable',settled.rects.filter(r => r.at<=flash.at).slice(-3).length===3
        &&Math.max(...settled.rects.filter(r => r.at<=flash.at).slice(-3).map(r => r.top))-Math.min(...settled.rects.filter(r => r.at<=flash.at).slice(-3).map(r => r.top))<1);
      const pixel=await app.evaluate(({nativeImage},{file,width,rect}) => {
        const image=nativeImage.createFromPath(file),size=image.getSize(),bytes=image.toBitmap(),scale=size.width/width;
        const x=Math.round((rect.right-8)*scale),y=Math.round((rect.top+(rect.bottom-rect.top)/2)*scale),i=(y*size.width+x)*4;
        return {r:bytes[i+2],g:bytes[i+1],b:bytes[i],a:bytes[i+3],x,y,size};
      },{file:path.join(artifact,width+'-arrived.png'),width,rect:flash.rect});
      check(width+' native blink is painted on the exact header',pixel.b>pixel.r+10&&pixel.g>pixel.r+4,pixel);
      await page.waitForFunction(() => window.sourceJumpFixture.state.flashes[0].finished);
      check(width+' quick single blink',(await state()).flashes.length===1&&flash.options.iterations===1&&flash.options.duration===500);
      await page.locator('[data-tab-message-source-jump="reply"]').click();
      await page.waitForFunction(() => window.sourceJumpFixture.state.pendingLocate.length===3);
      await names.last().click();await page.evaluate(() => window.sourceJumpFixture.releaseLocate(2));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(width+' name cancels pending arrow without late flash',(await state()).flashes.length===1);
      await arrow.click();await page.waitForFunction(() => window.sourceJumpFixture.state.pendingLocate.length===4);
      await page.evaluate(() => window.sourceJumpFixture.leave());await page.evaluate(() => window.sourceJumpFixture.releaseLocate(3));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(width+' leaving placement cancels delayed result',(await state()).flashes.length===1);
      await arrow.click();await page.waitForFunction(() => window.sourceJumpFixture.state.pendingLocate.length===5);
      await page.keyboard.press('Escape');await page.evaluate(() => window.sourceJumpFixture.releaseLocate(4));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(width+' Escape cancels without blink',(await state()).flashes.length===1);
      await page.evaluate(() => {window.sourceJumpFixture.state.foreignSession=true;});
      await arrow.click();await page.waitForFunction(() => window.sourceJumpFixture.state.pendingLocate.length===6);
      await page.evaluate(() => window.sourceJumpFixture.releaseLocate(5));
      await page.waitForFunction(() => window.sourceJumpFixture.ui().toasts.length>0);
      check(width+' changed read owner does not flash',(await state()).flashes.length===1
        &&(await state()).done.some(d => !d.found&&d.reason==='source-session-changed'));
      await page.evaluate(() => {window.sourceJumpFixture.state.foreignSession=false;window.sourceJumpFixture.state.holdLocate=false;});
      await page.locator('[data-tab-message-source-jump="reply"]').click();
      await page.waitForFunction(() => window.sourceJumpFixture.state.flashes.length===2);
      const replyFlash=(await state()).flashes[1];
      check(width+' reply jumps to its own MCP call',replyFlash.toolUseId==='reply-call:canonical:0'&&replyFlash.uuid==='reply-row'
        &&replyFlash.top>=-1&&replyFlash.bottom<=replyFlash.client+1,replyFlash);
      await page.waitForFunction(() => window.sourceJumpFixture.state.flashes[1].finished);
      await arrow.click();await page.waitForFunction(() => window.sourceJumpFixture.state.flashes.length===3);
      await page.waitForFunction(() => window.sourceJumpFixture.state.flashes[2].finished);
      check(width+' repeat completed request gets one new blink',(await state()).flashes.length===3);
      await page.evaluate(() => {window.sourceJumpFixture.state.holdLocate=true;});
      await arrow.click();await page.waitForFunction(() => window.sourceJumpFixture.state.pendingLocate.length===7);
      const scroller=await page.locator('[data-virtuoso-scroller]').boundingBox();
      await page.mouse.move(scroller.x+scroller.width/2,scroller.y+scroller.height/2);await page.mouse.wheel(0,120);
      await page.evaluate(() => window.sourceJumpFixture.releaseLocate(6));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(width+' trusted manual scroll cancels late jump',(await state()).flashes.length===3);
      await capture('final');
      result.state=await state();result.ui=await page.evaluate(() => window.sourceJumpFixture.ui());
      const guard=await app.evaluate(() => global.sourceFixtureState);result.guard=guard;
      check(width+' isolated clean runtime',result.errors.length===0&&result.console.length===0&&guard.forbidden.length===0&&guard.unknown.length===0&&guard.focus===0,{errors:result.errors,console:result.console,guard});
    } catch(error) {
      result.guard=await app.evaluate(() => global.sourceFixtureState).catch(() => null);
      result.failureDom=await page?.evaluate(() => ({body:document.body.innerText.slice(0,2000),
        fixture:window.sourceJumpFixture?.state,ready:document.readyState,script:document.querySelector('script')?.src})).catch(() => null);
      throw error;
    } finally {await cleanup(result);}
  }
  report.pass=true;
} catch(error) {report.error=error.stack||String(error);throw error;}
finally {
  if(app) await cleanup(report.runs.at(-1));
  await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({artifact,pass:report.pass,checks:report.checks.length,error:report.error}));
}

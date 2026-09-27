#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build,transformSync} from 'esbuild';
import ts from 'typescript';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-bottom-controls-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
if(process.env.NOTED_BOTTOM_CONTROLS_BASELINE==='1'){
 const file=path.join(snapshot,'src/renderer/components/Workspace/HistoryPanel.tsx');let source=await fs.readFile(file,'utf8');
 source=source.replace("data-history-composer-prompt-band\n      style={{\n        position: 'absolute',\n        pointerEvents: 'none',", "data-history-composer-prompt-band\n      style={{\n        position: 'absolute',\n        pointerEvents: 'auto',")
  .replace('promptBandRightInset={mainSurface ? centerRightInset + HISTORY_FLOATING_CONTROLS_WIDTH_PX : 0}','promptBandRightInset={0}');
 await fs.writeFile(file,source);
}
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-bottom-controls.tsx'),path.join(snapshot,'scripts/fixtures/history-bottom-controls.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'../noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-bottom-controls.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
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
 if(channel==='file:read')return{success:true,content:'# File preview\\nBody of the document.',size:40};
 if(channel==='file:exists-batch')return Object.fromEntries(args[0].map(p=>[p,!p.includes('missing')]));
 if(channel.includes('list')||channel.includes('List')||channel==='project:getGroups')return[];
 if(channel==='terminal:getCommandStates')return{};
 if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState')return null;
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:720,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact,'preload.cjs'))}}});
w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,NOTED_E2E_TEST:'true',NOTED_USER_DATA_DIR:path.join(artifact,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(artifact,'main.cjs')],env,cwd:artifact});
const result={artifact,checks:[],errors:[]};const logs=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.ready);
 const scroller=page.locator('[data-virtuoso-scroller]');
 await scroller.waitFor();await page.waitForTimeout(300);
 const up=async()=>{await scroller.evaluate(el=>{el.scrollTop=Math.max(0,el.scrollHeight-el.clientHeight-1800);});
   await page.locator('[data-history-scroll-to-bottom]').waitFor({state:'visible'});};
 await up();
 result.hitGrid=await page.evaluate(()=>['[data-history-scroll-to-bottom]','[data-side-surface-toggle]'].map(selector=>{
   const el=document.querySelector(selector),r=el.getBoundingClientRect();return {selector,points:[.15,.5,.85].flatMap(x=>[.15,.5,.85].map(y=>{
     const hit=document.elementFromPoint(r.x+r.width*x,r.y+r.height*y);return {x,y,ok:el.contains(hit),hit:hit?.outerHTML.slice(0,170)};}))};}));
 assert.ok(result.hitGrid.every(b=>b.points.every(p=>p.ok)),'all parts of both visible controls receive pointer hits');
 await page.locator('[data-side-surface-toggle]').click();
 assert.equal(await page.evaluate(()=>window.fixture.snapshot().terminalOpen),true);
 await page.locator('[data-side-surface-toggle]').click();
 assert.equal(await page.evaluate(()=>window.fixture.snapshot().terminalOpen),false);result.checks.push('terminal open/close');
 await page.locator('[data-history-scroll-to-bottom]').click();
 await page.waitForFunction(()=>{const s=document.querySelector('[data-virtuoso-scroller]');return s.scrollHeight-s.scrollTop-s.clientHeight<=2;});
 result.checks.push('arrow reaches actual bottom');
 await page.locator('[data-history-composer-prompt-band] .cb-composer-chip').first().click();
 await page.getByText('CONTROL-PROMPT-BODY-0',{exact:true}).first().waitFor({state:'visible'});result.checks.push('prompt chip preview');
 await page.keyboard.press('Escape');
 // Install the actual Workspace effect in this private DOM. Only the terminal
 // registry endpoint is substituted; History receives the real window event.
 const source=await fs.readFile(path.join(snapshot,'src/renderer/components/Workspace/Workspace.tsx'),'utf8');
 const tree=ts.createSourceFile('Workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let body;
 function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='useEffect'&&n.arguments[0]?.getText(tree).includes('const DOUBLE_TAP_MS'))body=n.arguments[0].getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(body);
 const code=transformSync(`(()=>{const workspaceView='workspace',currentView='terminal',effectiveTab={id:window.fixture.tabId};const terminalRegistry={get:()=>({scrollToBottom:()=>window.fixture.terminalBottom++})};return (${body})();})()`,{loader:'tsx',target:'chrome120'}).code;
 await page.evaluate(code=>{window.fixture.cleanupShortcut=eval(code);},code);
 await up();await scroller.evaluate(el=>{el.tabIndex=0;el.focus();});
 await page.keyboard.press('Space');await page.keyboard.press('Space');
 await page.waitForFunction(()=>window.fixture.terminalBottom===1);
 await page.waitForFunction(()=>{const s=document.querySelector('[data-virtuoso-scroller]');return s.scrollHeight-s.scrollTop-s.clientHeight<=2;});
 assert.equal(await page.evaluate(()=>window.fixture.events.length),2);result.checks.push('trusted double Space reaches bottom and dispatches both surfaces');
 const input=page.locator('.cm-content[contenteditable="true"]').last();await input.click();
 await page.keyboard.press('Space');await page.keyboard.press('Space');
 assert.equal(await page.evaluate(()=>window.fixture.snapshot().draft),'  ');
 assert.equal(await page.evaluate(()=>window.fixture.terminalBottom),1);result.checks.push('two spaces remain text in composer');
 await up();await scroller.evaluate(el=>el.focus());
 await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
 await page.waitForFunction(()=>window.fixture.terminalBottom===2);result.checks.push('existing double ArrowDown');
 await page.screenshot({path:path.join(artifact,'final.png')});assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.stack;process.exitCode=1;await app.firstWindow().then(p=>p.screenshot({path:path.join(artifact,'failure.png')})).catch(()=>{});}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));console.log(JSON.stringify(result));}

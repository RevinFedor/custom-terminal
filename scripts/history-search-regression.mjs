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
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-history-search-'));
const snapshot=path.join(artifact,'source');
execFileSync('git',['worktree','add','--detach',snapshot,'HEAD'],{cwd:repo,stdio:'pipe'});
for(const name of ['src','packages/claude-blocks'])await fs.cp(path.join(repo,name),path.join(snapshot,name),{recursive:true,force:true,filter:p=>!p.includes('/node_modules')&&!p.includes('/.git')});
await fs.mkdir(path.join(snapshot,'scripts/fixtures'),{recursive:true});
await fs.copyFile(path.join(repo,'scripts/fixtures/history-search.tsx'),path.join(snapshot,'scripts/fixtures/history-search.tsx'));
await fs.symlink(path.join(repo,'node_modules'),path.join(snapshot,'node_modules'));
const shared=path.join(artifact,'noted-shared/packages');
for(const n of ['structured-dnd','file-explorer'])await fs.cp(path.join(repo,'../noted-shared/packages',n),path.join(shared,n),{recursive:true,filter:p=>!p.includes('/node_modules')});
await build({entryPoints:[path.join(snapshot,'scripts/fixtures/history-search.tsx')],bundle:true,outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'esm',target:'chrome120',logLevel:'silent',
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
const result={artifact,steps:[],errors:[]};const logs=[];let debugPage;
try{
 const page=await app.firstWindow();debugPage=page;page.setDefaultTimeout(14000);
 page.on('pageerror',e=>result.errors.push(e.stack||e.message));page.on('console',m=>logs.push(m.text()));
 await page.waitForFunction(()=>window.fixture?.state.ready);
 await page.locator('[data-split-strip-menu-button]').click();
 await page.locator('[data-split-strip-menu-item="search-history"]').click();
 const search=page.locator('[data-pane-a] [data-history-search-panel]');
 await search.waitFor();
 await search.getByLabel('Тип сообщений').selectOption('user-images');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/2');
 await page.waitForFunction(()=>document.querySelectorAll('[data-timeline-entry-uuid][data-history-search-match="true"]').length===2);
 await page.waitForFunction(()=>window.fixture.state.hydrated.includes('row-8'));
 result.steps.push('menu opens exact chat search; empty image filter finds far rows and marks both iterations');
 await search.getByLabel('Поиск по чату',{exact:true}).fill('needle');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/1');
 await search.getByLabel('Тип сообщений').selectOption('all');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/4');
 await page.waitForFunction(()=>window.fixture.state.hydrated.includes('row-11'));
 await search.getByLabel('Поиск по чату',{exact:true}).press('ArrowLeft');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='4/4');
 await search.getByLabel('Поиск по чату',{exact:true}).press('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/4');
 await search.getByLabel('Поиск по чату',{exact:true}).press('ArrowDown');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='2/4');
 await search.getByLabel('Предыдущее совпадение').click();
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/4');
 await search.getByLabel('Следующее совпадение').click();
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='2/4');
 await search.getByLabel('Поиск по чату',{exact:true}).press('ArrowUp');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/4');
 result.steps.push('text intersects image filter; four occurrences belong to two marked iterations; arrows and buttons navigate');
 await page.waitForFunction(()=>CSS.highlights.has('hp-search'));
 result.highlightStyle=await page.locator('[data-pane-a] [data-history-row-real]').first().evaluate(node=>({
   regular:getComputedStyle(node,'::highlight(hp-search)').backgroundColor,
   current:getComputedStyle(node,'::highlight(hp-search-current)').backgroundColor,
 }));
 assert.equal(result.highlightStyle.regular,'rgba(234, 179, 8, 0.35)');
 assert.equal(result.highlightStyle.current,'rgba(234, 179, 8, 0.85)');
 const before=await page.evaluate(()=>[...CSS.highlights.keys()]);
 await page.evaluate(()=>window.fixture.showB(true));await page.waitForTimeout(450);
 assert.deepEqual(await page.evaluate(()=>[...CSS.highlights.keys()]),before);
 await page.locator('[data-fixture-search-b]').click();
 const searchB=page.locator('[data-pane-b] [data-history-search-panel]');
 await searchB.getByLabel('Поиск по чату',{exact:true}).fill('needle');
 await page.waitForFunction(()=>[...(CSS.highlights.get('hp-search')||[])].some(r=>r.startContainer.parentElement?.closest('[data-pane-b]')));
 await search.getByLabel('Закрыть поиск по чату').click();
 assert.ok(await page.evaluate(()=>[...(CSS.highlights.get('hp-search')||[])].some(r=>r.startContainer.parentElement?.closest('[data-pane-b]'))),'closing A must keep the visible B highlight');
 await page.locator('[data-split-strip-menu-button]').click();
 await page.locator('[data-split-strip-menu-item="search-history"]').click();
 await search.getByLabel('Поиск по чату',{exact:true}).fill('needle');
 await page.waitForFunction(()=>[...(CSS.highlights.get('hp-search')||[])].some(r=>r.startContainer.parentElement?.closest('[data-pane-a]')));
 await searchB.getByLabel('Закрыть поиск по чату').click();
 assert.ok(await page.evaluate(()=>[...(CSS.highlights.get('hp-search')||[])].some(r=>r.startContainer.parentElement?.closest('[data-pane-a]'))),'closing B must keep the visible A highlight');
 await page.evaluate(()=>window.fixture.showB(false));
 result.steps.push('two chats keep independent highlights; closing either and mounting/unmounting its neighbour preserve the other');
 await search.getByLabel('Поиск по чату',{exact:true}).fill('COMMON');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/240');
 await search.getByLabel('Поиск по чату',{exact:true}).press('ArrowLeft');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='240/240');
 assert.ok(await page.evaluate(()=>window.fixture.state.searches.some(r=>r.offset===200)));
 await search.getByRole('button',{name:'Предыдущие результаты',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='101/240');
 await search.getByRole('button',{name:'Следующие результаты',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='201/240');

 result.steps.push('navigation reaches results beyond the first transport page');
 await search.getByLabel('Тип сообщений').selectOption('user');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/120');
 await search.getByLabel('Тип сообщений').selectOption('all');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/240');

 await search.getByLabel('Поиск по чату',{exact:true}).fill('old');await page.waitForTimeout(210);
 await search.getByLabel('Поиск по чату',{exact:true}).fill('needle');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='1/4');await page.waitForTimeout(500);
 assert.equal(await search.locator('[data-history-search-count]').textContent(),'1/4');
 result.steps.push('late response cannot replace a newer query');
 await page.waitForFunction(()=>JSON.stringify([...document.querySelectorAll('[data-timeline-entry-uuid][data-history-search-match="true"]')].map(e=>e.getAttribute('data-timeline-entry-uuid')).sort())===JSON.stringify(['row-10','row-80']));
 result.timelineStyles=await page.locator('[data-timeline-entry-uuid][data-history-search-match="true"]').evaluateAll(rows=>rows.map(row=>({uuid:row.getAttribute('data-timeline-entry-uuid'),shadows:[...row.querySelectorAll('div')].map(e=>getComputedStyle(e).boxShadow).filter(v=>v!=='none')})));
 assert.ok(result.timelineStyles.every(row=>row.shadows.some(value=>value.includes('202, 138, 4')||value.includes('250, 204, 21'))));
 const seeksBefore=logs.filter(line=>line.includes('SCROLL_TO_START')).length;
 const searchesBefore=await page.evaluate(()=>window.fixture.state.searches.length);
 await page.evaluate(()=>window.fixture.refresh());
 await page.waitForFunction(n=>window.fixture.state.searches.length>n,searchesBefore);
 await page.waitForTimeout(300);
 assert.equal(logs.filter(line=>line.includes('SCROLL_TO_START')).length,seeksBefore,'background refresh must not reissue the user seek');
 await search.locator('[data-history-search-result="0"]').click();
 await page.waitForTimeout(250);
 assert.ok(logs.filter(line=>line.includes('SCROLL_TO_START')).length>seeksBefore,'clicking the current result still navigates again');
 result.steps.push('background refresh preserves reading position; explicit reselection navigates again');
 await page.screenshot({path:path.join(artifact,'search.png')});
 await search.getByLabel('Закрыть поиск по чату').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-history-search-match="true"]').length===0);
 const editor=page.locator('[data-pane-a] .gt-composer-editor .cm-content').last();
 await editor.click();await editor.fill('draft needle');await editor.press('Meta+f');
 assert.equal(await page.locator('[data-history-search-panel]').count(),0);
 result.composerFind=await page.locator('.gt-composer-editor').last().locator('input').count();
 assert.ok(result.composerFind>0,'composer retains its own find');
 result.panelBorders=await page.locator('.gt-composer-editor .cm-panels').evaluateAll(items=>items.map(e=>({top:getComputedStyle(e).borderTopWidth,bottom:getComputedStyle(e).borderBottomWidth})));
 assert.ok(result.panelBorders.every(b=>b.top==='0px'&&b.bottom==='0px'));
 await page.keyboard.press('Escape');
 await page.locator('[data-pane-a] [data-virtuoso-scroller]').click({position:{x:200,y:130}});await page.keyboard.press('Meta+f');
 await search.waitFor();
 result.steps.push('Cmd+F follows composer versus chat focus; composer find has no white full-width border');
 await search.getByLabel('Поиск по чату',{exact:true}).fill('zz-no-such-record');
 await page.waitForFunction(()=>document.querySelector('[data-history-search-count]')?.textContent==='0/0');
 assert.equal(await search.getByLabel('Следующее совпадение').isDisabled(),true);
 await search.getByLabel('Закрыть поиск по чату').focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>!document.querySelector('[data-history-search-panel]'));
 result.steps.push('role filter intersects text; Enter activates close; zero results disable navigation');
 assert.deepEqual(result.errors,[]);result.pass=true;
}catch(error){
 if(debugPage){await debugPage.screenshot({path:path.join(artifact,'failure.png')}).catch(()=>{});result.debug=await debugPage.evaluate(()=>({
 highlights:CSS.highlights?[...CSS.highlights.keys()]:null,state:window.fixture?.state,rows:[...document.querySelectorAll('[data-uuid]')].map(e=>({uuid:e.getAttribute('data-uuid'),text:e.textContent?.slice(0,90)})),text:document.querySelector('[data-pane-a] [data-virtuoso-scroller]')?.textContent?.slice(0,1000)
 })).catch(()=>null);}
 result.pass=false;result.failure=String(error);process.exitCode=1;}
finally{await app.close();await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(artifact,'renderer.log'),logs.join('\n'));execFileSync('git',['worktree','remove','--force',snapshot],{cwd:repo,stdio:'pipe'});}
console.log(JSON.stringify({artifact,pass:result.pass,steps:result.steps,failure:result.failure,errors:result.errors}));

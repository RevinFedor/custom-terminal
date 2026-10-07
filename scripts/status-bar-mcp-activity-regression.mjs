#!/usr/bin/env node
// Actual StatusBar declarations; private IPC/store boundaries, no App/provider.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
const repo = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mcp-activity-'));
const source = await fs.readFile(path.join(repo, 'src/renderer/components/StatusBar.tsx'), 'utf8');
const ast = ts.createSourceFile('StatusBar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['McpActivityChip', 'McpActivityPopup', 'focusMcpTarget', 'actionLabel', 'statusColor',
  'mcpPartyLabel', 'targetLabel', 'sourceLabel', 'timeLabel'];
const declarations = names.map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}).join('\n');
await fs.writeFile(path.join(root, 'fixture.tsx'), `import React,{useState,useEffect,useRef,useSyncExternalStore} from 'react';
import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
const listeners=new Map();const ipcRenderer={on:(k,f)=>listeners.set(k,f),removeListener:k=>listeners.delete(k)};
const ControlHint=({children})=>children;const MCP_ACTIVE_STATUSES=new Set(['running','creating','sending','pasting','starting']);
const subscribers=new Set();const state={openProjects:new Map([['target',{projectPath:'/project/Noted',tabs:new Map([['T',{name:'Fork / Rewind'}],['S',{name:'Terminal MCP'}]])}]]),
activeSpaceId:'current',spaces:[{id:'other',layout:{splitPanes:[{projectId:'target',tabId:'T'}]}}],splitPanes:[{tabId:'shown',projectId:'home'}],
openTabById:async(tabId,options)=>{window.fixture.navigation.push({tabId,options});return true}};
const projects={projects:{target:{name:'Noted Terminal'}}};
const store=data=>Object.assign(selector=>useSyncExternalStore(notify=>{subscribers.add(notify);return()=>subscribers.delete(notify)},()=>selector(data)),{getState:()=>data});
const useWorkspaceStore=store(state),useProjectsStore=store(projects);
window.fixture={navigation:[],ready:()=>listeners.has('terminal:mcp-activity'),
emit:status=>listeners.get('terminal:mcp-activity')({}, {id:'old-start',at:1791263450000,action:'start_ai',status,
tabId:'T',targetProjectId:'stale',sourceMeta:{projectId:'target',tabId:'S'},error:status==='error'?'Завершите выбор для Goal в терминале.':undefined}),
rename:()=>{state.openProjects.get('target').tabs.get('T').name='Fork restored';subscribers.forEach(f=>f())}};
${declarations}
createRoot(document.getElementById('root')).render(<div style={{position:'absolute',bottom:0,left:12}}><McpActivityChip/></div>);`);
await build({ entryPoints: [path.join(root, 'fixture.tsx')], outfile: path.join(root, 'fixture.js'), bundle: true,
  format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
  alias: { react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } });
const cssFiles = (await fs.readdir(path.join(repo,'dist/renderer/assets'))).filter(file=>file.endsWith('.css'));
const css = (await Promise.all(cssFiles.map(file=>fs.readFile(path.join(repo,'dist/renderer/assets',file),'utf8')))).join('\n');
await fs.writeFile(path.join(root,'style.css'),css);
await fs.writeFile(path.join(root,'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>html,body{margin:0;background:#202020;color:#ddd;font-family:Arial}*{box-sizing:border-box}</style><div id="root"></div><script src="fixture.js"></script>');
await fs.writeFile(path.join(root,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'user-data'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:!r.url.startsWith('file:')}));const w=new BrowserWindow({show:false,focusable:false,width:1000,height:700,webPreferences:{offscreen:true,sandbox:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(repo,'node_modules/.bin/electron'),args:[path.join(root,'main.cjs')],env,cwd:root});
const child=app.process(),result={root,sourceHash:createHash('sha256').update(source).digest('hex'),widths:[],errors:[]};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>result.errors.push(e.message));
 await page.waitForFunction(()=>window.fixture?.ready());
 await page.evaluate(()=>window.fixture.emit('error'));
 for(const width of [350,500,1000]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,700),width);
   await page.waitForFunction(width=>innerWidth===width,width);
   await page.getByRole('button',{name:/MCP/}).click();
   const row=page.getByRole('button',{name:/Fork \/ Rewind/});
   await row.waitFor();
   const text=await row.innerText();assert.match(text,/Noted Terminal/);assert.match(text,/Terminal MCP/);
   assert.equal(text.split('Завершите выбор для Goal в терминале.').length-1,1);
   assert.ok(!text.includes('stale'),'transport IDs are secondary tooltips');
   const geometry=await row.evaluate(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:innerWidth};});
   assert.ok(geometry.left>=0&&geometry.right<=width&&geometry.top>=0);
   await page.screenshot({path:path.join(root,width+'.png')});result.widths.push({width,text,geometry});
   await row.click();
 }
 await page.getByRole('button',{name:/MCP/}).click();
 await page.evaluate(()=>window.fixture.rename());
 await page.getByRole('button',{name:/Fork restored/}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fixture.navigation),Array(3).fill({tabId:'T',options:{projectId:'stale',projectPath:undefined,reason:'mcp-activity-target'}}));
 assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;await app.firstWindow().then(p=>p.screenshot({path:path.join(root,'failure.png')})).catch(()=>{});}
finally{
 let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned Electron close timed out')),5000)})]);}
 catch(error){result.closeWarning=String(error);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}finally{clearTimeout(timer);}
 result.electron={pid:child.pid,exitCode:child.exitCode,signal:child.signalCode};
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}

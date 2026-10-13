// Actual helper/native DOM & MutationObserver proof. Synthetic rows and input;
// controlled scheduler, no whole-app/provider/latency benchmark or OS pointer.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-pane-focus-inventory-'));
const input = process.env.PANE_FOCUS_SOURCE_PATH || path.join(repo, 'src/renderer/utils/paneFocusIsolation.ts');
const source = await fs.readFile(input, 'utf8');
await fs.writeFile(path.join(root, 'source.ts'), source);
const code = `
import {createPaneFocusIsolationManager} from ${JSON.stringify(path.join(repo, 'src/renderer/utils/paneFocusIsolation.ts'))};
const queue=[],logs=[],calls=[];
Object.defineProperty(window,'scheduler',{configurable:true,value:{postTask(fn){queue.push(fn);return Promise.resolve()}}});
console.warn=(message)=>logs.push(String(message));
const originalQuery=Element.prototype.querySelectorAll;
Element.prototype.querySelectorAll=function(selector){if(this.dataset?.proofRoot)calls.push([this.dataset.proofRoot,selector]);return originalQuery.call(this,selector)};
const selector='[data-terminal-pane-wrapper][data-pane-focus-isolated],[data-terminal-pane-chrome-host][data-pane-focus-isolated]';
const check=(v,message)=>{if(!v)throw Error(message)};
const equal=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message+': '+JSON.stringify(a)+' != '+JSON.stringify(b));
const results=[];
let cleanups=[];
function makeRoot(){const root=document.createElement('div');root.dataset.proofRoot='root-'+Math.random();document.body.append(root);cleanups.push(()=>root.remove());return root}
function pane(id,hidden=true,index='4',marker='data-terminal-pane-wrapper'){
 const p=document.createElement('section');p.setAttribute(marker,id);p.dataset.paneFocusIsolated=hidden?'1':'0';
 const input=document.createElement('input');input.setAttribute('tabindex',index);p.append(input);p.input=input;return p;
}
function manager(root,options={}){const m=createPaneFocusIsolationManager(root,options);cleanups.push(()=>m.dispose());m.sync();return m}
function rootQueries(root,s=selector){return calls.filter(([id,query])=>id===root.dataset.proofRoot&&query===s).length}
async function drain(){for(let i=0;i<6;i++){let budget=1000;while(queue.length){if(!budget--)throw Error('unbounded task loop');queue.shift()()}await Promise.resolve();if(!queue.length)return}throw Error('unsettled task loop')}
async function run(name,fn){try{const data=await fn();results.push({name,pass:true,...data})}catch(error){results.push({name,pass:false,error:String(error.stack||error)})}finally{for(const dispose of cleanups.reverse())dispose();cleanups=[];await drain()}}
window.proof=async()=>{
 await run('warm 53-boundary/53000-row sync never rediscovers retained descendants',async()=>{
  const root=makeRoot();for(let i=0;i<53;i++){const p=pane('tab-'+i);const rows=document.createElement('div');rows.innerHTML='<span>prepared</span>'.repeat(1000);p.append(rows);root.append(p)}
  const m=manager(root);await drain();const before=rootQueries(root);for(let i=0;i<5;i++)m.sync();await drain();
  const warm=rootQueries(root)-before;equal(warm,0,'warm full-root queries');return{boundaries:53,rows:53000,warmQueries:warm};
 });
 await run('late boundary is protected immediately, before mutation callback delivery',async()=>{
  const root=makeRoot(),m=manager(root);await drain();const p=pane('late',true,'8');root.append(p);
  const key=new KeyboardEvent('keydown',{key:'a',bubbles:true,cancelable:true});p.input.dispatchEvent(key);check(key.defaultPrevented,'capture guard lost late boundary');
  m.sync();await drain();equal(p.input.getAttribute('tabindex'),'-1','late quarantine');p.dataset.paneFocusIsolated='0';m.sync();await drain();equal(p.input.getAttribute('tabindex'),'8','late authored value');
 });
 await run('late marker attribute is consumed by takeRecords in the same turn',async()=>{
  const root=makeRoot(),p=pane('late-attr',false,'6');p.removeAttribute('data-pane-focus-isolated');root.append(p);const m=manager(root);await drain();
  p.dataset.paneFocusIsolated='1';m.sync();await drain();equal(p.input.getAttribute('tabindex'),'-1','attribute admission');p.dataset.paneFocusIsolated='0';m.sync();await drain();equal(p.input.getAttribute('tabindex'),'6','attribute restore');
 });
 await run('remove/reinsert keeps authored tabindex and final DOM order',async()=>{
  const root=makeRoot(),a=pane('a',true,'5'),b=pane('b',false,'2');root.append(a,b);const m=manager(root);await drain();
  a.remove();root.append(a);m.sync();await drain();a.dataset.paneFocusIsolated='0';m.sync();await drain();equal(a.input.getAttribute('tabindex'),'5','remove/reinsert discarded original');
  return {originalRestored:a.input.getAttribute('tabindex')};
 });
 await run('same tab ID replacement has independent DOM identity and originals',async()=>{
  const root=makeRoot(),old=pane('same',true,'2');root.append(old);const m=manager(root);await drain();const replacement=pane('same',true,'9');old.replaceWith(replacement);m.sync();await drain();
  replacement.dataset.paneFocusIsolated='0';m.sync();await drain();equal(replacement.input.getAttribute('tabindex'),'9','replacement borrowed old original');
 });
 await run('reorder before deferred work follows final DOM order and cancels old version',async()=>{
  const root=makeRoot(),a=pane('order-a'),b=pane('order-b'),c=pane('order-c');root.append(a,b,c);const m=manager(root);root.prepend(c);m.sync();const start=logs.length;await drain();
  const order=logs.slice(start).filter(s=>s.includes('action=isolate')).map(s=>s.match(/ tab=([^ ]+)/)[1]);equal(order,['order-c','order-a','order-b'],'DOM order');
 });
 await run('restore-first and live flags survive rapid hidden/visible switches',async()=>{
  const root=makeRoot(),a=pane('restore-a'),b=pane('restore-b',false);root.append(a,b);const m=manager(root);await drain();a.dataset.paneFocusIsolated='0';b.dataset.paneFocusIsolated='1';m.sync();const start=logs.length;await drain();
  const ops=logs.slice(start).filter(s=>s.includes('phase=deferred'));check(ops[0]?.includes('action=restore')&&ops[0]?.includes('tab=restore-a'),'restore first changed');
  b.dataset.paneFocusIsolated='0';m.sync();b.dataset.paneFocusIsolated='1';m.sync();b.dataset.paneFocusIsolated='0';m.sync();await drain();equal(b.input.getAttribute('tabindex'),'4','stale task applied old flags');
 });
 await run('hidden focus/beforeinput remain blocked and fresh controls are quarantined',async()=>{
  const root=makeRoot(),p=pane('guard'),rejections=[];root.append(p);const m=manager(root,{onHiddenFocus:id=>rejections.push(id)});await drain();p.input.focus();
  // An unfocused offscreen document changes activeElement without native
  // focusin delivery. Exercise the capture path explicitly, without OS focus.
  p.input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));check(document.activeElement!==p.input,'hidden focus accepted');
  const event=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'x'});p.input.dispatchEvent(event);check(event.defaultPrevented,'hidden beforeinput accepted');
  const button=document.createElement('button');button.tabIndex=7;p.append(button);await drain();equal(button.getAttribute('tabindex'),'-1','new control escaped');
  button.setAttribute('tabindex','3');await drain();p.dataset.paneFocusIsolated='0';m.sync();await drain();equal(button.getAttribute('tabindex'),'3','new authored value not restored');check(rejections.length>=2,'capture ownership lost');
 });
 await run('chrome host and wrapper sharing a tab ID are separate boundaries',async()=>{
  const root=makeRoot(),a=pane('shared',true,'2'),b=pane('shared',true,'7','data-terminal-pane-chrome-host');root.append(a,b);const m=manager(root);await drain();a.dataset.paneFocusIsolated='0';m.sync();await drain();
  equal(a.input.getAttribute('tabindex'),'2','wrapper restore');equal(b.input.getAttribute('tabindex'),'-1','chrome quarantine');b.dataset.paneFocusIsolated='0';m.sync();await drain();equal(b.input.getAttribute('tabindex'),'7','chrome own original');
 });
 await run('managed nested pane is excluded from outer workspace quarantine',async()=>{
  const root=makeRoot();root.dataset.workspacePresentation='warm';root.dataset.paneFocusIsolated='1';const child=pane('inner',false,'7'),button=document.createElement('button');button.tabIndex=6;root.append(child,button);
  const m=manager(root,{boundarySelector:'[data-workspace-presentation]',excludeBoundarySelector:selector});await drain();equal(child.input.getAttribute('tabindex'),'7','outer touched inner');equal(button.getAttribute('tabindex'),'-1','root missing');root.dataset.paneFocusIsolated='0';m.sync();await drain();equal(button.getAttribute('tabindex'),'6','outer restore');
 });
 await run('known center selector is cached but unknown relational selector queries fresh',async()=>{
  const root=makeRoot(),center=pane('center');center.removeAttribute('data-terminal-pane-wrapper');center.dataset.singleCenterFocusBoundary='center';root.append(center);const s='[data-single-center-focus-boundary][data-pane-focus-isolated]';const m=manager(root,{boundarySelector:s});await drain();const before=rootQueries(root,s);m.sync();m.sync();await drain();equal(rootQueries(root,s)-before,0,'known center queried');m.dispose();
  const other=makeRoot(),p=pane('custom',false,'5');p.className='eligible';other.append(p);const custom='.eligible[data-pane-focus-isolated]';const c=manager(other,{boundarySelector:custom});await drain();const start=rootQueries(other,custom);c.sync();c.sync();check(rootQueries(other,custom)-start>=2,'unknown selector silently cached');
 });
 await run('dispose cancels queued work, releases observers and restores exact values',async()=>{
  const root=makeRoot(),p=pane('dispose',true,'11');root.append(p);const m=manager(root);await drain();m.dispose();m.dispose();equal(p.input.getAttribute('tabindex'),'11','dispose did not restore');const before=logs.length;root.append(pane('after'));await drain();equal(logs.length,before,'disposed work continued');
 });
 return {pass:results.every(x=>x.pass),results,logs,boundary:'actual source helper/native DOM/MutationObserver; controlled scheduler and synthetic rows/input; no whole History/app/OS input or numerical latency A/B'};
};
`;
await build({stdin:{contents:code,resolveDir:repo,sourcefile:'pane-focus-proof.ts'},bundle:true,platform:'browser',format:'iife',target:'chrome120',outfile:path.join(root,'bundle.js'),logLevel:'silent',
  plugins:[{name:'exact-helper',setup(plugin){plugin.onLoad({filter:/\/paneFocusIsolation\.ts$/},()=>({contents:source,loader:'ts',resolveDir:path.join(repo,'src/renderer/utils')}))}}]});
await fs.writeFile(path.join(root,'fixture.ts'),code);
await fs.writeFile(path.join(root,'index.html'),'<!doctype html><html><body><script src="bundle.js"></script></body></html>');
await fs.writeFile(path.join(root,'main.cjs'),`
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');app.setPath('userData',path.join(__dirname,'profile'));
const deadline=setTimeout(()=>{console.error('proof timeout');app.exit(2)},20000);
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1000,height:600,webPreferences:{offscreen:true,backgroundThrottling:false}});
try{await w.loadFile(path.join(__dirname,'index.html'));const result=await w.webContents.executeJavaScript('proof()');result.pid=process.pid;fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result,null,2));console.log('FOCUS_PROOF '+JSON.stringify({pid:process.pid,pass:result.pass,cases:result.results.length,failed:result.results.filter(x=>!x.pass)}));process.exitCode=result.pass?0:1}catch(error){console.error(error);process.exitCode=2}finally{clearTimeout(deadline);w.destroy();app.exit(process.exitCode||0)}});
`);
const manifest={source:input,sha256:createHash('sha256').update(source).digest('hex'),artifactRoot:root};
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));
let exitCode=0;
try { const result=await promisify(execFile)(path.join(repo,'node_modules/.bin/electron'),[path.join(root,'main.cjs')],{cwd:repo,timeout:30000,maxBuffer:1024*1024});console.log(result.stdout);if(result.stderr)console.error(result.stderr); }
catch(error){exitCode=error.code||1;console.error(error.stdout||error.message);if(error.stderr)console.error(error.stderr);}
finally{await fs.rm(path.join(root,'profile'),{recursive:true,force:true});console.log('ARTIFACT_ROOT '+root);}
process.exitCode=typeof exitCode==='number'?exitCode:1;

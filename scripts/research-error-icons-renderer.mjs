#!/usr/bin/env node
// Finite component renderer, NOT the full Noted app or installed acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';

const require=createRequire(import.meta.url),repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-research-error-icons-'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const result={artifact,status:'RUNNING',boundary:'Actual extracted TimelineSegmentRow and HistoryResearchReply, actual ResearchResultContent/SC artwork/CSS/metadata projectors in private offscreen Electron. Synthetic canonical tag fixtures; source navigation, row API and reveal owner controlled. No full app/Main/PTY/provider/host/Chrome/OS input.',checks:[],cleanup:{},errors:[]};
const tracked=['src/renderer/components/Workspace/Timeline.tsx','src/renderer/components/Workspace/HistoryPanel.tsx',
 'src/renderer/components/Workspace/ResearchTimelineIcon.tsx','src/renderer/components/Workspace/ResearchResultContent.tsx',
 'src/renderer/components/Workspace/ResearchResultContent.css','src/renderer/utils/historyOrchestrationPromptPresentation.mjs',
 'src/renderer/utils/researchResultPresentation.mjs','packages/claude-blocks/src/theme.css','src/main/history-prompt-presentations.js','src/main/web-server.js'];
const texts=Object.fromEntries(await Promise.all(tracked.map(async p=>[p,await fs.readFile(path.join(repo,p),'utf8')])));
result.sourceHashes=Object.fromEntries(tracked.map(p=>[p,hash(texts[p])]));
function declarations(source,names){const ast=ts.createSourceFile('actual.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);return names.map(name=>{
 const n=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name||ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)===name));assert.ok(n,name);return n.getText(ast);
}).join('\n');}
const timeline=texts[tracked[0]],history=texts[tracked[1]];
const rowCode=declarations(timeline,['TimelineSegmentRow','expandedPreviewCharLimit','truncateTimelinePreviewText','EXPANDED_PREVIEW_MIN_CHARS','EXPANDED_PREVIEW_MAX_CHARS','EXPANDED_PREVIEW_CHARS_PER_LINE']);
const replyCode=declarations(history,['HistoryResearchReply']);
const web=texts['src/main/web-server.js'],snapshotCode=declarations(web,['orchestrationPresentationSnapshot']);
const snapshot=new Function('crypto',snapshotCode+';return orchestrationPresentationSnapshot;')({createHash});
const {normalizePromptPresentationSnapshot}=require('../src/main/history-prompt-presentations.js');
const cases=[['success','completion','success',false],['partial-files-success','completion','success',false],
 ['canonical-failed','completion','failed',true],['legacy-failure','failure',undefined,true],
 ['terminal-error','completion','error',true],['running','request',undefined,false],
 ['queued','request',undefined,false],['manual-interrupt','failure','interrupted',false],
 ['literal-error-text','completion','success',false]].map(([name,phase,outcome,failed],i)=>{
 const body=name==='literal-error-text'?'Готов… {"status":"failed","partialFiles":["missing"]}':'Готов применимый V15 patch…';
 const prompt='[saved exact reply]\n'+body,run={runId:'fixture-'+i,runKind:'external-research',outcome,
   ...(name==='partial-files-success'?{partialFiles:[{status:'error'}]}:{})};
 const tags=normalizePromptPresentationSnapshot(snapshot(run,phase,{prompt,bodyStart:19,bodyEnd:prompt.length},prompt)).semanticTags;
 // Use exact prefix length, not this fixture's typography, as the body address.
 tags[0].bodyStart=prompt.indexOf('\n')+1;tags[0].envelopeText=prompt.slice(0,tags[0].bodyStart);
 return {name,failed,entry:{uuid:'entry-'+i,type:'user',role:'user',content:prompt,semanticTags:tags}};
});
result.cases=cases.map(x=>({name:x.name,expectedFailed:x.failed,phase:x.entry.semanticTags[0].phase,outcome:x.entry.semanticTags[0].outcome??null}));
const fingerprints=Object.fromEntries(cases.map(c=>[c.entry.content,hash(c.entry.content)]));
const fixture=`import React,{useState,useRef,useCallback}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{ChevronDown,ChevronRight}from'lucide-react';
import{ResearchTimelineIcon}from'./src/renderer/components/Workspace/ResearchTimelineIcon';
import{ResearchResultContent}from'./src/renderer/components/Workspace/ResearchResultContent';
import{isFailedResearchPresentation,researchResultPresentation}from'./src/renderer/utils/researchResultPresentation.mjs';
import{getTerminalMcpTag as getOrchestrationTag,getLoopPromptOriginTag,isSystemPromptEntry,isServicePromptEntry}from'./src/shared/prompt-origin.mjs';
import{timelinePromptPreview,timelineResearchModelLabel}from'./src/renderer/utils/timelineEntryPreview.mjs';
import{timelineMarkerKind,timelineMarkerGeometry,buildTimelineCornerBadges}from'./src/renderer/utils/timelineMarkerPresentation.mjs';
import'./packages/claude-blocks/src/theme.css';import'./packages/claude-blocks/src/blocks.css';
const state=window.proof={calls:[],ready:false};const Tooltip=({children})=>children,TimelineCornerBadges=()=>null;
const api=new Proxy({},{get:(_t,k)=>(...args)=>{if(k!=='setSegmentRef')state.calls.push({name:k,uuids:args.filter(x=>x?.uuid).map(x=>x.uuid)})}});
const saved={};for(const c of window.input.cases)saved[c.entry.semanticTags[0].runId]={model:'6-astra',mode:'pro',effort:null};
const HistoryResearchModelsContext=React.createContext(saved);
const useHistoryRevealToggle=(_r,open,setOpen)=>useCallback(()=>{state.calls.push({name:'disclosure'});setOpen(!open)},[open]);
const ResearchSourceAction=({runId,destination})=><button onClick={()=>state.calls.push({name:destination||'source',runId})}>↗</button>;
${rowCode}\n${replyCode}
function App(){return <main><h2>Research error icons · dark theme</h2>{window.input.cases.map(c=>{
const view=timelinePromptPreview(c.entry,t=>window.input.hashes[t]);
const body=view.research||{...researchResultPresentation('Ожидает результата'),failed:false};
return <section data-case={c.name} key={c.name}><strong>{c.name}</strong><div className="marker"><TimelineSegmentRow entry={c.entry} index={0} api={api} isExpandedLayout={false} isInViewport={true}/></div>
<div className="history"><HistoryResearchReply result={body} source={{researchRunId:c.entry.semanticTags[0].runId}} phase={view.service?.phase} copied={false} onCopy={()=>state.calls.push({name:'copy'})}/></div></section>})}</main>}
flushSync(()=>createRoot(document.getElementById('fixture')).render(<App/>));state.ready=true;`;
let app,proc,timer;
try{
 const pressure=execFileSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8'});
 result.memoryAdmission=pressure.trim();assert.ok(Number(pressure.match(/free percentage:\s*(\d+)%/)?.[1])>=15,'component memory admission');
 const output=await build({stdin:{contents:fixture,loader:'tsx',resolveDir:repo},bundle:true,write:false,platform:'browser',format:'iife',target:'chrome120',outfile:path.join(artifact,'bundle.js'),
  define:{'process.env.NODE_ENV':'"production"'},alias:{'@noted/claude-blocks':path.join(repo,'packages/claude-blocks/src/index.ts')},loader:{'.png':'dataurl'},logLevel:'silent'});
 for(const file of output.outputFiles)await fs.writeFile(file.path,file.contents);
 await fs.writeFile(path.join(artifact,'input.js'),'window.input='+JSON.stringify({cases,hashes:fingerprints})+';');
 await fs.writeFile(path.join(artifact,'index.html'),`<meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>
 body{margin:0;background:#1a1a1a;color:#bcbab5;font:14px/1.4 Arial}main{padding:20px}h2{font-size:16px;margin:0 0 16px}section{display:grid;grid-template-columns:155px 38px 1fr;align-items:center;min-height:78px;border-bottom:1px solid #333}section>strong{font-size:12px;color:#8f8d88}.history{font-size:16px}.marker{width:32px;position:relative}.flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}.shrink-0{flex-shrink:0}.relative{position:relative}.absolute{position:absolute}.pointer-events-none{pointer-events:none}
 </style><div id="fixture"></div><script src="input.js"></script><script src="bundle.js"></script>`);
 await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();const w=global.ownedWindow=new BrowserWindow({width:900,height:860,show:false,focusable:false,frame:false,webPreferences:{offscreen:true,sandbox:true}});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CLAUDECODE;delete env.CLAUDE_CODE_SESSION_ID;delete env.CLAUDE_CODE_CHILD_SESSION;
 app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env,timeout:15000});proc=app.process();result.pid=proc.pid;
 timer=setTimeout(()=>{result.errors.push('45-second component deadline');void app.close().catch(()=>proc.kill('SIGTERM'));},45000);
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));
 await page.waitForFunction(()=>window.proof?.ready,{timeout:10000});await page.evaluate(()=>document.fonts.ready);
 const inspect=()=>page.evaluate(()=>[...document.querySelectorAll('[data-case]')].map(row=>{
  const mark=row.querySelector('[data-timeline-sc-desktop]'),globe=row.querySelector('.hp-research-result-icon'),label=row.querySelector('.hp-research-result-label');
  const get=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {tag:el.tagName,color:s.color,fill:s.fill,stroke:s.stroke,width:r.width,height:r.height,x:r.x,y:r.y}};
  return {name:row.dataset.case,marker:get(mark),globe:get(globe),label:getComputedStyle(label).color,flood:mark.querySelector('feFlood')?getComputedStyle(mark.querySelector('feFlood')).floodColor:null,failed:row.querySelector('[data-history-research-result]').dataset.researchFailed||null};
 }));
 const rows=await inspect();result.rendered=rows;
 for(const row of rows){const expected=cases.find(c=>c.name===row.name).failed;
  assert.equal(row.marker.tag,expected?'svg':'IMG');assert.equal(row.globe.stroke,expected?'rgb(239, 68, 68)':'rgb(167, 139, 250)');assert.equal(row.globe.fill,'none');
  if(expected){assert.equal(row.marker.fill,'rgb(243, 139, 168)');assert.equal(row.marker.stroke,'none');assert.equal(row.flood,'rgb(243, 139, 168)');}
  assert.ok(Math.abs(row.marker.width-rows[0].marker.width)<.01);assert.equal(row.globe.width,14);assert.equal(row.globe.height,14);assert.equal(row.label,rows[0].label);
 }
 result.checks.push('9 states: actual SVG stroke/fill/flood, marker bounds, History text colors');
 const png=await page.screenshot({path:path.join(artifact,'dark-gallery.png')});
 result.pixels=await page.evaluate(async({png,rows})=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d');c.drawImage(image,0,0);const scale=image.width/innerWidth;
 return rows.map(row=>{const sample=rect=>{const data=c.getImageData(Math.floor(rect.x*scale),Math.floor(rect.y*scale),Math.ceil(rect.width*scale),Math.ceil(rect.height*scale)).data;let crimson=0,red=0;for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];if(r>100&&r>b+15&&b>g+15&&r>g+35)crimson++;if(r>100&&r>g*1.3&&r>b*1.3)red++;}return {crimson,red};};return {name:row.name,marker:sample(row.marker),globe:sample(row.globe)};});},{png:png.toString('base64'),rows});
 for(const row of result.pixels){const expected=cases.find(c=>c.name===row.name).failed;if(expected){assert.ok(row.marker.crimson>=3,'painted crimson '+row.name);assert.ok(row.globe.red>=3,'painted red '+row.name);}else{assert.equal(row.marker.crimson,0);assert.equal(row.globe.red,0);}}
 result.checks.push('actual captured pixels distinguish error icons from unchanged purple controls');
 await page.locator('[data-case="canonical-failed"] .hp-research-result-toggle').click();
 assert.equal(await page.locator('[data-case="canonical-failed"] [data-research-full]').count(),1);
 await page.locator('[data-case="canonical-failed"] [data-timeline-entry-uuid]').click();
 assert.ok((await page.evaluate(()=>window.proof.calls)).some(x=>x.name==='handleEntryClick'));
 result.checks.push('actual disclosure and Timeline row click still reach their controlled owners');
 assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(error){result.status='FAIL';result.error=error.stack;process.exitCode=1;}
finally{
 if(timer)clearTimeout(timer);if(app){await app.close();result.cleanup.electronClosed=true;}
 if(proc){result.cleanup.exitCode=proc.exitCode;result.cleanup.signal=proc.signalCode;try{process.kill(proc.pid,0);result.cleanup.pidGone=false;}catch{result.cleanup.pidGone=true;}}
 for(const name of ['profile','bundle.js','bundle.css','input.js','index.html','main.cjs'])await fs.rm(path.join(artifact,name),{recursive:name==='profile',force:true});
 result.cleanup.generatedRemoved=true;
 await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({artifact,status:result.status,error:result.error,checks:result.checks,cleanup:result.cleanup}));
}

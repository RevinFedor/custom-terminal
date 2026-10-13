#!/usr/bin/env node
// Actual HistoryUserEntry/ResearchReply/Source + actual Preview and shared
// package. Native clipboard/IPC/queue/time/reveal owner are controlled seams.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const witness = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-research-result-'));
const hash = text => createHash('sha256').update(text).digest('hex');
const history = await fs.readFile(path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const tree = ts.createSourceFile('HistoryPanel.tsx', history, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = ['HistoryUserEntry','HistoryResearchReply','HistoryResearchModelsProvider','HistoryResearchModelsContext',
  'historyInstructionAttachment','historyUserPromptIsChipOnly','splitLeadingHistoryPromptParts','HISTORY_SURFACE_PRESENTATION_EVENT'];
const declarations = {};
for (const node of tree.statements) {
  if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
    const name=item.name.getText(tree); if(wanted.includes(name)) declarations[name]='const '+item.getText(tree)+';';
  }
  if (ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text)) declarations[node.name.text]=node.getText(tree);
}
for (const name of wanted) assert.ok(declarations[name], name);
const historyCSS=(history.slice(history.indexOf('.hp-history-transcript .cb-row {'),
  history.indexOf('/* The top collapse control still occupies'))
  +history.slice(history.indexOf('.hp-history-group-detail {'),history.indexOf('.hp-history-caption-gutter')))
  .replaceAll('${HISTORY_SERVICE_TEXT_RATIO}',history.match(/const HISTORY_SERVICE_TEXT_RATIO = ([.\d]+);/)[1]);
const origin=witness.entry||witness.entries[0],tag=origin.semanticTags[0];
const variant=(name,body)=>{
  const envelope=origin.content.slice(0,tag.bodyStart),content=envelope+body;
  return {...origin,uuid:'research-fixture-'+name,type:'user',content,semanticTags:[{...tag,bodyEnd:content.length,bodyProjectionHash:hash(content)}]};
};
const cases=[
 {...origin,type:'user'},
 variant('plain-json','{\n "items": [{"id":"do not drop","reason":"Keep values"}]\n}'),
 variant('fenced','```json\n{"items":[1,2]}\n```'),
 variant('jsonl',Array.from({length:120},(_,id)=>JSON.stringify({id,reason:'Полная запись '+id})).join('\n')),
 variant('mixed','## Итог\n\n'+('Длинный читаемый ответ. '.repeat(90))+'\n\n```json\n{"id":1}\n```\n\n```python\nprint(2)\n```'),
 variant('short','**Короткий ответ.**'),
 variant('malformed','Example: <CodeBlock language="json" editable={false}>{"id":1}</CodeBlock>'),
 {...origin,type:'user',uuid:'literal-user',semanticTags:[],content:'<CodeBlock language="json" editable={false}>{"id":1}</CodeBlock>'},
 {...origin,type:'user',uuid:'stale-proof',content:origin.content+'changed'},
 variant('physical-lines','Читаемый ответ с длинной физической строкой. '.repeat(7)),
 variant('literal-values','<CodeBlock language="json" editable={false}>'+JSON.stringify({paste:'<pasted_content>literal</pasted_content>',image:'[Image #1]'})+'</CodeBlock>'),
];
const hashes=Object.fromEntries(cases.map(entry=>[entry.content,hash(entry.content)]));
const result={artifact,status:'RUNNING',cases:[],cleanup:{},boundary:'Chromium: actual extracted HistoryUserEntry/ResearchReply/metadata provider + real Source/Preview/ConversationMessage/Markdown. IPC catalog and source-open ACK, clipboard writer, queue status, timestamp and existing reveal transaction are controlled; no Electron/provider/OS clipboard/installed or real virtualizer-position acceptance.'};
const tracked=['src/renderer/components/Workspace/HistoryPanel.tsx','src/renderer/components/Workspace/TabMessageSourceChip.tsx',
 'src/renderer/components/Workspace/TabMessageSourceChip.css','src/renderer/components/Workspace/ResearchResultContent.tsx',
 'src/renderer/components/Workspace/ResearchResultContent.css','src/renderer/components/Workspace/TimelineEntryPreview.tsx',
 'src/renderer/components/Workspace/TimelineEntryPreview.css','src/renderer/utils/researchResultPresentation.mjs',
 'src/renderer/utils/researchModelCatalog.mjs','src/renderer/utils/useResearchRunModels.ts','src/renderer/utils/researchReplyClipboard.mjs'];
result.loadedHashes=Object.fromEntries(await Promise.all(tracked.map(async p=>[p,hash(await fs.readFile(path.join(root,p),'utf8'))])));
result.loadedHashes[tracked[0]]=hash(history);
const fixture=`
import React,{memo,useState,useRef,useMemo,useCallback,useEffect,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Copy,Check,RotateCcw,Trash2,ArrowUp,RefreshCw,Repeat2} from 'lucide-react';
import {ConversationMessage,MessageActionRail,MessageActionButton,MessageStatusBadge,setCopyTextImpl} from './packages/claude-blocks/src/index';
import {ResearchResultContent} from './src/renderer/components/Workspace/ResearchResultContent';
import {HistoryPromptSource,ResearchSourceAction} from './src/renderer/components/Workspace/TabMessageSourceChip';
import {TimelineEntryPreview} from './src/renderer/components/Workspace/TimelineEntryPreview';
import {researchReplyFromProjection} from './src/renderer/utils/researchResultPresentation.mjs';
import {buildResearchReplyClipboardPayload} from './src/renderer/utils/researchReplyClipboard.mjs';
import {useResearchRunModels} from './src/renderer/utils/useResearchRunModels';
import {timelineResearchModelLabel} from './src/renderer/utils/timelineEntryPreview.mjs';
import {projectHistoryServicePromptBody,resolveHistoryOrchestrationPromptPresentation,resolveHistoryPromptSender} from './src/renderer/utils/historyOrchestrationPromptPresentation.mjs';
import {buildHistoryComposerPresentationParts} from './src/renderer/utils/composerChips.mjs';
import {buildHistoryMessageClipboardPayload} from './src/renderer/utils/composerClipboard.mjs';
import {getAutomaticContinuationKind} from './src/shared/prompt-origin.mjs';
import './packages/claude-blocks/src/theme.css';
import './packages/claude-blocks/src/blocks.css';
const state=window.researchState;
setCopyTextImpl(text=>state.codeCopies.push(text));
const useUIStore={getState:()=>({showToast:()=>{}})};
const historyServicePromptFingerprint=text=>window.researchData.hashes[text];
const HISTORY_PROMPT_SENT_PRESENTATION_MS=1000;
const historyPromptHandoffStatusPresentation=()=>null,isLocalPromptEntry=()=>false;
const writeElectronComposerSnapshotClipboard=payload=>{state.copies.push(payload.text);return{textCopied:true,snapshotCopied:true}};
const historyDiag=()=>{},historyRecordTimeAttributes=()=>({});
const Tooltip=({children})=><>{children}</>;
const HistoryUserPromptBand=({parts})=><div>{parts.map((part,i)=><span key={i}>{part.chip?.label}</span>)}</div>;
const HistoryUserPromptContent=({text})=><div data-ordinary-body>{text}</div>;
// Reuse the host hook contract, but the actual retained Virtuoso owner is not
// present in this component proof. Each disclosure is one synchronous update.
const useHistoryRevealToggle=(anchor,open,setOpen)=>useCallback(()=>{state.reveals++;flushSync(()=>setOpen(!open))},[open]);
${wanted.map(name=>declarations[name]).join('\n')}
function Fixture(){
 const [config,setConfig]=useState({index:0,width:300,font:13,previewExpanded:false,session:'owner-a'});
 state.setCase=c=>flushSync(()=>setConfig(c));
 const entry=window.researchData.cases[config.index];
 const saved=useResearchRunModels('component-tab',config.session,config.index<7||config.index>=9);
 return <main style={{width:config.width,margin:16,fontSize:config.font,'--cb-fs-base':config.font+'px'}}>
  <input data-draft defaultValue="НЕ МЕНЯТЬ ЧЕРНОВИК"/>
  <section className="hp-history-transcript" data-history-fixture>
   <HistoryResearchModelsProvider tabId="component-tab" sessionId={config.session} enabled entries={[entry]}>
    <HistoryUserEntry key={entry.uuid} entry={entry} tabId="component-tab" toolType="codex"
      allowRewind={false} allowHistoryRewriteRewind={false} allowDeleteIteration={false}/>
   </HistoryResearchModelsProvider>
  </section>
  <section style={{border:'1px solid #444',padding:8,marginTop:10}} data-preview-fixture>
   <TimelineEntryPreview entry={entry} toolType="codex" expanded={config.previewExpanded} responseLines={3} fontSize={config.font}
    researchModel={saved?.[entry.semanticTags[0]?.runId]}
    onExpand={()=>state.setCase({...config,previewExpanded:!config.previewExpanded})}
    onCopy={text=>state.copies.push(text)} onNavigatePrompt={()=>state.navigations++} onNavigateAnswer={()=>state.navigations++}
    onSourceNavigate={()=>{}} loadResponse={()=>{throw Error('No provider read')}} loadImages={()=>Promise.resolve([])}/>
  </section>
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
let browser, page;
const errors=[]; result.pageErrors=errors;
try {
 const bundle=await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},jsx:'automatic',bundle:true,write:false,platform:'browser',format:'iife',target:'chrome120',outfile:path.join(artifact,'bundle.js'),loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'native-seams',setup(b){
  b.onResolve({filter:/^@noted\/claude-blocks$/},()=>({path:path.join(root,'packages/claude-blocks/src/index.ts')}));
  b.onResolve({filter:/\/store\/useWorkspaceStore$/},()=>({path:'workspace',namespace:'seams'}));
  b.onResolve({filter:/\/store\/useUIStore$/},()=>({path:'ui',namespace:'seams'}));
  b.onResolve({filter:/\/store\/useOrchestrationStore$/},()=>({path:'orchestration',namespace:'seams'}));
  b.onResolve({filter:/\/utils\/uiPerformanceDiagnostics\.mjs$/},()=>({path:'diagnostics',namespace:'seams'}));
  b.onResolve({filter:/^\.\/RequestTrackerRow$/},()=>({path:'row',namespace:'seams'}));
  b.onLoad({filter:/.*/,namespace:'seams'},a=>({loader:'ts',contents:a.path==='orchestration'
    ?'export const subscribeOrchestrationRunChanges=fn=>{window.researchState.listeners.add(fn);return()=>window.researchState.listeners.delete(fn)}'
    :a.path==='workspace'?'export const useWorkspaceStore=Object.assign(fn=>fn({openProjects:new Map()}),{getState:()=>({openProjects:new Map(),openTabById:async()=>false})})'
    :a.path==='ui'?'export const useUIStore={getState:()=>({showToast:()=>{}})}'
    :a.path==='diagnostics'?'export const currentUIActionId=()=>"component-action";export const uiPerformancePhase=(stage,data)=>window.researchState.measurements.push({stage,...data});export const uiPerformancePhaseForAction=(id,stage,data)=>window.researchState.measurements.push({id,stage,...data})'
    :'export const requestRowLinkStyle={};'}));
 }}]});
 browser=await chromium.launch({headless:true,channel:'chrome'});
 page=await browser.newPage({viewport:{width:1100,height:900},deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(String(e.stack)));
 await page.setContent('<html><body style="background:#191919;color:#ddd;font-family:Arial"><div id="root"></div></body></html>');
 await page.evaluate(data=>{
  window.researchData=data;
  const state=window.researchState={copies:[],codeCopies:[],ipc:[],listeners:new Set(),measurements:[],reveals:0,navigations:0};
  window.require=name=>name==='node:crypto'?{createHash:()=>({update:text=>({digest:()=>data.hashes[text]})})}
   :name==='electron'?{ipcRenderer:{invoke:async(channel,arg)=>{
    state.ipc.push({channel,arg});
    if(channel==='orchestration:list-for-tab')return data.cases.filter(e=>e.semanticTags.length).map(e=>({runId:e.semanticTags[0].runId,label:'Saved research task',runKind:'external-research',sourceTabId:'component-tab',externalResearchModel:data.model.model,externalResearchEffort:data.model.effort,externalResearchMode:data.model.mode}));
    if(channel==='orchestration:open-research-job')return{success:true,jobId:'component-saved-job'};
    throw Error('Unexpected IPC '+channel);
   },send:()=>{throw Error('No native writes')},on:()=>{},removeListener:()=>{}}}
   :(()=>{throw Error('No native access '+name)})();
 },{cases,hashes,model:witness.model||{model:'6',effort:'xhigh',mode:'chat'}});
 await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text+'\n'+historyCSS});
 await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
 await page.screenshot({path:path.join(artifact,'initial-full.png')});
 assert.deepEqual(errors,[],'actual renderer must mount before acceptance');
 await page.locator('[data-history-research-result]').waitFor();
 await page.locator('[data-history-fixture] .hp-research-result-model').waitFor();
 await page.screenshot({path:path.join(artifact,'initial-full.png')});
 for(const width of [300,650])for(const font of [13,20])for(let index=0;index<cases.length;index++){
  const config={index,width,font,previewExpanded:false,session:'owner-a'};
  await page.evaluate(c=>window.researchState.setCase(c),config);
  assert.deepEqual(errors,[]);
  const research=index<7||index>=9;
  assert.equal(await page.locator('[data-history-research-result]').count(),research?1:0);
  if(research){
   const scope=page.locator('[data-history-fixture]');
   const button=scope.locator('[data-research-disclosure]');
   if(index===9){const preview=page.locator('[data-research-preview]');const box=await preview.boundingBox();
    const actualFont=await preview.evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
    assert.ok(box.height<=actualFont*4.6,'physical prose preview is at most three inherited-font lines');
    assert.equal(await button.count(),1,'a clipped physical line remains expandable');}
   if(await button.count()){
    if(await scope.locator('[data-research-full]').count())await button.click();
    const before=await scope.locator('.hp-research-result-header').boundingBox();
    await button.click();await page.locator('[data-history-fixture] [data-research-full]').waitFor();
    const after=await scope.locator('.hp-research-result-header').boundingBox();
    for(const key of ['x','y','width'])assert.ok(Math.abs(before[key]-after[key])<1,'answer header remains stationary');
    const geometry=await page.evaluate(()=>{const r=document.querySelector('[data-history-fixture]'),b=r.querySelector('.cb-user-bubble'),body=r.querySelector('[data-research-full]');return{container:r.getBoundingClientRect().toJSON(),bubble:b.getBoundingClientRect().toJSON(),background:getComputedStyle(b).backgroundColor,border:getComputedStyle(b).borderTopWidth,body:{height:body.getBoundingClientRect().height,overflow:getComputedStyle(body).overflowY,scroll:body.scrollHeight,client:body.clientHeight},code:[...r.querySelectorAll('.cb-code-scroll')].map(n=>({overflow:getComputedStyle(n).overflowY,maxHeight:getComputedStyle(n).maxHeight})),text:r.textContent}});
    assert.ok(geometry.bubble.right<=geometry.container.right+1,'right-aligned bubble stays in its owner');
    for(const code of geometry.code){assert.equal(code.overflow,'visible');assert.equal(code.maxHeight,'none');}
    assert.equal(geometry.background,'rgba(0, 0, 0, 0)');assert.equal(geometry.border,'0px');
    assert.ok(geometry.body.height<=180.1);assert.equal(geometry.body.overflow,'auto');
    if(index===3)assert.ok(geometry.body.scroll>geometry.body.client,'large JSONL has a real bounded scroll range');
    if(index===0)assert.ok(!geometry.text.includes('<CodeBlock'),'exact wrapper is hidden only in display');
    if(width===650&&font===13&&index===0)await page.locator('[data-history-fixture]').screenshot({path:path.join(artifact,'actual-expanded.png')});
    await button.click();
    await button.dblclick();assert.equal(await page.locator('[data-history-fixture] [data-research-full]').count(),0,'rapid double toggle returns to collapsed');
    await button.press('Enter');await button.press('Enter');
    assert.equal(await page.locator('[data-history-fixture] [data-research-full]').count(),0);
    const fullHeader=scope.locator('.hp-research-result-toggle'), box=await fullHeader.boundingBox();
    await fullHeader.click({position:{x:box.width-4,y:box.height/2}});
    assert.equal(await scope.locator('[data-research-full]').count(),1,'empty header area toggles too');
    await scope.locator('[data-external-research-source]').click();
    assert.equal(await scope.locator('[data-research-full]').count(),1,'source action does not toggle');
    await button.click();
   }else assert.equal(await button.count(),0,'short answers do not need a collapse layer');
   assert.equal(await scope.locator('[data-research-summary]').count(),0,'format/count is not the collapsed headline');
   assert.ok(await scope.locator('[data-research-preview]').textContent());
   await scope.getByRole('button',{name:/^(Copy original answer|Copied)$/}).click();
   assert.equal(await page.evaluate(()=>window.researchState.copies.at(-1)),cases[index].content);
  }
  const expand=page.locator('[data-preview-fixture]').getByRole('button',{name:'Развернуть превью',exact:true});
  if(await expand.count()){await expand.click();assert.deepEqual(errors,[]);await page.locator('[data-preview-fixture]').getByRole('button',{name:'Свернуть превью',exact:true}).click();}
  assert.equal(await page.locator('[data-draft]').inputValue(),'НЕ МЕНЯТЬ ЧЕРНОВИК');
  if(width===300&&font===13&&index===0)await page.locator('[data-history-fixture]').screenshot({path:path.join(artifact,'actual-collapsed.png')});
  result.cases.push({index,width,font,research});
 }
 result.catalogReads=await page.evaluate(()=>window.researchState.ipc.filter(x=>x.channel==='orchestration:list-for-tab').length);
 assert.equal(result.catalogReads,1,'History and Timeline share one same-owner metadata catalog');
 result.currentHashes=Object.fromEntries(await Promise.all(tracked.map(async p=>[p,hash(await fs.readFile(path.join(root,p),'utf8'))])));
 assert.deepEqual(result.currentHashes,result.loadedHashes,'loaded/current source must match');
 result.pageErrors=errors;assert.deepEqual(errors,[]);result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;
 if(page)await page.screenshot({path:path.join(artifact,'failure-full.png')}).catch(()=>{});}
finally{if(browser){await browser.close();result.cleanup.browserClosed=true;}
 await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({status:result.status,artifact,cases:result.cases.length,error:result.error,pageErrors:result.pageErrors,cleanup:result.cleanup}));}

#!/usr/bin/env node
// Actual shared header + actual extracted primary callback/reveal helper and
// flat Virtuoso. Optional public rows come from the bounded Application API;
// the default is explicit synthetic rows with the user's reported caption.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const reportedCaption='Нашёл подтверждённый сбой: в **17:57:41 по Бангкоку** главный процесс приложения аварийно завершился с ошибкой памяти V8. Это внутренний лимит JavaScript-памяти процесса; свободная оперативка компьютера сама по себе от такого падения не защищает.\n\nMCP уже восстановились, все шесть серверов работают. Теперь выясняю, что удерживало память перед падением и какая операция потребовала последнего выделения.';
const fixtureCall=i=>({uuid:'reported-call-'+i,role:'assistant',content:'',actions:[{tool:'__raw__',rawTool:{toolName:'Bash',family:'run',toolUseId:'reported-tool-'+i,args:{command:'python3'},result:'fixture only'}}]});
const witness=process.argv[2]?JSON.parse(await fs.readFile(process.argv[2],'utf8')):{
 dataOrigin:'Synthetic component rows; first caption transcribed from user screenshots. No executed Bash or crash investigation.',
 readSessionId:null,exactScreenshot:false,entries:[
  {uuid:'reported-caption-1',role:'assistant',textPhase:'commentary',content:reportedCaption},fixtureCall(1),
  {uuid:'reported-caption-2',role:'assistant',textPhase:'commentary',content:'Второе описание для проверки переключения.'},fixtureCall(2)]};
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-caption-cycle-'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const history=await fs.readFile(path.join(root,'src/renderer/components/Workspace/HistoryPanel.tsx'),'utf8');
const tree=ts.createSourceFile('HistoryPanel.tsx',history,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const wanted=['findHistoryScrollParent','applyHistoryRevealUpdate','historyRevealOpsByScroller','cycleHistoryGroupCaption'],decl={};
const visit=node=>{if(ts.isVariableDeclaration(node)&&wanted.includes(node.name.getText(tree)))decl[node.name.getText(tree)]='const '+node.getText(tree)+';';
 if(ts.isFunctionDeclaration(node)&&wanted.includes(node.name?.text))decl[node.name.text]=node.getText(tree);ts.forEachChild(node,visit)};
visit(tree);for(const name of wanted)assert.ok(decl[name],name);
const ratio=history.match(/const HISTORY_SERVICE_TEXT_RATIO = ([.\d]+);/)[1];
const a=history.indexOf('.hp-history-group {'),b=history.indexOf('/* Expanded members:',a);
assert.ok(a>=0&&b>a);const css=history.slice(a,b).replaceAll('${HISTORY_SERVICE_TEXT_RATIO}',ratio);
const {makeHistoryRowStub}=require('../src/main/history-entry-window.js');
const comment=(id,text)=>({uuid:id,sourceIdentity:'source-'+id,role:'assistant',content:text,textPhase:'commentary',
 recordTime:witness.entries.find(e=>e.content)?.recordTime});
const call=i=>({uuid:'call-'+i,role:'assistant',content:'',actions:[{tool:'__raw__',rawTool:{toolName:'Bash',family:'run',toolUseId:'tool-'+i,args:{command:'node script.js'},result:'done'}}]});
const captions=[comment('caption-a','First short text.'),comment('caption-b','Second text. '+ 'A longer wrapped caption. '.repeat(12)),comment('caption-c','Last text. '+ 'Summary line. '.repeat(3))];
const synthetic=captions.flatMap((e,i)=>[e,call(i)]);
const tracked=['src/renderer/components/Workspace/HistoryPanel.tsx','src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx',
 'src/renderer/utils/historyDisplayUnits.mjs','src/renderer/utils/historyGroupCaption.mjs','src/renderer/utils/historyMaterializedWindow.mjs',
 'src/renderer/utils/historyCardRevealAnchor.mjs','src/renderer/utils/historyRevealAnchor.mjs','src/renderer/utils/historyRecordTimePresentation.mjs'];
const result={artifact,status:'RUNNING',checks:[],cleanup:{},witness:{readSessionId:witness.readSessionId,exactScreenshot:witness.exactScreenshot,
 uuids:witness.entries.map(e=>e.uuid),hashes:witness.entries.filter(e=>e.content).map(e=>hash(e.content))},
 boundary:'Chromium: actual shared group header/projection, actual extracted primary caption callback and applyHistoryRevealUpdate, real flat Virtuoso and existing reveal-anchor helper. '+(witness.dataOrigin||'Bounded public group is real but not claimed the exact screenshot.')+' Hydration deliveries, presentation/gesture owner state, follow intent and diagnostics sink are controlled. No full retained History/provider/installed/native cursor/clipboard or performance acceptance.'};
result.loadedHashes=Object.fromEntries(await Promise.all(tracked.map(async f=>[f,hash(await fs.readFile(path.join(root,f),'utf8'))])));
const fixture=`
import React,{useState,useRef,useMemo,useCallback} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {Virtuoso} from 'react-virtuoso';
import {HistoryCollapsedGroupRow} from './src/renderer/components/Workspace/HistoryTranscriptPresentation';
import {buildHistoryDisplayUnits} from './src/renderer/utils/historyDisplayUnits.mjs';
import {historyGroupCaptionIdentity,rememberHistoryGroupCaption} from './src/renderer/utils/historyGroupCaption.mjs';
import {createHistoryCardRevealAnchor} from './src/renderer/utils/historyCardRevealAnchor.mjs';
import './packages/claude-blocks/src/theme.css';import './packages/claude-blocks/src/blocks.css';
const state=window.captionState,historyDiag=text=>state.logs.push(text),uiPerformancePhase=(stage,data)=>state.phases.push({stage,...data});
${['findHistoryScrollParent','historyRevealOpsByScroller','applyHistoryRevealUpdate'].map(n=>decl[n]).join('\n')}
function Fixture(){
 const [config,setConfig]=useState({width:650,font:13,mode:'public',owner:'a',presented:true});
 const [follow,setFollow]=useState(false),[loaded,setLoaded]=useState(false),[append,setAppend]=useState(false),[expanded,setExpanded]=useState(false);
 const tabId='caption-component-tab',historyOwnerKey=config.owner;
 const historyOwnerKeyRef=useRef(historyOwnerKey);historyOwnerKeyRef.current=historyOwnerKey;
 const historyPresentationProofRef=useRef({presented:true});historyPresentationProofRef.current={presented:config.presented};
 const groupCaptionSelectionsRef=useRef(new Map()),previousOwner=useRef(historyOwnerKey);
 if(previousOwner.current!==historyOwnerKey){groupCaptionSelectionsRef.current.clear();previousOwner.current=historyOwnerKey}
 const requestHistoryHydrationAt=(uuid,reason)=>{state.requests.push({uuid,reason});return true};
 ${decl.cycleHistoryGroupCaption}
 const rows=config.mode==='public'?window.captionData.public:config.mode==='stub'&&!loaded?window.captionData.stubs:
  config.mode==='single'?window.captionData.synthetic.slice(0,2).concat([window.captionData.synthetic[3]]):window.captionData.synthetic;
 const actual=append?[...rows,window.captionData.added,window.captionData.synthetic[1]]:rows;
 const group=useMemo(()=>buildHistoryDisplayUnits(actual).find(u=>u.kind==='group'),[actual]);
 const anchor=useMemo(()=>createHistoryCardRevealAnchor({getScroller:()=>state.scroller,getOwnerToken:()=>historyOwnerKeyRef.current,
  getGestureGeneration:()=>0,isPresented:()=>historyPresentationProofRef.current.presented}),[]);
 const ref=useRef(null);
 state.setCase=c=>flushSync(()=>{setConfig(c);setLoaded(false);setAppend(false);setExpanded(false);groupCaptionSelectionsRef.current.clear()});
 state.load=()=>flushSync(()=>setLoaded(true));state.append=()=>flushSync(()=>setAppend(true));
 state.presented=value=>flushSync(()=>setConfig(c=>({...c,presented:value})));
 state.owner=value=>flushSync(()=>setConfig(c=>({...c,owner:value})));
 state.seek=()=>ref.current?.scrollToIndex({index:6,align:'start',behavior:'auto'});
 state.units=group;
 const data=Array.from({length:14},(_,i)=>i===6?group:{kind:'filler',key:'filler-'+i});
 const bind=node=>{if(!(node instanceof HTMLElement))return;state.scroller=node;
  historyRevealOpsByScroller.set(node,{unpinTail:()=>{state.unpins++;flushSync(()=>setFollow(false))},afterRevealCommit:(a,o)=>anchor.afterCommit(a,o)});
 };
 return <main style={{width:config.width,fontSize:config.font,margin:16,'--cb-fs-base':config.font+'px'}}>
  <input data-draft defaultValue="Do not change draft"/>
  <Virtuoso ref={ref} className="hp-history-transcript" style={{height:620}} scrollerRef={bind} followOutput={follow} data={data}
   computeItemKey={(_,u)=>u.key} itemContent={(_,unit)=>unit.kind==='group'?<div data-history-group={unit.key} data-history-unit-key={unit.key} data-uuid={unit.entries[0].uuid}>
    <HistoryCollapsedGroupRow group={unit} expanded={expanded} captionOwnerKey={historyOwnerKey}
     captionIdentity={groupCaptionSelectionsRef.current.get(unit.key)||null} onCaptionChange={cycleHistoryGroupCaption}
     onToggle={()=>{state.expands++;setExpanded(!expanded)}}/>
   </div>:<div style={{height:80}}>Earlier or later independent row</div>}/>
 </main>;
}
window.require=()=>{throw Error('No native/clipboard/provider access')};createRoot(document.getElementById('root')).render(<Fixture/>);
`;
let browser,page;const errors=[];result.pageErrors=errors;
try{
 const bundle=await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},jsx:'automatic',bundle:true,write:false,platform:'browser',format:'iife',
  target:'chrome120',outfile:path.join(artifact,'bundle.js'),loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',
  plugins:[{name:'package',setup(b){b.onResolve({filter:/^@noted\/claude-blocks$/},()=>({path:path.join(root,'packages/claude-blocks/src/index.ts')}))}}]});
 browser=await chromium.launch({headless:true,channel:'chrome'});page=await browser.newPage({viewport:{width:1200,height:850},deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(String(e.stack)));
 await page.setContent('<html><body style="background:#151515;color:#ddd;font-family:Arial"><div id="root"></div></body></html>');
 await page.evaluate(data=>{window.captionData=data;window.captionState={requests:[],logs:[],phases:[],unpins:0,expands:0};},
  {public:witness.entries,synthetic,stubs:synthetic.map(makeHistoryRowStub),added:comment('caption-new','New appended text.')});
 await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text+'\n'+css});
 await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
 const number=()=>page.locator('.hp-history-caption-number');
 await page.evaluate(()=>window.captionState.seek());await number().waitFor();assert.deepEqual(errors,[]);
 for(const width of [300,650])for(const font of [13,20]){
  await page.evaluate(c=>window.captionState.setCase(c),{width,font,mode:'public',owner:'a',presented:true});
  await page.evaluate(()=>window.captionState.seek());await number().waitFor();
  assert.equal(await number().textContent(),'2');assert.equal(await number().getAttribute('title'),'Text 2 of 2 · Click for previous text');
  await number().hover();assert.equal(await number().evaluate(n=>getComputedStyle(n).cursor),'pointer');
  assert.equal(await number().evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(255, 255, 255, 0.08)');
  const before=await number().boundingBox();await number().click();assert.equal(await number().textContent(),'1');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
  const after=await number().boundingBox();assert.ok(Math.abs(after.y-before.y)<2,'cycle preserves clicked-number position in the real virtualizer');
  const first=witness.entries.find(e=>e.content?.trim());
  assert.equal(await page.locator('[data-history-caption-uuid]').getAttribute('data-history-caption-uuid'),first.uuid);
  const captionMetrics=await page.locator('.hp-history-group-detail').evaluate(n=>{
   const text=n.querySelector('.hp-history-caption-text'),number=n.querySelector('.hp-history-caption-number'),corner=n.querySelector('.hp-history-caption-gutter > span');
   const glyphLeft=el=>{const range=document.createRange();range.selectNodeContents(el);const r=range.getBoundingClientRect(),s=getComputedStyle(el);
    const context=document.createElement('canvas').getContext('2d');context.font=s.fontStyle+' '+s.fontWeight+' '+s.fontSize+' '+s.fontFamily;
    return r.x-context.measureText(el.textContent).actualBoundingBoxLeft;};
   const at=offset=>{const range=document.createRange();range.setStart(text.firstChild,offset);range.setEnd(text.firstChild,offset+1);return range.getBoundingClientRect().y;};
   const mcp=text.textContent.indexOf('\n\nMCP');
   return {text:text.textContent,whiteSpace:getComputedStyle(text).whiteSpace,width:text.clientWidth,scrollWidth:text.scrollWidth,
    numberLeft:glyphLeft(number),cornerLeft:glyphLeft(corner),translate:getComputedStyle(number).translate,
    paragraphDelta:mcp>=0?at(mcp+2)-at(mcp-1):null,lineHeight:parseFloat(getComputedStyle(text).lineHeight)};
  });
  result.checks.push({width,font,captionMetrics});
  assert.equal(captionMetrics.text,first.content.trim());assert.equal(captionMetrics.whiteSpace,'pre-wrap');
  assert.ok(captionMetrics.scrollWidth<=captionMetrics.width+1,'caption wraps inside its text column');
  assert.ok(Math.abs(captionMetrics.numberLeft-captionMetrics.cornerLeft)<2,'first digit aligns with the corner vertical stroke');
  if(captionMetrics.paragraphDelta!==null)assert.ok(captionMetrics.paragraphDelta>1.5*captionMetrics.lineHeight,'original blank line before MCP stays visible');
  if(witness.dataOrigin)await page.screenshot({path:path.join(artifact,`reported-caption-${width}-${font}.png`)});
  await number().click();assert.equal(await number().textContent(),'2','wraps back to latest');
  assert.equal(await page.locator('[aria-expanded]').getAttribute('aria-expanded'),'false','number never opens group');
  assert.equal(await page.locator('[data-draft]').inputValue(),'Do not change draft');
  if(width===650&&font===20)await page.screenshot({path:path.join(artifact,'actual-public-caption.png')});
  result.checks.push({width,font,check:'two captions/cycle/wrap/pointer/hover/stationary/draft, original paragraphs and gutter alignment'});
 }
 await page.evaluate(c=>window.captionState.setCase(c),{width:650,font:13,mode:'synthetic',owner:'a',presented:true});
 await page.evaluate(()=>window.captionState.seek());await number().waitFor();assert.equal(await number().textContent(),'3');
 await number().click();assert.equal(await number().textContent(),'2');await number().click();assert.equal(await number().textContent(),'1');
 await number().click();assert.equal(await number().textContent(),'3');await number().press('Enter');assert.equal(await number().textContent(),'2');
 await number().press('Space');assert.equal(await number().textContent(),'1');
 await page.evaluate(()=>window.captionState.append());assert.equal(await number().textContent(),'1');
 assert.match(await number().getAttribute('title'),/Text 1 of 4/);
 result.checks.push('three captions and native keyboard wrap; manual choice survives append');
 await page.evaluate(()=>window.captionState.owner('b'));assert.equal(await number().textContent(),'4','new owner cannot inherit selection');
 await page.evaluate(()=>window.captionState.owner('a'));assert.equal(await number().textContent(),'4','A→B→A cannot resurrect a cleared old choice');
 await page.evaluate(()=>window.captionState.presented(false));await number().click();assert.equal(await number().textContent(),'4','non-presented callback has no authority');
 result.checks.push('owner switch and non-presented guard');
 await page.evaluate(c=>window.captionState.setCase(c),{width:650,font:13,mode:'single',owner:'a',presented:true});
 await page.evaluate(()=>window.captionState.seek());await page.locator('[data-history-caption-uuid]').waitFor();
 assert.equal(await number().count(),0);assert.match(await page.locator('.hp-history-group-detail').textContent(),/First short text/);
 result.checks.push('one caption remains readable without a number or inert navigation control');
 await page.evaluate(c=>window.captionState.setCase(c),{width:650,font:13,mode:'stub',owner:'a',presented:true});
 await page.evaluate(()=>window.captionState.seek());await number().waitFor();await number().click();
 assert.equal(await number().textContent(),'2');assert.equal(await page.locator('.hp-history-group-detail').textContent(),'└2Loading text…');
 assert.deepEqual(await page.evaluate(()=>window.captionState.requests.at(-1)),{uuid:'caption-b',reason:'group-caption'});
 await page.evaluate(()=>window.captionState.load());assert.equal(await number().textContent(),'2');
 assert.match(await page.locator('.hp-history-group-detail').textContent(),/Second text/);
 result.checks.push('stub selection uses exact old hydration callback and cannot display a neighbour as the chosen text');
 assert.equal(await page.evaluate(()=>window.captionState.expands),0);
 assert.ok(await page.evaluate(()=>window.captionState.unpins)>0);
 assert.ok(await page.evaluate(()=>window.captionState.phases.some(p=>p.stage==='history-group-caption-cycle')));
 assert.deepEqual(errors,[]);
 result.currentHashes=Object.fromEntries(await Promise.all(tracked.map(async f=>[f,hash(await fs.readFile(path.join(root,f),'utf8'))])));
 assert.deepEqual(result.currentHashes,result.loadedHashes);result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;if(page)await page.screenshot({path:path.join(artifact,'failure-full.png')}).catch(()=>{});}
finally{if(browser){await browser.close();result.cleanup.browserClosed=true;}
 await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({status:result.status,artifact,checks:result.checks.length,error:result.error,pageErrors:errors,cleanup:result.cleanup}));}

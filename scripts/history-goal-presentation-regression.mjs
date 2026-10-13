#!/usr/bin/env node
// Component proof of the actual HistoryEntry/GoalRow + actual Preview/CSS.
// No provider/clipboard/production input and no full Electron acceptance.
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
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-goal-presentation-'));
const hash = text => createHash('sha256').update(text).digest('hex');
const history = await fs.readFile(path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const wanted = new Set(['HistoryEntry', 'HistoryGoalRow']), declarations = {};
const tree = ts.createSourceFile('HistoryPanel.tsx', history, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
for (const statement of tree.statements) if (ts.isVariableStatement(statement))
  for (const item of statement.declarationList.declarations) if (wanted.has(item.name.getText(tree)))
    declarations[item.name.getText(tree)] = 'const ' + item.getText(tree) + ';';
for (const name of wanted) assert.ok(declarations[name], name);
const css = history.slice(history.indexOf('.hp-history-slash {'), history.indexOf('/* One response-level timer'));
assert.ok(css.includes('.hp-history-goal'));
const sid='4a2ba840-c002-4141-b3c3-e592f5641cbf';
const entries = [
 {uuid:`codex-user-${sid}-31775`,sourceIdentity:`codex-user-source-${sid}-228537875`,role:'user',type:'user',timestamp:'2026-10-10T06:23:30.722Z',content:'<codex_internal_context source="user_goal">\nUser set goal status: "paused".\n</codex_internal_context>',expected:'Goal paused',previewKind:'goal-status'},
 {uuid:`codex-user-${sid}-31779`,sourceIdentity:`codex-user-source-${sid}-228544805`,role:'user',type:'user',timestamp:'2026-10-10T06:55:18.524Z',content:'<codex_internal_context source="user_goal">\nUser set goal status: "active".\n</codex_internal_context>',expected:'Goal active',previewKind:'goal-status'},
 {uuid:`codex-user-${sid}-31758`,sourceIdentity:`codex-user-source-${sid}-228460469`,role:'goal',type:'user',serviceCarrier:'goal-continuation',isGoalContinuation:true,timestamp:'2026-10-10T06:21:28.720Z',content:'Goal continued',expected:'Goal continued',previewKind:'goal'},
 {uuid:`codex-user-${sid}-31789`,role:'user',type:'user',timestamp:'2026-10-10T06:55:32.191Z',content:'продолжай работу, и можешь всё, что касается вакансий, делать в основном окне. Ну, то есть не открывать дополнительные окна Яндекса.',expected:null,previewKind:'iteration'},
];
const quoted={...entries[0],uuid:'codex-user-quoted',content:'Example: '+entries[0].content,expected:null,previewKind:'iteration'};
entries.push(quoted);
const fixture=`
import React,{memo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Target} from 'lucide-react';
import {ConversationMessage} from './packages/claude-blocks/src/index';
import {TimelineEntryPreview} from './src/renderer/components/Workspace/TimelineEntryPreview';
import {codexGoalPresentation,filterTimelineGoalPresentation} from './src/renderer/utils/codexGoalPresentation.mjs';
import './packages/claude-blocks/src/theme.css';
import './packages/claude-blocks/src/blocks.css';
const historyRecordTimeAttributes=()=>({});
// Ordinary user renderer is outside this Goal slice; the real route must
// reach it for a normal prompt/quoted negative, not paint it as Goal.
const HistoryUserEntry=({entry})=><div data-user-renderer>{entry.content}</div>;
${declarations.HistoryGoalRow}
${declarations.HistoryEntry}
const state=window.goalFixture={copies:[],navs:0};
window.require=()=>{throw Error('No native/clipboard/provider access in this component test')};
function Fixture(){
 const [config,setConfig]=useState({index:0,width:350,font:13,expanded:false});
 state.setCase=config=>flushSync(()=>setConfig(config));
 const entry=window.goalEntries[config.index];
 const shown=filterTimelineGoalPresentation(window.goalEntries,'codex');
 return <main style={{width:config.width,margin:20}}>
  <section data-history-fixture style={{fontSize:config.font}}>
   <HistoryEntry entry={entry} toolType="codex" tabId="private-goal-component"/>
  </section>
  <section data-rail-fixture>{shown.map(e=><span key={e.uuid} data-visible-point={e.uuid}>●</span>)}</section>
  <section data-dormant-preview style={{marginTop:12,border:'1px solid #555',padding:9}}>
   <TimelineEntryPreview entry={entry} toolType="codex" expanded={config.expanded} fontSize={config.font} responseLines={3}
    onExpand={()=>{}} onNavigatePrompt={()=>state.navs++} onNavigateAnswer={()=>state.navs++}
    onSourceNavigate={()=>{throw Error('Source navigation outside Goal slice')}}
    onCopy={text=>state.copies.push(text)} loadResponse={()=>{throw Error('Provider read forbidden')}} loadImages={()=>Promise.resolve([])}/>
  </section>
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const result={artifact,status:'RUNNING',cases:[],boundary:'Actual extracted HistoryEntry/GoalRow + real ConversationMessage and TimelineEntryPreview. Ordinary History user renderer and time attributes are stubbed; rail markers are fixture fed by real shared filter (actual final Timeline useMemo separately tested). Source navigation stub never called. No Electron/provider/OS clipboard/installed acceptance.',cleanup:{}};
let browser;
try{
 const bundle=await build({stdin:{contents:fixture,loader:'tsx',resolveDir:root},bundle:true,write:false,
  outfile:path.join(artifact,'bundle.js'),platform:'browser',format:'iife',target:'chrome120',loader:{'.png':'dataurl'},
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',plugins:[{name:'unused-source-seam',setup(b){
   b.onResolve({filter:/^@noted\/claude-blocks$/},()=>({path:path.join(root,'packages/claude-blocks/src/index.ts')}));
   b.onResolve({filter:/^\.\/TabMessageSourceChip$/},a=>({path:a.path,namespace:'unused-source'}));
   b.onLoad({filter:/.*/,namespace:'unused-source'},()=>({loader:'tsx',contents:'export function HistoryPromptSource(){throw Error("Source branch not used");}'}));
  }}]});
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(String(e.stack)));
 await page.setContent('<html><body style="background:#191919;color:#ddd;font-family:Arial"><div id="root"></div></body></html>');
 await page.evaluate(entries=>window.goalEntries=entries,entries);
 await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text+'\n'+css});
 await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
 await page.locator('[data-history-fixture]').waitFor();
 for(const width of [300,650])for(const font of [13,20])for(const expanded of [false,true])for(let index=0;index<entries.length;index++){
  const entry=entries[index],config={index,width,font,expanded};
  await page.evaluate(c=>window.goalFixture.setCase(c),config);
  assert.deepEqual(errors,[]);
  const actual=await page.evaluate(()=>{
   const h=document.querySelector('[data-history-fixture]'),g=h.querySelector('[data-history-goal-kind]'),p=document.querySelector('[data-timeline-preview]'),k=p.querySelector('.timeline-preview-kind');
   return{historyText:h.textContent,goal:!!g,color:g?getComputedStyle(g).color:null,height:h.getBoundingClientRect().height,
    bubble:h.querySelectorAll('.cb-user-bubble').length,preview:p.dataset.timelinePreview,kindColor:getComputedStyle(k).color,
    body:p.querySelector('[data-timeline-preview-prompt]').textContent,promptRole:p.querySelector('[data-timeline-preview-prompt]').getAttribute('role'),
    rail:[...document.querySelectorAll('[data-visible-point]')].map(x=>x.dataset.visiblePoint),navs:window.goalFixture.navs};
  });
  assert.equal(actual.goal,!!entry.expected);assert.equal(actual.preview,entry.previewKind);
  assert.deepEqual(actual.rail,[entries[3].uuid,quoted.uuid]);
  if(entry.expected){assert.equal(actual.historyText,entry.expected);assert.equal(actual.body,entry.expected);
   assert.equal(actual.bubble,0);assert.equal(actual.color,'rgb(146, 117, 189)');assert.equal(actual.kindColor,'rgb(167, 139, 250)');
   assert.equal(actual.promptRole,null);assert.ok(actual.height<font*3,'service row must stay compact');
   await page.locator('[data-timeline-preview-prompt]').click();assert.equal(await page.evaluate(()=>window.goalFixture.navs),actual.navs);
  }else{assert.equal(actual.historyText,entry.content);assert.equal(actual.kindColor,'rgb(238, 173, 120)');}
  result.cases.push({uuid:entry.uuid,...config,...actual});
  if(width===300&&font===13&&!expanded&&index<3){
   await page.locator('[data-history-fixture]').screenshot({path:path.join(artifact,'history-'+index+'.png')});
   await page.locator('[data-dormant-preview]').screenshot({path:path.join(artifact,'dormant-preview-'+index+'.png')});
   // Copy feedback is tested with a callback sink, never the OS clipboard.
   await page.getByRole('button',{name:'Копировать исходный текст'}).click();
   assert.equal(await page.evaluate(()=>window.goalFixture.copies.at(-1)),entry.content);
  }
 }
 result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;}
finally{
 if(browser){await browser.close();result.cleanup.browserClosed=true;}
 result.sourceHashes={};
 for(const p of ['src/renderer/components/Workspace/HistoryPanel.tsx','src/renderer/components/Workspace/Timeline.tsx',
  'src/renderer/components/Workspace/TimelineEntryPreview.tsx','src/renderer/components/Workspace/TimelineEntryPreview.css',
  'src/renderer/utils/codexGoalPresentation.mjs','src/renderer/utils/timelineEntryPreview.mjs','src/renderer/utils/timelineTranscriptRefresh.mjs'])
  result.sourceHashes[p]=hash(await fs.readFile(path.join(root,p)));
 result.loadedHistoryStable=result.sourceHashes['src/renderer/components/Workspace/HistoryPanel.tsx']===hash(history);
 if(!result.loadedHistoryStable){result.status='FAIL';result.error='History source changed during capture';process.exitCode=1;}
 await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({artifact,status:result.status,cases:result.cases.length,error:result.error,cleanup:result.cleanup}));
}

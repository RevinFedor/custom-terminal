#!/usr/bin/env node
// Actual SubAgentBlock and actual existing controller callbacks. Inspector
// contents/time attributes are controlled; no provider/runtime/clipboard.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('..',import.meta.url));
const file=path.join(root,'src/renderer/components/Workspace/HistoryPanel.tsx');
const source=await fs.readFile(file,'utf8'),hash=text=>createHash('sha256').update(text).digest('hex');
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-agent-row-toggle-'));
const wanted=['SubAgentBlock','HistoryAgentInspectorContext','formatSubagentDuration','historyAgentKey',
  'openHistoryAgent','toggleHistoryDetail','agentInspectorController'];
const tree=ts.createSourceFile('HistoryPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),decls={};
const visit=node=>{if(ts.isVariableDeclaration(node)&&wanted.includes(node.name.getText(tree)))
  decls[node.name.getText(tree)]='const '+node.getText(tree)+';';ts.forEachChild(node,visit)};
visit(tree);for(const name of wanted)assert.ok(decls[name],name);
const fixture=`
import React,{memo,useState,useMemo,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {Bot,Loader2,ChevronDown,ChevronRight} from 'lucide-react';
const historyRecordTimeAttributes=()=>({});
${['formatSubagentDuration','historyAgentKey','HistoryAgentInspectorContext','SubAgentBlock'].map(n=>decls[n]).join('\n')}
const state=window.agentToggle={};
function Fixture(){
 const [expandedBackgroundChipKey,setExpandedBackgroundChipKey]=useState(null);
 const [agentRosterOpen,setAgentRosterOpen]=useState(false);
 ${['openHistoryAgent','toggleHistoryDetail','agentInspectorController'].map(n=>decls[n]).join('\n')}
 state.openDirect=openHistoryAgent;
 return <main style={{width:500,margin:20}}>
  <input data-draft defaultValue="Сохранить ввод"/>
  {expandedBackgroundChipKey&&<div data-agent-menu={expandedBackgroundChipKey} style={{position:'fixed',left:550,top:20,padding:5,background:'#28232f'}}>Панель агента: {expandedBackgroundChipKey}</div>}
  <HistoryAgentInspectorContext.Provider value={agentInspectorController}>
   <SubAgentBlock entryUuid="row-a" live={false} action={{toolUseId:'child-a',description:'Authorizedcareer research sidecar, ONLY interview-case depth — Fermat',subagentStatus:'interrupted'}}/>
   <SubAgentBlock entryUuid="row-b" live={false} action={{toolUseId:'child-b',description:'Second saved child',subagentStatus:'completed',durationMs:12000}}/>
  </HistoryAgentInspectorContext.Provider>
 </main>;
}
window.require=()=>{throw Error('No runtime/clipboard/IPC in this component proof')};
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const result={artifact,status:'RUNNING',loadedHistoryHash:hash(source),checks:[],cleanup:{},
 boundary:'Chromium: actual extracted SubAgentBlock + open/toggle/controller callbacks. Inspector contents and time metadata stubbed; no full History/child reader/provider/installed acceptance.'};
let browser;
try{
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,
  format:'iife',platform:'browser',jsx:'automatic',outfile:path.join(artifact,'bundle.js'),logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:800,height:400},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',error=>errors.push(String(error.stack)));
 await page.setContent('<html><body style="background:#191919;color:#ddd;font:16px Arial"><div id="root"></div></body></html>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.screenshot({path:path.join(artifact,'initial-full.png')});
 assert.deepEqual(errors,[]);
 const a=page.locator('[data-history-agent-card="task:child-a"] button'),b=page.locator('[data-history-agent-card="task:child-b"] button');
 await a.waitFor();
 assert.equal(await a.getAttribute('aria-expanded'),'false');
 await a.click();assert.equal(await a.getAttribute('aria-expanded'),'true');
 assert.equal(await page.locator('[data-agent-menu]').getAttribute('data-agent-menu'),'task:child-a');
 await page.screenshot({path:path.join(artifact,'opened-full.png')});
 await a.click();assert.equal(await a.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('[data-agent-menu]').count(),0);
 result.checks.push('same row open/close');
 await a.dblclick();assert.equal(await page.locator('[data-agent-menu]').count(),0);
 result.checks.push('rapid repeated click returns to closed');
 await a.click();await b.click();assert.equal(await b.getAttribute('aria-expanded'),'true');assert.equal(await a.getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('[data-agent-menu]').getAttribute('data-agent-menu'),'task:child-b');
 result.checks.push('different row selects exact other child');
 await page.evaluate(()=>window.agentToggle.openDirect('task:child-b'));
 assert.equal(await page.locator('[data-agent-menu]').count(),1,'external open remains idempotent, not a toggle');
 result.checks.push('navigation/open contract preserved');
 await b.press('Enter');assert.equal(await page.locator('[data-agent-menu]').count(),0);
 result.checks.push('keyboard can close the same row');
 for(const card of await page.locator('[data-history-agent-card]').all())assert.equal(await card.evaluate(n=>getComputedStyle(n).borderLeftWidth),'0px');
 result.checks.push('agent row border removed');
 assert.equal(await page.locator('[data-draft]').inputValue(),'Сохранить ввод');
 await page.screenshot({path:path.join(artifact,'closed-full.png')});
 result.currentHistoryHash=hash(await fs.readFile(file,'utf8'));assert.equal(result.currentHistoryHash,result.loadedHistoryHash);
 assert.deepEqual(errors,[]);result.pageErrors=errors;result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;}
finally{if(browser){await browser.close();result.cleanup.browserClosed=true;}
 await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({status:result.status,artifact,checks:result.checks.length,error:result.error,cleanup:result.cleanup}));}

#!/usr/bin/env node
// Actual History card/helper + claude-blocks + actual Main menu callbacks.
// Payload/reveal/time environment and native Menu/editor effects are controlled;
// this is component/dispatch QA, not installed app/GT GUI acceptance.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { historyFileMenuHarness } from './lib/history-file-menu-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-file-menu-'));
const history = await fs.readFile(path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const main = await fs.readFile(path.join(root, 'src/main/main.js'), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', history, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['HistoryToolCallPart', 'FileActionBlock', 'ReadActionBlock', 'HistoryPayloadContext']);
const declarations = {};
for (const statement of ast.statements) {
  if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) {
    const name = item.name.getText(ast);
    if (names.has(name)) declarations[name] = `const ${item.getText(ast)};`;
  }
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'openHistoryFileActionContextMenu')
    declarations.openHistoryFileActionContextMenu = statement.getText(ast);
}
for (const name of [...names, 'openHistoryFileActionContextMenu']) assert.ok(declarations[name], name);
const file = path.join(root, 'docs/tmp/хранилище-и-очистка-диска.md');
const otherRoot = '/tmp/history-second-owner';
const cases = [
  { name: 'actual-MultiEdit-10202', action: { toolName: 'MultiEdit', family: 'edit',
    toolUseId: 'call_08f965025cfb4d8faf8482e0aa0ed3ed:canonical:0', args: { file_path: file,
      edits: [
        { old_string: 'Backend tests проверяют отсутствие новых обходов/таймеров, closed scope,',
          new_string: 'Итоговый focused suite72/72 PASS, fail/skip0. Backend tests проверяют отсутствие новых обходов/таймеров, closed scope,' },
        { old_string: 'fact про отключение ambient на Home. Reindex result будет отмечен после ACK.',
          new_string: 'fact про отключение ambient на Home. MCP reindex подтверждён:176/176,\ncached171, skip/warn/err0. Финальные7source SHA сверены root: все MATCH.' },
      ] } }, expected: file },
  { name: 'actual-shell-Read-10187', action: { toolName: 'Bash', family: 'read',
    args: { command: "sed -n '35,55p' docs/tmp/хранилище-и-очистка-диска.md" } }, expected: file },
  { name: 'actual-Git-10202', action: { toolName: 'Bash', family: 'git',
    args: { command: 'git diff --check -- docs/tmp/хранилище-и-очистка-диска.md docs/tmp/оптимизация-history.md docs/knowledge/fact-resource-usage-panel.md docs/methodology/сценарии-багов.md' } }, expected: file },
  { name: 'native-Read', action: { toolName: 'Read', args: { file_path: file } }, expected: file },
  { name: 'native-Write', action: { toolName: 'Write', args: { file_path: file, content: 'component sample' } }, expected: file },
  { name: 'native-Update', action: { toolName: 'Update', args: { file_path: file, old_string: 'a', new_string: 'b' } }, expected: file },
  { name: 'legacy-Read', legacy: 'Read', action: { filePath: file }, expected: file },
  { name: 'legacy-Edit', legacy: 'Edit', action: { tool: 'Edit', filePath: file, oldString: 'a', newString: 'b' }, expected: file },
  { name: 'Git-glob-not-file', action: { toolName: 'Bash', family: 'git', args: { command: 'git status --short -- src/main/process-metrics* src/main/system-memory*' } }, expected: null },
  { name: 'run-not-file', action: { toolName: 'Bash', args: { command: 'echo docs/not-a-file.md' } }, expected: null },
  { name: 'same-basename-other-owner', cwd: otherRoot, action: { toolName: 'Read', args: { file_path: 'docs/tmp/хранилище-и-очистка-диска.md' } }, expected: otherRoot + '/docs/tmp/хранилище-и-очистка-диска.md' },
];

const fixture = `
import React, {memo,useState,useRef,useCallback,useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChevronDown,ChevronRight} from 'lucide-react';
import {ToolCallPart as CBToolCallPart} from './packages/claude-blocks/src/index';
import {historyActionHeadline} from './src/shared/history-action-grammar.mjs';
import {projectNativeQuestionReply} from './src/shared/native-question-reply.mjs';
import {dispatchHistoryFileActionContextMenu} from './src/renderer/utils/historyFileActionContextMenu.mjs';
import './packages/claude-blocks/src/theme.css';
import './packages/claude-blocks/src/blocks.css';
const state=window.historyFileFixture={requests:[],parentMenus:0,reveals:0,payloadReads:0,copies:0};
const ipcRenderer={send:(channel,payload)=>state.requests.push({channel,payload})};
// Portable path shim is outside this UI proof; node:test covers real Node APIs.
window.require=name=>{
 if(name==='node:path')return{isAbsolute:p=>p.startsWith('/'),resolve:(base,p)=>p.startsWith('/')?p:(base.endsWith('/')?base.slice(0,-1):base)+'/'+p};
 if(name==='node:url')return{pathToFileURL:p=>new URL(p.split('/').map(encodeURIComponent).join('/'),'file://')};
 if(name==='node:os')return{homedir:()=>'/Users/example'};
 throw Error('Unexpected host access '+name);
};
const shortPath=p=>p.split('/').pop();
const historyRecordTimeAttributes=()=>({});
const historyServicePromptFingerprint=()=>{throw Error('Unexpected native question hash')};
const useHistoryRevealToggle=(ref,open,setOpen)=>()=>{state.reveals++;setOpen(!open)};
const useRehydratedPayload=result=>({text:result,pending:false,failed:false});
const useRehydratedCopy=()=>()=>{state.copies++;throw Error('Copy forbidden')};
${declarations.HistoryPayloadContext}
${declarations.openHistoryFileActionContextMenu}
${declarations.HistoryToolCallPart}
${declarations.FileActionBlock}
${declarations.ReadActionBlock}
function Fixture(){
 const [config,setConfig]=useState({index:0,width:400});
 state.setCase=config=>flushSync(()=>setConfig(config));
 const c=window.historyFileCases[config.index];
 return <main style={{margin:20,width:config.width}}><input data-draft defaultValue="ordinary draft stays"/>
  <HistoryPayloadContext.Provider value={{cwd:c.cwd||${JSON.stringify(root)}}}>
   <div data-parent-entry onContextMenu={e=>{e.preventDefault();state.parentMenus++}}>
    {c.legacy==='Read'?<ReadActionBlock filePath={c.action.filePath}/>:
     c.legacy?<FileActionBlock key={c.name} action={c.action}/>:
     <HistoryToolCallPart key={c.name} {...c.action} result="Small component output"/>}
   </div>
  </HistoryPayloadContext.Provider></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const result = {artifact,status:'RUNNING',cases:[],boundary:'Actual extracted History components/helper + real claude-blocks + actual Main callbacks. Chromium; payload/reveal/time/path environment/native Menu/editor/clipboard seams controlled. Not full Electron/GT GUI/installed/provider.',cleanup:{}};
let browser;
try {
  const bundle = await build({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,
    outfile:path.join(artifact,'fixture.js'),format:'iife',platform:'browser',target:'chrome120',
    define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1100,height:800},deviceScaleFactor:2});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e.stack)));
  await page.setContent('<html><body style="background:#191919;color:#eee;font-family:Arial"><div id="root"></div></body></html>');
  await page.evaluate(c=>window.historyFileCases=c,cases);
  await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text});
  await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
  await page.locator('[data-parent-entry]').waitFor();
  for(const width of [300,650])for(let index=0;index<cases.length;index++){
    const c=cases[index];
    await page.evaluate(config=>window.historyFileFixture.setCase(config),{index,width});
    const before=await page.evaluate(()=>({requests:window.historyFileFixture.requests.length,parent:window.historyFileFixture.parentMenus,reveals:window.historyFileFixture.reveals}));
    const selector=c.legacy==='Read'?'[data-parent-entry] span':c.legacy?'[data-parent-entry] button':'.cb-tool-head-inner';
    await page.locator(selector).first().click({button:'right'});
    const after=await page.evaluate(()=>({requests:window.historyFileFixture.requests,parent:window.historyFileFixture.parentMenus,
      reveals:window.historyFileFixture.reveals,draft:document.querySelector('[data-draft]').value,copies:window.historyFileFixture.copies}));
    assert.deepEqual(errors,[]);assert.equal(after.reveals,before.reveals);assert.equal(after.draft,'ordinary draft stays');assert.equal(after.copies,0);
    if(c.expected){
      assert.equal(after.requests.length,before.requests+1);assert.equal(after.parent,before.parent);
      const request=after.requests.at(-1);assert.equal(request.channel,'show-markdown-link-context-menu');
      assert.equal(fileURLToPath(request.payload.href),c.expected);assert.equal(request.payload.editorFirst,true);
      if(c.expected===file){
        const h=historyFileMenuHarness(main),menu=h.show(request.payload);
        assert.equal(menu.template[0].label,'Открыть в GT Editor');assert.equal(menu.template[1].label,'Открыть в Sublime Text');
        menu.template[0].click();menu.template[1].click();await Promise.resolve();
        const url=new URL(h.calls[0].url);assert.equal(url.searchParams.get('folder'),path.dirname(file));
        assert.equal(url.searchParams.get('file'),path.basename(file));assert.equal(h.calls[1].file,file);
      }
    }else{assert.equal(after.requests.length,before.requests);assert.equal(after.parent,before.parent+1);}
    if(index===0){await page.locator('[data-parent-entry]').screenshot({path:path.join(artifact,'edit-'+width+'.png')});
      await page.locator(selector).click();assert.equal(await page.evaluate(()=>window.historyFileFixture.reveals),before.reveals+1);
      assert.equal(await page.locator('.cb-tool-body').count(),1);
      await page.locator('.cb-edit-path').click({button:'right'});
      assert.equal(await page.evaluate(()=>window.historyFileFixture.requests.length),after.requests.length+1);
    }
    result.cases.push({name:c.name,width,expected:c.expected,requests:after.requests.length-before.requests,parent:after.parent-before.parent});
  }
  result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;}
finally{
  if(browser){await browser.close();result.cleanup.browserClosed=true;}
  result.sourceHashes={};
  result.usedSourceHashes={
    'src/renderer/components/Workspace/HistoryPanel.tsx':createHash('sha256').update(history).digest('hex'),
    'src/main/main.js':createHash('sha256').update(main).digest('hex'),
  };
  for(const p of ['src/renderer/components/Workspace/HistoryPanel.tsx','src/renderer/utils/historyFileActionContextMenu.mjs','src/main/main.js'])
    result.sourceHashes[p]=createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex');
  result.usedSourceStable=Object.entries(result.usedSourceHashes).every(([p,sha])=>result.sourceHashes[p]===sha);
  if(!result.usedSourceStable){result.status='FAIL';result.error='Loaded History/Main source changed during component proof';process.exitCode=1;}
  await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({artifact,status:result.status,cases:result.cases.length,error:result.error,cleanup:result.cleanup}));
}

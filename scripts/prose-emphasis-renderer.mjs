#!/usr/bin/env node
// Finite shared-Markdown component proof, not full Noted/installed E2E.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';

const repo=fileURLToPath(new URL('..',import.meta.url));
const artifact=await fs.mkdtemp(path.join(os.tmpdir(),'noted-prose-emphasis-'));
const result={artifact,status:'RUNNING',checks:[],errors:[],cleanup:{},
  boundary:'Actual shared Markdown/React/theme/CSS in private offscreen Electron; finite synthetic prose, not full app/installed/History data/PTY/provider/OS input.'};
const sourcePaths=['packages/claude-blocks/src/components/Markdown.tsx','packages/claude-blocks/src/theme.css','packages/claude-blocks/src/blocks.css'];
const hash=s=>createHash('sha256').update(s).digest('hex');
result.sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,hash(await fs.readFile(path.join(repo,p)))])));
const sample='Обычный текст и **важный фрагмент**.\n\n## Нейтральный заголовок\n\n## **Жирный заголовок**\n\n`inline code` и **`code внутри bold`**.\n\n- Первый **пункт**\n- Второй пункт\n\n> Цитата с **акцентом**.\n\n```text\n**literal code block**\n```';
const preview='Краткая подпись: **важный фрагмент**.\n\n## **Заголовок подписи**';
const fixture=`import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{Markdown}from'./packages/claude-blocks/src/components/Markdown';
import'./packages/claude-blocks/src/theme.css';import'./packages/claude-blocks/src/blocks.css';
flushSync(()=>createRoot(document.getElementById('fixture')).render(<main><section className="full"><Markdown text={${JSON.stringify(sample)}}/></section>
<section className="preview"><Markdown preview text={${JSON.stringify(preview)}}/></section>
<section className="controls"><span className="error-token">Ошибка</span> · <span className="error-text">Error detail</span> · <span className="literal">**обычный user-текст**</span></section></main>));window.fixtureReady=true;`;
let app,proc,deadline;
try{
 const pressure=execFileSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8'});
 result.memoryAdmission=pressure.trim();assert.ok(Number(pressure.match(/free percentage:\s*(\d+)%/)?.[1])>=15,'component memory admission');
 const built=await build({stdin:{contents:fixture,loader:'tsx',resolveDir:repo},bundle:true,write:false,platform:'browser',format:'iife',target:'chrome120',
  outfile:path.join(artifact,'bundle.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 for(const file of built.outputFiles)await fs.writeFile(file.path,file.contents);
 await fs.writeFile(path.join(artifact,'index.html'),`<meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>
 body{margin:0;background:#1a1a1a;font:18px/1.5 Arial;color:#e8e8e8}main{padding:16px}section{min-width:0}.preview{margin-top:18px;color:#888;font:14px/1.5 Arial;border-top:1px solid #333;padding-top:12px}.controls{font:14px/1.5 Arial;margin-top:16px}.error-token{color:var(--cb-error)}.error-text{color:var(--cb-error-text)}
 </style><div id="fixture"></div><script src="bundle.js"></script>`);
 await fs.writeFile(path.join(artifact,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'profile'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();const win=global.ownedWindow=new BrowserWindow({width:900,height:900,show:false,focusable:false,frame:false,webPreferences:{offscreen:true,sandbox:true}});win.loadFile(${JSON.stringify(path.join(artifact,'index.html'))})});app.on('window-all-closed',()=>app.quit());`);
 const env={...process.env};for(const k of ['ELECTRON_RUN_AS_NODE','CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_CHILD_SESSION'])delete env[k];
 app=await electron.launch({args:[path.join(artifact,'main.cjs')],cwd:artifact,env,timeout:15000});proc=app.process();result.pid=proc.pid;
 deadline=setTimeout(()=>{result.errors.push('30-second component deadline');void app.close().catch(()=>proc.kill('SIGTERM'));},30000);
 const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));
 await page.waitForFunction(()=>window.fixtureReady===true,{timeout:10000});await page.evaluate(()=>document.fonts.ready);
 result.rendered=[];
 for(const width of [900,350]){
  await page.setViewportSize({width,height:900});
  const state=await page.evaluate(()=>{
   const style=selector=>{const el=document.querySelector(selector),s=getComputedStyle(el);return{color:s.color,weight:s.fontWeight,size:s.fontSize,bg:s.backgroundColor}};
   return{width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
    body:style('.full .cb-prose p'),strong:style('.full .cb-prose p strong'),heading:style('.full h2'),headingStrong:style('.full h2 strong'),
    inline:style('.full p code'),boldCode:style('.full strong code'),preview:style('.preview p'),previewStrong:style('.preview p strong'),previewHeading:style('.preview h2 strong'),
    error:style('.error-token'),errorText:style('.error-text'),codeStrong:document.querySelectorAll('.cb-code-block strong').length,
    codeLiteral:document.querySelector('.cb-code-block').textContent.includes('**literal code block**'),literalStrong:document.querySelectorAll('.literal strong').length};
  });
  assert.equal(state.strong.color,'rgb(199, 120, 130)');assert.equal(state.previewStrong.color,state.strong.color);
  assert.equal(state.strong.weight,'600');assert.equal(state.strong.size,state.body.size);assert.equal(state.strong.bg,'rgba(0, 0, 0, 0)');
  assert.equal(state.heading.color,state.body.color);assert.equal(state.headingStrong.color,state.body.color);
  assert.equal(state.previewHeading.color,state.preview.color);assert.equal(state.inline.color,'rgb(177, 185, 249)');assert.equal(state.boldCode.color,state.inline.color);
  assert.equal(state.error.color,'rgb(239, 68, 68)');assert.equal(state.errorText.color,'rgb(243, 139, 168)');
  assert.equal(state.codeStrong,0);assert.equal(state.codeLiteral,true);assert.equal(state.literalStrong,0);assert.equal(state.overflow,false);
  result.rendered.push(state);await page.screenshot({path:path.join(artifact,'dark-'+width+'.png')});
 }
 await page.evaluate(()=>document.querySelector('.full').style.setProperty('--cb-prose-strong','#aabbcc'));
 assert.equal(await page.locator('.full p strong').first().evaluate(el=>getComputedStyle(el).color),'rgb(170, 187, 204)');
 result.checks.push('900/350px actual shared Markdown computed styles and captured dark PNGs','bold only; neutral headings, literal/inline code, user text, status colors and font metrics preserved','independent theme override works without a new parser');
 for(const p of sourcePaths)assert.equal(hash(await fs.readFile(path.join(repo,p))),result.sourceHashes[p],'source changed during proof '+p);
 assert.deepEqual(result.errors,[]);result.status='PASS';
}catch(error){result.status='FAIL';result.error=error.stack;process.exitCode=1;}
finally{
 if(deadline)clearTimeout(deadline);
 if(app){await app.close();result.cleanup.electronClosed=true;}
 if(proc){result.cleanup.exitCode=proc.exitCode;result.cleanup.signal=proc.signalCode;try{process.kill(proc.pid,0);result.cleanup.pidGone=false;}catch{result.cleanup.pidGone=true;}}
 for(const name of ['profile','bundle.js','bundle.css','index.html','main.cjs'])await fs.rm(path.join(artifact,name),{recursive:name==='profile',force:true});
 result.cleanup.generatedRemoved=true;await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({artifact,status:result.status,error:result.error,checks:result.checks,cleanup:result.cleanup}));
}

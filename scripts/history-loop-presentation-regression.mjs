#!/usr/bin/env node
// Cheap component QA, not the full Electron/queue/provider acceptance.
// Actual Preview component, actual count-button JSX, actual Loop-label JSX/CSS.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { codexNativeQuestionDefinition, registerNativeQuestionDefinition,
  proveCodexNativeQuestionReply } from '../src/shared/native-question-reply.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-loop-presentation-'));
const hash = text => createHash('sha256').update(text).digest('hex');
const read = file => fs.readFile(path.join(repo, file), 'utf8');
const history = await read('src/renderer/components/Workspace/HistoryPanel.tsx');
const queue = await read('src/renderer/components/Workspace/PromptQueueOverlay.tsx');
const rail = await read('src/renderer/components/Workspace/Timeline.tsx');
let queueButton, loopLabel, narrowMarker, wideMarker;
for (const [name, source] of [['HistoryPanel.tsx', history], ['PromptQueueOverlay.tsx', queue]]) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => {
    if (ts.isJsxElement(node)) {
      const text = node.openingElement.getText(ast);
      if (text.includes('className={`pq-rail-button pq-rail-count')) queueButton = node.getText(ast);
      if (text.includes('data-history-loop-label')) loopLabel = node.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
assert.ok(queueButton && loopLabel, 'read actual production JSX, not a copied mock');
const railAST=ts.createSourceFile('Timeline.tsx',rail,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const visitMarker=node=>{
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(railAST)==='div'){
    const text=node.getText(railAST);
    if(text.includes('width: dotGeometry.width'))narrowMarker=text;
    if(text.includes('width: expSize')&&text.includes('entryUsesDiamond'))wideMarker=text;
  }
  ts.forEachChild(node,visitMarker);
};visitMarker(railAST);assert.ok(narrowMarker&&wideMarker);
const dotColorCode=rail.slice(rail.indexOf('  let dotColor: string;'),rail.indexOf('  const dotGeometry = timelineMarkerGeometry('));
const queueCSS = queue.slice(queue.indexOf('.pq-rail-button {'), queue.indexOf('.pq-rail-run.pq-rail-active {'))
  .replaceAll('${TINT}', '#DA7756');
const historyCSS = history.slice(history.indexOf('.hp-history-transcript .cb-user-bubble.hp-history-user-bubble--orchestration {'),
  history.indexOf('/* The top collapse control still occupies'));
assert.ok(queueCSS && historyCSS);
const witnessPath = process.argv[2];
const loop = witnessPath ? JSON.parse(await fs.readFile(witnessPath, 'utf8')).loop[0] : {
  uuid: 'component-loop', role: 'user', content: 'Private Loop display sample; no queue is executed.',
  semanticTags: [{ kind: 'prompt-origin', source: 'loop' }],
};
loop.type = 'user';
const continuationPath=process.argv[3];
const continuation=continuationPath?JSON.parse(await fs.readFile(continuationPath,'utf8')).continue[0]:{
  uuid:'component-continue',role:'user',content:'continue',semanticTags:[{kind:'prompt-origin',source:'system',systemSource:'codex-capacity-retry'}]};
continuation.type='user';
const question = 'Exact private question?', answer = 'Private answer';
const content = '<send_user_message_question_reply>\n' + JSON.stringify([{ question, answer,
  questionItemId: JSON.stringify(['request_user_input_async', 'component-call', 0]) }]) + '\n</send_user_message_question_reply>';
const definitions = new Map();
registerNativeQuestionDefinition(definitions, codexNativeQuestionDefinition({ callId: 'component-call',
  toolName: 'request_user_input_async', args: { questions: [{ title: question }] },
  sourceIdentity: 'component-call-source', physicalSessionId: 'component-session' }, hash));
const native = { ...loop, uuid: 'component-native-reply', content,
  questionReplyProof: proveCodexNativeQuestionReply(content, definitions, 'component-session', hash) };
const data = { loop, continue:continuation, plain: { ...loop, semanticTags: [] }, literal_continue:{...continuation,semanticTags:[]}, native,
  hashes: { [loop.content]: hash(loop.content), [continuation.content]:hash(continuation.content), [content]: hash(content), [question]: hash(question) } };
const fixture = `
import React, {useState, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {RefreshCw, Repeat2} from 'lucide-react';
import {TimelineEntryPreview} from './src/renderer/components/Workspace/TimelineEntryPreview';
import {timelineMarkerKind,timelineMarkerGeometry} from './src/renderer/utils/timelineMarkerPresentation.mjs';
import {isServicePromptEntry} from './src/shared/prompt-origin.mjs';
import './packages/claude-blocks/src/theme.css';
import './packages/claude-blocks/src/blocks.css';
const TINT='#DA7756', PULSE='#a78bfa';
const state=window.loopFixture={copies:0,navigations:0};
function QueueCount({config}) {
  const activeItemCount=config.count, postPromptEnabled=config.post, loopPromptEnabled=config.loop;
  const panelAttached=!config.closed, collapsed=config.closed, queueCountButtonRef=useRef(null);
  const expandPanel=()=>{},collapsePanel=()=>{},openQueueHoverPreview=()=>{};
  return ${queueButton};
}
function Marker({entry,wide}) {
  const kind=timelineMarkerKind(entry,text=>window.loopData.hashes[text]);
  const entryIsAutomaticContinuation=kind==='loop'||kind==='continue',entryIsQuestionReply=kind==='question-reply';
  const entryIsSystem=kind==='system',entryIsOrchestration=kind==='terminal-mcp',entryUsesDiamond=entryIsSystem||entryIsOrchestration;
  const entryIsServicePrompt=isServicePromptEntry(entry),isHovered=false,isInViewport=false,isPromptVisible=false;
  const displaysAsCompact=false,isContinued=false,isPlan=false,isGoalContinuation=false,active=false,entryIsTimeout=false,entryIsSubAgent=false;
  const isUnreachable=false,isRewindMarked=false,hasNote=false,notePos='before',showAsChild=false,expSize='8px';
  ${dotColorCode}
  const dotGeometry=timelineMarkerGeometry({isOrchestration:entryIsOrchestration,isSystem:entryIsSystem,displaysAsCompact,showAsChild,isHovered,isInViewport});
  return <span data-component-marker={wide?'wide':'rail'} data-marker-kind={kind} style={{display:'inline-flex',width:32,height:20,alignItems:'center',justifyContent:'center'}}>
    {wide?${wideMarker}:${narrowMarker}}
  </span>;
}
function Fixture() {
  const [config,setConfig]=useState({mode:'loop',width:300,expanded:false,count:0,post:false,loop:true,closed:true});
  state.setCase=config=>flushSync(()=>setConfig(config));
  const entry=window.loopData[config.mode];
  const continuePrompt=config.mode==='continue',loopPrompt=!continuePrompt;
  return <main style={{width:config.width,margin:20}}>
    <section style={{background:'#191919',border:'1px solid #666',padding:10}} data-component-popup>
      <TimelineEntryPreview entry={entry} toolType="codex" expanded={config.expanded} responseLines={3} fontSize={13}
        onExpand={()=>state.setCase({...config,expanded:!config.expanded})}
        onNavigatePrompt={()=>state.navigations++} onNavigateAnswer={()=>state.navigations++}
        onSourceNavigate={()=>{throw Error('unexpected source navigation')}}
        onCopy={()=>{state.copies++;throw Error('Copy forbidden')}}
        loadResponse={()=>{throw Error('unexpected provider read')}} loadImages={()=>Promise.resolve([])} />
    </section>
    <section style={{marginTop:20}} data-component-queue><QueueCount config={config}/></section>
    <section style={{marginTop:12}}><Marker entry={entry} wide={false}/><Marker entry={entry} wide={true}/></section>
    <section className="hp-history-transcript" style={{marginTop:20}} data-component-history-label>
      <div className={'cb-user-bubble '+(continuePrompt?'hp-history-user-bubble--continue':'hp-history-user-bubble--loop')}>${loopLabel}<span>{(continuePrompt?window.loopData.continue:window.loopData.loop).content.slice(0,180)}</span></div>
    </section>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const result = { artifact, status: 'RUNNING', boundary:
  'Chromium component fixture: actual Preview; extracted actual queue/label JSX+CSS; source-navigation stub never called. No Electron/Main/provider/queue executor/clipboard.',
  witness: { uuid: loop.uuid, sourceIdentity: loop.sourceIdentity, contentHash: hash(loop.content) }, cases: [], cleanup: {} };
let browser;
try {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: repo, loader: 'tsx' }, bundle: true,
    outfile: path.join(artifact, 'bundle.js'), write: false, format: 'iife', platform: 'browser', target: 'chrome120',
    loader: { '.png': 'dataurl' }, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
      name: 'unexercised-source-navigation', setup(build) {
        build.onResolve({ filter: /^@noted\/claude-blocks$/ }, () => ({ path: path.join(repo, 'packages/claude-blocks/src/index.ts') }));
        build.onResolve({ filter: /^\.\/TabMessageSourceChip$/ }, args => ({ path: args.path, namespace: 'no-source-navigation' }));
        build.onLoad({ filter: /.*/, namespace: 'no-source-navigation' }, () => ({ loader: 'tsx',
          contents: 'export function HistoryPromptSource(){throw Error("source branch outside this component proof");}' }));
      },
    }] });
  const js = bundled.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  const css = bundled.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  assert.ok(js && css);
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  result.pageErrors=[];
  page.on('pageerror',error=>result.pageErrors.push(String(error.stack)));
  await page.setContent('<!doctype html><html><body style="background:#191919;color:#e5e5e5;font-family:Arial"><div id="root"></div></body></html>');
  await page.evaluate(data => {
    window.loopData = data;
    window.require = name => {
      if (name !== 'node:crypto') throw Error('No Electron/IPC/clipboard in this fixture');
      return { createHash: () => ({ update: text => ({ digest: () => {
        if (!data.hashes[text]) throw Error('unexpected hash input'); return data.hashes[text];
      } }) }) };
    };
  }, data);
  await page.addStyleTag({ content: css + '\n' + queueCSS + '\n' + historyCSS });
  await page.addScriptTag({ content: js });
  await page.locator('[data-timeline-preview="loop"]').waitFor();
  for (const width of [300,500]) for (const mode of ['loop','continue','literal_continue','plain','native']) for (const expanded of [false,true]) {
    const config={width,mode,expanded,count:0,post:false,loop:true,closed:true};
    await page.evaluate(config=>window.loopFixture.setCase(config),config);
    assert.deepEqual(result.pageErrors,[], 'the actual component must remain mounted');
    const actual=await page.evaluate(()=>{
      const p=document.querySelector('[data-timeline-preview]'),h=p.querySelector('.timeline-preview-kind');
      return {kind:p.dataset.timelinePreview,title:h?.textContent,background:getComputedStyle(p).backgroundColor,
        chipBackground:getComputedStyle(h).backgroundColor,
        popupBackground:getComputedStyle(document.querySelector('[data-component-popup]')).backgroundColor,
        innerBackgrounds:[...p.querySelectorAll('.timeline-preview-header,.timeline-preview-reading-frame,.timeline-preview-viewport,.timeline-preview-contents,.timeline-preview-footer')]
          .map(n=>({className:n.className,background:getComputedStyle(n).backgroundColor})),
        headerColor:getComputedStyle(h).color,promptRole:p.querySelector('[data-timeline-preview-prompt]')?.getAttribute('role'),
        promptColor:getComputedStyle(p.querySelector('[data-timeline-preview-prompt]')).color,
        user:p.dataset.timelinePreviewUser,historyLabel:document.querySelector('.hp-history-loop-label')?.textContent,
        historyColor:getComputedStyle(document.querySelector('.cb-user-bubble')).backgroundColor,
        historyText:getComputedStyle(document.querySelector('.cb-user-bubble')).color,
        markers:[...document.querySelectorAll('[data-component-marker]')].map(m=>{const s=getComputedStyle(m.firstElementChild);return{kind:m.dataset.markerKind,variant:m.dataset.componentMarker,transform:s.transform,radius:s.borderRadius,width:s.width,height:s.height,color:s.backgroundColor};})};
    });
    const automatic=mode==='loop'||mode==='continue';
    assert.equal(actual.kind,mode==='native'?'question-reply':automatic?mode:'iteration');
    assert.equal(actual.title,mode==='native'?'Ответ на вопрос':mode==='loop'?'Loop':mode==='continue'?'Continue':'User mess.');
    if(width===300&&mode==='native')await page.locator('[data-component-popup]').screenshot({path:path.join(artifact,'native-panel-'+(expanded?'expanded':'collapsed')+'.png')});
    assert.equal(actual.background,automatic?'rgba(114, 90, 159, 0.08)':'rgba(0, 0, 0, 0)');
    if(mode==='native'){
      assert.equal(actual.headerColor,'rgb(147, 197, 253)');
      assert.match(actual.chipBackground,/^rgba\(59, 130, 246, 0\./);
      assert.equal(actual.popupBackground,'rgb(25, 25, 25)');
      for(const inner of actual.innerBackgrounds)assert.equal(inner.background,'rgba(0, 0, 0, 0)',inner.className+' must not paint a second panel');
    }
    assert.equal(actual.historyColor,'rgba(114, 90, 159, 0.08)');
    assert.equal(actual.historyLabel,mode==='continue'?'Continue':'Loop');
    assert.equal(actual.historyText,'rgb(143, 141, 136)');
    if(automatic){assert.equal(actual.promptColor,'rgb(143, 141, 136)');assert.equal(actual.headerColor,'rgb(143, 141, 136)');
      for(const marker of actual.markers){assert.equal(marker.kind,mode);assert.equal(marker.transform,'none');assert.equal(marker.radius,'50%');assert.equal(marker.width,marker.height);}}
    assert.equal(actual.promptRole,expanded?null:'button');
    result.cases.push({kind:'preview',...config,...actual});
    if(width===300&&!expanded)await page.screenshot({path:path.join(artifact,mode+'-collapsed.png')});
  }
  for(const count of [0,12,99])for(const post of [false,true])for(const loop of [false,true]) {
    const config={width:300,mode:'loop',expanded:false,count,post,loop,closed:true};
    await page.evaluate(config=>window.loopFixture.setCase(config),config);
    const actual=await page.evaluate(()=>{
      const b=document.querySelector('.pq-rail-count'),svg=b.querySelector('[data-prompt-queue-loop-indicator]');
      const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const label=b.querySelector('[data-prompt-queue-count-label]');
      const range=document.createRange();range.selectNodeContents(label);
      const r=range.getBoundingClientRect();
      return {button:rect(b),text:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},loop:svg?rect(svg):null,
        stroke:svg?getComputedStyle(svg).stroke:null,dots:b.querySelectorAll('span span').length,textValue:label.textContent.trim(),
        copies:window.loopFixture.copies};
    });
    assert.equal(actual.button.width,26);assert.equal(actual.button.height,26);
    assert.equal(actual.textValue,String(count));assert.equal(actual.dots,post?1:0);assert.equal(actual.copies,0);
    assert.equal(!!actual.loop,loop);
    if(loop){assert.equal(actual.loop.width,8);assert.equal(actual.loop.height,8);assert.equal(actual.stroke,'rgb(167, 139, 250)');
      assert.ok(actual.loop.right<actual.button.right&&actual.loop.bottom<actual.button.bottom);
      assert.ok(actual.text.bottom<=actual.loop.top+.1,'two-digit count must not intersect the Loop icon');}
    result.cases.push({kind:'queue',...config,...actual});
  }
  await page.screenshot({path:path.join(artifact,'queue-99-post-loop.png')});
  result.status='PASS';
}catch(error){result.status='FAIL';result.error=String(error.stack);process.exitCode=1;}
finally{
  if(browser){await browser.close();result.cleanup.browserClosed=true;}
  result.sourceHashes={};
  for(const file of ['src/renderer/components/Workspace/TimelineEntryPreview.tsx','src/renderer/components/Workspace/TimelineEntryPreview.css',
    'src/renderer/components/Workspace/HistoryPanel.tsx','src/renderer/components/Workspace/PromptQueueOverlay.tsx'])result.sourceHashes[file]=hash(await read(file));
  await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({artifact,status:result.status,cases:result.cases.length,error:result.error,cleanup:result.cleanup}));
}

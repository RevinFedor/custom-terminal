#!/usr/bin/env node
// Real projection/header/cards/rails + flat Virtuoso, using bounded public
// History witnesses. Native IPC/clipboard and retained scroll-owner are seams.
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
const savedRuns = process.argv[3] ? JSON.parse(await fs.readFile(process.argv[3], 'utf8')) : [];
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-research-groups-'));
const hash = text => createHash('sha256').update(text).digest('hex');
const history = await fs.readFile(path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const wanted = ['HistoryUserEntry', 'HistoryResearchReply', 'HistoryResearchModelsProvider', 'HistoryResearchModelsContext',
  'historyInstructionAttachment', 'historyUserPromptIsChipOnly', 'splitLeadingHistoryPromptParts', 'historyVirtuosoUnitKey', 'HISTORY_SURFACE_PRESENTATION_EVENT'];
const tree = ts.createSourceFile('HistoryPanel.tsx', history, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), declarations = {};
for (const node of tree.statements) {
  if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
    const name = item.name.getText(tree);
    if (wanted.includes(name)) declarations[name] = 'const ' + item.getText(tree) + ';';
  }
  if (ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text)) declarations[node.name.text] = node.getText(tree);
}
for (const name of wanted) assert.ok(declarations[name], name);
const cut = (start, end) => {
  const a = history.indexOf(start), b = history.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return history.slice(a, b);
};
const historyCSS = (cut('.hp-history-transcript .cb-row {', '/* The top collapse control still occupies')
  + cut('.hp-history-group-detail {', '.hp-history-caption-gutter')
  + cut('.hp-history-group-member {', '/* Rhythm INSIDE a container'))
  .replaceAll('${HISTORY_SERVICE_TEXT_RATIO}', history.match(/const HISTORY_SERVICE_TEXT_RATIO = ([.\d]+);/)[1]);
assert.ok(witness.entries.length >= 4, 'at least four exact public consecutive replies');
const entries = witness.entries.slice(0, 4);
const rows = [...entries, witness.entries[4] || { ...entries[3], uuid: 'synthetic-appended-reply', sourceIdentity: 'synthetic-appended-source' }];
const hashes = Object.fromEntries(rows.map(entry => [entry.content, hash(entry.content)]));
const tracked = ['src/renderer/components/Workspace/HistoryPanel.tsx', 'src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx',
  'src/renderer/utils/historyDisplayUnits.mjs', 'src/main/history-entry-window.js',
  'src/renderer/components/Workspace/ResearchResultContent.tsx', 'src/renderer/components/Workspace/ResearchResultContent.css',
  'src/renderer/components/Workspace/TabMessageSourceChip.tsx', 'src/renderer/utils/researchResultPresentation.mjs',
  'src/renderer/utils/researchReplyClipboard.mjs', 'src/renderer/utils/useResearchRunModels.ts', 'src/renderer/utils/historyLiveProjection.mjs'];
const result = { artifact, status: 'RUNNING', checks: [], cleanup: {}, witness: {
  readSessionId: witness.readSessionId, uuids: witness.entries.map(e => e.uuid), wireHashes: witness.entries.map(e => hash(e.content)) },
  boundary: 'Chromium: real group projection/shared header/rail/foot, extracted actual HistoryUserEntry/ResearchReply/provider, real ConversationMessage/Markdown and flat Virtuoso. Public copied rows are real. Native catalog options, clipboard memory sink, timestamps and retained reveal/scroll transaction are controlled. Not full retained History/provider/OS clipboard/installed or scroll-position/performance acceptance.' };
result.loadedHashes = Object.fromEntries(await Promise.all(tracked.map(async p => [p, hash(await fs.readFile(path.join(root, p), 'utf8'))])));
result.loadedHashes[tracked[0]] = hash(history);
const fixture = `
import React,{memo,useState,useRef,useMemo,useCallback,useEffect,useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Virtuoso} from 'react-virtuoso';
import {Copy,Check,RotateCcw,Trash2,ArrowUp,RefreshCw,Repeat2} from 'lucide-react';
import {ConversationMessage,MessageActionRail,MessageActionButton,MessageStatusBadge,setCopyTextImpl} from './packages/claude-blocks/src/index';
import {HistoryCollapsedGroupRow,HistoryGroupRail,HistoryGroupFoot} from './src/renderer/components/Workspace/HistoryTranscriptPresentation';
import {ResearchResultContent} from './src/renderer/components/Workspace/ResearchResultContent';
import {HistoryPromptSource,ResearchSourceAction} from './src/renderer/components/Workspace/TabMessageSourceChip';
import {buildHistoryDisplayUnits,resolveHistoryDisplayTarget,isGroupUnit} from './src/renderer/utils/historyDisplayUnits.mjs';
import {historyLivePresentationKey} from './src/renderer/utils/historyLiveProjection.mjs';
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
const state=window.groupState;
setCopyTextImpl(text=>state.codeCopies.push(text));
const useUIStore={getState:()=>({showToast:()=>{}})};
const historyServicePromptFingerprint=text=>window.groupData.hashes[text];
const HISTORY_PROMPT_SENT_PRESENTATION_MS=1000;
const historyPromptHandoffStatusPresentation=()=>null,isLocalPromptEntry=()=>false;
const writeElectronComposerSnapshotClipboard=payload=>{state.copies.push(payload.text);return{textCopied:true,snapshotCopied:true}};
const historyDiag=()=>{},historyRecordTimeAttributes=()=>({});
const Tooltip=({children})=><>{children}</>;
const HistoryUserPromptBand=({parts})=><div>{parts.map((part,i)=><span key={i}>{part.chip?.label}</span>)}</div>;
const HistoryUserPromptContent=({text})=><div data-ordinary-body>{text}</div>;
const useHistoryRevealToggle=(anchor,open,setOpen)=>useCallback(()=>{state.cardToggles++;flushSync(()=>setOpen(!open))},[open]);
${wanted.map(name => declarations[name]).join('\n')}
function Fixture(){
 const [config,setConfig]=useState({width:650,font:13,count:4,split:false,failed:false});
 const [expandedKeys,setExpandedKeys]=useState(new Set());
 const list=useRef(null);
 const presentation=useRef({presented:false});
 state.present=(value,channel='research-test')=>{presentation.current.presented=value;
  window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT,{detail:{channel,presented:value}}))};
 const rows=useMemo(()=>{const a=window.groupData.rows.slice(0,config.count);
  if(config.failed&&a[1])a[1]={...a[1],semanticTags:a[1].semanticTags.map(t=>({...t,phase:'failure'}))};
  if(config.split)a.splice(2,0,{uuid:'ordinary-user-boundary',role:'user',content:'Настоящее пользовательское сообщение'});return a},[config.count,config.split,config.failed]);
 const units=useMemo(()=>buildHistoryDisplayUnits(rows,{expandedKeys}),[rows,expandedKeys]);
 const collapse=(key,source)=>{state.groupToggles.push({key,source});flushSync(()=>setExpandedKeys(current=>{const next=new Set(current);next.delete(key);return next}))};
 const toggle=key=>{state.groupToggles.push({key,source:'header'});flushSync(()=>setExpandedKeys(current=>{const next=new Set(current);if(next.has(key))next.delete(key);else next.add(key);return next}))};
 state.setCase=c=>flushSync(()=>{setExpandedKeys(new Set());setConfig(c)});
 state.append=()=>flushSync(()=>setConfig(c=>({...c,count:5})));
 state.units=units.map(u=>({kind:u.kind,key:u.key,uuid:u.entry?.uuid,members:u.entries?.map(e=>e.uuid),expanded:u.expanded}));
 state.navigate=uuid=>{const target=resolveHistoryDisplayTarget(units,uuid);state.lastTarget=target;
  if(target?.groupKey){flushSync(()=>setExpandedKeys(current=>new Set([...current,target.groupKey])))};
  const open=buildHistoryDisplayUnits(rows,{expandedKeys:target?.groupKey?new Set([...expandedKeys,target.groupKey]):expandedKeys});
  const resolved=resolveHistoryDisplayTarget(open,uuid);list.current?.scrollToIndex({index:resolved.index,align:'start',behavior:'auto'});return resolved};
 return <main style={{width:config.width,margin:16,fontSize:config.font,'--cb-fs-base':config.font+'px'}}>
  <input data-draft defaultValue="НЕ МЕНЯТЬ ЧЕРНОВИК"/>
  <HistoryResearchModelsProvider tabId="group-component-tab" sessionId="group-owner" enabled entries={rows}
    presented={false} presentationRef={presentation} presentationChannel="research-test">
   <Virtuoso ref={list} className="hp-history-transcript" style={{height:850}} data={units} computeItemKey={(_,u)=>historyVirtuosoUnitKey(u)} overscan={200}
    itemContent={(_,unit)=>unit.kind==='group'?<div data-history-group={unit.key} data-history-row-real="1" data-uuid={unit.expanded?undefined:unit.entries[0].uuid} style={{paddingTop:2,paddingBottom:2}}>
      <HistoryCollapsedGroupRow group={unit} expanded={unit.expanded} onToggle={()=>toggle(unit.key)}/>
     </div>:<div data-uuid={unit.entry.uuid} data-history-row-real="1" style={{paddingTop:unit.expandedGroup?0:4,paddingBottom:unit.expandedGroup?0:4}}>
      {unit.expandedGroup?<div className="hp-history-group-member hp-history-group-member--research" data-history-group-member={unit.expandedGroup.key} data-history-group-last={unit.expandedGroup.last?'1':undefined}>
       <HistoryGroupRail groupKey={unit.expandedGroup.key} onCollapse={collapse}/>
       <HistoryUserEntry entry={unit.entry} tabId="group-component-tab" toolType="codex" allowRewind={false} allowHistoryRewriteRewind={false} allowDeleteIteration={false}/>
       {unit.expandedGroup.last&&<HistoryGroupFoot groupKey={unit.expandedGroup.key} onCollapse={collapse}/>}</div>
       :<HistoryUserEntry entry={unit.entry} tabId="group-component-tab" toolType="codex" allowRewind={false} allowHistoryRewriteRewind={false} allowDeleteIteration={false}/>}</div>}/>
  </HistoryResearchModelsProvider>
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
let browser, page;
const errors = []; result.pageErrors = errors;
try {
  const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, jsx: 'automatic', bundle: true, write: false,
    platform: 'browser', format: 'iife', target: 'chrome120', outfile: path.join(artifact, 'bundle.js'), loader: { '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', plugins: [{ name: 'native-seams', setup(b) {
      b.onResolve({ filter: /^@noted\/claude-blocks$/ }, () => ({ path: path.join(root, 'packages/claude-blocks/src/index.ts') }));
      for (const [filter, name] of [[/\/store\/useWorkspaceStore$/, 'workspace'], [/\/store\/useUIStore$/, 'ui'],
        [/\/store\/useOrchestrationStore$/, 'orchestration'], [/\/utils\/uiPerformanceDiagnostics\.mjs$/, 'diagnostics'], [/^\.\/RequestTrackerRow$/, 'row']])
        b.onResolve({ filter }, () => ({ path: name, namespace: 'seams' }));
      b.onLoad({ filter: /.*/, namespace: 'seams' }, a => ({ loader: 'ts', contents: a.path === 'orchestration'
        ? 'export const subscribeOrchestrationRunChanges=fn=>{window.groupState.listeners.add(fn);return()=>window.groupState.listeners.delete(fn)}'
        : a.path === 'workspace' ? 'export const useWorkspaceStore=Object.assign(fn=>fn({openProjects:new Map()}),{getState:()=>({openProjects:new Map(),openTabById:async()=>false})})'
        : a.path === 'ui' ? 'export const useUIStore={getState:()=>({showToast:()=>{}})}'
        : a.path === 'diagnostics' ? 'export const currentUIActionId=()=>"component-action";export const uiPerformancePhase=(stage,data)=>window.groupState.measurements.push({stage,...data});export const uiPerformancePhaseForAction=(id,stage,data)=>window.groupState.measurements.push({id,stage,...data})'
        : 'export const requestRowLinkStyle={};' }));
    } }] });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(String(e.stack)));
  await page.setContent('<html><body style="background:#191919;color:#ddd;font-family:Arial"><div id="root"></div></body></html>');
  await page.evaluate(data => {
    window.groupData = data;
    const state = window.groupState = { copies: [], codeCopies: [], ipc: [], listeners: new Set(), measurements: [], cardToggles: 0, groupToggles: [] };
    window.require = name => name === 'node:crypto' ? { createHash: () => ({ update: text => ({ digest: () => data.hashes[text] }) }) }
      : name === 'electron' ? { ipcRenderer: { invoke: async (channel, arg) => {
        state.ipc.push({ channel, arg });
        if (channel === 'orchestration:list-for-tab') return data.rows.map((e,i) => ({ runId: e.semanticTags[0].runId, label: data.savedRuns.find(r=>r.runId===e.semanticTags[0].runId)?.label||'Saved task '+(i+1), runKind: 'external-research', sourceTabId: 'group-component-tab', externalResearchModel: '6', externalResearchEffort: 'xhigh', externalResearchMode: 'chat' }));
        if (channel === 'orchestration:open-research-job') return state.failOpen ? {success:false,error:'Controlled missing saved job'} : { success: true, jobId: 'component-saved-job' };
        throw Error('Unexpected IPC ' + channel);
      }, send: () => { throw Error('No native writes'); }, on: () => {}, removeListener: () => {} } }
      : (() => { throw Error('No native access ' + name); })();
  }, { rows, hashes, savedRuns });
  await page.addStyleTag({ content: bundle.outputFiles.find(f => f.path.endsWith('.css')).text + '\n' + historyCSS });
  await page.addScriptTag({ content: bundle.outputFiles.find(f => f.path.endsWith('.js')).text });
  const header = () => page.locator('.hp-history-research-group-toggle');
  await header().waitFor(); assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.groupState.ipc.length), 0, 'dormant owner does not read metadata');
  await page.evaluate(() => window.groupState.present(true, 'foreign-owner'));
  assert.equal(await page.evaluate(() => window.groupState.ipc.length), 0, 'foreign presentation is ignored');
  await page.evaluate(() => window.groupState.present(true));
  await page.waitForFunction(() => window.groupState.ipc.some(x => x.channel === 'orchestration:list-for-tab'));
  await page.evaluate(() => { window.groupState.present(false); window.groupState.present(true); });
  result.checks.push('retained dormant owner reads metadata on exact presentation; foreign/duplicate events do not read');
  result.widthGeometry = [];
  for (const width of [300, 650, 1000]) for (const font of [13, 20]) {
    await page.evaluate(config => window.groupState.setCase(config), { width, font, count: 5, split: false });
    const before = await header().boundingBox();
    await header().click();
    await page.locator('[data-history-group-member]').nth(4).waitFor();
    const after = await header().boundingBox();
    for(const key of ['x','y','width'])assert.ok(Math.abs(after[key]-before[key])<1,'header '+key+' stays fixed on disclosure');
    const geometry = await page.evaluate(() => {
      const rect = n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      return { header: rect(document.querySelector('.hp-history-research-group-bubble')),
        cards: Array.from(document.querySelectorAll('.hp-history-group-member--research .cb-user-bubble')).map(rect),
        rail: rect(document.querySelector('.hp-history-group-member--research')),
        owner: rect(document.querySelector('.hp-history-transcript')) };
    });
    result.widthGeometry.push({ width, font, ...geometry });
    if (width === 650 && font === 13) await page.screenshot({ path: path.join(artifact, 'exact-five-expanded.png') });
    for (const card of geometry.cards) {
      assert.ok(card.left > geometry.header.left, 'child rows indent below the left group rail');
      assert.ok(Math.abs(card.width - geometry.cards[0].width) < 1, 'all child rows share a width');
      assert.ok(Math.abs(card.right - geometry.header.right) < 1, 'all grouped cards share the right edge');
      assert.ok(card.right <= geometry.rail.right + 1 && card.left >= geometry.rail.left - 1, 'cards stay inside the group rail owner');
      assert.ok(card.left >= geometry.owner.left && card.right <= geometry.owner.right, 'no horizontal viewport escape');
    }
    result.checks.push({ width, font, check: 'closed/open header stays fixed; left-indented replies remain contained' });
  }
  for (const width of [300, 650]) for (const font of [13, 20]) {
    await page.evaluate(config => window.groupState.setCase(config), { width, font, count: 4, split: false });
    await header().waitFor();
    assert.equal(await header().count(), 1);
    assert.equal(await header().textContent(), 'Research ×4');
    assert.equal(await page.locator('[data-history-research-result]').count(), 0, 'closed group mounts no hidden reply body');
    const geometry = await header().evaluate(n => { const bubble = n.closest('.cb-user-bubble'), owner = n.closest('.hp-history-transcript');
      return { bubble: bubble.getBoundingClientRect().toJSON(), owner: owner.getBoundingClientRect().toJSON(), background: getComputedStyle(bubble).backgroundColor, border: getComputedStyle(bubble).borderColor }; });
    assert.ok(geometry.bubble.right <= geometry.owner.right + 1);
    assert.ok(geometry.bubble.right > geometry.owner.right - 24, 'counter is aligned to user edge');
    assert.ok(geometry.bubble.width < width - 24, 'right-side lane preserves the existing action gutter');
    assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
    if (width === 650 && font === 13) await page.screenshot({ path: path.join(artifact, 'closed-full.png') });
    await header().click();
    await page.locator('[data-history-group-member]').nth(3).waitFor();
    assert.equal(await header().getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-history-research-result]').count(), 4);
    assert.deepEqual(await page.locator('.hp-research-result-model').allTextContents(), Array(4).fill('· 6 · xhigh'));
    assert.equal(await page.locator('[data-external-research-source] svg').count(),4,'source is an actionable SVG arrow');
    assert.equal(await page.locator('.hp-history-research-group [data-research-preview]').count(),0,'no group caption');
    assert.equal(await page.locator('[data-uuid]').count(), 4, 'expanded header does not duplicate first UUID');
    const rails = await page.locator('[data-history-group-member]').evaluateAll(nodes => nodes.map(n => ({ left: getComputedStyle(n).borderLeftWidth, right: getComputedStyle(n).borderRightWidth, rect:n.getBoundingClientRect().toJSON() })));
    for (const rail of rails) { assert.equal(rail.left, '1px'); assert.equal(rail.right, '0px'); }
    for(let i=1;i<rails.length;i++)assert.ok(Math.abs(rails[i].rect.top-rails[i-1].rect.bottom)<1,'group rail is continuous between virtual rows');
    if (width === 650 && font === 13) await page.screenshot({ path: path.join(artifact, 'expanded-full.png') });
    await page.locator('[data-history-group-foot]').click();
    assert.equal(await header().getAttribute('aria-expanded'), 'false');
    await header().press('Enter');
    await page.locator('[data-history-group-rail]').first().click();
    assert.equal(await page.locator('[data-history-research-result]').count(), 0);
    await header().dblclick();
    assert.equal(await header().getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-draft]').inputValue(), 'НЕ МЕНЯТЬ ЧЕРНОВИК');
    result.checks.push({ width, font, check: 'closed/open/left rail/foot/keyboard/repeat/transparent/UUIDs' });
  }
  await page.evaluate(() => window.groupState.setCase({ width: 650, font: 13, count: 4, split: false }));
  const key = await page.locator('[data-history-group]').getAttribute('data-history-group');
  await page.evaluate(() => window.groupState.append());
  assert.equal(await header().textContent(), 'Research ×5');
  assert.equal(await page.locator('[data-history-group]').getAttribute('data-history-group'), key);
  await header().click(); await page.locator('[data-history-group-member]').nth(4).waitFor();
  result.checks.push('append grows same group without changing key');
  await page.evaluate(() => window.groupState.setCase({ width: 650, font: 13, count: 4, split: true }));
  await header().nth(1).waitFor();
  assert.equal(await header().count(), 2);
  assert.deepEqual(await header().allTextContents(), ['Research ×2', 'Research ×2']);
  assert.equal(await page.locator('[data-ordinary-body]').textContent(), 'Настоящее пользовательское сообщение');
  result.checks.push('ordinary user boundary gives two independent groups');
  await page.evaluate(() => window.groupState.setCase({ width: 650, font: 13, count: 1, split: false }));
  await page.locator('[data-history-research-result]').waitFor();
  assert.equal(await header().count(), 0);
  result.checks.push('singleton keeps its original card');
  await page.evaluate(() => window.groupState.setCase({ width: 650, font: 13, count: 4, split: false }));
  const target = await page.evaluate(uuid => window.groupState.navigate(uuid), entries[2].uuid);
  assert.equal(target.index, 3);
  await page.locator(`[data-uuid="${entries[2].uuid}"] [data-history-research-result]`).waitFor();
  result.checks.push('hidden exact UUID resolves to expanded member, not group key');
  await page.evaluate(() => window.groupState.navigate(window.groupData.rows[0].uuid));
  const first = page.locator(`[data-uuid="${entries[0].uuid}"]`);
  await first.getByRole('button', { name: 'Copy original answer', exact: true }).click();
  assert.equal(await page.evaluate(() => window.groupState.copies.at(-1)), entries[0].content);
  const rowHeader=first.locator('.hp-research-result-toggle'), headerBox=await rowHeader.boundingBox();
  await rowHeader.click({position:{x:headerBox.width-8,y:headerBox.height/2}});
  await first.locator('[data-research-full]').waitFor();
  const body=first.locator('[data-research-full]');
  assert.equal(await body.evaluate(n=>getComputedStyle(n).overflowY),'auto');
  assert.ok((await body.boundingBox()).height<=180.1,'the result is height-bounded');
  assert.equal(await first.locator('[data-research-preview]').count(),0,'excerpt is replaced by body');
  await first.locator('[data-external-research-source]').click();
  assert.equal(await body.count(),1,'source jump must not toggle the answer');
  assert.deepEqual(await page.evaluate(()=>window.groupState.ipc.at(-1)),{channel:'orchestration:open-research-job',arg:{runId:entries[0].semanticTags[0].runId}});
  await first.getByRole('button', { name: 'Collapse answer', exact: true }).click();
  assert.equal(await header().getAttribute('aria-expanded'), 'true', 'child disclosure does not close group');
  result.checks.push('individual raw Copy and body disclosure preserved inside group');
  assert.equal(await first.locator('[data-external-research-source]').getAttribute('data-external-research-opened-job'),'component-saved-job');
  await page.evaluate(()=>{window.groupState.failOpen=true});
  await first.locator('[data-external-research-source]').click();
  assert.equal(await first.locator('[data-external-research-source]').getAttribute('data-external-research-open-state'),'failed');
  assert.equal(await first.locator('[data-external-research-source]').getAttribute('data-external-research-opened-job'),null);
  await page.evaluate(()=>window.groupState.setCase({width:650,font:13,count:4,split:false,failed:true}));
  assert.match(await header().textContent(),/1 failed/);
  assert.equal(await page.locator('[data-history-research-result]').count(),0,'failure count is visible before opening');
  await header().click();
  assert.equal(await page.locator('[data-research-failed="true"]').count(),1);
  assert.equal(await page.locator('.hp-research-result-icon').nth(1).evaluate(n=>getComputedStyle(n).color),'rgb(239, 68, 68)');
  result.checks.push('failed result visible in collapsed count and row; source refusal is distinct from result failure');
  assert.equal(await page.locator('[data-draft]').inputValue(), 'НЕ МЕНЯТЬ ЧЕРНОВИК');
  result.catalogReads = await page.evaluate(() => window.groupState.ipc.filter(x => x.channel === 'orchestration:list-for-tab').length);
  assert.equal(result.catalogReads, 1, 'one owner catalog, not one read per grouped response');
  result.currentHashes = Object.fromEntries(await Promise.all(tracked.map(async p => [p, hash(await fs.readFile(path.join(root, p), 'utf8'))])));
  assert.deepEqual(result.currentHashes, result.loadedHashes);
  assert.deepEqual(errors, []);
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = String(error.stack); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(artifact, 'failure-full.png') }).catch(() => {});
} finally {
  if (browser) { await browser.close(); result.cleanup.browserClosed = true; }
  await fs.writeFile(path.join(artifact, 'RESULT.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, checks: result.checks.length, error: result.error, pageErrors: errors, cleanup: result.cleanup }));
}

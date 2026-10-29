import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { buildSync, transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildHistoryDisplayUnits, historyCompositeActionFacts, isHistoryDisplayGroupExpanded,
  setHistoryDisplayGroupExpanded } from './historyDisplayUnits.mjs';
import { createHistoryCompositeGroupState } from './historyCompositeGroupState.mjs';
import { historyLivePresentationKey } from './historyLiveProjection.mjs';
import { historyResponseTailLabel, formatHistoryResponseCompletedAt } from './historyResponseTiming.mjs';

// Actual presentation components, no Electron window or OS input.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = buildSync({
  stdin: { contents: `export { HistoryResponseWorkHeader, HistoryResponseWorkPreview, HistoryResponseWorkMember, HistoryCompositeWorkActions, HistoryCollapsedGroupRow, HistoryGroupRail }
    from './src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx';
    export { Markdown } from '@noted/claude-blocks';`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { HistoryResponseWorkHeader, HistoryResponseWorkPreview, HistoryResponseWorkMember, HistoryCompositeWorkActions, HistoryCollapsedGroupRow, HistoryGroupRail, Markdown } = loaded.exports;
const action = (id, family) => ({ uuid:id, role:'assistant', content:'', actions:[{tool:'__raw__',rawTool:{
  toolUseId:id, toolName:family === 'edit' ? 'Edit' : 'Read', family, args:{}, result:'ok',
}}] });
const rows = [
  {uuid:'c1',role:'assistant',textPhase:'commentary',content:'Проверяю **важный** текст.\n\nСледующий абзац.'},
  action('r','read'),action('e','edit'),
  {uuid:'c2',role:'assistant',textPhase:'commentary',content:'Нашёл причину.'},
  {uuid:'f',role:'assistant',textPhase:'final_answer',content:'Финальный ответ'},
];

test('real header, full Markdown and tool row render in original order without caption formatting',()=>{
  const closed=buildHistoryDisplayUnits(rows,{responseWork:true});
  const units=buildHistoryDisplayUnits(rows,{responseWork:true,expandedKeys:new Set([closed[0].key])});
  const html=units.map(unit=>{
    if(unit.familyKey==='response-work') return renderToStaticMarkup(React.createElement(HistoryResponseWorkHeader,
      {expanded:unit.expanded,onToggle(){}},'Worked · 00:03'));
    if(unit.kind==='group') return renderToStaticMarkup(React.createElement(HistoryCollapsedGroupRow,
      {group:unit,expanded:!!unit.expanded,onToggle(){}}));
    return renderToStaticMarkup(React.createElement(Markdown,{text:unit.entry.content}));
  }).join('');
  const offsets=['Worked · 00:03','Проверяю','Read','Нашёл причину','Финальный ответ'].map(value=>html.indexOf(value));
  assert.ok(offsets.every((value,index)=>value>=0&&(index===0||offsets[index-1]<value)));
  assert.match(html,/<strong>важный<\/strong>/);assert.match(html,/Следующий абзац/);
  assert.match(html,/aria-expanded="true"/);assert.doesNotMatch(html,/hp-history-group-detail|cb-prose-preview/);
});

test('closed preview renders the latest commentary as bounded Markdown, not raw markup or tool count',()=>{
  const closed=buildHistoryDisplayUnits(rows,{responseWork:true});
  const html=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:closed[0]}));
  assert.match(html,/Нашёл причину/);assert.doesNotMatch(html,/Проверяю|×|Read|Edit/);
  const marked=buildHistoryDisplayUnits([{uuid:'m',role:'assistant',textPhase:'commentary',
    content:'# Заголовок\n\n**важное** сообщение'}],{responseWork:true})[0];
  const formatted=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:marked}));
  assert.match(formatted,/<strong>важное<\/strong>/);assert.doesNotMatch(formatted,/# Заголовок|\*\*важное/);
  const long=buildHistoryDisplayUnits([{uuid:'long',role:'assistant',textPhase:'commentary',
    content:'**'+'а'.repeat(1000)+'**'}],{responseWork:true})[0];
  const bounded=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:long}));
  assert.match(bounded,/<strong>/);assert.doesNotMatch(bounded,/\*\*/);assert.match(bounded,/…/);
  const streaming=buildHistoryDisplayUnits([{uuid:'stream',role:'assistant',textPhase:'commentary',
    content:'Проверяю **настройки'}],{responseWork:true})[0];
  const streamingHtml=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:streaming}));
  assert.match(streamingHtml,/<strong>настройки<\/strong>/);assert.doesNotMatch(streamingHtml,/\*\*/);
  const code=buildHistoryDisplayUnits([{uuid:'code',role:'assistant',textPhase:'commentary',
    content:'Проверяю `a**b`'}],{responseWork:true})[0];
  const codeHtml=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:code}));
  assert.match(codeHtml,/<code[^>]*>a\*\*b<\/code>/);assert.doesNotMatch(codeHtml,/<\/code>\*\*/);
  const rich=buildHistoryDisplayUnits([{uuid:'rich',role:'assistant',textPhase:'commentary',
    content:'[ссылка](https://example.invalid)\n\n```text\nстрока кода\n```'}],{responseWork:true})[0];
  const richHtml=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:rich}));
  assert.match(richHtml,/ссылка/);assert.match(richHtml,/строка кода/);
  assert.doesNotMatch(richHtml,/\[ссылка\]|```|href=/,'preview is formatted and does not navigate or fetch');
  const availableStub=buildHistoryDisplayUnits([{uuid:'stub',role:'assistant',rowStub:true,hasContent:true,
    textPhase:'commentary',content:'Уже загружено'}],{responseWork:true})[0];
  const hydrated=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group:availableStub}));
  assert.match(hydrated,/Уже загружено/);assert.doesNotMatch(hydrated,/Загрузка комментария/);
});

test('before the first commentary only the most recent tool is shown, without a multiplier',()=>{
  const group=buildHistoryDisplayUnits([action('r','read'),action('e','edit')],{responseWork:true})[0];
  const html=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group}));
  assert.match(html,/Edit/);assert.doesNotMatch(html,/Read|×/);
});

test('preview time belongs to the exact selected text, not to the group timer',()=>{
  const recordTime={version:1,kind:'message',scope:'record',timestamp:'2026-10-27T05:00:00Z'};
  const group=buildHistoryDisplayUnits([{uuid:'old',role:'assistant',textPhase:'commentary',content:'old',recordTime},
    {uuid:'new',role:'assistant',textPhase:'commentary',content:'new',recordTime}],{responseWork:true})[0];
  const html=renderToStaticMarkup(React.createElement(HistoryResponseWorkPreview,{group}));
  assert.match(html,/data-history-time-at="2026-10-27T05:00:00Z"/);
  assert.match(html,/work-preview:new/);assert.doesNotMatch(html,/work-preview:old/);
});

test('work rail is inset from the pane edge and the preview has one fixed line',()=>{
  const css=fs.readFileSync(root+'/src/renderer/components/Workspace/HistoryPanel.tsx','utf8');
  const rail=css.match(/\.hp-history-response-member\s*\{([^}]+)\}/)?.[1]||'';
  const preview=css.match(/\.hp-history-work-preview-text\s*\{([^}]+)\}/)?.[1]||'';
  assert.match(rail,/margin-left:\s*4px/);assert.match(rail,/0\.28/);
  assert.match(preview,/height:\s*1\.45em/);assert.match(preview,/white-space:\s*nowrap/);
  assert.match(preview,/text-overflow:\s*ellipsis/);
});

test('the actual running timer paints its loader before any preview; completed and compact do not fake it',()=>{
  const source=fs.readFileSync(root+'/src/renderer/components/Workspace/HistoryPanel.tsx','utf8');
  const a=source.indexOf('const HistoryResponseTailTimer = memo('),b=source.indexOf('\n});',a)+4;
  const c=source.indexOf('function HistorySpinner('),d=source.indexOf('\n}\n',c)+2;
  assert.ok(a>=0&&b>a&&c>=0&&d>c);
  const compiled=transformSync(source.slice(c,d)+'\n'+source.slice(a,b),{loader:'tsx',format:'cjs'}).code;
  const Timer=new Function('React','memo','useState','useEffect','historyResponseTailLabel',
    'formatHistoryResponseCompletedAt','CompositedTextShimmer',compiled+';return HistoryResponseTailTimer;')(
      React,React.memo,React.useState,React.useEffect,historyResponseTailLabel,formatHistoryResponseCompletedAt,
      ({children})=>React.createElement('span',null,children));
  const render=timing=>renderToStaticMarkup(React.createElement(Timer,{timing,placement:'tail'}));
  const running=render({state:'running',phase:'response',startTs:Date.now(),intervalId:1});
  assert.match(running,/noted-infinite-animation/);assert.match(running,/Working/);
  const complete=render({state:'completed',startTs:1,endTs:2,durationMs:1});
  assert.doesNotMatch(complete,/noted-infinite-animation/);assert.match(complete,/Worked/);
  const compact=render({state:'running',phase:'compacting',startTs:Date.now()});
  assert.doesNotMatch(compact,/noted-infinite-animation/);assert.match(compact,/Compacting/);
});

test('actual header click and keyboard activate one toggle',()=>{
  let count=0,prevented=0;
  const node=HistoryResponseWorkHeader.type({expanded:true,onToggle:()=>count++,children:'Working'});
  node.props.onClick();node.props.onKeyDown({key:'Enter',preventDefault:()=>prevented++});
  node.props.onKeyDown({key:' ',preventDefault:()=>prevented++});
  node.props.onKeyDown({key:'ArrowDown',preventDefault:()=>prevented++});
  assert.equal(count,3);assert.equal(prevented,2);assert.equal(node.props['aria-expanded'],true);
});

test('the actual work heading exposes exact time-range metadata for the existing Cmd hover',()=>{
  const attrs={'data-history-time-key':'work:uuid:c1:time-range','data-history-time-kind':'group',
    'data-history-time-at':'2026-10-27T04:00:00Z','data-history-time-end-at':'2026-10-27T04:04:00Z'};
  const html=renderToStaticMarkup(React.createElement(HistoryResponseWorkHeader,
    {expanded:true,onToggle(){},recordTimeAttributes:attrs},'Worked · 00:04'));
  assert.match(html,/data-history-time-at="2026-10-27T04:00:00Z"/);
  assert.match(html,/data-history-time-end-at="2026-10-27T04:04:00Z"/);
});

test('actual outer and inner rail handlers target only their own independent group',()=>{
  const events=[];
  const outer=HistoryGroupRail({groupKey:'work:uuid:c1',title:'Свернуть работу',onCollapse:(...args)=>events.push(args)});
  const inner=HistoryGroupRail({groupKey:'grp:r',nested:true,onCollapse:(...args)=>events.push(args)});
  let stopped=0;
  const event={preventDefault(){},stopPropagation(){stopped++;}};
  outer.props.onClick(event);inner.props.onClick(event);
  assert.deepEqual(events,[['work:uuid:c1','rail'],['grp:r','rail']]);
  assert.equal(stopped,2,'the inner rail cannot bubble into the outer collapse');
  assert.equal(outer.props['data-history-group-rail-level'],'outer');
  assert.equal(inner.props['data-history-group-rail-level'],'inner');
  let keys=new Set();keys=setHistoryDisplayGroupExpanded(keys,'work:uuid:c1',false);
  keys=setHistoryDisplayGroupExpanded(keys,'grp:r',true);
  assert.equal(isHistoryDisplayGroupExpanded(keys,'work:uuid:c1'),false);
  assert.equal(isHistoryDisplayGroupExpanded(keys,'grp:r'),true);
  keys=setHistoryDisplayGroupExpanded(keys,'work:uuid:c1',true);
  assert.equal(isHistoryDisplayGroupExpanded(keys,'grp:r'),true);
});

test('actual work wrapper renders distinct outer and inner rail elements',()=>{
  const html=renderToStaticMarkup(React.createElement(HistoryResponseWorkMember,
    {groupKey:'work:uuid:c1',onCollapse(){}},
    React.createElement('div',{className:'hp-history-group-member'},
      React.createElement(HistoryGroupRail,{groupKey:'grp:r',nested:true,onCollapse(){}}),
      React.createElement(Markdown,{text:'Рабочий текст'}))));
  assert.match(html,/data-history-work-member="work:uuid:c1"/);
  assert.match(html,/data-history-group-rail="work:uuid:c1" data-history-group-rail-level="outer"/);
  assert.match(html,/data-history-group-rail="grp:r" data-history-group-rail-level="inner"/);
  assert.match(html,/Рабочий текст/);
});

test('text-and-calls in one source row retain one UUID and an independently collapsible tool group',()=>{
  const composite={uuid:'one-row',sourceIdentity:'same-source',role:'assistant',content:'Текст',actions:[...action('r','read').actions,...action('e','edit').actions]};
  const facts=historyCompositeActionFacts(composite),store=createHistoryCompositeGroupState();
  assert.equal(facts.length,2);
  const render=(entry=composite)=>renderToStaticMarkup(React.createElement(HistoryCompositeWorkActions,
    {entry,facts,store,liveBackgroundUuids:new Set(),isTurnBusy:false,onReveal(){}},
    React.createElement('span',{'data-test':'call-body'},'individual calls')));
  let html=render();assert.match(html,/Read/);assert.match(html,/Edit/);
  assert.doesNotMatch(html,/data-test="call-body"|hp-history-group-detail/);
  // The same exact ID used by Timeline opens the correct composite row.
  const requested=JSON.stringify(['one-row','e']);
  store.revealOnce(requested);
  html=render();assert.match(html,/data-test="call-body"/);
  assert.match(html,/data-history-group-rail-level="inner"/);
  store.acknowledge(facts.flatMap(fact=>[
    JSON.stringify(['presentation',historyLivePresentationKey(composite),fact.toolUseId]),
    JSON.stringify(['one-row',fact.toolUseId]),
  ]));
  store.clearReveal(requested);
  assert.equal(store.isOpen([requested]),true,'a consumed target remains open after navigation finishes');
  assert.equal(store.isOpen([JSON.stringify(['other-row','e'])]),false);
  assert.match(render({...composite,uuid:'durable-row'}),/data-test="call-body"/,
    'stable presentation identity keeps the tool group open after live-to-durable UUID adoption');
  assert.equal(composite.uuid,'one-row');assert.equal(composite.content,'Текст');
});

test('composite group state notifies only subscribers to the exact row and call',()=>{
  const store=createHistoryCompositeGroupState(),a=JSON.stringify(['row-a','call']),b=JSON.stringify(['row-b','call']);
  let aCount=0,bCount=0;const unsubscribe=store.subscribe([a],()=>aCount++);store.subscribe([b],()=>bCount++);
  store.set([a],true);assert.equal(aCount,1);assert.equal(bCount,0);
  store.set([a],true);assert.equal(aCount,1);
  unsubscribe();store.set([a],false);assert.equal(aCount,1);
  store.revealOnce(b);assert.equal(store.isOpen([b]),true);
  store.clearReveal(b);assert.equal(store.isOpen([b]),false,'an unmatched target does not accumulate state');
});

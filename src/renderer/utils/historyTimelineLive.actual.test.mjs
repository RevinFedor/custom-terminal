import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import * as timeline from './timelineTranscriptRefresh.mjs';
import { reduceHistoryLiveProjection, historyLivePresentationIdentities } from './historyLiveProjection.mjs';
import { resolveHistoryNavigationTarget, retainHistoryLocalPromptLiveAliases } from './historyPromptPresentation.mjs';

const compact = { tabId:'tab', toolType:'codex', sessionId:'s', type:'history_entry', recordByteOffset:100,
  entry:{ uuid:'live-compact', role:'compact', sessionId:'s', sourceIdentity:'source-100',
    timestamp:'2026-09-26T01:52:07.926Z', compactEncrypted:true, content:'Conversation compacted' } };
const owner={toolType:'codex',sessionId:'s'};

test('one existing compact event projects both History and Timeline while busy, then adopts exact durable identity',()=>{
 const point=timeline.projectTimelineLiveCompactEntry(compact,owner);
 const history=reduceHistoryLiveProjection([],compact);
 assert.equal(point.type,'compact');
 assert.equal(resolveHistoryNavigationTarget(history,timeline.historyNavigationIdentityForTimelineEntry(point)).uuid,'live-compact');
 const canonical={...point,uuid:'canonical-compact',isLiveCompactProjection:false,isSentHandoffProjection:false};
 const merged=timeline.mergeTimelineEntriesWithSentHandoffs([canonical],[],[point]);
 assert.equal(merged.length,1);assert.equal(merged[0].uuid,'canonical-compact');
});
test('compact exact guards reject foreign provider/session, unaddressable entry and invalid time',()=>{
 for(const invalid of [
  {...compact,toolType:'claude'}, {...compact,sessionId:'other'}, {...compact,type:'preview'},
  {...compact,entry:{...compact.entry,sessionId:'other'}}, {...compact,entry:{...compact.entry,sourceIdentity:''}},
  {...compact,entry:{...compact.entry,uuid:''}}, {...compact,entry:{...compact.entry,timestamp:'invalid'}},
  {...compact,entry:{...compact.entry,role:'assistant'}},
 ]) assert.equal(timeline.projectTimelineLiveCompactEntry(invalid,owner),null);
});
const local={uuid:'local-prompt-tab-h1',handoffId:'h1',role:'queued',sessionId:'s',auditEntryUuid:'carrier',sourceIdentity:'source-190',content:'same text'};
const carrier={toolType:'codex',sessionId:'s',message:{type:'user',uuid:'live-user',sessionId:'s',sourceIdentity:'source-200',sourceIdentityAliases:['source-190']}};
const isLocal=e=>e.uuid.startsWith('local-prompt-');
test('owned prompt keeps promotion aliases without replacing its visible card or using equal text',()=>{
 const other={...local,uuid:'local-prompt-tab-other',sourceIdentity:'other',auditEntryUuid:'other'};
 const rows=retainHistoryLocalPromptLiveAliases([local,other],carrier,isLocal);
 assert.equal(rows[0].uuid,local.uuid);assert.equal(rows[1],other);
 assert.equal(resolveHistoryNavigationTarget(rows,'source-200').uuid,local.uuid);
 assert.equal(retainHistoryLocalPromptLiveAliases(rows,carrier,isLocal),rows);
 const source=[local];
 assert.equal(retainHistoryLocalPromptLiveAliases(source,{...carrier,sessionId:'other'},isLocal),source);
 assert.equal(retainHistoryLocalPromptLiveAliases(source,{...carrier,message:{...carrier.message,sourceIdentityAliases:[],content:'same text'}},isLocal),source);
 assert.equal(timeline.historyNavigationIdentityForTimelineEntry({uuid:'carrier',sourceIdentity:'source-190',isSentHandoffProjection:true}),'source-190');
});

function actualEffect(file,needle,hook='useEffect'){
 const source=fs.readFileSync(new URL('../components/Workspace/'+file,import.meta.url),'utf8');
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let body;
 function walk(node){if(ts.isCallExpression(node)&&node.expression.getText(tree)===hook
   &&node.arguments[0]?.getText(tree).includes(needle))body=node.arguments[0].getText(tree);ts.forEachChild(node,walk);}
 walk(tree);assert.ok(body,'actual effect '+needle);
 return transformSync('globalThis.effect='+body,{loader:'tsx',format:'cjs',target:'es2022'}).code;
}
const timelineEffect=actualEffect('Timeline.tsx','projectTimelineLiveUserMessage(');
test('actual Timeline listener accepts compact in background and rejects foreign tab without loading a snapshot',()=>{
 let listener;let snapshot={ownerKey:'owner',entries:[]};
 const scope={...timeline,sessionId:'s',toolType:'codex',tabId:'tab',timelineOwnerKey:'owner',
  timelineInstanceIdRef:{current:'instance'},isTurnBusyRef:{current:true},console:{warn(){}},
  setLiveUserSnapshot:fn=>{snapshot=fn(snapshot);},
  useUIStore:{getState:()=>({historyRewindPreviews:{}})},shouldClearRewindPreviewForDurableUser:()=>false,
  ipcRenderer:{on:(_key,fn)=>{listener=fn;},removeListener:()=>{}},setHistoryRewindPreview:()=>{},
 };
 vm.runInNewContext(timelineEffect,scope);scope.effect();
 listener({},compact);assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].type,'compact');
 listener({},compact);assert.equal(snapshot.entries.length,1);
 listener({},{...compact,tabId:'other'});assert.equal(snapshot.entries.length,1);
});

const navigationEffect=actualEffect('HistoryPanel.tsx','const requestedTargetIdentity = historyScrollToUuid');
function navigationFixture(){
 const frames=[],acks=[],moves=[];
 const live={uuid:'live-user',role:'user',sourceIdentity:'source-200',sessionId:'s'};
 const scope={historyScrollToUuid:'source-200',surfaceLoading:false,entries:[],displayEntries:[live],
  resolveHistoryNavigationTarget,expandGroupForUuid:()=>false,displayEntryIndexByUuid:new Map([['live-user',0]]),
  displayEntryIndexByUuidRef:{current:new Map([['live-user',0]])},entriesRef:{current:[live]},
  setHistoryScrollToUuid:()=>{},tabId:'tab',toolType:'codex',pendingInitialHistoryIndex:-1,
  scrollGenRef:{current:0},scrollMountedRef:{current:true},historyScrollInFlightRef:{current:null},
  historyJumpHydrationActiveRef:{current:false},panelDiagContextRef:{current:''},
  visibleRangeRef:{current:{start:0,end:0}},historyDiag:()=>{},
  HISTORY_SCROLL_PIXEL_CAP_WARN_PX:16_000_000,JUMP_STUB_HYDRATION_WAIT_MS:1000,
  historyScrollSeekController:{stampMachineScrollCooldown(){}},lastProgrammaticHistoryScrollRef:{current:null},setFlashUuid:()=>{},
  isHistoryHydrationTargetStub:()=>false,requestHistoryHydrationAt:()=>{},hydrationLastResultRef:{current:null},
  virtuosoRef:{current:{scrollToIndex:value=>moves.push(value.index)}},
  performance:{now:()=>10},requestAnimationFrame:fn=>frames.push(fn),setTimeout:()=>{},CSS:{escape:value=>value},
  CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},window:{dispatchEvent:event=>acks.push(event.detail)},
 };
 scope.virtuosoScrollerRef={current:{scrollHeight:2000,scrollTop:400,clientHeight:900,getBoundingClientRect:()=>({top:0}),
  querySelector:selector=>scope.entriesRef.current.some(row=>selector.includes('"'+row.uuid+'"'))?{hasAttribute:()=>false,getBoundingClientRect:()=>({top:400})}:null}};
 vm.runInNewContext(navigationEffect,scope);
 return {scope,frames,acks,moves,step(){frames.shift()?.();}};
}
test('actual navigation resolves live rows absent from durable entries and follows canonical UUID during convergence',()=>{
 const f=navigationFixture();f.scope.effect();f.step();
 f.scope.entriesRef.current=[{uuid:'canonical-user',sourceIdentity:'source-200',role:'user'}];
 f.scope.displayEntryIndexByUuidRef.current=new Map([['canonical-user',7]]);
 for(let i=0;i<5;i++)f.step();
 assert.equal(f.acks.length,1);assert.equal(f.acks[0].found,true);assert.equal(f.acks[0].targetUuid,'canonical-user');
 assert.deepEqual(f.moves,[0,7,7,7]);
});
test('actual navigation refuses equal text/foreign identity and a superseded owner cannot acknowledge',()=>{
 const miss=navigationFixture();miss.scope.historyScrollToUuid='foreign-source';miss.scope.effect();
 assert.equal(miss.acks[0].found,false);assert.equal(miss.acks[0].reason,'identity-not-in-display');
 const stale=navigationFixture();stale.scope.effect();stale.scope.scrollGenRef.current++;stale.step();assert.equal(stale.acks.length,0);
});

const committedEffect=actualEffect('HistoryPanel.tsx','consumeMaterializedPromptHandoffs(committed)','useLayoutEffect');
test('actual commit observer consumes only committed durable rows, never local/live or uncommitted reader data',()=>{
 const consumed=[];
 const canonical={uuid:'canonical',sourceIdentity:'source',role:'user'};
 const scope={entries:[local,canonical,{uuid:'live',liveProjection:true}],presentedOwnerKey:'A',historyOwnerKey:'A',
  historyOwnerKeyRef:{current:'A'},durableSourceIdentitiesRef:{current:new Set()},committedHistoryEntriesRef:{current:null},
  rawServerEntriesRef:{current:[{uuid:'uncommitted'}]},historyLivePresentationIdentities,isLocalPromptEntry:isLocal,
  reconcileLiveProjectionAgainstDurable:()=>{},consumeMaterializedPromptHandoffs:rows=>consumed.push(rows),
 };
 vm.runInNewContext(committedEffect,scope);scope.effect();
 assert.deepEqual(consumed[0],[canonical]);assert.equal(scope.committedHistoryEntriesRef.current.ownerKey,'A');
 scope.historyOwnerKeyRef.current='B';scope.effect();assert.equal(consumed.length,1);
});

test('actual audit replay enriches existing chips without a new row/tail pin; a new equal-text send remains new',()=>{
 const file=new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url);
 const source=fs.readFileSync(file,'utf8');const tree=ts.createSourceFile('HistoryPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let body;function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='appendLocalPromptEntry')body=n.initializer.arguments[0].getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(body);
 const canonical={uuid:'canonical',role:'user',sessionId:'s',sourceIdentity:'source-190',content:'same text'};
 let rows=[canonical],pins=0;
 const scope={sessionId:'s',tabId:'tab',LOCAL_PROMPT_PREFIX:'local-prompt-',
  normalizeHistoryPromptText:s=>s,normalizeComposerChips:v=>v,retainHistoryDraftImages:(_t,v)=>v,
  committedHistoryEntriesRef:{current:{ownerKey:'A',entries:rows}},historyOwnerKeyRef:{current:'A'},
  findServerPromptEntry:(items,e)=>items.find(row=>row.uuid===e.auditEntryUuid||!!e.sourceIdentity&&row.sourceIdentity===e.sourceIdentity),
  presentationEntriesRef:{current:rows},historySnapshotOwner:{},promptHandoffMetaRef:{current:new Map()},
  setEntries:fn=>{rows=fn(rows);},persistVolatileOverlay:()=>{},keepHistoryTailPinnedAfterMutation:()=>pins++,
  isLocalPromptEntry:isLocal,historyDiag:()=>{},promptPreview:s=>s,
 };
 vm.runInNewContext(transformSync('globalThis.append='+body,{loader:'tsx',format:'cjs',target:'es2022'}).code,scope);
 const chip={id:'chip',kind:'prompt',text:'body',label:'prompt'};
 scope.append('same text','sent',{handoffId:'old',auditEntryUuid:'canonical',promptChips:[chip],submittedAt:Date.now()});
 assert.equal(rows.length,1);assert.equal(rows[0].promptChips[0],chip);assert.equal(pins,0);
 scope.append('same text','sending',{handoffId:'new',requiresAuditIdentity:true,submittedAt:Date.now()});
 assert.equal(rows.length,2);assert.equal(rows[1].handoffId,'new');assert.equal(pins,1);
});

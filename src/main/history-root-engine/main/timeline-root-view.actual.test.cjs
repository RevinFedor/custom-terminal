'use strict';
// ONE finite Node process, no app, native UI, provider, MCP or profiles.
// node --max-old-space-size=80 --max-semi-space-size=4 --expose-gc <this file>
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),v8=require('node:v8');
const {DatabaseSync}=require('node:sqlite');
const evidence=process.env.NOTED_TIMELINE_VIEW_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence),'explicit own evidence directory');
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2,'TOTAL V8 heap <=128MiB');
fs.mkdirSync(evidence,{recursive:true});
// node:sqlite replaces the Electron-ABI better-sqlite3 binding ONLY. Actual
// HistoryPagedStore/arenas/logical/view/layout run without substitution.
class SQLite{
 constructor(filename){this.name=filename;this.native=new DatabaseSync(filename);this.depth=0;}
 get inTransaction(){return this.native.isTransaction;}
 exec(s){return this.native.exec(s);}
 prepare(s){const q=this.native.prepare(s),convert=r=>{if(!r)return r;const out={};for(const [k,v]of Object.entries(r))out[k]=v instanceof Uint8Array?Buffer.from(v):v;return out;};
  return{get:(...a)=>convert(q.get(...a)),all:(...a)=>q.all(...a).map(convert),run:(...a)=>q.run(...a),*iterate(...a){for(const r of q.iterate(...a))yield convert(r);}};}
 pragma(s,o={}){const r=this.prepare('PRAGMA '+s).all();return o.simple?Object.values(r[0])[0]:r;}
 transaction(fn){return(...a)=>{if(this.depth)return fn(...a);this.exec('BEGIN');this.depth++;try{const r=fn(...a);this.exec('COMMIT');return r;}catch(e){try{this.exec('ROLLBACK');}catch{}throw e;}finally{this.depth--;}};}
 close(){this.native.close();}
}
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createTimelineLogicalRoot}=require('./timeline-root-logical');
const {createTimelineRootView}=require('./timeline-root-view');
const {createTimelineRootLayout}=require('./timeline-root-layout');
const F=require('../shared/timeline-entry-facts.cjs'),P=require('../shared/prompt-origin.cjs');
const {resolveForkMarkerBoundary,normalizeForkMarkerEntryUuids}=require('../shared/fork-marker-boundary.cjs');
const {isVisibleAppFork}=require('../shared/fork-operation.cjs');
const source=fs.readFileSync(path.resolve(__dirname,'../../../renderer/components/Workspace/Timeline.tsx'),'utf8');
const ts=require('typescript');
const groupSource=source.slice(source.indexOf('function computeGroups('),source.indexOf('// Module-level remount acceleration.'));
const derivations=source.slice(source.indexOf('  const groupMap = useMemo('),source.indexOf('  // ═',source.indexOf('  const hiddenCompactBoundaryIndices = useMemo(')));
assert(groupSource.includes('groupCounter++')&&derivations.includes('semanticGroupForcedOpenIds')&&derivations.includes('hiddenCompactBoundaryIndices'));
const oracleScript=new vm.Script(ts.transpileModule(groupSource+'\n'+derivations+`\nresult={groupMap,collapsedGroupPresentation,semanticGroups,semanticGroupByUuid,codexCompactClusters,forkSnapshotSets,forkMarkerIndexByLastSnapIndex,semanticGroupForcedOpenIds,hiddenCompactBoundaryIndices,semanticActionByUuid,semanticMetaPromptByUuid};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
let peakHeap=0,peakFixture=0,scenarios=0,semanticsComplete=false;const fixtureDirs=new Set();
function sample(dir){const memory=process.memoryUsage();peakHeap=Math.max(peakHeap,memory.heapTotal);assert(memory.heapTotal<=128*1024**2);let bytes=0;for(const root of fixtureDirs)for(const name of fs.readdirSync(root)){const st=fs.lstatSync(path.join(root,name));assert(!st.isSymbolicLink());bytes+=st.size;}peakFixture=Math.max(peakFixture,bytes);assert(bytes<=64*1024**2,'TOTAL fixture <=64MiB');}
function pins(store){return{leases:store.stats().leases,builders:store.stats().activeBuilders,pins:store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n};}
function publish(store,value){const arena=new HistoryProjectionArena(store);try{return arena.step(()=>arena.publish(value));}finally{arena.close();}}
function annotations(store,notes=[],outline=null,rewinds=[],summaries=[],overrides=[]){const root=publish(store,{notes,outline,rewindMarkers:rewinds,promptSummaries:summaries,turnActionOverrides:overrides});
 function wrap(root){let closed=false;return{root,revision:'fixture-annotations',notes:root.cursor().field('notes'),outline:root.cursor().field('outline'),promptSummaries:root.cursor().field('promptSummaries'),turnActionOverrides:root.cursor().field('turnActionOverrides'),
  hasRewindMarker:uuid=>rewinds.some(r=>r.entry_uuid===uuid),fork(){return wrap(root.fork());},release(){if(!closed){closed=true;root.release();}}};}return wrap(root);}
async function fixture(t,entries,{notes=[],outline=null,rewinds=[],presentation=null,summaries=[],overrides=[]}={}){
 const dir=fs.mkdtempSync(path.join(evidence,'fixture-')),store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:48*1024**2});
 fixtureDirs.add(dir);
 const sourceRoot=publish(store,{entries}),ann=annotations(store,notes,outline,rewinds,summaries,overrides),pres=presentation?publish(store,presentation):null;
 const base={success:true,semanticSnapshotComplete:true,root:sourceRoot,entries:sourceRoot.cursor().field('entries')};
 const audit={assertCurrent(){},async checkpoint(){sample(dir);await new Promise(resolve=>setImmediate(resolve));}};
 const logical=await createTimelineLogicalRoot(store,base,{annotations:ann,presentationRoot:pres,control:audit});
 sourceRoot.release();ann.release();pres?.release();const held=[];
 const hold=x=>{held.push(x);return x;};
 const options=value=>hold(publish(store,value));
 const build=(value={},extra={})=>createTimelineRootView({store,logicalRoot:logical,optionsRoot:options(value),control:audit,...extra}).then(hold);
 t.after(()=>{try{for(let i=held.length-1;i>=0;i--)held[i].release();logical.release();assert.deepEqual(pins(store),{leases:0,builders:0,pins:0});sample(dir);}finally{store.close();fs.rmSync(dir,{recursive:true});fixtureDirs.delete(dir);assert(!fs.existsSync(dir));global.gc?.();}});
 return{store,logical,dir,build,hold,options,notes,outline,rewinds,summaries,overrides,audit};
}
const u=(id,extra={})=>({uuid:id,type:'user',content:'work '+id,sessionId:'session-A',...extra});
const mcp={kind:'orchestration',runKind:'session',runId:'run'};
const sc={kind:'orchestration',runKind:'external-research',runId:'research'};
const note=(uuid,position='before')=>({entry_uuid:uuid,content:'note '+uuid,position});
const outline=groups=>({schemaVersion:2,outline:{groups,turns:[],metaPrompts:[]}});
const semantic=(id,ids)=>({id,title:'Caption '+id,memberUuids:ids,members:ids.map(uuid=>({uuid,description:'detail '+uuid}))});
function rootGroups(v,field){return mat(v.root.field(field));}
function headers(v){const out=[];for(let i=0;i<v.length;i+=3)out.push(...v.window({startOrdinal:i}).items);return out;}
let presentation,normalizeMarkers;
async function oracle(entries,opts,f,v,extra={}){
 const isCodex=(opts.toolType||'codex')==='codex',forkMarkers=normalizeMarkers(opts.forkMarkers||[]),notes=Object.fromEntries(f.notes.map(n=>[n.entry_uuid,n.content]));
 let lastBoundaryIndex=-1;if(!isCodex&&opts.toolType!=='gemini')entries.forEach((e,i)=>{if(e.type==='compact'||e.isPlan)lastBoundaryIndex=e.type==='compact'&&entries[i+1]?.isCompactSummary?i+1:i;});
 if(opts.lastBoundaryIndex!==undefined)lastBoundaryIndex=opts.lastBoundaryIndex;
 const context={entries,isCodex,forkMarkers,notes,rewindMarkers:new Set(f.rewinds.map(r=>r.entry_uuid)),timelineOutlineRecord:f.outline,timelineActionOverrides:Object.fromEntries(f.overrides.map(x=>[x.entryUuid,x])),
  lastBoundaryIndex,claudeMemoryBoundaryUuid:null,selectionStartId:extra.activeRangeAction?'selected':null,rangeActionMenu:null,copyingRange:null,deletingRange:null,rewindState:null,editRangeState:null,
  useMemo:fn=>fn(),timelineAutomaticGroupKind:F.timelineAutomaticGroupKind,collectTimelineDocs:presentation.collectTimelineDocs,
  getLoopPromptOriginTag:P.getLoopPromptOriginTag,getOrchestrationTag:P.getTerminalMcpTag,isEligibleTabTitleEntry:F.isEligibleTimelineTitleEntry,
  normalizeForkMarkerEntryUuids,resolveForkMarkerBoundary};
 vm.createContext(context);oracleScript.runInContext(context);const d=context.result,auto=rootGroups(v,'automatic'),sem=rootGroups(v,'semantic');
 // Preferences use NEW exact authority keys. Only the reference renderer
 // translates them to its old display IDs for this finite comparison.
 const expandedAuto=new Set(),expandedSem=new Set();
 for(const g of auto)assert.equal(g.expanded,(extra.intents||[]).find(i=>i.key===g.key)?.expanded===true||!!opts.expandedAutomatic?.includes(g.key),'automatic preference');
 const validSemantic=(opts.expandedSemantic||[]).filter(key=>sem.some(g=>g.key===key));
 const defaultLast=opts.expandedSemantic===undefined||opts.expandedSemantic.length>0&&validSemantic.length===0;
 for(let n=0;n<sem.length;n++)assert.equal(sem[n].expanded,d.semanticGroupForcedOpenIds.has(sem[n].displayId)||validSemantic.includes(sem[n].key)||defaultLast&&n===sem.length-1,'semantic restore/forced-open');
 for(const g of auto)if(g.expanded)expandedAuto.add(g.displayId);
 for(const g of sem)if(g.expanded)expandedSem.add(g.displayId);
 const out=[],emit=(kind,logicalRank,baseExtent,flexWeight=0,extra={})=>out.push({kind,logicalRank,baseExtent,flexWeight,...extra});
 const expanded=!!opts.expandedLayout,tree=!!opts.treeMode;
 if(entries.length&&(opts.sessionBoundaries||[]).some(b=>b.childSessionId===entries[0].sessionId)&&entries[0].sessionId&&!forkMarkers.some(m=>!m.entry_uuids||m.entry_uuids.length===0))emit('plan-beginning',0,8);
 if(entries.length&&forkMarkers.some(m=>m.snapshot_complete!==false&&isVisibleAppFork(m)&&(!m.entry_uuids||m.entry_uuids.length===0)))emit('fork-beginning',0,8);
 for(let i=0;i<entries.length;i++){
  const e=entries[i],g=d.groupMap.get(i),membership=d.semanticGroupByUuid.get(e.uuid),sg=membership?.group;
  const sgExpanded=sg&&(expandedSem.has(sg.id)||d.semanticGroupForcedOpenIds.has(sg.id)),sgStart=membership?.memberIndex===0;
  const groupExpanded=g&&expandedAuto.has(g.groupId),cluster=d.codexCompactClusters.get(i);
  if(expanded&&sg&&!sgExpanded&&!F.isTimelineAttributeEntry(e)){if(sgStart)emit('semantic-header',i,30,0,{expanded:false});continue;}
  if(g?.isGroupChild&&!g.isGroupHeader&&!groupExpanded)continue;
  if(cluster&&!cluster.isHead||d.hiddenCompactBoundaryIndices.has(i))continue;
  if(expanded&&sg&&sgStart)emit('semantic-header',i,30,0,{expanded:true});
  const collapsed=g?.isGroupHeader&&!groupExpanded,editing=extra.editNote?.logicalRank===i,hasNote=!!notes[e.uuid]||editing,pos=editing?extra.editNote.position:f.notes.find(n=>n.entry_uuid===e.uuid)?.position||'before';
  if(collapsed&&hasNote&&pos==='before')emit('note-before',i,6);
  if(g?.isGroupHeader)emit('automatic-header',i,20,collapsed&&!expanded?1:0,{expanded:!!groupExpanded});
  if(!collapsed){
   if(hasNote&&pos==='before')emit('note-before',i,6);
   const badges=presentation.buildTimelineCornerBadges({isLoop:!!P.getLoopPromptOriginTag(e),hasPromptChip:e.hasPromptChip===true||e.promptChips?.some(c=>c?.kind==='prompt'),
    docsEditedCount:(e.docsEdited||(e.type==='docs_edit'&&e.content?[e.content]:[])).length,
    docsSearchCount:(e.docsSearchQueries||(e.type==='docs_search'&&e.content?[e.content]:[])).length,subagentCount:e.subAgents?.length||0,
    compactClusterSize:(e.type==='compact'||e.isCompactSummary)&&!tree?cluster?.count||1:0});
   const dense=badges.items.filter(b=>b.slot.endsWith('right')).length>=3,marker=presentation.timelineMarkerKind(e,s=>require('node:crypto').createHash('sha256').update(s).digest('hex'));
   const base=marker==='sc-desktop'?32:dense||tree?22:g?.isGroupChild&&groupExpanded?14:20;
   emit('entry',i,base,expanded?0:1);
   if(hasNote&&pos==='after')emit('note-after',i,6);
  }
  if(collapsed&&hasNote&&pos==='after')emit('note-after',i,6);
  if(i===lastBoundaryIndex)emit('last-boundary',i,8);
  const hit=d.forkMarkerIndexByLastSnapIndex.get(i),fork=hit===undefined?null:forkMarkers[hit],old=!isCodex&&lastBoundaryIndex>=0&&i<=lastBoundaryIndex;
  if(fork&&isVisibleAppFork(fork)&&!old)emit('fork',i,20);
  const next=entries[i+1];let plan=i!==entries.length-1&&!fork&&next&&e.sessionId&&next.sessionId&&e.sessionId!==next.sessionId;
  if(plan)for(const snap of d.forkSnapshotSets)if(snap.has(e.uuid)&&snap.has(next.uuid)){plan=false;break;}
  if(plan&&!old)emit('plan-boundary',i,8);
 }
 // Compare ALL atom order, membership and captions before any bounds claims.
 const actual=headers(v).map(a=>({kind:a.kind,logicalRank:a.logicalRank,baseExtent:a.baseExtent,flexWeight:a.flexWeight,...(['semantic-header','automatic-header'].includes(a.kind)?{expanded:a.expanded}:{})}));
 assert.deepEqual(actual,out,'exact Native-reference atom stream');
 const autoByStart=new Map(auto.map(g=>[g.startIndex,g]));
 for(const [rank,g]of d.groupMap)if(rank===g.startIndex){const actual=autoByStart.get(rank);assert(actual);assert.equal(actual.displayId,g.groupId);assert.equal(actual.agentName,g.agentName);assert.equal(actual.hasTimeout,g.hasTimeout);assert.equal(actual.memberRanks.length,g.groupSize);
  const members=entries.slice(rank,rank+g.groupSize);assert.deepEqual(actual.edited,presentation.collectTimelineDocs(members).edited);assert.deepEqual(actual.searched,presentation.collectTimelineDocs(members).searched);assert.deepEqual(actual.promptLabels,presentation.collectTimelinePromptLabels(members));assert.equal(actual.hasPromptChip,members.some(e=>e.hasPromptChip===true||e.promptChips?.some(c=>c?.kind==='prompt')));assert.equal(actual.isLoop,members.some(e=>!!P.getLoopPromptOriginTag(e)));
  assert.deepEqual(actual.memberRanks,Array.from({length:g.groupSize},(_,j)=>rank+j));}
 assert.deepEqual(sem.map(g=>g.displayId),Array.from(d.semanticGroups,g=>g.id));
 for(let i=0;i<entries.length;i++){
  const fct=mat(v.factsAt(i)),expected=d.semanticGroupByUuid.get(entries[i].uuid);
  assert.equal(fct.semanticIndex===null?null:sem[fct.semanticIndex].displayId,expected?.group.id??null,'semantic ownership '+i);
  assert.equal(fct.semanticMemberIndex,expected?.memberIndex??null);
  assert.equal(fct.markerKind,presentation.timelineMarkerKind(entries[i],s=>require('node:crypto').createHash('sha256').update(s).digest('hex')));
  assert.equal(fct.clusterCount,d.codexCompactClusters.get(i)?.count||1);
  assert.equal(fct.clusterNoise,!!d.codexCompactClusters.get(i)?.isNoise);
  const action=d.semanticActionByUuid.get(entries[i].uuid);
  if(action){const actual=mat(v.annotationAt('action',fct.actionOrdinal));assert.equal(actual.description,action.description);assert.equal(actual.manual,!!action.manual);assert.equal(actual.role,action.role);}
  else assert.equal(fct.actionOrdinal,null);
  const meta=d.semanticMetaPromptByUuid.get(entries[i].uuid);if(meta)assert.deepEqual(mat(v.annotationAt('meta',fct.metaPromptOrdinal)),JSON.parse(JSON.stringify(meta)));
  else assert.equal(fct.metaPromptOrdinal,null);
  if(expected&&expected.memberIndex>=0){assert.equal(fct.semanticRole,expected.role);assert.equal(fct.semanticDetail,expected.detail);}
 }
 for(const g of sem){const expected=d.semanticGroups.find(x=>x.id===g.displayId);assert.equal(g.title,expected.title);assert.deepEqual(g.outlineGroup,JSON.parse(JSON.stringify(expected)));}
 scenarios++;return d;
}

test('Native-reference full visual semantics BEFORE ownership/bounds/lifetime assertions',async t=>{
 presentation=await import('../../../renderer/utils/timelineMarkerPresentation.mjs');normalizeMarkers=(await import('../../../renderer/utils/forkMarkerSnapshot.mjs')).normalizeForkMarkers;
 const mixed=[u('start'),u('a',{isSubAgent:true,subAgentName:'one',docsEdited:['docs/a','docs/a'],promptChipLabels:[' Saved ',' Saved ']}),
  u('b',{isSubAgentTimeout:true,subAgentName:'two',docsSearchQueries:['query'],semanticTags:[{kind:'prompt-origin',source:'loop'}]}),
  u('m1',{semanticTags:[mcp]}),u('m2',{semanticTags:[mcp],hasPromptChip:true}),u('sc',{semanticTags:[sc]}),u('m3',{semanticTags:[mcp]}),
  u('dense',{docsEdited:['d'],docsSearchQueries:['q'],subAgents:[{}]}),u('compact',{type:'compact'}),u('noise',{content:'  '}),u('compact2',{type:'compact'}),
  u('continued',{type:'continued'}),u('technical',{type:'compact'}),u('summary',{isCompactSummary:true}),u('last',{sessionId:'session-B'})];
 const question=require('../shared/native-question-reply.cjs'),fingerprint=s=>require('node:crypto').createHash('sha256').update(s,'utf8').digest('hex');
 const definition={callId:'call-exact',toolName:'request_user_input_async',namespace:'',sourceIdentity:'call-source',physicalSessionId:'session-A',turnIndex:1,args:{questions:[{title:'Exact question?',options:['A','B']}]}};
 const definitions=new Map();question.registerNativeQuestionDefinition(definitions,question.codexNativeQuestionDefinition(definition,fingerprint));
 const replyText='<send_user_message_question_reply>\n'+JSON.stringify([{question:'Exact question?',answer:'B',questionItemId:JSON.stringify(['request_user_input_async','call-exact',0])}])+'\n</send_user_message_question_reply>';
 const proof=question.proveCodexNativeQuestionReply(replyText,definitions,'session-A',fingerprint);assert(proof);
 const cases=[
  ['mixed compact',mixed,{notes:[note('a'),note('dense','dot'),note('last','after')]},{toolType:'codex'}],
  ['tree base and child expansion',mixed,{notes:[note('a','after')]},{toolType:'codex',treeMode:true}],
  ['Claude paired compact and old strips',mixed,{notes:[note('summary','dot')]},{toolType:'claude',forkMarkers:[{fork_mode:'full',entry_uuids:[' a ','b'],hidden:1}]}],
  ['semantic collapsed attributes', [u('lead',{type:'compact'}),u('p1'),u('s1',{isSubAgent:true}),u('s2',{isSubAgent:true}),u('p2'),u('between',{type:'compact'}),u('p3'),u('p4'),u('tail',{type:'continued'})],
   {outline:outline([semantic('work1',['p1','p2']),semantic('work2',['p3','p4']),semantic('invalid',['p1','p4'])])},{expandedLayout:true,expandedSemantic:[]}],
  ['semantic default last and compact cluster', [u('p1'),u('p2'),u('co',{type:'compact'}),u('blank',{content:''}),u('p3'),u('p4')],{outline:outline([semantic('g1',['p1','p2']),semantic('g2',['p3','p4'])])},{expandedLayout:true}],
  ['semantic forced by notes',[u('p1'),u('p2')],{notes:[note('p2','before')],outline:outline([semantic('g',['p1','p2'])])},{expandedLayout:true,expandedSemantic:[]}],
  ['semantic forced by rewind',[u('p1'),u('p2')],{rewinds:[{entry_uuid:'p2'}],outline:outline([semantic('g',['p1','p2'])])},{expandedLayout:true,expandedSemantic:[]}],
  ['session change forces semantic',[u('p1'),u('p2',{sessionId:'session-B'})],{outline:outline([semantic('g',['p1','p2'])])},{expandedLayout:true,expandedSemantic:[]}],
  ['empty visible fork before entries',[u('p1')],{},{forkMarkers:[{fork_mode:'full',entry_uuids:[]}],sessionBoundaries:[{childSessionId:'session-A'}]}],
  ['hidden empty suppresses beginning plan',[u('p1')],{},{forkMarkers:[{fork_mode:'full',hidden:true,entry_uuids:[]}],sessionBoundaries:[{childSessionId:'session-A'}]}],
  ['incomplete empty suppresses plan without stripe',[u('p1')],{},{forkMarkers:[{fork_mode:'full',snapshot_complete:false,entry_uuids:[]}],sessionBoundaries:[{childSessionId:'session-A'}]}],
  ['no survivor is not beginning',[u('p1'),u('p2',{sessionId:'session-B'})],{},{forkMarkers:[{fork_mode:'full',entry_uuids:['absent']}],sessionBoundaries:[{childSessionId:'session-A'}]}],
  ['sparse snapshots, hidden first at same edge',[u('p1'),u('p2'),u('p3',{sessionId:'session-B'}),u('p4')],{},{forkMarkers:[{fork_mode:'full',hidden:true,entry_uuids:['p1','p2']},{fork_mode:'full',entry_uuids:['p2']},{fork_mode:'full',entry_uuids:['p1','p3']}]}],
  ['inherited plan suppressed by any snapshot',[u('p1'),u('p2',{sessionId:'session-B'}),u('p3')],{},{forkMarkers:[{fork_mode:'history_rewind',entry_uuids:['p1','p2','p3']}]}],
  ['plan beginning + regular boundaries',[u('p1'),u('p2',{sessionId:'session-B'})],{},{sessionBoundaries:[{childSessionId:'session-A'}]}],
  ['semantic active range forces every group',[u('p1'),u('p2'),u('p3'),u('p4')],{outline:outline([semantic('g1',['p1','p2']),semantic('g2',['p3','p4'])])},{expandedLayout:true,expandedSemantic:[]},{activeRangeAction:true}],
  ['editing note point intent',[u('p1'),u('p2')],{},{},{editNote:{logicalRank:0,position:'after'}}],
  ['captions action overrides and member metadata',[u('p1'),u('p2')],{outline:{schemaVersion:2,outline:{groups:[{...semantic('g',['p1','p2']),members:[{uuid:'p1',role:'start',detail:'initial'},{uuid:'p2',role:'end',description:'completed'}]}],turns:[{uuid:'p1',description:' Auto action.。 '},{uuid:'p2',description:'native action.'}],metaPrompts:[{uuid:'p1',title:'Meta title'}]}},overrides:[{entryUuid:'p2',actionLabel:' Manual override... '}]},{expandedLayout:true,expandedSemantic:[]}],
  ['duplicate UUID membership matches Native map',[u('p1'),u('p1'),u('p2')],{outline:outline([semantic('g',['p1','p2'])])},{expandedLayout:true,expandedSemantic:[]}],
  ['empty array docs suppresses fallback density',[u('d',{type:'docs_edit',content:'doc',docsEdited:[],docsSearchQueries:['query'],subAgents:[{}]})],{},{toolType:'codex'}],
  ['structural attribute outside semantic children',[u('compact',{type:'compact'}),u('p1'),u('docs',{type:'docs_search',content:'query'}),u('p2'),u('compact2',{type:'compact'})],{outline:outline([semantic('g',['p1','p2'])])},{expandedLayout:true,expandedSemantic:[]}],
  ['system automatic continue and loop markers',[u('system',{semanticTags:[{kind:'prompt-origin',source:'system',systemSource:'build-install-return'}]}),u('retry',{semanticTags:[{kind:'prompt-origin',source:'system',systemSource:'codex-capacity-retry'}]}),u('loop',{semanticTags:[{kind:'prompt-origin',source:'loop'}]})],{},{toolType:'codex'}],
  ['hidden fork on semantic member forces open',[u('p1'),u('p2')],{outline:outline([semantic('g',['p1','p2'])])},{expandedLayout:true,expandedSemantic:[],forkMarkers:[{fork_mode:'full',hidden:true,entry_uuids:['p1']}]}],
  ['Claude last boundary forces semantic open',[u('p1'),u('p2',{isPlan:true}),u('p3')],{outline:outline([semantic('g',['p1','p2'])])},{toolType:'claude',expandedLayout:true,expandedSemantic:[]}],
  ['exact native question reply marker and unchanged actual content',[u('reply',{content:replyText,questionReplyProof:proof}),u('stale',{content:replyText+'x',questionReplyProof:proof})],{},{toolType:'codex'}],
  ['fork preprocessing trims deduplicates and removes empty UUIDs',[u('p1'),u('p2')],{},{forkMarkers:[null,[],{fork_mode:'full',entry_uuids:[' ',null,4,'p1',' p1 ']},{fork_mode:'full',entry_uuids:['   ',null]}],sessionBoundaries:[{childSessionId:'session-A'}]}],
  ['empty',[],{},{expandedLayout:true}],
 ];
 for(const [name,entries,ann,opts,extra={}]of cases)await t.test(name,async t=>{
  const f=await fixture(t,entries,ann),v=await f.build(opts,extra);await oracle(entries,opts,f,v,extra);sample(f.dir);
  if(name==='tree base and child expansion'){
   const groups=rootGroups(v,'automatic'),intents=groups.filter(g=>g.memberRanks.length>1).map(g=>({key:g.key,expanded:true}));
   const opened=f.hold(await v.withOptions({intents,control:f.audit}));await oracle(entries,opts,f,opened,{intents});
  }
 });
 assert.equal(scenarios,cases.length+1,'ALL semantic cases completed');semanticsComplete=true;
});

test('bounded paging, independent frozen cuts, exact generation and layout coordinates AFTER oracle',async t=>{
 assert(semanticsComplete);const entries=[u('x'),u('a',{isSubAgent:true}),u('b',{isSubAgent:true}),u('co',{type:'compact'}),u('y')];
 const f=await fixture(t,entries),v=await f.build({}),old=headers(v),g=rootGroups(v,'automatic')[0];
 const fork=f.hold(v.fork()),clone=f.hold(v.clone()),open=f.hold(await v.withOptions({intents:[{key:g.key,expanded:true}],control:f.audit}));
 assert.deepEqual(headers(v),old);assert.deepEqual(headers(fork),old);assert(open.length>v.length);
 const rep=v.resolve({uuid:'b'});assert.equal(rep.logicalRank,2);assert.equal(rep.canonicalOrdinal,2);assert.equal(rep.representative.kind,'automatic-header');
 assert.equal(mat(v.actualRow(2)).uuid,'b');assert.equal(open.resolve({uuid:'b'}).representative.kind,'entry');
 assert.equal(v.resolve({uuid:'missing'}).found,false);assert.throws(()=>v.window({limit:4}),/WINDOW/);
 const range=v.rangeFacts(1,2);assert.equal(range.count,2);assert.equal(range.headers,1);assert.equal(range.visibleEntries,0);assert.equal(range.visualStart,range.visualEnd);
 const layout=f.hold(await createTimelineRootLayout({store:f.store,atomsCursor:v.atoms,layoutFingerprint:'font-width-exact',mode:'compact',viewportExtent:400}));
 assert.equal(layout.info().count,v.length);assert.equal(layout.info().totalExtent,400);
 for(let i=0;i<v.length;i++){const rect=layout.rect(i);assert.deepEqual(v.lookup(old[i].key),old[i]);assert.equal(rect.key,old[i].key);assert.equal(rect.baseExtent,old[i].baseExtent);assert.equal(layout.atomAtOffset(rect.start).ordinal,i);}
 const checked=v.stats().ownership;assert.equal(checked.nativeRows,0);assert.equal(checked.nativeMapEntries,0);assert.equal(checked.inputIdentitySlots,0);
 assert.equal(v.stats().wholeTimelineDTOs,0);assert.equal(v.stats().maxNativeRowSinks,1);assert.equal(v.stats().globalMemoryBounded,false);
 v.release();assert.deepEqual(headers(fork),old);fork.release();assert.deepEqual(headers(clone),old);
 const f2=await fixture(t,entries),fresh=await f2.build({expandedAutomatic:[g.displayId,g.key]});
 assert.notEqual(rootGroups(fresh,'automatic')[0].key,g.key,'same old group ordinal never inherits across generation');
 assert.equal(rootGroups(fresh,'automatic')[0].expanded,false);
 const owner=await f.build({forkMarkers:[{fork_mode:'full',entry_uuids:['a','b']}]});
 const rebuilding=owner.withOptions({intents:[],control:f.audit});owner.release();const independent=f.hold(await rebuilding);assert(independent.length>0);assert.equal(independent.resolve({uuid:'b'}).found,true);
 f.logical.release();assert.equal(mat(independent.actualRow(1)).uuid,'a','caller logical release does not revoke view');
 let gcSteps=0;for(;;){const result=f.store.collectStep(256);if(result.complete)break;assert(++gcSteps<5000);await new Promise(resolve=>setImmediate(resolve));}
 assert.deepEqual(headers(clone),old);assert.equal(mat(clone.actualRow(2)).uuid,'b');
 sample(f.dir);sample(f2.dir);
});

test('expanded child group authority, exact timeout counts and compact selected fork annotation',async t=>{
 presentation=await import('../../../renderer/utils/timelineMarkerPresentation.mjs');
 normalizeMarkers=(await import('../../../renderer/utils/forkMarkerSnapshot.mjs')).normalizeForkMarkers;
 const entries=[u('a',{isSubAgent:true}),u('b',{isSubAgent:true,isSubAgentTimeout:true}),u('c',{isSubAgentTimeout:true}),u('tail')];
 const f=await fixture(t,entries),opts={expandedLayout:true,treeMode:true,forkMarkers:[{source_session_id:'parent',fork_session_id:'child',
  fork_mode:'full',entry_uuids:['a','b','c'],created_at:123,hidden:false,snapshot_complete:true}]},v=await f.build(opts),g=rootGroups(v,'automatic')[0];
 const intents=[{key:g.key,expanded:true}],opened=f.hold(await v.withOptions({intents,control:f.audit}));
 await oracle(entries,opts,f,opened,{intents});
 const group=rootGroups(opened,'automatic')[0];assert.equal(group.failedCount,2);assert.equal(group.hasTimeout,true);
 assert.equal(group.mcpCount,0);assert.equal(group.scCount,0);
 for(const header of headers(opened).filter(h=>h.kind==='entry'&&h.logicalRank<3))assert.equal(header.groupKey,group.key,'child owns an exact signed group key');
 const fork=mat(opened.annotationAt('fork',0));assert.equal(fork.source_session_id,'parent');assert.equal(fork.fork_session_id,'child');
 assert.equal(fork.snapshotCount,3);assert.equal(fork.created_at,123);assert(!Object.hasOwn(fork,'entry_uuids'));
 assert(!Object.hasOwn(fork,'membership'));assert.equal(opened.stats().ownership.nativeMapEntries,0);
});

test('rewind uses complete Codex user order and exact normalized UTF16 across windows',async t=>{
 const body='😀\u0000\ud800'+'x'.repeat(33001)+'\udc00 tail',
  entries=[u('lead',{content:'before'}),u('target',{content:'\t\r\n'+body+'\u00a0\ufeff'}),
   u('boundary',{type:'compact',content:'compact'}),u('assistant',{type:'assistant',content:body}),
   u('duplicate',{content:body}),u('prefix-only',{content:body+' different'}),
   u('summary',{isCompactSummary:true,content:' '+body+' '}),u('last',{content:'after'})];
 const f=await fixture(t,entries),logical=f.logical;
 // The finite reference is the existing Codex Timeline native selector:
 // all user entries, no compact/plan boundary, full replace(/\s+/g,' ').trim().
 const users=entries.filter(e=>e.type==='user'),normalize=s=>s.replace(/\s+/g,' ').trim();
 for(let rank=0;rank<entries.length;rank++){
  const entry=entries[rank];if(entry.type!=='user')continue;
  const targetIndex=users.findIndex(e=>e.uuid===entry.uuid),facts=await logical.rewindContext(rank,{control:f.audit});
  assert.deepEqual({...facts,revision:undefined},{entryIndex:rank,targetIndex,rewindableCount:users.length,
   lastBoundaryIdx:-1,skipDuplicates:users.slice(targetIndex+1).filter(e=>normalize(e.content)===normalize(entry.content)).length,
   menuSource:'full-text',revision:undefined});
 }
 await assert.rejects(logical.rewindContext(3),/TARGET_NOT_USER/);
 let checks=0;await assert.rejects(logical.rewindContext(1,{control:{assertCurrent(){if(++checks===2)throw Error('selected-demand-cancelled');},async checkpoint(){}}}),/selected-demand-cancelled/);
 assert.equal((await logical.rewindContext(1,{control:f.audit})).skipDuplicates,2,'cancel does not alter the frozen selector');
});

test('automatic tail append keeps expanded group choice while membership revision changes',async t=>{
 const entries=[u('head'),u('a',{isSubAgent:true}),u('b',{isSubAgent:true})],f=await fixture(t,entries);
 const initial=await f.build({sourceGeneration:'verified-tail-epoch'}),group=rootGroups(initial,'automatic')[0];
 const expanded=f.hold(await initial.withOptions({intents:[{key:group.key,expanded:true}],control:f.audit}));
 const base=f.hold(publish(f.store,{entries:[...entries,u('c',{isSubAgent:true})]}));
 const logical=f.hold(await createTimelineLogicalRoot(f.store,{success:true,semanticSnapshotComplete:true,root:base,entries:base.cursor().field('entries')},{control:f.audit}));
 const appended=f.hold(await createTimelineRootView({store:f.store,logicalRoot:logical,
  optionsRoot:f.options({sourceGeneration:'verified-tail-epoch'}),preferencesRoot:expanded.root.field('preferences'),control:f.audit}));
 const next=rootGroups(appended,'automatic')[0];assert.equal(next.key,group.key);assert.equal(next.expanded,true);
 assert.notEqual(next.membershipRevision,group.membershipRevision);assert.equal(next.memberRanks.length,3);
 const rewritten=f.hold(await createTimelineRootView({store:f.store,logicalRoot:logical,
  optionsRoot:f.options({sourceGeneration:'different-rewrite-epoch'}),preferencesRoot:expanded.root.field('preferences'),control:f.audit}));
 assert.notEqual(rootGroups(rewritten,'automatic')[0].key,group.key);assert.equal(rootGroups(rewritten,'automatic')[0].expanded,false);
});
test('Actual-N docs/labels/member references and preferences stay paged; append versus rewrite generation',async t=>{
 assert(semanticsComplete);
 const long='long Ω🙂 '.repeat(30),entries=[u('start'),...Array.from({length:12},(_,i)=>u('member-'+i,{isSubAgent:true,subAgentName:long+i,
  docsEdited:[long+'doc'+i,'same'],docsSearchQueries:[long+'query'+i],promptChipLabels:[long+'label '+i],promptChips:i===2?[{kind:'prompt',label:'saved'}]:[]})),u('end')];
 const f=await fixture(t,entries),opts={sourceGeneration:'exact-source-epoch-1',expandedAutomatic:Array.from({length:96},(_,i)=>require('node:crypto').createHash('sha256').update('stale'+i).digest('hex'))};
 const v=await f.build(opts);await oracle(entries,opts,f,v);const g=rootGroups(v,'automatic')[0],cursor=v.group(g.key);
 assert.equal(cursor.field('memberRanks').kind,'array');assert.equal(cursor.field('memberRanks').length,12);assert.equal(cursor.field('edited').length,13);assert.equal(cursor.field('promptLabels').length,13);
 assert(!Array.isArray(cursor));assert(!Array.isArray(v.atoms));assert.equal(v.stats().ownership.nativeMapEntries,0);assert.equal(v.stats().ownership.nativeRows,0);
 assert(JSON.stringify(v.window()).length<8192,'fixed scalar window excludes large docs/labels/captions');
 const expanded=f.hold(await v.withOptions({intents:[{key:g.key,expanded:true}],control:f.audit}));assert.equal(rootGroups(expanded,'automatic')[0].key,g.key);assert.equal(expanded.resolve({uuid:'member-11'}).representative.kind,'entry');
 const closed=f.hold(await expanded.withOptions({intents:[{key:g.key,expanded:false}],control:f.audit}));assert.equal(closed.length,v.length);assert.equal(rootGroups(expanded,'automatic')[0].expanded,true);assert.equal(rootGroups(v,'automatic')[0].expanded,false);
 const base2=f.hold(publish(f.store,{entries:[...entries,u('append')]})),logical2=f.hold(await createTimelineLogicalRoot(f.store,{success:true,semanticSnapshotComplete:true,root:base2,entries:base2.cursor().field('entries')},{control:f.audit}));
 const appended=f.hold(await createTimelineRootView({store:f.store,logicalRoot:logical2,optionsRoot:f.options({sourceGeneration:'exact-source-epoch-1',expandedAutomatic:[g.key]}),control:f.audit}));
 assert.equal(rootGroups(appended,'automatic')[0].key,g.key,'unchanged membership survives verified append within epoch');assert.equal(rootGroups(appended,'automatic')[0].expanded,true);
 const rewritten=f.hold(await createTimelineRootView({store:f.store,logicalRoot:logical2,optionsRoot:f.options({sourceGeneration:'exact-source-epoch-2',expandedAutomatic:[g.key]}),control:f.audit}));
 assert.notEqual(rootGroups(rewritten,'automatic')[0].key,g.key);assert.equal(rootGroups(rewritten,'automatic')[0].expanded,false,'no inherited ordinal or key across rewrite');
 // A cancelled build must stop during a real cursor checkpoint and return ALL
 // its own leases/build admissions, while the old result stays usable.
 const cancelOptions=f.options(opts),before=pins(f.store);let checkpoints=0;
 await assert.rejects(()=>createTimelineRootView({store:f.store,logicalRoot:f.logical,optionsRoot:cancelOptions,control:{assertCurrent(){},async checkpoint(){checkpoints++;throw new Error('cursor-cancelled');}}}),/cursor-cancelled/);
 assert.equal(checkpoints,1);assert.deepEqual(pins(f.store),before);assert.equal(v.resolve({uuid:'member-11'}).found,true);
 const lateOptions=f.options({}),lateBefore=pins(f.store),budget=f.store.diskBudget;let quotaCheckpoints=0;
 try{await assert.rejects(()=>createTimelineRootView({store:f.store,logicalRoot:f.logical,optionsRoot:lateOptions,control:{assertCurrent(){},async checkpoint(){quotaCheckpoints++;f.store.diskBudget=1;}}}),e=>e.code==='HISTORY_BACKING_FULL');}finally{f.store.diskBudget=budget;}
 assert.equal(quotaCheckpoints,1);assert.deepEqual(pins(f.store),lateBefore,'partial late quota returns exact pins');sample(f.dir);
});

test('logical/canonical/visual coordinates, selected-one compatibility, cancellation/quota cleanup',async t=>{
 assert(semanticsComplete);const entries=[u('goal',{role:'goal'}),u('a'),u('b')];
 const f=await fixture(t,entries,{presentation:{liveEntries:[u('live',{handoffId:'h',timestamp:'2026-10-26T00:00:00Z'})]}}),v=await f.build({});
 assert.equal(v.resolve({uuid:'a'}).logicalRank,0);assert.equal(v.resolve({uuid:'a'}).canonicalOrdinal,1);
 assert.equal(v.resolve({uuid:'live'}).canonicalOrdinal,null);
 const before=pins(f.store);let calls=0;
 await assert.rejects(()=>f.build({}, {control:{assertCurrent(){if(++calls>5)throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});}}}),/cancelled/);
 // build() intentionally holds its options lease even when build fails.
 const after=pins(f.store);assert.equal(after.builders,before.builders);assert.equal(after.leases,before.leases+1);assert.equal(after.pins,before.pins+1);
 const limit=f.store.diskBudget;f.store.diskBudget=1;
 try{await assert.rejects(()=>createTimelineRootView({store:f.store,logicalRoot:f.logical}),e=>e.code==='HISTORY_BACKING_FULL');}finally{f.store.diskBudget=limit;}
 assert.deepEqual(pins(f.store),after,'failed quota adds no lease/pin');assert.equal(v.resolve({uuid:'a'}).found,true);
 sample(f.dir);
});

test.after(()=>{
 const result={scope:'finite actual HistoryPagedStore + logical + visual + layout; source-extracted Native-reference renderer derivations',scenarios,semanticsComplete,
  heapLimit:v8.getHeapStatistics().heap_size_limit,peakHeapTotal:peakHeap,peakFixtureBytes:peakFixture,actualUI:false,globalMemoryBounded:false,
  substitutions:['Node22 node:sqlite for Electron ABI','finite paged annotation fixture; SQL capture independently covered by annotation owner'],
  open:['parent renderer/API/action integration and actual UI acceptance remain outside this worker']};
 fs.writeFileSync(path.join(evidence,'RESULT.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
});

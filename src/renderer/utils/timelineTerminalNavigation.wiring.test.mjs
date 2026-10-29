import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=readFileSync(new URL('../components/Workspace/TimelineRootSurface.tsx',import.meta.url),'utf8');
const start=source.indexOf('  const navigate = async ('),end=source.indexOf('  const navigateRef =',start);
assert(start>0&&end>start);
const body=ts.transpileModule(source.slice(start,end)+'\nreturn navigate;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function harness({duringQuery,absent=false,nonNavigable=false}={}){
 const calls=[],terminal={},frame={instanceId:'one',generation:'G1',generationOrdinal:1};let released=0,held=0,sid='session';
 const revision='a'.repeat(64),props={tabId:'tab',sessionId:'session',cwd:'/own',isVisible:true},clicked=[];
 const fact=before=>({kind:'timeline-terminal-navigation-v1',logicalRank:4,revision,logicalRevision:revision,navigable:!nonNavigable,
  searchLines:['selected exact UTF16 Ω\ud800'],occurrenceBefore:2,previousBeforeRank:before,
  previousAnchor:before===4?{logicalRank:3,searchLines:['absent predecessor'],occurrenceBefore:1}:{logicalRank:2,searchLines:['found predecessor'],occurrenceBefore:0},
  nextPreviousBeforeRank:before===4?3:2});
 const client={header:{logicalRevisionToken:revision},retain(){held++;let done=false;return async()=>{assert(!done);done=true;released++;};},
  async query(op,args,options){assert.equal(op,'terminal-navigation');calls.push(['query',args]);
   if(!options.owns())throw Object.assign(Error('cancelled'),{code:'HISTORY_READ_CANCELLED'});
   await Promise.resolve();duringQuery?.({frame,props,setSid:value=>{sid=value;}});
   if(!options.owns())throw Object.assign(Error('cancelled'),{code:'HISTORY_READ_CANCELLED'});
   return{terminalNavigation:fact(args.beforeLogicalRank??4)};}};
 const registry={get:()=>absent?undefined:terminal,getPresentationIdentity:()=>absent?null:{...frame},
  findTextBufferRow(tab,lines,count,after){calls.push(['find',tab,lines,count,after]);return lines[0]==='found predecessor'?88:-1;},
  scrollToTextInBuffer(tab,lines,count,after){calls.push(['scroll',tab,lines,count,after]);return after===-1;}};
 const deps={queuedTarget:null,selected:null,historySurfaceVisible:false,historyOpen:false,readOnly:false,tabId:'tab',sessionId:'session',cwd:'/own',
  setContextMarked(){},terminalRegistry:registry,activeRef:{current:true},latest:{current:props},
  useWorkspaceStore:{getState:()=>({getCodexSessionId:()=>sid})},setClicked:value=>clicked.push(value),owner:{},model:{current:{client}},emit(){},setQueuedTarget(){},
  setSelected(){},setRangeMenu(){},setPopup(){},historyNavigationIdentityForTimelineEntry:e=>e.uuid,useUIStore:{getState(){throw Error('no History branch');}}};
 const keys=Object.keys(deps),navigate=new Function(...keys,body)(...keys.map(k=>deps[k]));
 return{navigate,subject:{entry:{uuid:'assistant-subject',type:'assistant',content:'full exact selected source'},logicalRank:4,client},calls,clicked,counts:()=>({held,released})};
}
test('actual RootSurface plain navigation uses bounded predecessor continuation and original anchored fallback',async()=>{
 const h=harness();await h.navigate(h.subject);assert.deepEqual(h.counts(),{held:1,released:1});
 assert.deepEqual(h.calls.filter(c=>c[0]==='query').map(c=>c[1]),[{logicalRank:4},{logicalRank:4,beforeLogicalRank:3,ifRevision:'a'.repeat(64)}]);
 assert.deepEqual(h.calls.filter(c=>c[0]==='find').map(c=>[c[2][0],c[3],c[4]]),[['absent predecessor',1,-1],['found predecessor',0,-1]]);
 assert.deepEqual(h.calls.filter(c=>c[0]==='scroll').map(c=>[c[2],c[3],c[4]]),[[['selected exact UTF16 Ω\ud800'],2,88],[['selected exact UTF16 Ω\ud800'],2,-1]]);
 assert.equal(h.clicked.at(-1),null);
});
test('terminal instance generation or current source loss after await cancels only this navigation',async()=>{
 for(const change of [({frame})=>{frame.generation='G2';},({setSid})=>setSid('other'),({props})=>{props.isVisible=false;}]){
  const h=harness({duringQuery:change});await assert.rejects(h.navigate(h.subject),{code:'HISTORY_READ_CANCELLED'});
  assert.equal(h.calls.filter(c=>c[0]==='scroll'||c[0]==='find').length,0);assert.deepEqual(h.counts(),{held:1,released:1});
 }
});
test('missing terminal is ordinary failed navigation; nonnavigable attribute does not search or fabricate a position',async()=>{
 const absent=harness({absent:true});await absent.navigate(absent.subject);assert.deepEqual(absent.clicked,[{rank:4,status:'failed'}]);assert.equal(absent.calls.length,0);
 const attribute=harness({nonNavigable:true});await attribute.navigate(attribute.subject);assert.equal(attribute.calls.length,1);assert.equal(attribute.clicked.length,0);
 assert.deepEqual(attribute.counts(),{held:1,released:1});
});

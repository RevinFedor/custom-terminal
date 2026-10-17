'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let ts;try{ts=require('typescript');}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');}
const root=path.resolve(__dirname,'../..'), product=root;
const redraw=require(path.join(product,'src/main/terminal-redraw-diagnostics.js'));
const input=require(path.join(product,'src/main/terminal-input-progress.js'));
const {createAgentInputObservation,observeAgentInput}=require(path.join(product,'src/main/agent-input-observation.js'));
const installed=fs.readFileSync(require.resolve('./main'),'utf8');
const actual=process.env.MAIN_SOURCE ? fs.readFileSync(process.env.MAIN_SOURCE,'utf8') : installed;
function declaration(name){const ast=ts.createSourceFile('main.js',actual,ts.ScriptTarget.Latest,true);const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(n,name);return n.getText(ast);}
function tick(){return new Promise(resolve=>setImmediate(resolve));}
// These are the actual supplied installed declarations. The default sandbox
// adapts ONLY the new diagnostic entry + three direct writes, not their guards.
// MAIN_SOURCE runs the already-patched CURRENT declaration with no adaptation.
function manualDeclaration(){return declaration('readTerminalInputDiagnosticOwner')+'\n'+declaration('handleTerminalInput');}
function manual({queue=false,throwLog=false}={}){
 let time=10,revision=2;const writes=[],captures=[],jobs=[],term={write(data){writes.push(data);}};
 const mirror={generation:'M',writeSeq:3334,flushedSeq:3334,redrawTrace:redraw.createTerminalRedrawTrace(8,{now:()=>100000+time,log:()=>{if(throwLog)throw Error('sink');}})};redraw.recordTerminalOutput(mirror.redrawTrace,'\x1b[?2026h',{seq:3004,at:1});
 const ctx={Buffer,...redraw,...input,nodePerformance:{timeOrigin:100000,now:()=>time},console:{log(){},warn(){},error(){}},terminals:new Map([['T',term]]),terminalCommandState:new Map([['T',{isRunning:true,runSeq:1}]]),mainWindow:null,dictationClipboardReceipts:{entries:new Map(),observeWritten(){}},terminalCommandAdmission:{cancel(){},valid:()=>true},codexLateMcpProofPending:new Map(),classifyLateMcpProofInput:()=>({cancelProof:false}),codexTuiReadyTabs:new Set(['T']),codexWatchers:new Map(),codexTurnWatchers:new Map(),codexKnownSessions:new Map(),codexLastRunCommandPayload:new Map(),aiStoppingTabs:new Map(),ptyLastQueuedWriteOperation:new WeakMap(),ptyActiveWriteOperation:new WeakMap(),shouldSerializeManualPtyInput:({alreadySerialized})=>queue&&!alreadySerialized,withPtyWriteLock:(_term,work)=>new Promise((resolve,reject)=>jobs.push(()=>Promise.resolve().then(work).then(resolve,reject))),classifyManualPtyInputAtBoundary:()=>({action:'continue'}),resolveAiToolTypeForTab:()=> 'codex',getTerminalLifecycleGeneration:()=> 'L:1',getTerminalStopRevision:()=>0,getTerminalInputRevision:()=>revision,bumpTerminalInputRevision:()=>++revision,conversationOwners:{noteInput(){}},isPureCodexEscapeBurst:()=>false,codexManualQueueInterrupts:new Map(),getHeadlessTerminalMirror:()=>mirror,recordComposerForensicPtyInput:()=>({id:1}),codexStartupPromptAdoptionProbeTabs:new Set(),codexStartupAutoEnter:new Map(),terminalInputLineBuffers:new Map(),classifyClaudeResumeShellInput:()=>({matched:false}),getLiveAiRuntimeOwners:()=>['codex'],trackClaudeInputLineForLocalCommands:()=>null,trackCodexInputLineForCompact:()=>null,captureTerminalInputForLastCommand:()=>captures.push(writes.length),geminiActiveTabs:new Set(),prepareCodexNativeSettingsIntentInput:()=>null,codexImageBindings:{handleTerminalInput(){}},deferredTerminalInputOwnerIncidents:new WeakSet(),reportTerminalIncident:async()=>({}),terminalProjects:new Map()};
 for(const n of ['revokeCodexActionAuthoritiesForManualInput','trackManualCodexRewindNavigationInput','queueTerminalCommandMeta','markCodexNativeSettingsIntentInputWritten','activateClaudeLocalCommandWatcher','discardClaudeLocalCommandWatcherPreparation'])ctx[n]=()=>{};
 vm.createContext(ctx);vm.runInContext(manualDeclaration(),ctx);
 return {ctx,writes,captures,jobs,term,mirror,at:t=>time=t,run:(data,meta={xtermInputOrigin:'user'})=>ctx.handleTerminalInput(null,'T',data,meta),snap:()=>mirror.redrawTrace.inputProgress.snapshot()};
}

test('actual manual paste body remains transparent while DEC2026 is open; capture precedes write',async()=>{
 const h=manual(),data='\x1b[200~Текст\nвставки\x1b[201~';await h.run(data);
 assert.deepEqual(h.writes,[data]);assert.deepEqual(h.captures,[0]);const r=h.snap().records[0];assert.equal(r.standaloneEnter,false);assert.equal(r.bracketedPaste,true);assert.equal(r.writesReturned,1);assert.equal(r.owner.syncOpen,true);assert.equal(r.owner.mirrorWriteSeq,3334);assert.equal(r.writeOwner.inputRevision,r.owner.inputRevision+1);
});
test('actual Stop guard still rejects without a diagnostic write',async()=>{
 const h=manual();h.ctx.aiStoppingTabs.set('T',{toolType:'codex'});await h.run('paste');assert.equal(h.writes.length,0);assert.equal(h.snap().records[0].writesAttempted,0);
});
test('actual existing serializer reentry retains one input receipt and original receive time',async()=>{
 const h=manual({queue:true}),p=h.run('paste');await tick();assert.equal(h.writes.length,0);h.at(2000);await h.jobs.shift()();await p;const s=h.snap();assert.equal(s.records.length,1);assert.equal(s.records[0].receivedAt,100010);assert.equal(s.records[0].firstWriteAt,102000);assert.deepEqual(h.writes,['paste']);
});
test('actual serializer physical-owner replacement refuses original bytes',async()=>{
 const h=manual({queue:true}),p=h.run('paste');await tick();h.ctx.terminals.set('T',{write(){assert.fail('foreign writer');}});await h.jobs.shift()();await p;assert.equal(h.writes.length,0);assert.equal(h.snap().records[0].writesAttempted,0);
});
test('actual manual input remains single-write with failing diagnostic sink',async()=>{
 const h=manual({throwLog:true});await h.run('paste');assert.deepEqual(h.writes,['paste']);assert.ok(h.snap().diagnosticErrors>0);
});
test('terminal protocol responses do not acquire a new manual trace or new input permission',async()=>{
 const h=manual();await h.run('\x1b[1;1R',{xtermInputOrigin:'terminal-response'});assert.equal(h.snap().records.length,0);assert.deepEqual(h.writes,['\x1b[1;1R']);
});

function clock(){let t=1000,id=0;const timers=new Map();return{now:()=>t,setTimer:(f,ms)=>{const k=++id;timers.set(k,{f,at:t+ms});return k;},clearTimer:k=>timers.delete(k),async to(v){t=v;for(const[k,x]of [...timers])if(x.at<=t){timers.delete(k);x.f();}for(let n=0;n<10;n++)await tick();},timers};}
// Exact frame admission condition from CURRENT codex-draft-authority.js; ports
// supplying current physical screen/identity remain controlled (not a CLI).
function getCodexDraftFrameBlocker({synchronizedOutputOpen=false,writeSeq=null,flushedSeq=null,pendingResizeWriteSeq=null}={}){
 if(synchronizedOutputOpen===true)return 'synchronized-output-open';
 if(!Number.isFinite(writeSeq)||!Number.isFinite(flushedSeq)||writeSeq!==flushedSeq)return 'frame-not-flushed';
 if(pendingResizeWriteSeq!==null&&pendingResizeWriteSeq!==undefined&&(!Number.isFinite(pendingResizeWriteSeq)||writeSeq<=pendingResizeWriteSeq))return 'post-resize-frame-not-observed';return null;
}
function warm(){const c=clock(),listeners=new Set(),reports=[];let current=true,open=true,seq=3334,flushed=3334,draft=false;
 const headless={};const ctx={console:{log(){},warn(){}},createMainAgentInputObservation(_tab,_provider,budget,options){const o=createAgentInputObservation({timeoutMs:budget,isCurrent:()=>current&&options.isOwnerCurrent(),now:c.now,setTimer:c.setTimer,clearTimer:c.clearTimer,subscribe:w=>{listeners.add(w);return()=>listeners.delete(w);}});o.identity={mirrorToken:headless};return o;},captureCodexSendStartupFrameWait:()=>null,codexSendStartupFrameWaitIsCurrent:()=>true,observeAgentInput,HEADLESS_XTERM_FLUSH_TIMEOUT_MS:2500,flushHeadlessTerminalMirror:async()=>({success:true}),getHeadlessCodexDraftState(){const blocker=getCodexDraftFrameBlocker({synchronizedOutputOpen:open,writeSeq:seq,flushedSeq:flushed});return {success:true,hasDraft:blocker?null:draft,preview:'',frameBlocker:blocker,frameIdentity:{generation:'M',writeSeq:seq},frameState:{generation:'M',writeSeq:seq,flushedSeq:flushed,synchronizedOutputOpen:open},source:'headless-main'};},mergeCodexDraftAuthority:x=>x,hasDefinitiveDraftState:r=>r?.success===true&&typeof r.hasDraft==='boolean',shouldWaitForCodexDraftProof:({initialHasDraft,expected,waitOnUnknownOnly})=>initialHasDraft===expected?false:waitOnUnknownOnly?initialHasDraft===null:true,agentSendTestFaultActive:()=>false,agentDraftObservationResult:(_tab,_provider,_o,report)=>report.value||{hasDraft:null,proofReason:report.reason,observation:report.observation},agentInputObservationInvalidated:r=>['superseded','cancelled'].includes(r?.observation?.status),reportTerminalIncident:async(_key,value)=>reports.push(value)};
 vm.createContext(ctx);vm.runInContext(declaration('requestTerminalCodexDraftState'),ctx);
 const run=()=>ctx.requestTerminalCodexDraftState(null,'T','agent-send-preflight:history-panel',700,{waitFor:false,waitTimeoutMs:2500,waitOnUnknownOnly:true});
 return{c,listeners,reports,run,frame:(o,s,f,d=false)=>{open=o;seq=s;flushed=f;draft=d;for(const w of listeners)w();},cancel:()=>{current=false;for(const w of listeners)w();}};
}
test('characterization: actual warm request expires with applied3334 but open frame; late close cannot revive it',async()=>{
 const h=warm(),p=h.run();await h.c.to(1200);h.frame(true,3335,3335);await h.c.to(3501);const r=await p;assert.equal(r.hasDraft,null);assert.equal(r.proofReason,'deadline');assert.equal(h.reports[0].context.mainProof.frameBlocker,'synchronized-output-open');assert.equal(h.listeners.size,0);h.frame(false,4000,4000);assert.equal(r.hasDraft,null);assert.equal(h.c.timers.size,0);
});
test('actual request: new closed but unflushed frame cannot settle; flushed current frame can',async()=>{
 const h=warm();let resolved=false;const p=h.run().then(x=>(resolved=true,x));await h.c.to(1200);h.frame(false,3335,3334);await h.c.to(1300);assert.equal(resolved,false);h.frame(false,3335,3335);await h.c.to(1400);assert.equal((await p).hasDraft,false);assert.equal(h.listeners.size,0);
});
test('actual request: owner change supersedes wait; real nonempty composer remains nonempty',async()=>{
 const a=warm(),p=a.run();await a.c.to(1200);a.cancel();await a.c.to(1300);assert.equal((await p).observation.status,'superseded');assert.equal(a.listeners.size,0);
 const b=warm(),q=b.run();await b.c.to(1200);b.frame(false,3335,3335,true);await b.c.to(1300);assert.equal((await q).hasDraft,true);
});

// Deliberately unimplemented product contract, separate from diagnostic GREEN.
// This tests the old actual request, not a fake successful replacement sender.
if (process.env.CAPABILITY_ONLY === '1') test('CAPABILITY CONTRACT proposed: same-owner open-frame wait must not become final after 2.5s',async()=>{
 const h=warm();let finished=false;const p=h.run().then(r=>{finished=true;return r;});
 await h.c.to(3501);await p;
 assert.equal(finished,false,'Current warm proof is terminal after its 2500ms budget. The diagnostic patch intentionally does not repair accepted-item lifetime.');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('/Users/fedor/Desktop/custom-terminal/node_modules/typescript');
const source = fs.readFileSync(require('node:path').resolve(__dirname,'../src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
function between(a,b) { const i=source.indexOf(a); assert(i>=0,a); const j=source.indexOf(b,i+a.length); assert(j>=0,b); return source.slice(i,j); }
const runner = between('  wakeInitialHistoryRef.current = () => {','  useLayoutEffect(() => {\n    // Names the owner-takeover');
const install = between('    pendingInitialHistoryRef.current = { ownerKey: historyOwnerKey','    return () => {\n      if (pendingInitialHistoryRef.current');
const revoke = between('      if (pendingInitialHistoryRef.current?.generation === generation','      deferredWarmRefreshCancelRef.current?.();');
const ordinary = between('    appliedHistoryPresentationRef.current = {\n      presented: proof.presented,\n      visit: proof.visit,\n    };\n    if (proof.presented)', '\n\n    // The old dormant');
const externalChanged = between('        if (proof.presented) wakeInitialHistoryRef.current?.();', '\n        if (!geometryStable) remountForChangedGeometry();');
const externalSame = between('      } else {\n        if (proof.presented) wakeInitialHistoryRef.current?.();', '\n        // First visible visit');
function compile(s) { return ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText; }
function harness() {
 const calls=[], frames=new Map(), signals=[]; let id=0;
 const c={ pendingInitialHistoryRef:{current:null},wakeInitialHistoryRef:{current:null},historyPresentationProofRef:{current:{presented:false}},historyOwnerKey:'A', historyOwnerKeyRef:{current:'A'},historyOwnerGenerationRef:{current:1},generation:1,cachedSnapshot:null, historyRevisionRef:{current:{token:'r'}}, toolType:'claude',sessionId:'session',cwd:'/x',tabId:'tab',deferredWarmRefreshCancelRef:{current:null},onInitialSourceSignalRef:{current:x=>signals.push(x)},appliedHistoryPresentationRef:{current:null},proof:{presented:true,visit:1},loadHistory: async x=>{calls.push(['load',x]);return true},ipcRenderer:{invoke:async (...x)=>{calls.push(['probe',...x]);return {success:true,unchanged:true}}},historyDiag:()=>{},Date,queueMicrotask, requestAnimationFrame:f=>{frames.set(++id,f);return id},cancelAnimationFrame:n=>frames.delete(n)};
 vm.createContext(c); const run=s=>vm.runInContext('{\n'+compile(s)+'\n}',c); run(runner);
 const frame=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(f=>f())};
 return {c,calls,signals,frames,run,frame,install:()=>run(install),revoke:()=>run(revoke),show:()=>{c.historyPresentationProofRef.current.presented=true;run(ordinary)},external:()=>{c.historyPresentationProofRef.current.presented=true;run(externalChanged);run(externalSame.replace('      } else {', ''))}};
}
(async()=>{
 let h=harness(); h.install(); assert.equal(h.calls.length,0); h.show(); assert.deepEqual(h.calls,[['load',false]]); h.show(); h.external(); assert.equal(h.calls.length,1);
 h=harness(); h.c.cachedSnapshot={}; h.install(); assert.equal(h.calls.length,0); h.external(); assert.equal(h.calls.length,0); assert.equal(h.frames.size,1); h.frame(); assert.equal(h.calls.length,0); h.frame(); assert.equal(h.calls[0][0],'probe'); await Promise.resolve(); await Promise.resolve(); assert.equal(h.signals[0].status,'cached'); h.external(); assert.equal(h.calls.length,1);
 h=harness(); h.install(); h.revoke(); h.c.historyOwnerKey='B'; h.c.historyOwnerKeyRef.current='B'; h.c.historyOwnerGenerationRef.current=2; h.c.generation=2; h.install(); h.revoke(); h.c.historyOwnerKey='A'; h.c.historyOwnerKeyRef.current='A'; h.c.historyOwnerGenerationRef.current=3; h.c.generation=3; h.show(); assert.equal(h.calls.length,0); h.install(); assert.deepEqual(h.calls,[['load',false]]);
 h=harness(); h.install(); h.revoke(); h.show(); assert.equal(h.calls.length,0);
 h=harness(); h.install(); await h.c.loadHistory(true); assert.deepEqual(h.calls,[['load',true]]); assert(h.c.pendingInitialHistoryRef.current); h.show(); assert.deepEqual(h.calls,[['load',true],['load',false]]);
 h=harness(); h.c.cachedSnapshot={}; h.c.historyRevisionRef.current=null; h.install(); h.show(); h.frame(); h.frame(); assert.deepEqual(h.calls,[['load',true]]);
 h=harness(); h.c.cachedSnapshot={}; h.c.ipcRenderer.invoke=async()=>{h.calls.push(['probe']);return {success:true,unchanged:false}}; h.install(); h.show(); h.frame(); h.frame(); await Promise.resolve(); assert.deepEqual(h.calls,[['probe'],['load',true]]);
 h=harness(); h.c.historyPresentationProofRef.current.presented=true; h.install(); assert.deepEqual(h.calls,[['load',false]]);
 h=harness(); h.c.cachedSnapshot={}; h.install(); h.show(); h.revoke(); h.c.historyOwnerGenerationRef.current=2; h.frame(); h.frame(); assert.equal(h.calls.length,0);
 h=harness(); h.c.cachedSnapshot={}; h.install(); h.show(); h.frame(); h.c.historyPresentationProofRef.current.presented=false; h.frame(); assert.equal(h.calls.length,0); assert(h.c.pendingInitialHistoryRef.current); assert.equal(h.c.pendingInitialHistoryRef.current.scheduled,false); h.show(); h.frame(); h.frame(); assert.equal(h.calls.length,1); h.show(); assert.equal(h.calls.length,1);
 h=harness(); h.install(); await Promise.resolve(); assert.equal(h.calls.length,0); assert.equal(h.signals.length,1); assert.equal(h.signals[0].status,'deferred'); h.show(); await Promise.resolve(); await Promise.resolve(); assert(h.signals.some(x=>x.status==='success'));
 // Actual parent completion/callback: deferral releases only the admission,
 // never marks data ready or advances a hidden Timeline to its loading phase.
 const parentSource=fs.readFileSync(require('node:path').resolve(__dirname,'../src/renderer/components/Workspace/SplitPaneSurface.tsx'),'utf8');
 const selected=(a,b)=>{const i=parentSource.indexOf(a),j=parentSource.indexOf(b,i+a.length);assert(i>=0&&j>i);return parentSource.slice(i,j);};
 const parentBody=selected('  const completeAdmission = useCallback(', '  const reconcileAdmissionTracker = useCallback(')
  +selected('  const handleHistoryInitialSourceSignal = useCallback(', '  const handleTimelineInitialSourceSignal = useCallback(');
 let completed=0,heavy=0,ordinary=0;const tracker={timeout:null,endMark(){},startedAt:0,requirements:new Set(['history:load']),lease:{complete(){completed++;}}};
 const pc={useCallback:fn=>fn,admissionTrackerRef:{current:tracker},window:{clearTimeout(){}},heavyActivationPhaseRef:{current:'history'},startTransition:fn=>fn(),setHeavyActivationPhase(){heavy++;},console:{warn(){}},tabId:'tab',paneIndex:0,performance:{now:()=>1},prewarmConfigRef:{current:{}},panePrewarmSignalMatches:(_c,_r,owner)=>owner==='A',reconcileAdmissionTracker(){return pc.admissionTrackerRef.current;},settleAdmissionRequirement(){ordinary++;}};
 vm.createContext(pc);vm.runInContext(compile(parentBody)+'\nthis.handle=handleHistoryInitialSourceSignal;',pc);
 pc.handle({phase:'load',status:'deferred',ownerKey:'OTHER'});assert.equal(completed,0);
 pc.handle({phase:'load',status:'deferred',ownerKey:'A'});assert.equal(completed,1);assert.equal(heavy,0);assert.equal(pc.heavyActivationPhaseRef.current,'history');assert.equal(pc.admissionTrackerRef.current,null);
 pc.handle({phase:'load',status:'deferred',ownerKey:'A'});assert.equal(completed,1);
 pc.handle({phase:'subscribe',status:'success',ownerKey:'A'});assert.equal(ordinary,1);
 console.log('PASS actual initial caller: hidden, show, repeats, owner ABA/unmount, cached two frames, explicit background, stale warm');
})().catch(e=>{console.error(e); process.exitCode=1});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {transformSync}=require('esbuild');
const panel=fs.readFileSync(process.env.NOTED_PANEL_PREIMAGE||path.resolve(__dirname,'../src/renderer/components/Workspace/HistoryPanel.tsx'),'utf8');
const a=panel.indexOf('  const settleHistoryWheelGeometryRelease = useCallback(');
const b=panel.indexOf('  historyPresentationApplyGuardRef.current',a);assert(a>0&&b>a);
const script=transformSync(panel.slice(a,b),{loader:'ts'}).code;
function fixture(source,masked){
 let options,active=false;const masks=[];
 const scroller={isConnected:true,hasAttribute:name=>name==='data-history-seek-geometry-settling'&&masked};
 const env={useCallback:f=>f,measureHistoryWheelGeometryRelease:()=>({trailingHeightDelta:0,measuredRows:0}),
  chooseHistoryGestureReleaseAnchorMode:()=> 'semantic-row',setHistorySeekGeometryMask(_s,value){masked=value;masks.push(value);},
  restoreHistoryWheelGeometryRows(){},setHistorySeekPresentationEpoch(){},readHistoryWheelAddress:()=>({status:'ready'}),
  historyOwnerKeyRef:{current:'owner'},historyOwnerGenerationRef:{current:1},historyPresentationProofRef:{current:{visit:1}},
  historyPresentationOwnsWrite:()=>true,settleHistoryVisualAnchor(o){options=o;return ()=>{};},
  historyTabIdRef:{current:'finite'},historyWheelGeometryReleaseSettleCancelRef:{current:null},
  historyScrollSeekController:{isActive:()=>active},historyRestoreInFlightRef:{current:0},historyScrollInFlightRef:{current:null},
  hydrationRequestInFlightRef:{current:false},historyPointerScrollActiveRef:{current:false},terminalPreviewAnchorSettleCancelRef:{current:null},
  historyUserGestureGenerationRef:{current:1},readHistoryWheelGeometryAnchorTop(){},historyDiag(){}};
 const settle=new Function('env',`const {${Object.keys(env).join(',')}}=env;${script};return settleHistoryWheelGeometryRelease;`)(env);
 settle({scroller,identity:'row',targetTop:0,ownerKey:'owner',ownerGeneration:1,presentationVisit:1,gestureGeneration:1,source,bottomGap:100});
 return{finish:reason=>options.onFinish({reason,frames:1,writes:0,corrections:0,pausedFrames:0,maxDriftPx:0}),
  active:()=>{active=true;},masked:()=>masked,masks};
}
test('hydration successor releases the existing seek mask when its own anchor settlement ends',()=>{
 const f=fixture('hydration-apply',true);assert(f.masked());f.finish('settled');assert.equal(f.masked(),false);
});
test('a new active seek keeps transferred mask; ordinary unmasked hydration never acquires it',()=>{
 const f=fixture('hydration-apply',true);f.active();f.finish('cancelled');assert.equal(f.masked(),true);
 const g=fixture('hydration-apply',false);g.finish('settled');assert.deepEqual(g.masks,[]);
 const h=fixture('seek-exit',false);assert(h.masked());h.finish('settled');assert.equal(h.masked(),false);
});

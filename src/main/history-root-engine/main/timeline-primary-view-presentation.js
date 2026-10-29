'use strict';
const {createHash}=require('node:crypto');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createPrimaryTimelinePresentation}=require('./timeline-primary-presentation');
const {captureTimelineRootAnnotations}=require('./timeline-root-annotations');
const {captureTimelineRootForkPresentation}=require('./timeline-root-fork-presentation');
const {createTimelineLogicalRoot}=require('./timeline-root-logical');
const {createTimelineRootView}=require('./timeline-root-view');
const {createTimelineRootLayout}=require('./timeline-root-layout');
const {readTimelineAnnotationFreshness}=require('./timeline-annotation-freshness');
const {readTimelineForkPresentationFreshness}=require('./timeline-fork-presentation-freshness');
const {captureTimelineRootWorkingFiles,readTimelineWorkingFileFreshness,sameTimelineWorkingFileWitness}=require('./timeline-root-working-files');
const {captureTimelinePresentationInput}=require('./timeline-presentation-input');
const {getCodexProcessActionOwnershipRevision}=require('./codex-process-action-ownership');
const {forkFrozenCanonical}=require('./history-frozen-canonical');
const {performance}=require('node:perf_hooks');
let preparationStageId=0;
// Existing worker console adds the request/call identity. Fixed phase names,
// no row/source contents; elapsed intervals include awaits, not exclusive CPU.
async function preparationStage(stage,operation){
 const id=++preparationStageId,start=performance.now();let failure;
 const report=fields=>{try{console.log('[TimelineRootPreparation] '+JSON.stringify({id,stage,
  startAbs:performance.timeOrigin+start,timing:'inclusive-elapsed-wall',...fields}));}catch{}};
 report({event:'begin'});
 try{return await operation();}catch(error){failure=error;throw error;}
 finally{const end=performance.now();report({event:'end',endAbs:performance.timeOrigin+end,
  elapsedMs:end-start,outcome:failure?'error':'success',...(failure?{errorCode:/^[A-Z0-9_]{1,80}$/.test(failure.code)?failure.code:'OTHER'}:{})});}
}
const fail=code=>Object.assign(new Error(code),{code});
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const once=fn=>{let done=false;return()=>{if(!done){done=true;return fn();}};};
function styleOptions(payload){
 const o=payload.timelineViewOptions||{};
 if(!o||typeof o!=='object'||Array.isArray(o))throw fail('TIMELINE_VIEW_OPTIONS');
 const out={expandedLayout:o.expandedLayout===true,treeMode:o.treeMode===true};
 for(const name of ['width','viewportExtent','fontSize','summaryFontSize','lineClamp']){
  const n=o[name]??0;if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw fail('TIMELINE_VIEW_OPTIONS');out[name]=n;
 }
 if(o.layoutFingerprint!==undefined&&(typeof o.layoutFingerprint!=='string'||!o.layoutFingerprint||o.layoutFingerprint.length>512))throw fail('TIMELINE_VIEW_OPTIONS');
 out.layoutFingerprint=o.layoutFingerprint||hash(out);return Object.freeze(out);
}
function equalWitness(before,current){
 if(!before||!current||before.mode!==current.mode)return false;
 for(const key of Object.keys(current)){
  if(key==='dataVersion'&&before.mode==='scoped')continue;
  const a=before[key],b=current[key];
  if(Array.isArray(b)){if(!Array.isArray(a)||a.length!==b.length||a.some((v,i)=>v!==b[i]))return false;}
  else if(a!==b)return false;
 }return true;
}
function makeOptions(store,raw,style,forks){
 const arena=new HistoryProjectionArena(store,forks?.optionsRoot||null);let root;
 try{root=arena.step(()=>{const state=arena.state();state.toolType='codex';state.sourceGeneration=raw.sourceSnapshot.sourceGeneration;
  state.expandedLayout=style.expandedLayout;state.treeMode=style.treeMode;
  if(!forks)state.forkMarkers=arena.make('array');state.sessionBoundaries=arena.make('array');return arena.publish();});return root;}
 finally{arena.close();}
}
function info(p){
 return {timelineViewSchema:1,canonicalEntryCount:p.canonicalEntryCount,
  logicalEntryCount:p.view.logical.entries.length,visualAtomCount:p.view.length,
  timelinePresentationIdentity:p.presentationIdentity,timelinePresentationRevision:p.presentationRevision,
  semanticRevisionToken:p.semanticRevisionToken,logicalRevisionToken:p.view.logical.revision,viewRevisionToken:p.view.revision,layoutInfo:p.layout.info()};
}
function resultFor(raw,p,metrics){
 return {...raw,root:p.view.lease,entries:p.view.atoms,readProfile:'timeline-view-v1',
  timelinePresentation:p,semanticSnapshotComplete:true,semanticRevisionToken:p.semanticRevisionToken,viewRevisionToken:p.view.revision,
  timelineViewHeader:info(p),readMetrics:{...raw.readMetrics,...metrics},release:once(()=>p.release())};
}
function retainedSourceWitness(raw,service,control){
 control?.assertCurrent();raw.root.cursor();const current=service.codexData?._api?.isCodexSourceSnapshotCurrent;
 if(typeof current!=='function'||current(raw.sourceSnapshot)!==true)throw fail('CODEX_SOURCE_READ_INVALIDATED');
 return hash(raw.sourceSnapshot);
}
function presentationFreshness(control){
 if(this.closed)throw fail('TIMELINE_VIEW_RELEASED');control?.assertCurrent();
 if(this.service.promptPresentationStore!==this.manager||this.manager.db!==this.connection)
  return{ok:false,requiredClass:'metadata',reason:'metadata-owner-changed'};
 try{retainedSourceWitness(this.raw,this.service,control);}catch(e){if(e.code==='CODEX_SOURCE_READ_INVALIDATED')return{ok:false,requiredClass:'source',reason:'source-changed'};throw e;}
 if(!this.runtimeCapture?.sessions||getCodexProcessActionOwnershipRevision(this.runtimeCapture.sessions)!==this.runtimeCapture.revision)
  return{ok:false,requiredClass:'metadata',reason:'runtime-changed'};
 if(!this.reusableAssets)return{ok:false,requiredClass:'metadata',reason:'asset-recovery-unwitnessed'};
 if(this.manager.getHistoryPromptPresentationRevision('codex',this.payload.sessionId)!==this.promptRevision)
  return{ok:false,requiredClass:'metadata',reason:'prompt-changed'};
 if(!equalWitness(this.annotations.captureWitness,readTimelineAnnotationFreshness(this.connection,'codex',this.payload.sessionId))
   ||!equalWitness(this.forks.captureWitness,readTimelineForkPresentationFreshness(this.connection)))
  return{ok:false,requiredClass:'metadata',reason:'annotation-changed'};
 if(!sameTimelineWorkingFileWitness(this.workingFilesWitness,readTimelineWorkingFileFreshness(this.connection,this.payload.tabId)))
  return{ok:false,requiredClass:'metadata',reason:'working-file-links-changed'};
 control?.assertCurrent();return{ok:true};
}
async function createPrimaryTimelineViewPresentation(store,canonical,{service,payload,control}={}){
 if(payload?.readProfile!=='timeline-view-v1')throw fail('TIMELINE_VIEW_PROFILE_REQUIRED');
 let base,annotations,working,presentation,logical,forks,options,view,layout,transferred=false;
 const manager=service.promptPresentationStore,connection=manager?.db,style=styleOptions(payload);
 const sourceWitness=()=>retainedSourceWitness(canonical,service,control);
 try{
  base=await preparationStage('base',()=>createPrimaryTimelinePresentation(store,canonical,{service,payload:{...payload,readProfile:'timeline-primary-v1'},control}));
  annotations=await preparationStage('annotations',()=>captureTimelineRootAnnotations({store,manager,sessionId:payload.sessionId,readSourceWitness:sourceWitness,control,
   cooperate:control?.checkpoint?()=>control.checkpoint():undefined}));
  working=await preparationStage('working-files',()=>captureTimelineRootWorkingFiles({store,manager,tabId:payload.tabId,readSourceWitness:sourceWitness,control}));
  // Existing authoring handoffs/current live points are imported once on
  // semantic preparation. Canonical Timeline rows are never a native input.
  presentation=await preparationStage('current-input',()=>captureTimelinePresentationInput(store,payload.timelinePresentation,{control}));
  logical=await preparationStage('logical',()=>createTimelineLogicalRoot(store,base,{annotations,workingFiles:working.files,presentationRoot:presentation.root,cwd:payload.cwd||'',control}));
  forks=await preparationStage('forks',()=>captureTimelineRootForkPresentation({store,manager,sessionId:payload.sessionId,logicalRoot:logical,readSourceWitness:sourceWitness,control,
   cooperate:control?.checkpoint?()=>control.checkpoint():undefined}));
  options=makeOptions(store,canonical,style,forks);
  view=await preparationStage('view',()=>createTimelineRootView({store,logicalRoot:logical,optionsRoot:options,preferencesRoot:payload._timelinePreferencesRoot||null,
   intents:payload.viewIntents||[],editNote:payload.editNote||null,activeRangeAction:payload.activeRangeAction===true,control}));
  layout=await preparationStage('layout',()=>createTimelineRootLayout({store,atomsCursor:view.atoms,layoutFingerprint:style.layoutFingerprint,
   mode:style.expandedLayout?'expanded':'compact',viewportExtent:style.viewportExtent,control}));
  control?.assertCurrent();sourceWitness();
  const p={store,service,payload:Object.freeze({toolType:'codex',sessionId:payload.sessionId,cwd:payload.cwd||'',tabId:payload.tabId||''}),
   base,raw:canonical,annotations,forks,options,view,layout,style,manager,connection,canonicalEntryCount:canonical.entries.length,
   semanticRevisionToken:hash([base.semanticRevisionToken,logical.revision]),workingFilesWitness:working.captureWitness,
   presentationIdentity:presentation.identity,presentationRevision:presentation.revision,closed:false,
   promptRevision:base.timelinePromptRevision,runtimeCapture:base.timelineRuntimeCapture,
   reusableAssets:base.timelinePreparation.imageRecoveryCalls===0,freshness:presentationFreshness,
   release(){if(this.closed)return;this.closed=true;let error;
    for(const close of [()=>this.layout.release(),()=>this.view.release(),()=>logical.release(),()=>forks.release(),()=>options.release(),()=>annotations.release(),()=>base.release()])
     try{close();}catch(e){error||=e;}if(error)throw error;}
  };
  working.assertCurrent();
  if(!equalWitness(annotations.captureWitness,readTimelineAnnotationFreshness(connection,'codex',payload.sessionId))
   ||!equalWitness(forks.captureWitness,readTimelineForkPresentationFreshness(connection)))throw fail('TIMELINE_VIEW_METADATA_CAPTURE_CHANGED');
  transferred=true;return resultFor(canonical,p,{timelineSemanticPreparations:1,timelinePromptPasses:base.timelinePreparation.promptPasses,
   timelineAnnotationCaptures:1,timelineForkCaptures:1,timelineViewBuilds:1,timelineLayoutBuilds:1});
 }finally{presentation?.release();working?.release();if(!transferred){let error;for(const x of [layout,view,logical,forks,options,annotations,base])try{x?.release?.();}catch(e){error||=e;}
  if(error)console.warn('[TimelineRoot] provisional-cleanup-failed code='+String(error.code||error.message));}}
}
async function forkPrimaryTimelineViewPresentation(store,parent,raw,{payload,control}={}){
 if(Object.hasOwn(payload,'timelinePresentation')||payload.timelinePresentationIdentity!==parent.presentationIdentity)
  return{kind:'miss',ok:false,requiredClass:'metadata',reason:'presentation-input-changed'};
 const freshness=parent.freshness(control);
 if(!freshness.ok)return{kind:'miss',...freshness};
 const style=styleOptions(payload);
 let view,layout,options,annotations,forks,retained,transferred=false;
 try{
  // Capture independent ownership before the first asynchronous view build.
  annotations=parent.annotations.fork();forks=parent.forks.fork();
  retained={...parent,raw,annotations,forks,closed:false};
  const held=parent.view.fork();
  try{options=makeOptions(store,raw,style,forks);
   view=await preparationStage('view-fork',()=>held.withOptions({optionsRoot:options,intents:payload.viewIntents||[],editNote:payload.editNote||null,
    activeRangeAction:payload.activeRangeAction===true,control}));
  }finally{held.release();}
  layout=await preparationStage('layout-fork',()=>createTimelineRootLayout({store,atomsCursor:view.atoms,layoutFingerprint:style.layoutFingerprint,
   mode:style.expandedLayout?'expanded':'compact',viewportExtent:style.viewportExtent,control}));
  control?.assertCurrent();const after=presentationFreshness.call(retained,control);
  if(!after.ok)return{kind:'miss',...after};
  const rawRelease=once(()=>raw.release()),p={...parent,raw,annotations,forks,view,layout,style,options,closed:false,
   release(){if(this.closed)return;this.closed=true;let error;for(const close of [()=>this.layout.release(),()=>this.view.release(),()=>options.release(),()=>annotations.release(),()=>forks.release(),rawRelease])
    try{close();}catch(e){error||=e;}if(error)throw error;}};
  const result=resultFor(raw,p,Object.fromEntries(Object.entries(raw.readMetrics||{}).map(([k,v])=>[k,typeof v==='boolean'?false:0])));
  result.readMetrics={...result.readMetrics,timelineSemanticPreparations:0,timelinePromptPasses:0,timelineAnnotationCaptures:0,
   timelineForkCaptures:0,timelineViewBuilds:1,timelineLayoutBuilds:1};transferred=true;return{kind:'hit',result};
 }finally{if(!transferred){layout?.release();view?.release();options?.release();annotations?.release();forks?.release();}}
}
function retainPrimaryTimelineViewPresentation(store,parent,{control}={}){
 if(parent.closed)throw fail('TIMELINE_VIEW_RELEASED');control?.assertCurrent();
 let raw,annotations,forks,options,view,layout,transferred=false;
 try{
  raw=forkFrozenCanonical(store,parent.raw);annotations=parent.annotations.fork();forks=parent.forks.fork();
  options=parent.options.fork();view=parent.view.fork();layout=parent.layout.fork();control?.assertCurrent();
  const p={...parent,raw,annotations,forks,options,view,layout,closed:false,
   release(){if(this.closed)return;this.closed=true;let error;
    for(const close of [()=>this.layout.release(),()=>this.view.release(),()=>options.release(),()=>forks.release(),()=>annotations.release(),()=>raw.release()])
     try{close();}catch(e){error||=e;}if(error)throw error;}};
  const result=resultFor(raw,p,Object.fromEntries(Object.entries(raw.readMetrics||{}).map(([k,v])=>[k,typeof v==='boolean'?false:0])));
  transferred=true;return result;
 }finally{if(!transferred){layout?.release();view?.release();options?.release();forks?.release();annotations?.release();raw?.release();}}
}
module.exports={createPrimaryTimelineViewPresentation,forkPrimaryTimelineViewPresentation,retainPrimaryTimelineViewPresentation,styleOptions};

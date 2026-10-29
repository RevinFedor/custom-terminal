'use strict';

const {createHash,randomUUID}=require('node:crypto');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createHistoryRootDisplayView}=require('./history-root-display-view');
const {forkFrozenCanonical}=require('./history-frozen-canonical');
const {capturePrimaryDependencies,comparePrimaryDependencies,checkPrimaryTime}=require('./history-primary-dependencies');
const {validateCanonicalMetadata,validatePreparedMetadata}=require('./history-primary-metadata-validation');
const privateViews=new WeakMap();
const fail=code=>Object.assign(new Error(code),{code});
const once=fn=>{let done=false;return()=>{if(!done){done=true;return fn();}};};
const METADATA_SCHEMA=1;

function primaryViewOptions(payload={},strict=false){
 const value=strict?payload.primaryViewOptions:payload;
 if(strict&&(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).some(key=>!['grouping','captionSelections'].includes(key))))throw fail('HISTORY_PRIMARY_VIEW_OPTIONS');
 const grouping=value?.grouping||{};
 if(strict&&(typeof grouping!=='object'||Array.isArray(grouping)
  ||Object.keys(grouping).some(key=>!['enabled','threshold','expandedKeys','responseWork'].includes(key))
  ||grouping.enabled!==undefined&&typeof grouping.enabled!=='boolean'
  ||grouping.responseWork!==undefined&&typeof grouping.responseWork!=='boolean'
  ||grouping.threshold!==undefined&&(!Number.isFinite(grouping.threshold)||grouping.threshold<2)))throw fail('HISTORY_PRIMARY_VIEW_OPTIONS');
 const keys=grouping.expandedKeys||[],captions=value?.captionSelections||[];
 if(strict&&(!(Array.isArray(keys)||keys instanceof Set)||[...keys].some(key=>typeof key!=='string')
  ||!Array.isArray(captions)||captions.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(x=>typeof x!=='string'))))throw fail('HISTORY_PRIMARY_VIEW_OPTIONS');
 return {grouping:{enabled:grouping.enabled!==false,responseWork:grouping.responseWork===true,
  threshold:Math.max(2,Number(grouping.threshold)||2),expandedKeys:new Set(keys)},
  captionSelections:captions};
}
async function primaryViewRevision(store,root,semanticIdentity,options,hashFrozenOverlay,control){
 const arena=new HistoryProjectionArena(store,root);let input;
 try{
  input=arena.step(()=>arena.publish(arena.own(options)));
  const hash=createHash('sha256').update('history-primary-view-v1:'+semanticIdentity+';');
  await hashFrozenOverlay(store,input.cursor(),hash,control);control?.assertCurrent();return hash.digest('hex');
 }finally{try{input?.release();}finally{arena.close();}}
}
function createPrimarySemanticBundle({store,canonical,preparedRoot,metadataRoot,durableMetadataRoot,canonicalMetadataValidation,preparedMetadataValidation,settingsKeyRoot,indexes,
 overlayRoot,arena,timings,prompts,service,payload,sessions,startDependencies,endDependencies,timeWindow,
 semanticToken,runtimeRevision,metrics,projectUnit,hashFrozenOverlay,hiddenCount,hiddenTurnCount,unwitnessedRecovery=false,identity=randomUUID()}){
 // This is NOT the wrapper whose release belongs to the plane's parent.
 const canonicalHeld=forkFrozenCanonical(store,canonical);
 let transferred=false;
 try{
 let refs=1,closed=false;
 const metadataIdentity=randomUUID();
 const dependencySessions=sessions&&sessions.length<=16?Object.freeze(sessions.slice()):null;
 const initial=comparePrimaryDependencies(startDependencies,endDependencies);
 const reusable=initial.ok&&!unwitnessedRecovery;
 const miss=initial.ok?{reason:'unwitnessed-image-recovery',requiredClass:'semantic'}:initial;
 const resources=[()=>indexes.close(),()=>preparedRoot.release(),()=>metadataRoot.release(),()=>durableMetadataRoot.release(),
  ()=>settingsKeyRoot.release(),()=>overlayRoot.release(),()=>arena.close(),()=>timings?.release(),()=>prompts.release(),()=>canonicalHeld.release()];
 function assertOpen(){if(closed)throw fail('HISTORY_PRIMARY_RELEASED');preparedRoot.cursor();}
 function release(){if(closed)return;if(--refs!==0)return;closed=true;let error;
  for(const dispose of resources){try{dispose();}catch(e){error||=e;}}if(error)throw error;}
 function retain(){assertOpen();refs++;return once(release);}
 const scope=Object.freeze({toolType:'codex',sessionId:payload.sessionId,cwd:payload.cwd||'',tabId:payload.tabId||''});
 function check(serviceNow,payloadNow){
  assertOpen();
  if(serviceNow!==service||scope.sessionId!==payloadNow.sessionId||scope.cwd!==(payloadNow.cwd||'')||scope.tabId!==(payloadNow.tabId||''))throw fail('HISTORY_ROOT_OWNER_MISMATCH');
  if(!reusable)return {ok:false,reason:miss.reason||'semantic-preparation-changed',requiredClass:miss.requiredClass||'semantic'};
  const time=checkPrimaryTime(timeWindow);if(!time.ok)return time;
  return comparePrimaryDependencies(endDependencies,capturePrimaryDependencies(service,canonicalHeld,dependencySessions,{tabId:scope.tabId}));
 }
 const bundle=Object.freeze({store,identity,metadataIdentity,metadataSchema:METADATA_SCHEMA,semanticToken,canonical:canonicalHeld,
  preparedRoot,metadataRoot,durableMetadataRoot,canonicalMetadataValidation,preparedMetadataValidation,settingsKeyRoot,indexes,toolClaimsCursor:overlayRoot.cursor().field('liveToolResults'),sourceSnapshot:Object.freeze({...canonical.sourceSnapshot}),
  canonicalEntryCount:canonical.entries.length,runtimeRevision,promptRevision:prompts.revision,timingRevision:timings?.revision||'none',
  hiddenCount,hiddenTurnCount,metrics:Object.freeze({...metrics,promptPasses:prompts.passes,timingPasses:timings?.reconciliationPasses||0}),
  projectUnit,hashFrozenOverlay,assertOpen,retain,check,refs:()=>refs,releaseConstruction:once(release)});
 transferred=true;return bundle;
 }finally{if(!transferred)canonicalHeld.release();}
}
function retainedViewOwner(view) {
 let refs=0,closed=false;
 return Object.freeze({view,
  retain(){if(closed)throw fail('HISTORY_PRIMARY_RELEASED');refs++;return once(()=>{
   if(--refs!==0)return;closed=true;view.close();
  });},
 });
}
function wrapPrimaryView(bundle,view,viewRevision,route,heldViewOwner=null){
 const releaseBundle=bundle.retain(),viewOwner=heldViewOwner||retainedViewOwner(view);
 let releaseView,closed=false,transferred=false,failed=false,primaryError;
 try{
  releaseView=viewOwner.retain();
  const assert=()=>{if(closed)throw fail('HISTORY_PRIMARY_RELEASED');bundle.assertOpen();};
  const work=route==='view'||heldViewOwner?{semanticPreparations:0,promptPasses:0,timingPasses:0,indexBuilds:0,metadataRows:0,semanticOverlayHashes:0}
   :{semanticPreparations:1,promptPasses:bundle.metrics.promptPasses,timingPasses:bundle.metrics.timingPasses,
    indexBuilds:1+bundle.metrics.timingPasses,metadataRows:bundle.canonicalEntryCount+bundle.metadataRoot.cursor().length,semanticOverlayHashes:1};
  const result={root:view.root,view,headerCursor:view.root.cursor().field('headers'),
   sessionMetaCursor:bundle.canonical.sessionMeta,
   sourceMetadataCursor:bundle.metadataRoot.cursor(),durableMetadataCursor:bundle.durableMetadataRoot.cursor(),settingsPresentationKeysCursor:bundle.settingsKeyRoot.cursor(),
   displayUnitCount:view.length,logicalCount:view.length,logicalcount:view.length,canonicalCount:bundle.canonicalEntryCount,canonicalEntryCount:bundle.canonicalEntryCount,
   semanticIdentity:bundle.identity,metadataIdentity:bundle.metadataIdentity,metadataSchema:bundle.metadataSchema,
   canonicalMetadataValidation:bundle.canonicalMetadataValidation,preparedMetadataValidation:bundle.preparedMetadataValidation,
   semanticRevision:bundle.semanticToken,semanticRevisionToken:bundle.semanticToken,viewRevisionToken:viewRevision,primaryRequestClass:route,
   semanticSnapshotComplete:true,sourceSnapshot:bundle.sourceSnapshot,runtimeRevision:bundle.runtimeRevision,
   promptPresentationRevision:bundle.promptRevision,responseTimingRevision:bundle.timingRevision,
   settingsIndexes:bundle.indexes,hiddenCount:bundle.hiddenCount,hiddenTurnCount:bundle.hiddenTurnCount,
   async validateCanonicalMetadata({control}={}){
    assert();control?.assertCurrent();
    const expected=bundle.canonicalMetadataValidation;
    if(!expected)throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_REQUIRED');
    if(expected.kind==='refused')throw fail(expected.error);
    if(expected.kind!=='validated')throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_REQUIRED');
    const value=await validateCanonicalMetadata(bundle.store,bundle.durableMetadataRoot,{control});
    assert();control?.assertCurrent();
    if(value.digest!==expected.digest||value.canonicalEntryCount!==expected.canonicalEntryCount)
      throw fail('HISTORY_PRIMARY_METADATA_VALIDATION_CHANGED');
    return value;
   },
   async validatePreparedMetadata({control}={}){
    assert();control?.assertCurrent();
    const expected=bundle.preparedMetadataValidation;
    if(!expected)throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_REQUIRED');
    if(expected.kind==='refused')throw fail(expected.error);
    if(expected.kind!=='validated')throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_REQUIRED');
    const value=await validatePreparedMetadata(bundle.store,bundle.metadataRoot,{control});
    assert();control?.assertCurrent();
    if(value.digest!==expected.digest||value.preparedEntryCount!==expected.preparedEntryCount)
      throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_CHANGED');
    return value;
   },
   toolCoverageInputs(){assert();return {entries:bundle.indexes.entries,claims:bundle.toolClaimsCursor,hashCursor:bundle.hashFrozenOverlay};},
   headerAt(rank){assert();return view.headerAt(rank);},unitAt(rank){assert();return view.unitAt(rank);},
   resolveUUID(uuid){assert();return view.resolve(uuid);},rowByUuid(uuid){assert();return view.rowByUuid(uuid);},
   presentationSource(){assert();return view.sourceCursor();},
   presentationSourceOrdinal(uuid){assert();return view.sourceOrdinal(uuid);},
   presentationSourceAddress(ordinal){assert();return view.addressForSourceRank(ordinal);},
   presentationGroupAddress(key){assert();return view.addressForGroup(key);},
   presentationKeyAddress(key){assert();return view.addressForKey(key);},
   caption(...args){assert();return view.caption(...args);},
   async unitForRenderer(rank,options={}){assert();return bundle.projectUnit(bundle.store,view,rank,options);},
   stats(){assert();return {...bundle.metrics,route,work:Object.freeze({...work}),semanticBundleRefs:bundle.refs(),
    display:view.stats?.(),bounds:{nativeMetadata:'OPEN',selectedPromptNative:'OPEN',oneUnitRichNative:'OPEN',wholePrimary:false}};},
   close:once(()=>{closed=true;let error;try{releaseView();}catch(e){error=e;}try{releaseBundle();}catch(e){error||=e;}if(error)throw error;}),
  };
  assert();privateViews.set(result,{bundle,viewOwner,viewRevision,route,isLive:()=>!closed});transferred=true;return Object.freeze(result);
 }catch(error){failed=true;primaryError=error;throw error;}
 finally{if(!transferred){
  let cleanupError;
  try{releaseView?.();}catch(error){cleanupError=error;}
  try{releaseBundle();}catch(error){cleanupError||=error;}
  if(cleanupError){
   if(!failed)throw cleanupError;
   // A failed construction remains the primary outcome. Even a frozen or
   // non-object thrown value cannot let secondary cleanup replace it.
   try{if(primaryError&&typeof primaryError==='object')primaryError.primaryViewCleanupError=
     cleanupError.code||'HISTORY_PRIMARY_VIEW_CLEANUP';}catch{}
  }
 }}
}
// A retained presentation owns a reference to the ORIGINAL immutable view and
// bundle. It is not a header registry lookup or a new source/view projection.
// Each wrapper has independent liveness; dropping the original Root cannot
// revoke an issued child. Existing root capacity bounds these fixed owners.
function retainPrimaryHistoryPresentation(store,parent){
 const record=privateViews.get(parent);
 if(!record||record.bundle.store!==store||!record.isLive())throw fail('HISTORY_PRIMARY_RELEASED');
 return wrapPrimaryView(record.bundle,record.viewOwner.view,record.viewRevision,record.route,record.viewOwner);
}
async function forkPrimaryHistoryView(store,parent,{service,payload,control}={}){
 const record=privateViews.get(parent);
 if(!record||record.bundle.store!==store||!record.isLive())throw fail('HISTORY_PRIMARY_RELEASED');
 const bundle=record.bundle;
 if(payload.expectedSemanticIdentity!==bundle.identity)throw fail('HISTORY_ROOT_OWNER_MISMATCH');
 const options=primaryViewOptions(payload,true),release=bundle.retain();let view,primary,transferred=false;
 try{
  control?.assertCurrent();let check=bundle.check(service,payload);
  if(!check.ok)return {kind:'miss',...check};
  view=await createHistoryRootDisplayView(store,bundle.preparedRoot,{...options.grouping,complete:true,frozen:true,control});
  const revision=await primaryViewRevision(store,bundle.preparedRoot,bundle.identity,options,bundle.hashFrozenOverlay,control);
  check=bundle.check(service,payload);if(!check.ok)return {kind:'miss',...check};
  control?.assertCurrent();primary=wrapPrimaryView(bundle,view,revision,'view');view=null;transferred=true;
  return {kind:'hit',primary,canonical:bundle.canonical};
 }finally{try{if(!transferred){primary?.close();view?.close();}}finally{release();}}
}
module.exports={createPrimarySemanticBundle,wrapPrimaryView,forkPrimaryHistoryView,retainPrimaryHistoryPresentation,primaryViewOptions,primaryViewRevision,METADATA_SCHEMA};

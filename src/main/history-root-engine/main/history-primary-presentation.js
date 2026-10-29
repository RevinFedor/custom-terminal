'use strict';

// EARLY primary History presentation. Native compatibility owners below are
// deliberate and reported: N handles/metadata, frozen sidecar rows, and ONE
// selected prompt's native semantic adapter. No whole History DTO capture.
const fs = require('node:fs');
const { types: { isProxy } } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { isHistoryPagedCursor, historyPagedCursorAddress, materializeHistoryCursorSync: materialize } = require('./history-paged-store');
const { createHistoryRootDisplayView } = require('./history-root-display-view');
const { reconcileRootResponseTimings } = require('./history-root-response-timings');
const { buildHistoryRootIndexes, trimmedFacts } = require('./history-root-indexes');
const { getCodexProcessActionOwnershipRevision } = require('./codex-process-action-ownership');
const text = require('./history-paged-text');
const { decorateHistoryPromptPresentations } = require('./history-primary-compat/src/main/history-prompt-presentations.js.cjs');
const { makeHistoryRowStub } = require('./history-primary-compat/src/main/history-entry-window.js.cjs');
const live = require('./history-primary-compat/src/renderer/utils/historyLiveProjection.mjs.cjs');
const local = require('./history-primary-compat/src/renderer/utils/primaryLocalCompat.ts.cjs');
const fail = code => Object.assign(new Error(code), { code });
const { isFrozenCanonical } = require('./history-frozen-canonical');
const { primaryTimeWindow,MAX_SESSIONS } = require('./history-primary-dependencies');
const { capturePrimaryChangeDependencies:capturePrimaryDependencies, primaryDependencyScope,
  primaryDependencyChange, completePrimaryDependencyCleanup } = require('./history-primary-dependency-change');
const {createPrimarySemanticBundle,wrapPrimaryView,primaryViewOptions,primaryViewRevision}=require('./history-primary-semantic-bundle');
const { establishCanonicalMetadataValidation, establishPreparedMetadataValidation } = require('./history-primary-metadata-validation');
const scalar = cursor => cursor.kind === 'text' ? [...cursor.textChunks()].join('') : cursor.scalar();
const once = fn => { let done = false; return () => { if (!done) { done = true; return fn(); } }; };
const clone = value => structuredClone(value);
const grammarFields = new Set(['file_path','path','offset','limit','summary','query','url','command','glob']);

// Root-owned cursor facade for the unmodified native live/local helpers. Its
// target contains NO decoded fields. Native array results hold these handles,
// never full body graphs. String reads are ephemeral, never cached here.
function nativeAdapter(arena, metrics, assert) {
  const handles = new WeakMap(), cache = new Map();
  let adoptionOnly = false;
  function read(value) {
    assert();
    if (text.isPagedText(value)) {
      const result = text.materialize(value,'primary-native-semantic-scalar');
      metrics.scalarReads++;
      metrics.maxNativeScalarChars = Math.max(metrics.maxNativeScalarChars,result.length);
      return result;
    }
    if (!value || typeof value !== 'object') return value;
    const id=arena.owner(value);
    if(id===null)throw fail('HISTORY_PRIMARY_ARENA_VALUE_REQUIRED');
    if(cache.has(id))return cache.get(id);
    const array=Array.isArray(value), target=array?[]:value instanceof Map?new Map():value instanceof Set?new Set():{};
    const proxy=new Proxy(target,{
      get(_target,key,receiver){
        assert();
        if(array && key==='length')return value.length;
        if(typeof key==='symbol')return Reflect.get(target,key,receiver);
        if(adoptionOnly && key==='content' && read(value.role)==='assistant')return undefined;
        if(Object.hasOwn(value,key))return read(value[key]);
        return Reflect.get(target,key,receiver);
      },
      has(_target,key){return Object.hasOwn(value,key)||Reflect.has(target,key);},
      ownKeys(){return Reflect.ownKeys(value);},
      getOwnPropertyDescriptor(_target,key){
        if(array && key==='length')return {value:value.length,writable:true,enumerable:false,configurable:false};
        if(!Object.hasOwn(value,key))return undefined;
        return {get:()=>read(value[key]),enumerable:true,configurable:true};
      },
      set(){throw fail('HISTORY_PRIMARY_NATIVE_FACADE_IMMUTABLE');},
    });
    handles.set(proxy,value);cache.set(id,proxy);return proxy;
  }
  function importValue(value,seen=new Map()) {
    const handle=value && typeof value==='object' && handles.get(value);
    if(handle)return handle;
    if(!value || typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    const out=arena.make(Array.isArray(value)?'array':value instanceof Map?'map':value instanceof Set?'set':'object');
    seen.set(value,out);
    if(value instanceof Map)for(const [k,v]of value)out.set(importValue(k,seen),importValue(v,seen));
    else if(value instanceof Set)for(const v of value)out.add(importValue(v,seen));
    else {
      if(Array.isArray(value))out.length=value.length;
      for(const key of Object.keys(value))out[key]=importValue(value[key],seen);
    }
    return out;
  }
  // Only the controlled top record from makeHistoryRowStub takes this path.
  // Inspect descriptors without invoking accessors/proxy traps; arbitrary
  // graphs (including every child) retain the exact importer above.
  function importStubRecord(value) {
    if(!value || typeof value!=='object' || isProxy(value))return importValue(value);
    const proto=Object.getPrototypeOf(value);
    if(proto!==Object.prototype && proto!==null)return importValue(value);
    if(Reflect.ownKeys(value).some(key=>!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))
      return importValue(value);
    // Match the old allocation/seen order and ordinary-object normalization,
    // even for null-prototype inputs. Back references resolve the placeholder.
    const seen=new Map(),out=arena.make('object');
    seen.set(value,out);
    const keys=Object.keys(value);
    return arena._completeDataRecord(out,(function*(){
      for(const key of keys)yield [key,importValue(value[key],seen)];
    })());
  }
  return {read,importValue,importStubRecord,adoption(fn){adoptionOnly=true;try{return fn();}finally{adoptionOnly=false;}},
    clear(){cache.clear();},size:()=>cache.size};
}

// Capture every prompt-sidecar/fork read BEFORE a cooperative await. The
// original helper may bind/recover through the original manager, then the
// owner reruns a successful changed pass (max 3). UNKNOWN throws, never retry.
function freezePromptSidecars(manager, payload, uuids, service, canonical, physicalSessions) {
  if (!manager?.getHistoryPromptPresentations) return { db:manager, revision:'none', dependencySessions:physicalSessions,
    dependencies:capturePrimaryDependencies(service,canonical,physicalSessions,{tabId:payload.tabId}) };
  const connection=manager.db;
  const ownReadSnapshot = !!connection?.transaction && !connection.inTransaction;
  const capture = () => {
    const rows = new Map(), contexts = new Map(), exact = [];
    let owner=payload.sessionId;
    for (let depth=0;owner && depth<17 && !rows.has(owner);depth++) {
      rows.set(owner,clone(manager.getHistoryPromptPresentations('codex',owner)));
      const context=clone(manager.getSessionHistoryContext?.(owner) || null);
      contexts.set(owner,context); owner=context?.fork?.sourceSessionId;
    }
    if (manager.getHistoryPromptPresentationsForEntries) for(let start=0;start<uuids.length;start+=800) {
      for(const row of clone(manager.getHistoryPromptPresentationsForEntries('codex',uuids.slice(start,start+800)))) {
        exact.push(row);
      }
    }
    const revision=manager.getHistoryPromptPresentationRevision?.('codex',payload.sessionId)||'none';
    const db = Object.create(manager);
    db.getHistoryPromptPresentations=(_tool,session)=>rows.get(session)||[];
    db.getSessionHistoryContext=session=>contexts.get(session)||null;
    // A one-row native call must still see the WHOLE frozen root's exact
    // sidecar context: source-alias ambiguity cannot depend on selected row.
    if(manager.getHistoryPromptPresentationsForEntries) db.getHistoryPromptPresentationsForEntries=()=>exact;
    // Preserve method this for actual existing mutation owner.
    for(const name of ['bindHistoryPromptPresentationEntry','saveHistoryPromptPresentation'])
      if(typeof manager[name]==='function')db[name]=manager[name].bind(manager);
    const dependencySessions=physicalSessions?[...new Set([...physicalSessions,...contexts.keys()])].sort():null;
    const dependencies=capturePrimaryDependencies(service,canonical,dependencySessions,{ownReadSnapshot,tabId:payload.tabId,
      preparedOwner:{manager,connection}});
    return {db,revision,dependencySessions,dependencies,rowCount:[...rows.values()].reduce((n,r)=>n+r.length,0)+exact.length};
  };
  return ownReadSnapshot
    ? connection.transaction(capture)() : capture();
}

async function preparePrompts(store, canonical, service, payload, control, metrics, physicalSessions) {
  const manager=service.promptPresentationStore;
  const ids=new Set();
  for(const row of canonical.entries.rows()) {control?.assertCurrent();const id=scalar(row.field('uuid'));if(id)ids.add(id);}
  const uuids=[...ids];
  metrics.nativeUUIDCount=uuids.length;
  let result;
  for(let pass=0;pass<3;pass++) {
    control?.assertCurrent();
    const snapshot=freezePromptSidecars(manager,payload,uuids,service,canonical,physicalSessions);
    metrics.maxFrozenSidecarRows=Math.max(metrics.maxFrozenSidecarRows,snapshot.rowCount||0);
    const arena=new HistoryProjectionArena(store,canonical.root);
    let root;
    try {
      const rows=arena.state();
      for(let i=0;i<canonical.entries.length;i++) {
        control?.assertCurrent();
        const cursor=canonical.entries.at(i), role=scalar(cursor.field('role'));
        const isPrompt=['user','queued'].includes(role) || scalar(cursor.field('type'))==='user' || scalar(cursor.field('kind'))==='user';
        if(isPrompt) {
          // Explicit ONE user-row compatibility sink, including actual prompt/
          // image/authoring/question semantics. No array of full prompt bodies.
          const entry=materialize(cursor,{control});
          metrics.nativePromptRows++; metrics.maxNativePromptRows=1;
          const recovery=typeof service.recoverManagedHistoryImageRef==='function'
            ? (...args)=>{metrics.imageRecoveryCalls++;return Reflect.apply(service.recoverManagedHistoryImageRef,undefined,args);} : null;
          const prepared=decorateHistoryPromptPresentations(snapshot.db,{
            toolType:'codex',sessionId:payload.sessionId,entries:[entry],
            recoverManagedImageRef:recovery,
          })[0];
          if(prepared!==entry)arena.step(()=>{rows[i]=prepared;});
        }
        if(i%32===31) {
          if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));
          control?.assertCurrent();
        }
      }
      root=arena.step(()=>arena.publish(rows));
      const revision=manager?.getHistoryPromptPresentationRevision?.('codex',payload.sessionId)||'none';
      const stable=revision===snapshot.revision;
      const preparedRoot=root;
      result={root:preparedRoot,revision,stable,passes:pass+1,dependencySessions:snapshot.dependencySessions,
        dependencies:snapshot.dependencies,release:once(()=>preparedRoot.release())};
      root=null;
      if(stable || pass===2) return result;
      result.release();result=null;
    } finally { root?.release();arena.close(); }
  }
}

async function verifySource(canonical,service,control,store) {
  control?.assertCurrent();
  if (isFrozenCanonical(store,canonical)) return;
  const snapshot=canonical.sourceSnapshot;
  if(!snapshot || !snapshot.filePath)throw fail('HISTORY_PRIMARY_SOURCE_FENCE_REQUIRED');
  const current=service.codexData?._api?.isCodexSourceSnapshotCurrent;
  if(current && !current(snapshot))throw fail('CODEX_SOURCE_READ_INVALIDATED');
  const stat=await fs.promises.stat(snapshot.filePath);
  control?.assertCurrent();
  if(stat.size!==snapshot.size || stat.mtimeMs!==snapshot.mtimeMs
    || snapshot.fileIdentity && snapshot.fileIdentity!==stat.dev+':'+stat.ino
    || Number.isFinite(snapshot.ctimeMs) && snapshot.ctimeMs!==stat.ctimeMs)throw fail('CODEX_SOURCE_READ_INVALIDATED');
  if(current && !current(snapshot))throw fail('CODEX_SOURCE_READ_INVALIDATED');
}

// Typed graph digest over the frozen overlay. JSON would drop undefined,
// sparse slots, maps/sets, reject BigInt and cycles. Hash scalar UTF16 chunks
// and traversal IDs directly; only metadata/stack frames are native OPEN.
async function hashFrozenOverlay(store,root,hash,control) {
  const seen=new Map(),stack=[{cursor:root}],tag=value=>hash.update(value+';');
  let steps=0;
  while(stack.length){
    control?.assertCurrent();
    const frame=stack.at(-1);
    if(frame.children){
      const next=frame.children.next();
      if(next.done){tag('end');stack.pop();continue;}
      if(next.value.tag!==undefined)tag(next.value.tag);
      if(next.value.cursor)stack.push({cursor:next.value.cursor});
      continue;
    }
    const cursor=frame.cursor,kind=cursor.kind;tag(kind);
    if(kind==='text'){
      tag(cursor.length);
      for(const chunk of cursor.textChunks()){
        control?.assertCurrent();hash.update(Buffer.from(chunk,'utf16le'));
        if(++steps%64===0 && control?.checkpoint)await control.checkpoint();
      }stack.pop();continue;
    }
    if(!['object','array','map','set'].includes(kind)){
      const value=cursor.scalar();
      tag(typeof value==='number'?(Object.is(value,-0)?'-0':String(value))
        :typeof value==='bigint'?value.toString():String(value));
      stack.pop();continue;
    }
    const address=historyPagedCursorAddress(cursor),identity=JSON.stringify(address);
    if(seen.has(identity)){tag('ref:'+seen.get(identity));stack.pop();continue;}
    const id=seen.size;seen.set(identity,id);tag('id:'+id);
    const meta=store.json(address.ref.id);
    tag(meta.nullPrototype?'null-prototype':'standard-prototype');
    frame.children=(function*(){
      if(kind==='array'){
        yield {tag:'length:'+cursor.length};
        for(const item of store.vectorPresent(meta.items)){
          if(item.ordinal<cursor.length)yield {tag:'index:'+item.ordinal,cursor:cursor.at(item.ordinal)};
        }
      }
      if(kind==='map'||kind==='set')for(const [key,value]of cursor.pairs()){
        yield {tag:'key',cursor:key};if(kind==='map')yield {tag:'value',cursor:value};
      }
      for(const [key,value]of cursor.fields()){
        yield {tag:'field',cursor:key};yield {tag:'value',cursor:value};
      }
    })();
    if(++steps%64===0){
      if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));
    }
  }
  control?.assertCurrent();
}

async function createPrimaryHistoryPresentation(store,canonical,{service,payload={},control,diagnostics}={}) {
  if(!service || payload.toolType!=='codex' || !canonical?.success
    || canonical.representation!=='codex-canonical-root-v1'
    || !isHistoryPagedCursor(canonical.entries) || canonical.entries.kind!=='array')
    throw fail('HISTORY_PRIMARY_CANONICAL_REQUIRED');
  const metrics={nativeUUIDCount:0,maxFrozenSidecarRows:0,nativePromptRows:0,maxNativePromptRows:0,
    scalarReads:0,maxNativeScalarChars:0,nativeRootHandles:0,wholeHistoryDTOs:0,imageRecoveryCalls:0,
    canonicalStubRows:0,preparedStubRows:0,preparedReusedStubRows:0,
    globalMemoryBounded:false,actualUI:false};
  const dependencyScope=primaryDependencyScope(payload);
  let prompts,timings,arena,overlayRoot,preparedRoot,metadataRoot,durableMetadataRoot,settingsKeyRoot,indexes,view,bundle;
  const checkpoint=async()=>{control?.assertCurrent();if(control?.checkpoint)await control.checkpoint();
    else await new Promise(resolve=>setImmediate(resolve));control?.assertCurrent();};
  // Fixed stages of this one preparation; no rows, source text or SQL are
  // inspected for diagnostics. Wall intervals include checkpoints/awaits.
  // The worker adds its existing request correlation and bounded stage events.
  const diagnostic=diagnostics?{schema:'history-primary-preparation-v1',startAbs:performance.timeOrigin+performance.now(),
    timing:'elapsed-wall; process-cpu-is-all-threads; phases-are-sequential',phases:[],outcome:'incomplete'}:null;
  let cpuStart=null;try{if(diagnostic)cpuStart=process.cpuUsage();}catch{}
  let phaseName=null,phaseStart=0,endPhase=null;
  const phase=name=>{if(!diagnostic)return;try{
    const now=performance.now();
    if(phaseName)diagnostic.phases.push({stage:phaseName,startAbs:performance.timeOrigin+phaseStart,
      endAbs:performance.timeOrigin+now,elapsedMs:now-phaseStart});
    try{endPhase?.();}catch{} endPhase=null;phaseName=name;phaseStart=now;
    if(name)try{endPhase=diagnostics.beginPhase?.('primary-'+name);}catch{}
  }catch{}};
  const finishDiagnostic=error=>{if(!diagnostic)return;try{
    phase(null);diagnostic.endAbs=performance.timeOrigin+performance.now();
    diagnostic.elapsedMs=diagnostic.endAbs-diagnostic.startAbs;
    diagnostic.outcome=error?'error':'success';
    diagnostic.canonicalStubRows=metrics.canonicalStubRows;
    diagnostic.preparedStubRows=metrics.preparedStubRows;
    diagnostic.preparedReusedStubRows=metrics.preparedReusedStubRows;
    try{const cpu=cpuStart&&process.cpuUsage(cpuStart);
      diagnostic.processCpuUserMs=cpu?cpu.user/1000:null;diagnostic.processCpuSystemMs=cpu?cpu.system/1000:null;
    }catch{diagnostic.processCpuUserMs=diagnostic.processCpuSystemMs=null;}
    diagnostics.complete?.(diagnostic);
  }catch{}};
  try {
    phase('source-check');
    await verifySource(canonical,service,control,store);
    phase('session-membership');
    const sessions=new Set([payload.sessionId]);
    for(const row of canonical.entries.rows()) {
      const session=scalar(row.field('sessionId'));if(session)sessions.add(session);
    }
    const physicalSessions=sessions.size<=MAX_SESSIONS?[...sessions]:null;
    const runtimeRevision=getCodexProcessActionOwnershipRevision([...sessions]);
    phase('prompts');
    prompts=await preparePrompts(store,canonical,service,payload,control,metrics,physicalSessions);
    const dependencySessions=prompts.dependencySessions,startDependencies=prompts.dependencies;
    if(!prompts.stable)throw fail('HISTORY_PRIMARY_PROMPT_SNAPSHOT_UNSTABLE');
    phase('response-timings');
    if(service.promptPresentationStore) {
      timings=await reconcileRootResponseTimings(store,prompts.root,{
        db:service.promptPresentationStore,toolType:'codex',sessionId:payload.sessionId,tabId:payload.tabId,control,
        // applyRootResponseTimings calls this inside the SAME read cut as its
        // actual bound values/revision, after all pending bindings.
        captureDependencies:({db,connection})=>capturePrimaryDependencies(service,canonical,dependencySessions,{
          ownReadSnapshot:true,tabId:payload.tabId,preparedOwner:{manager:db,connection}}),
      });
      if(!timings.stable)throw fail('HISTORY_PRIMARY_TIMING_SNAPSHOT_UNSTABLE');
    }
    const semanticRoot=timings?.root||prompts.root;
    phase('indexes');
    indexes=await buildHistoryRootIndexes(store,semanticRoot,{control});
    // Read latest supplied overlay only AFTER semantic preparation awaits.
    phase('overlay-capture');
    await checkpoint();
    const owner=payload.overlayOwner;
    if(owner && (owner.sessionId!==payload.sessionId || owner.tabId!==payload.tabId
      || owner.generation!=null && owner.generation!==payload.generation))throw fail('HISTORY_PRIMARY_OVERLAY_OWNER_MISMATCH');
    arena=new HistoryProjectionArena(store,indexes.lease);
    const input=arena.step(()=>arena.own({
      localEntries:payload.localEntries||[],liveEntries:payload.liveEntries||[],
      liveToolResults:payload.liveToolResults||[],
      suppressions:payload.suppressions||[],
      rewindPreview:payload.rewindPreview||null,
      settingsPresentationKeys:new Map(payload.settingsPresentationKeys||[]),
    }));
    overlayRoot=arena.step(()=>arena.publish(input));
    const adapter=nativeAdapter(arena,metrics,()=>control?.assertCurrent());
    const durable=Array.from(arena.state().entries,r=>adapter.read(r));
    metrics.nativeRootHandles=durable.length;
    // Canonical coverage is independent from the merged presentation. A live
    // row rendered in the derived view is not proof that the held physical
    // source cut already contains it.
    phase('canonical-stubs');
    const durableMetadata=arena.step(()=>arena.make('array'));
    for(let i=0;i<durable.length;i++){
      const value=await primaryRowStub(arena,arena.state().entries[i],adapter,{control,compatibility:true});
      metrics.canonicalStubRows++;
      arena.step(()=>durableMetadata.push(value));
      if(i%32===31)await checkpoint();
    }
    durableMetadataRoot=arena.step(()=>arena.publish(durableMetadata));
    phase('current-merge');
    const overlays=adapter.read(input);
    const settingsKeys=new Map(overlays.settingsPresentationKeys instanceof Map
      ? materialize(overlayRoot.cursor().field('settingsPresentationKeys')):[]);
    const filtered=local.filterSuppressedPromptEntries(durable,overlays.suppressions).entries;
    const mergeFrom=Date.now();
    let combined=adapter.adoption(()=>local.mergeServerAndLocalEntries(filtered,overlays.localEntries));
    const timeWindow=primaryTimeWindow(payload.localEntries||[],mergeFrom,Date.now());
    combined=live.buildHistoryLivePresentation(combined,overlays.liveEntries,{settingsPresentationKeys:settingsKeys});
    const resultsCursor=overlayRoot.cursor().field('liveToolResults');
    const results=resultsCursor.kind==='map'?[...materialize(resultsCursor).values()]:overlays.liveToolResults;
    if(results.length)combined=combined.map(entry=>live.applyHistoryLiveToolResultsToEntry(entry,results));
    const rewind=local.buildRewindPreviewEntries(combined,overlays.rewindPreview);
    settingsKeyRoot=arena.step(()=>arena.publish(arena.own(settingsKeys)));
    phase('prepared-root');
    const visible=arena.step(()=>arena.make('array'));
    for(let i=0;i<rewind.entries.length;i++){
      arena.step(()=>visible.push(adapter.importValue(rewind.entries[i])));
      if(i%32===31)await checkpoint();
    }
    preparedRoot=arena.step(()=>arena.publish(visible));
    // Temporary early UI owner: all-ID/current-stub metadata for legacy action
    // indices, in EXACT prepared source order (local/live -> Rewind).
    phase('prepared-stubs');
    const metadata=arena.step(()=>arena.make('array'));
    for(let i=0;i<visible.length;i++) {
      control?.assertCurrent();
      const raw=visible[i],id=arena.owner(raw);
      // The semantic rows were exposed to CURRENT only through immutable
      // native facades. Import returns their original arena owners; changed
      // native records get fresh owners. Compare those exact owners at the
      // SAME ordinal, not UUIDs/counts or evictable handle object identity.
      // The earlier compatibility stub therefore has exactly the same input.
      // Both metadata arrays and their full Nc/Np validations remain distinct.
      const reuse=id!==null && i<durable.length && id===arena.owner(arena.state().entries[i]);
      const value=reuse?durableMetadata[i]
        :await primaryRowStub(arena,raw,adapter,{control,compatibility:true});
      if(reuse)metrics.preparedReusedStubRows++;else metrics.preparedStubRows++;
      arena.step(()=>metadata.push(value));
      if(i%32===31)await checkpoint();
    }
    metadataRoot=arena.step(()=>arena.publish(metadata));
    adapter.clear();durable.length=0;combined=null;
    // Validate the canonical thin subtree independently of prepared visibility.
    // Its page-backed proof replaces the renderer Nc graph; prepared Np stays
    // the genuine compatibility owner. A broader selected-consumer grammar is
    // not narrowed by a metadata-only refusal until that fact is demanded.
    phase('canonical-validation');
    const canonicalMetadataValidation=await establishCanonicalMetadataValidation(store,durableMetadataRoot,{control});
    // This distinct full Np check covers every reachable prepared thin value,
    // including local/live rows and rows hidden inside a collapsed unit. It
    // never borrows canonical Nc's attestation or constructs another N graph.
    phase('prepared-validation');
    const preparedMetadataValidation=await establishPreparedMetadataValidation(store,metadataRoot,{control});
    control?.assertCurrent();
    const viewOptions=primaryViewOptions(payload),semanticIdentity=randomUUID();
    phase('display-view');
    view=await createHistoryRootDisplayView(store,preparedRoot,{...viewOptions.grouping,complete:true,frozen:true,control});
    phase('revision-hashes');
    const semanticRevision=createHash('sha256').update(JSON.stringify([
      'history-primary-v1',canonical.sourceSnapshot,payload.sessionId,payload.cwd||'',payload.tabId||'',
      runtimeRevision,prompts.revision,timings?.revision||'none',
    ]));
    await hashFrozenOverlay(store,overlayRoot.cursor(),semanticRevision,control);
    const viewRevision=await primaryViewRevision(store,preparedRoot,semanticIdentity,viewOptions,hashFrozenOverlay,control);
    phase('final-source-check');
    await verifySource(canonical,service,control,store);
    if(runtimeRevision!==getCodexProcessActionOwnershipRevision([...sessions]))throw fail('HISTORY_PRIMARY_RUNTIME_CHANGED');
    phase('dependency-check');
    const manager=service.promptPresentationStore;
    const ownReadSnapshot=!!manager?.db?.transaction && !manager.db.inTransaction;
    const observe=()=>({
      prompt:manager?.getHistoryPromptPresentationRevision?.('codex',payload.sessionId),
      timing:manager?.getHistoryResponseTimingRevision?.('codex',payload.sessionId,payload.tabId||null),
      dependencies:capturePrimaryDependencies(service,canonical,dependencySessions,{ownReadSnapshot,tabId:payload.tabId}),
    });
    const observed=ownReadSnapshot?manager.db.transaction(observe)():observe();
    control?.assertCurrent();
    if(manager?.getHistoryPromptPresentationRevision && observed.prompt!==prompts.revision)
      throw primaryDependencyChange(fail('HISTORY_PRIMARY_PROMPT_CHANGED'),'prompt',prompts.dependencies,observed.dependencies,dependencyScope);
    if(manager?.getHistoryResponseTimingRevision && observed.timing!==timings.revision)
      throw primaryDependencyChange(fail('HISTORY_PRIMARY_TIMING_CHANGED'),'timing',timings.dependencies,observed.dependencies,dependencyScope);
    const token=semanticRevision.digest('hex');
    const endDependencies=observed.dependencies;
    phase('bundle-publication');
    bundle=createPrimarySemanticBundle({store,canonical,preparedRoot,metadataRoot,durableMetadataRoot,canonicalMetadataValidation,preparedMetadataValidation,settingsKeyRoot,indexes,
      overlayRoot,arena,timings,prompts,service,payload,sessions:dependencySessions,startDependencies,endDependencies,timeWindow,
      semanticToken:token,runtimeRevision,metrics,projectUnit:projectPrimaryHistoryUnit,hashFrozenOverlay,
      hiddenCount:rewind.hiddenCount,hiddenTurnCount:rewind.hiddenTurnCount,unwitnessedRecovery:metrics.imageRecoveryCalls>0,identity:semanticIdentity});
    // Ownership moves exactly once from this construction to the bundle.
    prompts=timings=arena=overlayRoot=preparedRoot=metadataRoot=durableMetadataRoot=settingsKeyRoot=indexes=null;
    control?.assertCurrent();
    const result=wrapPrimaryView(bundle,view,viewRevision,payload.primaryRequestClass|| (payload.localRootLease?'semantic':'source'));
    view=null;bundle.releaseConstruction();bundle=null;finishDiagnostic(null);return result;
  } catch(error) {
    if(diagnostic)diagnostic.failedStage=phaseName;
    phase('cleanup');
    let clean=true;
    for(const dispose of [()=>view?.close(),()=>indexes?.close(),()=>preparedRoot?.release(),
      ()=>overlayRoot?.release(),()=>metadataRoot?.release(),()=>durableMetadataRoot?.release(),()=>settingsKeyRoot?.release(),()=>arena?.close(),()=>timings?.release(),()=>prompts?.release(),()=>bundle?.releaseConstruction()]){
      try{dispose();}catch{clean=false;}
    }
    completePrimaryDependencyCleanup(error,clean);finishDiagnostic(error);throw error;
  }
}

async function primaryRowStub(arena,raw,adapter,{control,caption=false,compatibility=false}={}) {
  const row=adapter.read(raw), source={};
  // Existing stub helper reads this finite structural vocabulary. Actions
  // use lazy getters; no arbitrary args/result fields are traversed.
  for(const key of ['questionReplyProof','imageCount','rowStub','actionSummary','contentLength','hasContent','hasThinking','uuid','role','timestamp','recordTime','sessionId','messageId','textPhase',
    'preTokens','postTokens','compactEncrypted','viewOwnerSessionId','physicalSessionId','transcriptSegmentId',
    'rawUuid','contentRevision','entryRef','recordByteOffset','sourceIdentity','sourceIdentityAliases',
    'sourceUuidAliases','serviceCarrier','semanticTags','thinkingSeconds','settingsFact']) {
    source[key]=row[key];
  }
  source.actions=Array.isArray(row.actions)?row.actions.map(action=>{
    if(action?.tool!=='__raw__')return action;
    const raw=action.rawTool,args=raw?.args;
    const safeArgs={};
    if(args&&typeof args==='object')for(const key of grammarFields) {
      if(Object.hasOwn(args,key))Object.defineProperty(safeArgs,key,{get:()=>args[key],enumerable:true});
    }
    return {tool:'__raw__',rawTool:{...Object.fromEntries(
      ['toolUseId','toolName','recordTime','family','bashWord','bashDetail','mcpServer','mcpMethod','isError']
        .map(key=>[key,raw?.[key]])),args:safeArgs}};
  }):undefined;
  const value=makeHistoryRowStub(source);
  if(compatibility)for(const key of ['rewriteRenderKey','rewriteLayoutUuid','settingsPresentationKey',
    'servicePresentationKey','isLocal','liveProjection','queueStatus','handoffId','auditEntryUuid','auditSessionId',
    'auditTimestamp','optimisticAt','statusChangedAt','statusReason','statusAtSend','requiresAuditIdentity',
    'sendOperationKey','sendAttemptId','presentationHandoffId'])
    if(row[key]!==undefined)value[key]=row[key];
  // The footer-to-header handoff needs only this fixed timing certificate.
  // Do not import arbitrary responseTiming fields into the metadata owner.
  if(compatibility && row.responseTiming){
    const timing=row.responseTiming, startTs=Number(timing.startTs), endTs=Number(timing.endTs),
      durationMs=Number(timing.durationMs), intervalId=Number(timing.intervalId);
    if(Number.isFinite(startTs)&&Number.isFinite(endTs)&&Number.isFinite(durationMs)
      &&endTs>=startTs&&durationMs>=0){
      value.responseTiming={startTs,endTs,durationMs};
      if(Number.isFinite(intervalId))value.responseTiming.intervalId=intervalId;
    }
  }
  const content=await trimmedFacts(raw.content,{checkpoint:control?.checkpoint});
  const thinking=await trimmedFacts(raw.thinking,{checkpoint:control?.checkpoint});
  if(text.isText(raw.content)){value.contentLength=content.trimmedLength;if(content.hasContent)value.hasContent=true;}
  if(thinking.hasContent)value.hasThinking=true;
  control?.assertCurrent();
  return arena.step(()=>{
    const out=adapter.importStubRecord(value);
    if(caption && text.isText(raw.content)){
      out.content=raw.content;
      // Only this selected caption text is complete. Actions/thinking and
      // other hidden fields remain thin; never mark the whole row hydrated.
      out.captionTextComplete=true;
    }
    return out;
  });
}


// One selected presentation unit. Entry body stays exact. Every hidden group
// member is the CURRENT row stub; captions carry text plus the same stub, not
// hidden actions/results/reasoning. No JSON stringify/parse/type narrowing.
async function projectPrimaryHistoryUnit(store,view,rank,{control}={}) {
  control?.assertCurrent();
  const unit=view.unitAt(rank);if(!unit)throw fail('HISTORY_PRIMARY_UNIT_RANGE');
  const arena=new HistoryProjectionArena(store,view.root);
  let lease;
  try {
    const rawUnit=arena.state().units[rank];
    if(scalar(unit.field('kind'))==='entry')lease=arena.step(()=>arena.publish(rawUnit));
    else {
      const adapter=nativeAdapter(arena,{scalarReads:0,maxNativeScalarChars:0},()=>control?.assertCurrent());
      const projected=arena.step(()=>arena.assign(rawUnit));
      const members=arena.step(()=>arena.make('array'));
      
      // A response chapter can contain a whole long turn. The header needs
      // only its first real source identity; expanded members are separate
      // paged units and a collapsed header must not materialize the turn.
      const responseWork=scalar(unit.field('familyKey'))==='response-work';
      const memberCount=responseWork
        ? Math.min(1,unit.field('entries').length) : unit.field('entries').length;
      for(let i=0;i<memberCount;i++){
        const value=await primaryRowStub(arena,rawUnit.entries[i],adapter,{control});
        arena.step(()=>{members[i]=value;});
      }
      arena.step(()=>{projected.entries=members;});
      if(responseWork){
        // The closed preview reads at most 513 UTF-16 units of ONE selected
        // commentary; no hidden body or full source graph crosses the wire.
        const bounded=(value,limit)=>{
          if(!text.isText(value))return {value:'',truncated:false};
          let out='';for(const chunk of text.chunks(value,0,Math.min(value.length,limit+1)))out+=chunk;
          let end=Math.min(out.length,limit);
          if(end>0 && end<value.length && /[\uD800-\uDBFF]/.test(out[end-1]))end--;
          return {value:out.slice(0,end),truncated:value.length>end};
        };
        arena.step(()=>{projected.previewEntry=null;projected.previewFact=null;});
        if(rawUnit.expanded!==true && rawUnit.previewEntry){
          const original=rawUnit.previewEntry, prefix=bounded(original.content,512);
          const preview=arena.step(()=>arena.record({uuid:original.uuid,
            ...(text.isText(original.content) ? {content:prefix.value,previewTextComplete:true,previewTruncated:prefix.truncated}
              : {rowStub:true,hasContent:true,previewTextComplete:false})}));
          arena.step(()=>{projected.previewEntry=preview;});
        } else if(rawUnit.expanded!==true && rawUnit.previewFact){
          const original=rawUnit.previewFact, family=bounded(original.family,128).value;
          const safe={family,isError:original.isError===true};
          const fields=family==='mcp'?['mcpServer','mcpMethod']
            :family==='read'||family==='edit'||family==='search'?['subject','targetLabel']
              :family==='run'||family==='git'?['bashWord']:[];
          for(const key of fields){
            const part=bounded(original[key],128);
            safe[key]=part.value.replace(/\s+/g,' ').trim()+(part.truncated?'…':'');
          }
          const preview=arena.step(()=>arena.record(safe));
          arena.step(()=>{projected.previewFact=preview;});
        }
      }
      if(unit.field('captionEntries').kind==='array'){
        const captions=arena.step(()=>arena.make('array'));
        for(const row of rawUnit.captionEntries){
          const value=await primaryRowStub(arena,row,adapter,{control,caption:true});arena.step(()=>captions.push(value));
        }arena.step(()=>{projected.captionEntries=captions;});
      }
      if(unit.field('captionEntry').kind==='object'){
        const value=await primaryRowStub(arena,rawUnit.captionEntry,adapter,{control,caption:true});arena.step(()=>{projected.captionEntry=value;});
      }
      lease=arena.step(()=>arena.publish(projected));adapter.clear();
    }
    control?.assertCurrent();return lease;
  } catch(error){lease?.release();throw error;}
  finally{arena.close();}
}
module.exports={createPrimaryHistoryPresentation,projectPrimaryHistoryUnit,
  prepareRootPromptPresentations:preparePrompts,verifyRootPresentationSource:verifySource};

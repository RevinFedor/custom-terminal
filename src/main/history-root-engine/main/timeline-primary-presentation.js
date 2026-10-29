'use strict';

// Timeline's existing prompt decorator runs over the actual rooted Timeline
// reducer output, never over History display units. Full native prompt rows
// remain an explicit selected compatibility sink; this does not claim a
// global memory bound for prompt sidecars or the eventual renderer.
const { createHash } = require('node:crypto');
const { isHistoryPagedCursor } = require('./history-paged-store');
const { prepareRootPromptPresentations,verifyRootPresentationSource } = require('./history-primary-presentation');
const { getCodexProcessActionOwnershipRevision } = require('./codex-process-action-ownership');
const { MAX_SESSIONS } = require('./history-primary-dependencies');
const { buildHistoryRootIndexes } = require('./history-root-indexes');
const fail=code=>Object.assign(new Error(code),{code});
const scalar=cursor=>cursor.kind==='text'?[...cursor.textChunks()].join(''):cursor.scalar();

async function createPrimaryTimelinePresentation(store,canonical,{service,payload,control}={}) {
  if(!service||payload?.toolType!=='codex'||payload.readProfile!=='timeline-primary-v1'
    ||canonical?.success!==true||canonical.representation!=='codex-timeline-root-v1'
    ||!isHistoryPagedCursor(canonical.entries)||canonical.entries.kind!=='array')
    throw fail('TIMELINE_PRIMARY_CANONICAL_REQUIRED');
  const metrics={nativeUUIDCount:0,maxFrozenSidecarRows:0,nativePromptRows:0,maxNativePromptRows:0,
    imageRecoveryCalls:0,wholeTimelineDTOs:0,globalMemoryBounded:false,actualUI:false};
  const manager=service.promptPresentationStore;
  let prompts,indexes,transferred=false;
  try {
    await verifyRootPresentationSource(canonical,service,control,store);
    const sessions=new Set([payload.sessionId]);
    for(const row of canonical.entries.rows()) {
      control?.assertCurrent();const id=scalar(row.field('sessionId'));if(id)sessions.add(id);
    }
    const owners=[...sessions],runtime=getCodexProcessActionOwnershipRevision(owners);
    prompts=await prepareRootPromptPresentations(store,canonical,service,payload,control,metrics,
      sessions.size<=MAX_SESSIONS?owners:null);
    indexes=await buildHistoryRootIndexes(store,prompts.root,{control});
    control?.assertCurrent();
    if(service.promptPresentationStore!==manager)throw fail('TIMELINE_PRIMARY_PROMPT_OWNER_CHANGED');
    if(!prompts.stable||prompts.revision!==(manager?.getHistoryPromptPresentationRevision?.('codex',payload.sessionId)||'none'))
      throw fail('TIMELINE_PRIMARY_PROMPT_CHANGED');
    if(runtime!==getCodexProcessActionOwnershipRevision(owners))throw fail('TIMELINE_PRIMARY_RUNTIME_CHANGED');
    await verifyRootPresentationSource(canonical,service,control,store);
    control?.assertCurrent();
    const revision=createHash('sha256').update(JSON.stringify(['timeline-primary-v1',canonical.sourceSnapshot,prompts.revision,runtime])).digest('hex');
    let released=false;
    const result={...canonical,root:indexes.lease,entries:indexes.entries,timelineIndexes:indexes,readProfile:'timeline-primary-v1',
      semanticSnapshotComplete:true,semanticRevisionToken:revision,
      timelinePromptRevision:prompts.revision,
      timelineRuntimeCapture:Object.freeze({sessions:sessions.size<=MAX_SESSIONS?Object.freeze(owners):null,revision:runtime}),
      timelinePreparation:Object.freeze({...metrics,promptPasses:prompts.passes}),
      release(){if(released)return;released=true;let error;
        for(const release of [()=>indexes.close(),()=>prompts.release(),()=>canonical.release()])
          try{release();}catch(e){error||=e;}if(error)throw error;}};
    transferred=true;return result;
  }finally{if(!transferred){try{indexes?.close();}finally{prompts?.release();}}}
}
module.exports={createPrimaryTimelinePresentation};

'use strict';

const crypto=require('node:crypto'),path=require('node:path');
const {fingerprint}=require('./workflow-organization');
const copy=value=>JSON.parse(JSON.stringify(value));
const fail=(code,statusCode=409)=>{throw Object.assign(new Error(code),{code,statusCode});};
const id=value=>typeof value==='string' && value.length>0 && value.length<=256;
const deepFreeze=value=>{if(value && typeof value==='object' && !Object.isFrozen(value)){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
const LEASE_MS=300000,MAX_CAPTURES=32,MAX_RECORDS=2048,MAX_BYTES=64*1024*1024,MAX_CAPTURE_BYTES=8*1024*1024;

/** Bounded read admissions, not an organization store. Only commitDrag writes.
 * Exact retries share their pickup; expiry rejects the old request instead of
 * taking a new snapshot. Durable commit recovery belongs to the existing journal.
 */
class WorkflowNativeDrag {
  constructor({readCapture,mutate,readCommand,now=Date.now,loadCompiler=()=>require(path.join(__dirname,'../../dist/workflow-native-drag.cjs'))}) {
    Object.assign(this,{readCapture,mutate,readCommand,now,loadCompiler});
    this.epoch=crypto.randomUUID();this.captures=new Map();this.bytes=0;
  }
  status(){return {version:1,epoch:this.epoch,serverTime:this.now(),leaseMs:LEASE_MS,maxCaptures:MAX_CAPTURES,
    maxCaptureBytes:MAX_CAPTURE_BYTES,maxRecords:MAX_RECORDS,maxActions:64,inventory:'active-membership'};}
  compiler(){
    if(!this.loadedCompiler){
      try{this.loadedCompiler=this.loadCompiler();}catch{fail('workflow_drag_compiler_unavailable',503);}
    }
    if(this.loadedCompiler?.version!==1)fail('workflow_drag_compiler_unavailable',503);
    return this.loadedCompiler;
  }
  prune(){for(const [key,entry] of this.captures)if(entry.expiresAt<this.now()){
    this.bytes-=entry.bytes || 0;this.captures.delete(key);
  }}
  async capture(raw) {
    const input=copy(raw);
    if(input?.version!==1 || !id(input.gestureId) || input.gestureId.length>128 || !id(input.workflowId) || typeof input.sourceId!=='string'
      || input.sourceId.length>8192 || !Array.isArray(input.selectedTabIds) || input.selectedTabIds.length>10000)fail('workflow_drag_capture_invalid',400);
    if(input.epoch!==this.epoch)fail('workflow_drag_epoch_changed');
    if(!Number.isSafeInteger(input.startedAt) || input.startedAt>this.now()+15000 || input.startedAt+LEASE_MS<this.now())fail('workflow_drag_capture_expired',410);
    this.prune();
    const captureId=this.epoch+':'+input.gestureId,hash=fingerprint(input),old=this.captures.get(captureId);
    if(old){if(old.hash!==hash)fail('workflow_drag_capture_id_conflict');if(old.discarded)fail('workflow_drag_capture_released',410);return old.promise;}
    if(this.captures.size>=MAX_RECORDS || [...this.captures.values()].filter(entry=>!entry.discarded && !entry.failed).length>=MAX_CAPTURES)fail('workflow_drag_capture_capacity',429);
    const entry={hash,expiresAt:input.startedAt+LEASE_MS,bytes:0,context:null,promise:null};
    this.captures.set(captureId,entry);
    entry.promise=(async()=>{
      const compiler=this.compiler(),read=await this.readCapture();
      const expected=input.expected;
      if(expected?.organizationRevision!==read.dto.clocks.organization.revision
        || expected.groupsRevision!==read.dto.clocks.groups.revision || expected.tree!==read.dto.clocks.tree.value)fail('workflow_drag_pickup_changed');
      const captured=compiler.captureNativeDrag(read,input);
      const bytes=Buffer.byteLength(JSON.stringify(captured));
      if(bytes>MAX_CAPTURE_BYTES || this.bytes+bytes>MAX_BYTES)fail('workflow_drag_capture_capacity',429);
      if(entry.discarded || this.captures.get(captureId)!==entry || entry.expiresAt<this.now())fail('workflow_drag_capture_expired',410);
      entry.context=deepFreeze(captured);entry.bytes=bytes;this.bytes+=bytes;
      return deepFreeze({version:1,captureId,gestureId:input.gestureId,expiresAt:entry.expiresAt,
        mutationId:'workflow-drag:'+input.gestureId,inventory:'active-membership',
        publication:read.snapshot.publication,
        sourceRootIds:captured.admission.sourceRootIds,sourceFamilyIds:captured.admission.familyIds,
        clocks:read.dto.clocks,workflows:read.dto.workflows});
    })().catch(error=>{entry.failed=true;throw error;});
    return entry.promise;
  }
  async entry(captureId){
    this.prune();const entry=this.captures.get(captureId);
    if(!entry || entry.discarded)fail('workflow_drag_capture_expired',410);
    await entry.promise;
    if(entry.discarded || !entry.context || entry.expiresAt<this.now())fail('workflow_drag_capture_expired',410);
    return entry;
  }
  async preview(raw) {
    const input=copy(raw);
    if(input?.version!==1 || typeof input.captureId!=='string')fail('workflow_drag_preview_invalid',400);
    const entry=await this.entry(input.captureId);
    const compiled=this.compiler().previewNativeDrag(entry.context,input.destination);
    const previewId=fingerprint({captureId:input.captureId,destination:input.destination,request:compiled.request});
    return {version:1,captureId:input.captureId,previewId,tree:compiled.tree,proposal:compiled.request,
      commit:{version:1,captureId:input.captureId,previewId,mutationId:compiled.request.mutationId,destination:input.destination}};
  }
  async commit(raw) {
    const input=copy(raw);
    if(input?.version!==1 || !id(input.mutationId) || typeof input.previewId!=='string')fail('workflow_drag_commit_invalid',400);
    const inputHash=fingerprint(input),old=this.readCommand(input.mutationId);
    if(old){
      if(old.kind!=='commitDrag' || old.nativeCommit?.inputHash!==inputHash)fail('workflow_mutation_id_conflict');
      const request={...old};delete request.kind;
      return this.mutate('commitDrag',request); // exact stored body, even after restart
    }
    const preview=await this.preview(input);
    if(preview.previewId!==input.previewId || preview.proposal.mutationId!==input.mutationId)fail('workflow_drag_preview_changed');
    return this.mutate('commitDrag',{...preview.proposal,nativeCommit:{inputHash,captureId:input.captureId,previewId:input.previewId}});
  }
  release(captureId){
    this.prune();const entry=this.captures.get(captureId);
    if(!entry)fail('workflow_drag_capture_expired',410);
    this.bytes-=entry.bytes;entry.bytes=0;entry.context=null;entry.discarded=true;entry.promise=null;
    return {success:true,captureId};
  }
}
module.exports={WorkflowNativeDrag};

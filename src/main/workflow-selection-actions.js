'use strict';

const {fingerprint}=require('./workflow-organization');
const fail=code=>{throw Object.assign(Error(code),{code,statusCode:409});};
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
};
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)
  && Object.keys(value).every(key=>allowed.includes(key));
const id=value=>typeof value==='string'&&value.length>0&&value.trim()===value;
const synchronous=value=>{if(value&&typeof value.then==='function')fail('selection_journal_must_be_synchronous');return value;};

/** CANDIDATE ONLY. Composition supplies Main-owned capture, the existing
 * durable action journal adapter and canonical executor/receipt adapters.
 * No SQL/schema, IPC registration, process signaling or new close writer here.
 * In particular, a current group-close or whole-workflow-stop DTO is NOT an
 * implementation of these admission ports. */
function createWorkflowSelectionActions({captureMember,isMemberCurrent,journal,observeStop,
  closeTarget,stopTarget,readReceipt,verifyReceipt}) {
  for(const port of [captureMember,isMemberCurrent,observeStop,closeTarget,stopTarget,readReceipt,verifyReceipt])
    if(typeof port!=='function')fail('selection_action_adapter_required');
  for(const key of ['read','admit','prepare','start','complete'])
    if(typeof journal?.[key]!=='function')fail('selection_action_journal_adapter_required');
  const flights=new Map();
  const command=id=>{const value=synchronous(journal.read(id));if(!value)fail('selection_action_missing');
    if(value.version!==1 || !Array.isArray(value.members))fail('selection_action_forward_version');
    return freeze(copy(value));};
  const memberOf=(value,tabId)=>{
    const member=value.members.find(member=>member.tabId===tabId);
    if(!member)fail('selection_action_member_not_requested');return member;
  };
  const begin=request=>{
    if(!keys(request,['version','mutationId','action','members','origin']) || request.version!==1
      || !id(request.mutationId) || !['close','stop'].includes(request.action)
      || !keys(request.origin,['workflowId','windowId']) || !id(request.origin.workflowId)
      || request.origin.windowId!==null&&!id(request.origin.windowId)
      || !Array.isArray(request.members)||!request.members.length
      || request.members.some(member=>!keys(member,['projectId','tabId'])||!id(member.projectId)||!id(member.tabId))
      || new Set(request.members.map(member=>member.tabId)).size!==request.members.length)fail('selection_action_request_invalid');
    const input=copy(request),hash=fingerprint(input),old=synchronous(journal.read(input.mutationId));
    if(old){if(old.fingerprint!==hash)fail('selection_action_id_conflict');return receipt(input.mutationId);}
    // All execution namespace/subject/membership/runtime-owner proofs come
    // from Main and are captured synchronously BEFORE the first await.
    const members=input.members.map(({projectId,tabId})=>{
      const captured=captureMember(tabId);
      if(!captured || captured.active!==true || captured.namespace!==projectId
        || !captured.subject || !captured.membership || !captured.owner)fail('selection_action_capture_unknown');
      return freeze(copy({tabId,projectId,...captured}));
    });
    const frozen=freeze({...input,fingerprint:hash,members});
    synchronous(journal.admit(frozen));return receipt(input.mutationId);
  };
  const receipt=mutationId=>{
    const value=command(mutationId),results=value.members.map(member=>({tabId:member.tabId,
      state:value.steps?.[member.tabId]?.state || 'admitted'}));
    return {success:true,mutationId,completed:results.every(row=>row.state==='completed'),results};
  };
  const ack=async({mutationId,tabId})=>{
    const value=command(mutationId),member=memberOf(value,tabId);
    const actual=await readReceipt(value,member);
    if(!actual || !await verifyReceipt(value,member,actual))
      return {success:false,pending:true,mutationId,tabId,error:'selection_action_receipt_unknown'};
    synchronous(journal.complete(value,member,actual));
    return {success:true,completed:true,mutationId,tabId};
  };
  const execute=async({mutationId,tabId})=>{
    const value=command(mutationId),member=memberOf(value,tabId),phase=value.steps?.[tabId]?.state;
    if(phase&&!['admitted','prepared','started','completed'].includes(phase))fail('selection_action_phase_unknown');
    // A durable started marker survives a crash/lost ACK. It never grants a
    // second Stop/Close, even when an observation now reports no process.
    if(phase==='started'||phase==='completed')return ack({mutationId,tabId});
    const guard=()=>isMemberCurrent(member)===true;
    if(!guard())return {success:false,skipped:true,error:'selection_action_owner_changed'};
    const admission=synchronous(journal.prepare(value,member));
    let observation=null;
    if(value.action==='stop') {
      observation=await observeStop(member);
      if(!guard())return {success:false,skipped:true,error:'selection_action_owner_changed'};
      if(observation?.known!==true)return {success:false,error:'selection_stop_process_unknown'};
    }
    if(!guard())return {success:false,skipped:true,error:'selection_action_owner_changed'};
    const started=synchronous(journal.start(value,member,admission)); // DURABLE atomic CAS before physical executor.
    if(started?.acquired!==true)return ack({mutationId,tabId});
    if(!guard())return {success:false,pending:true,error:'selection_action_owner_changed_after_admission'};
    try {
      // Existing executors must recheck this Main guard after their awaits.
      // Their returned Boolean/success flag is deliberately not an ACK.
      if(value.action==='close')await closeTarget({command:value,member,admission,guard});
      else await stopTarget({command:value,member,admission,observation,guard});
    } catch(error) {
      const proven=await ack({mutationId,tabId});
      return proven.completed?proven:{...proven,error:'selection_action_outcome_unknown'};
    }
    return ack({mutationId,tabId});
  };
  const step=request=>{
    if(!keys(request,['mutationId','tabId'])||!id(request.mutationId)||!id(request.tabId))return Promise.reject(Error('selection_step_request_invalid'));
    const key=JSON.stringify([request.mutationId,request.tabId]),old=flights.get(key);
    if(old)return old;
    const promise=execute(request).finally(()=>{if(flights.get(key)===promise)flights.delete(key);});
    flights.set(key,promise);return promise;
  };
  return {begin,step,ack,receipt};
}
module.exports={createWorkflowSelectionActions};

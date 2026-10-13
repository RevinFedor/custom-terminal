/** Group publication has its own clock; organization revision cannot order it. */
export function newerWorkflowGroups(current, incoming) {
  if (!incoming) return current;
  return current && incoming.version === current.version && incoming.revision <= current.revision ? current : incoming;
}

const codeOf = error => String(error?.code || error?.message || error).match(/\bworkflow_group_[a-z_]+\b/)?.[0];
const rejectedCodes = new Set(['revision_changed','definition_changed','missing','alias_mismatch','membership_changed',
  'tab_missing','previous_membership_required','assignment_invalid','name_required','color_invalid','status_invalid',
  'collapse_invalid','mutation_invalid','mutation_id_conflict','request_version_required','version_unsupported',
  'metadata_version_unsupported','id_required'].map(code=>'workflow_group_'+code));
const confirmed = (result, request) => result?.success === true && result.mutationId === request.mutationId
  && result.version === request.version && Number.isSafeInteger(result.revision) && result.revision > request.expectedRevision;

/** One mutation lane, with the same durable Main receipt used by HTTP clients.
 * Unknown delivery owns its frozen request until receipt/exact retry resolves it.
 * No stale request is rewritten with a later revision. */
export function createWorkflowGroupClient({invoke, publish}) {
  let tail=Promise.resolve(), unresolved=null;
  const enqueue=task=>{const work=tail.then(task);tail=work.catch(()=>{});return work;};
  const refresh=async()=>{const value=await invoke('workflow:groups-read');publish(value);return value;};
  const receipt=operation=>invoke('workflow:group-mutation',operation.request.mutationId);
  const apply=async(operation,retry=false)=>{
    const {kind,request}=operation;
    let result;
    if(retry) result=await receipt(operation).catch(()=>null);
    if(!confirmed(result,request)) {
      try {
        result=await invoke('workflow:group-mutate',{kind,request});
        if(!confirmed(result,request))throw new Error('workflow_group_ack_unconfirmed');
      } catch(original) {
        result=await receipt(operation).catch(()=>null);
        if(!confirmed(result,request)) {
          const code=codeOf(original),notApplied=rejectedCodes.has(code);
          if(notApplied)unresolved=null;
          let current,refreshError;
          try {current=await refresh();}catch(error){refreshError=String(error?.message || error);}
          const group=current?.groups?.find(group=>group.id===request.groupId);
          const error=Object.assign(new Error(original?.message || String(original)),{code,
            disposition:notApplied?'not-applied':'unknown',workflowOperation:{kind,mutationId:request.mutationId,
              groupId:request.groupId,expectedRevision:request.expectedRevision,expectedGroupRevision:request.expectedGroupRevision,
              collapsed:request.collapsed,requestedName:request.name || request.metadata?.name,color:request.color,status:request.status,
              currentRevision:current?.revision,currentGroupRevision:group?.revision,
              stage:'workflow:group-mutate',outcome:notApplied?'not-applied':'unknown',refreshError}});
          console.warn('[WorkflowGroup] operation failed',JSON.stringify(error.workflowOperation),error.message);
          throw error;
        }
      }
    }
    publish(result);
    if(unresolved===operation)unresolved=null;
    return result;
  };
  return {
    refresh:()=>enqueue(async()=>{if(unresolved)await apply(unresolved,true);return refresh();}),
    mutate:(kind,input)=>{
      const request=structuredClone(input);
      return enqueue(async()=>{
        if(unresolved) {
          const previous=unresolved;
          if(previous.request.mutationId===request.mutationId
            && (previous.kind!==kind || JSON.stringify(previous.request)!==JSON.stringify(request)))
            throw new Error('workflow_group_mutation_id_conflict');
          const result=await apply(previous,true);
          if(previous.request.mutationId===request.mutationId)return result;
        }
        const operation={kind,request};unresolved=operation;
        return apply(operation);
      });
    },
  };
}

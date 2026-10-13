/** Dwell and cancel share one lane: a cancel applies the requested baseline
 * after the preceding ACK, using the resulting publication/group revision. */
export function createWorkflowGroupExpansionQueue({read,refresh=async()=>read(),mutate,mutationId=()=>crypto.randomUUID()}) {
  let tail=Promise.resolve(),pending=null;
  return (groupId,expanded) => {
    const operation=tail.then(async()=>{
      // Dwell cancellation cannot overtake an expansion with unknown delivery.
      if(pending)await send(pending);
      const baseline=read()?.groups.find(group=>group.id===groupId);
      const publication=await refresh(),group=publication?.groups.find(group=>group.id===groupId);
      if(!group)return false;
      // New memberships may advance the publication, but a changed definition
      // is another user's edit, not permission to rebase this gesture.
      if(!baseline || baseline.revision!==group.revision)throw Object.assign(new Error('workflow_group_definition_changed'),{
        disposition:'not-applied',workflowOperation:{kind:'collapse',groupId,collapsed:!expanded,
          expectedGroupRevision:baseline?.revision,currentGroupRevision:group.revision,currentRevision:publication.revision,
          stage:'workflow:groups-read',outcome:'not-applied'}});
      if(!!group.collapsed===!expanded)return true;
      pending={version:1,mutationId:mutationId(),expectedRevision:publication.revision,
        groupId,expectedGroupRevision:group.revision,collapsed:!expanded};
      return send(pending);
    });
    tail=operation.catch(()=>{});
    return operation;
  };
  async function send(request) {
    try {
      const result=await mutate(request);
      pending=null;
      return result === true || result?.success === true;
    } catch(error) {if(error?.disposition==='not-applied')pending=null;throw error;}
  }
}

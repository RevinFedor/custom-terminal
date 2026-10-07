/** Dwell and cancel share one lane: a cancel applies the requested baseline
 * after the preceding ACK, using the resulting publication/group revision. */
export function createWorkflowGroupExpansionQueue({read,mutate,mutationId=()=>crypto.randomUUID()}) {
  let tail=Promise.resolve();
  return (groupId,expanded) => {
    const operation=tail.then(async()=>{
      const publication=read(),group=publication?.groups.find(group=>group.id===groupId);
      if(!group)return false;
      if(!!group.collapsed===!expanded)return true;
      const result=await mutate({version:1,mutationId:mutationId(),expectedRevision:publication.revision,
        groupId,expectedGroupRevision:group.revision,collapsed:!expanded});
      return result === true || result?.success === true;
    });
    tail=operation.catch(()=>{});
    return operation;
  };
}

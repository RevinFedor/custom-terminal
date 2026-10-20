/** One captured Main admission; a closing menu/first removed tab is NOT a
 * cancellation of that accepted set. No owner proof is authored in renderer. */
export function createPaneSelectionRuntimePort({invoke,getState,makeId=()=>crypto.randomUUID()}) {
  const flights=new WeakMap();
  return {run(action,lease) {
    if(flights.has(lease))return flights.get(lease);
    const promise=(async()=>{
      if(!['close','stop'].includes(action)||!lease.isCurrent())throw Error('selection_capture_changed');
      const captured=lease.entries.map(({projectId,tabId})=>({projectId,tabId}));
      const mutationId=makeId();
      const exactResults=receipt=>Array.isArray(receipt?.results)&&receipt.results.length===captured.length
        &&receipt.results.every((row,index)=>row.tabId===captured[index].tabId&&row.namespace===captured[index].projectId);
      const admission=await invoke('workflow:selection-begin',{version:1,mutationId,action,
        origin:{workflowId:lease.workflowId,windowId:lease.windowId??null},members:captured});
      if(admission?.success!==true||admission.mutationId!==mutationId||admission.action!==action||!exactResults(admission))
        throw Error(admission?.error||'selection_admission_unconfirmed');
      // Parent terminals first, explicitly selected file families last. This
      // keeps Full's pre-existing attached-file cascade without closing twice.
      const targets=action==='close'?[...captured.filter(ref=>getState().openProjects.get(ref.projectId)?.tabs.get(ref.tabId)?.tabType!=='file'),
        ...captured.filter(ref=>getState().openProjects.get(ref.projectId)?.tabs.get(ref.tabId)?.tabType==='file')]:captured;
      for(const ref of targets) {
        const step=await invoke('workflow:selection-step',{mutationId,tabId:ref.tabId});
        if(step?.success!==true||step.completed&&(step.mutationId!==mutationId||step.tabId!==ref.tabId))
          throw Error(step?.error||'selection_step_unconfirmed');
        if(action==='close'&&!step.completed) {
          const guard=step.closeGuard;
          if(!guard||guard.mutationId!==mutationId||guard.tabId!==ref.tabId||!guard.guardToken)
            throw Error('selection_close_guard_unconfirmed');
          const closed=await getState().closeTab(ref.projectId,ref.tabId,{selectionCloseGuard:guard});
          if(closed!==true)throw Error('selection_close_not_confirmed');
        }
        const ack=await invoke('workflow:selection-ack',{mutationId,tabId:ref.tabId});
        if(ack?.success!==true||ack.completed!==true||ack.mutationId!==mutationId||ack.tabId!==ref.tabId)
          throw Error(ack?.error||'selection_receipt_unknown');
      }
      const receipt=await invoke('workflow:selection-receipt',{mutationId});
      if(receipt?.success!==true||receipt.completed!==true||receipt.mutationId!==mutationId||receipt.action!==action||!exactResults(receipt))
        throw Error(receipt?.error||'selection_batch_unconfirmed');
    })();
    flights.set(lease,promise);
    // A duplicate UI invocation shares its one accepted intent, including an
    // UNKNOWN result. It cannot manufacture a new mutation ID after rejection.
    return promise;
  }};
}

/** Exact own relation ACKs reconcile queued metadata echoes, never foreign gaps. */
export function createWorkflowRelationReceipts() {
  const receipts=new Map(),captures=new WeakMap();
  let sequence=0;
  const key=(namespace,row)=>JSON.stringify([namespace,row.tabId || row.id,row.executionSubject?.subjectId || null]);
  return {
    capture(namespace,rows) {
      for(const row of rows)captures.set(row,{address:key(namespace,row),sequence,revision:row.executionStorageRevision});
    },
    record(receipt) {
      if(receipt?.version!==1 || receipt.kind!=='visual-parent' || !receipt.mutationId || !receipt.namespace || !receipt.tabId)return;
      const address=key(receipt.namespace,{tabId:receipt.tabId,executionSubject:receipt.executionSubject});
      const list=receipts.get(address) || [];
      if(!list.some(item=>item.mutationId===receipt.mutationId))receipts.set(address,[...list,{...receipt,sequence:++sequence}]);
    },
    prepare(namespace,rows,acks) {
      for(const row of rows)for(const receipt of receipts.get(key(namespace,row)) || []) {
        const capture=captures.get(row);
        if(capture && (capture.address!==key(namespace,row) || receipt.sequence<=capture.sequence))continue;
        if((row.visualParentTabId || null)!==receipt.beforeParent)continue;
        const native=row.executionSubject?.version===2;
        // Legacy metadata has no CAS revision: only a snapshot captured before
        // this receipt can be an old echo. Future explicit parent edits win.
        if(!native && !capture)continue;
        if(native) {
          if(row.executionSubject.executionNamespace!==namespace || receipt.toRevision!==receipt.fromRevision+1)continue;
          const from=capture?.revision ?? row.executionStorageRevision;
          const exact=row.executionStorageRevision===receipt.fromRevision;
          const covered=from<=receipt.fromRevision && row.executionStorageRevision>=receipt.toRevision
            && acks?.covers(namespace,row,from,receipt.toRevision);
          if(!exact && !covered)continue;
          if(exact)row.executionStorageRevision=receipt.toRevision;
        }
        row.visualParentTabId=receipt.afterParent || undefined;
        row.closedVisualParentTabId=undefined;
      }
    },
  };
}

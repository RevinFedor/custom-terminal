// A renderer-owned ACK can outlive the Tab object that submitted its snapshot.
// Track only contiguous, exact writes; catalog reads/foreign revisions are not ACKs.
export function createExecutionRevisionAcks() {
  const ranges=new Map();
  const key=(namespace,tab)=>{
    const scope=tab?.executionSubject,id=tab?.tabId || tab?.id;
    return scope?.version===2 && scope.executionNamespace===namespace && scope.tabId===id && scope.subjectId
      ? JSON.stringify([namespace,id,scope.subjectId]) : null;
  };
  const revision=(namespace,tab)=>{
    const value=tab?.executionStorageRevision,range=ranges.get(key(namespace,tab));
    return range && Number.isSafeInteger(value) && value>=range.from && value<=range.to ? range.to : value;
  };
  const advance=(namespace,tab)=>{
    if(tab && key(namespace,tab))tab.executionStorageRevision=revision(namespace,tab);
  };
  const matchesPoint=(namespace,tab,receipt,cwd)=>!!key(namespace,tab) && receipt?.version===1 && receipt.kind==='cwd'
    && receipt.namespace===namespace && receipt.tabId===(tab?.tabId || tab?.id)
    && receipt.subjectId===tab?.executionSubject?.subjectId
    && key(namespace,{tabId:receipt.tabId,executionSubject:receipt.executionSubject})===key(namespace,tab)
    && receipt.executionSubject.cwd===cwd && Number.isSafeInteger(receipt.fromRevision)
    && Number.isSafeInteger(receipt.toRevision) && receipt.toRevision>=receipt.fromRevision
    && receipt.toRevision<=receipt.fromRevision+1;
  return {
    revision,advance,matchesPoint,
    covers(namespace,tab,from,to) {
      const range=ranges.get(key(namespace,tab));
      return !!range && Number.isSafeInteger(from) && Number.isSafeInteger(to)
        && range.from<=from && from<=to && to<=range.to;
    },
    relation(namespace,tab,receipt) {
      const address=key(namespace,tab);
      if(!address || receipt?.version!==1 || receipt.kind!=='visual-parent' || !receipt.mutationId
        || receipt.namespace!==namespace || receipt.tabId!==(tab.tabId || tab.id)
        || key(namespace,{tabId:receipt.tabId,executionSubject:receipt.executionSubject})!==address
        || receipt.subjectId!==tab.executionSubject.subjectId
        || receipt.executionSubject.cwd!==tab.executionSubject.cwd
        || !Number.isSafeInteger(receipt.fromRevision) || receipt.toRevision!==receipt.fromRevision+1
        || revision(namespace,tab)!==receipt.fromRevision)return false;
      const old=ranges.get(address);
      ranges.set(address,{from:old && old.to===receipt.fromRevision?old.from:receipt.fromRevision,to:receipt.toRevision});
      advance(namespace,tab);return true;
    },
    point(namespace,tab,receipt) {
      if(!matchesPoint(namespace,tab,receipt,receipt.executionSubject?.cwd) || revision(namespace,tab)!==receipt.fromRevision)return false;
      const address=key(namespace,tab),old=ranges.get(address);
      ranges.set(address,{from:old && old.to===receipt.fromRevision?old.from:receipt.fromRevision,to:receipt.toRevision});
      advance(namespace,tab);return true;
    },
    prepare(namespace,rows){for(const row of rows)advance(namespace,row);},
    ack(namespace,rows,result,targets=()=>[]) {
      if(result?.success!==true || !Array.isArray(result.executionRevisions)
        || result.projectId && result.projectId!==namespace
        || Array.isArray(result.projectIds) && !result.projectIds.includes(namespace))return;
      for(const row of rows) {
        const address=key(namespace,row),from=row.executionStorageRevision;
        if(!address || !Number.isSafeInteger(from))continue;
        const receipt=result.executionRevisions.find(entry=>entry.tabId===row.tabId && entry.subjectId===row.executionSubject.subjectId);
        const to=receipt?.revision;
        if(!Number.isSafeInteger(to) || (to!==from && to!==from+1))continue;
        const old=ranges.get(address);
        if(!old || to>old.to)ranges.set(address,{from:old && old.to===from ? old.from : from,to});
        for(const tab of targets(row.tabId) || [])advance(namespace,tab);
      }
    },
    canHydrate(namespace,current,saved,pending) {
      if(!key(namespace,saved))return true;
      if(pending || key(namespace,current)!==key(namespace,saved))return false;
      return Number.isSafeInteger(saved.executionStorageRevision)
        && saved.executionStorageRevision>=revision(namespace,current);
    },
  };
}

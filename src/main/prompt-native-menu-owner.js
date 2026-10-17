'use strict';

// Ephemeral native UI request ownership. This is not catalog/runtime authority.
const currentBySender = new WeakMap();
function beginPromptNativeMenu({sender,window,readTarget,readLifetime=()=>null}) {
  currentBySender.get(sender)?.close();
  let captured=null,lifetime=null;
  try {captured=readTarget();lifetime=readLifetime();} catch {}
  const removers=[];
  let closed=false,shown=false;
  const listen=(owner,name,callback)=>{
    owner?.on?.(name,callback);
    removers.push(()=>owner?.removeListener?.(name,callback));
  };
  const lease={
    isCurrent() {
      if(closed || currentBySender.get(sender)!==lease || sender.isDestroyed()
        || !window || window.isDestroyed())return false;
      try {
        const now=readLifetime();
        return captured!==null && readTarget()===captured && (lifetime===null || now
          && now.generation===lifetime.generation && now.terminal===lifetime.terminal && now.sdk===lifetime.sdk);
      } catch {return false;}
    },
    popup(menu,options) {
      if(!lease.isCurrent()){lease.close();return false;}
      shown=true;
      menu.popup({...options,callback:()=>lease.close()});
      return true;
    },
    close() {
      if(closed)return;
      closed=true;
      for(const remove of removers)remove();
      if(currentBySender.get(sender)===lease)currentBySender.delete(sender);
    },
  };
  currentBySender.set(sender,lease);
  listen(sender,'destroyed',()=>lease.close());
  listen(sender,'did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame!==false)lease.close();});
  listen(window,'closed',()=>lease.close());
  listen(window,'blur',()=>lease.close());
  // Before popup the user may already have returned to typing or pressed Esc.
  // Once the native menu is shown it owns its normal keyboard navigation.
  listen(sender,'before-input-event',(_event,input)=>{if(!shown && input?.type==='keyDown')lease.close();});
  return lease;
}

function promptNativeTargetStamp(execution,tabId,projectId) {
  const row=execution?.row,scope=execution?.scope;
  if(!row || row.execution_archived===1)return null;
  const namespace=scope?.version===2?scope.executionNamespace:scope?.projectId;
  if(projectId && namespace!==projectId)return null;
  return JSON.stringify([tabId,namespace,row.id,scope?.subjectId || row.execution_subject_id || null]);
}

function promptNativeCatalogFailure(error,label) {
  return {status:['prompt_catalog_preparing','prompt_catalog_changed'].includes(error?.code)?'preparing':'failed',
    label,code:error?.code || 'prompt_catalog_unavailable'};
}

module.exports={beginPromptNativeMenu,promptNativeTargetStamp,promptNativeCatalogFailure};

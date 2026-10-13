import {useWorkspaceStore} from '../store/useWorkspaceStore';
import {useUIStore} from '../store/useUIStore';
import {findOpenTabOwner} from './tabLinkNavigation.mjs';
import {tabNavigationLocation} from './tabNavigationLocation.mjs';

const path=window.require('path');
const creations=new Map<string,Promise<string>>();
let request=0;
export type TabWindowAction='beside'|'replace-shown';

/** A disk document gets a file tab through existing creation, without linking
 * it to an arbitrary AI or starting a PTY. Concurrent clicks share creation. */
export async function openFilePathTab(filePath:string,windowAction?:TabWindowAction) {
  const mine=++request,state=useWorkspaceStore.getState(),workflowId=state.activeSpaceId;
  const location=tabNavigationLocation(state),revision=state.navigationRevision,display=state.windowDisplayKey;
  const normalized=path.resolve(filePath),key=workflowId+'\0'+normalized;
  const current=()=>mine===request && useWorkspaceStore.getState().navigationRevision===revision
    && useWorkspaceStore.getState().windowDisplayKey===display
    && tabNavigationLocation(useWorkspaceStore.getState())===location;
  const find=()=>{
    const s=useWorkspaceStore.getState();
    const all=[...s.openProjects.values()].flatMap(w=>[...w.tabs.values()]).filter(tab=>
      tab.tabType==='file' && tab.filePath && path.resolve(tab.filePath)===normalized
      && s.tabCatalog[tab.id]?.active!==false);
    const local=all.filter(tab=>!s.organizationReady
      || (s.pendingTabWorkflowMembership[tab.id] || s.tabWorkflowMembership[tab.id])?.workflowId===workflowId);
    const matches=local.length?local:all;
    // Multiple owners may intentionally link the same path. Prefer a standalone
    // document; only an unambiguous existing link can supply its exact identity.
    return matches.find(tab=>!tab.visualParentTabId)?.id || (matches.length===1?matches[0].id:null);
  };
  try {
    let id=find();
    if (!id) {
      let creating=creations.get(key);
      if (!creating) {
        creating=(async()=>{
          const exists=await window.require('electron').ipcRenderer.invoke('file:exists-batch',[normalized]);
          if (exists?.[normalized]!==true) throw new Error('Файл не найден');
          const found=find();if(found)return found;
          const store=useWorkspaceStore.getState();
          const tabOptions={tabType:'file' as const,filePath:normalized,color:'purple' as const,
            background:true,nameSetManually:true,skipInitialRename:true};
          return store.organizationReady
            ? store.createWorkflowTab({workflowId,name:path.basename(normalized),cwd:path.dirname(normalized),tabOptions})
            : state.activeProjectId ? store.createTab(state.activeProjectId,path.basename(normalized),path.dirname(normalized),tabOptions) : '';
        })();
        creations.set(key,creating);
        void creating.finally(()=>{if(creations.get(key)===creating)creations.delete(key);}).catch(()=>{});
      }
      id=await creating;
    }
    if (!id || !current()) return false;
    const owner=findOpenTabOwner(useWorkspaceStore.getState(),id);
    if (!owner || owner.tab.filePath!==normalized) return false;
    if (useUIStore.getState().filePreview?.source==='sidebar') {
      useUIStore.getState().closeFilePreview();
      if (state.activeProjectId) useWorkspaceStore.getState().setOpenFilePath(state.activeProjectId,null);
    }
    const opened=await useWorkspaceStore.getState().openTabById(id,{reason:'file-sidebar',windowAction});
    if (!opened) return false;
    console.log('[FileTab:open] source=sidebar tab='+id+' mode='+(windowAction || 'append'));
    return true;
  } catch(error) {
    console.warn('[FileTab:open] failed',error);
    if (current()) useUIStore.getState().showToast(error instanceof Error?error.message:'Не удалось открыть файл','warning');
    return false;
  }
}

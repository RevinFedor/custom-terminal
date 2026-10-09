import {useWorkspaceStore} from '../store/useWorkspaceStore';

export function captureLinkedFileAction(projectId:string,tabId:string) {
  const state=useWorkspaceStore.getState(),tab=state.openProjects.get(projectId)?.tabs.get(tabId);
  if(tab?.tabType!=='file' || !tab.filePath)return null;
  const catalog=state.tabCatalog?.[tabId];
  return Object.freeze({projectId,tabId,path:tab.filePath,parent:tab.visualParentTabId || null,
    storageId:catalog?.storageId ?? null,subjectId:catalog?.executionSubject?.subjectId ?? null});
}
export function linkedFileActionCurrent(target:ReturnType<typeof captureLinkedFileAction>) {
  return !!target && JSON.stringify(captureLinkedFileAction(target.projectId,target.tabId))===JSON.stringify(target);
}

const deleting=new Set<string>();
export async function unlinkLinkedFile(target:ReturnType<typeof captureLinkedFileAction>) {
  if(!target || !linkedFileActionCurrent(target))return {ok:false,error:'Файл или его связь изменились'};
  const key=`${target.projectId}\0${target.tabId}`;
  if(deleting.has(key))return {ok:false,error:'Удаление уже выполняется'};
  deleting.add(key);
  try {
    const closed=await useWorkspaceStore.getState().closeTab(target.projectId,target.tabId,{skipProcessCheck:true,archive:false});
    return closed ? {ok:true}:{ok:false,error:'Удаление связи не подтверждено'};
  } catch(error) {return {ok:false,error:error instanceof Error?error.message:String(error)};}
  finally {deleting.delete(key);}
}
/** Same Trash ingress as the file explorer. A disk failure cannot unlink the
 * row, and a replaced/reparented link cannot inherit an old menu's authority. */
export async function deleteLinkedFile(target:ReturnType<typeof captureLinkedFileAction>) {
  if(!target || !linkedFileActionCurrent(target))return {ok:false,error:'Файл или его связь изменились'};
  const key=`${target.projectId}\0${target.tabId}`;
  if(deleting.has(key))return {ok:false,error:'Удаление уже выполняется'};
  deleting.add(key);
  try {
    const deleted=await window.require('electron').ipcRenderer.invoke('file:delete',target.path);
    if(deleted!==true)return {ok:false,error:'Не удалось переместить файл в корзину. Связь сохранена'};
    if(!linkedFileActionCurrent(target))return {ok:false,error:'Файл в корзине; изменившаяся связь оставлена без изменений'};
    const closed=await useWorkspaceStore.getState().closeTab(target.projectId,target.tabId,{skipProcessCheck:true,archive:false});
    return closed ? {ok:true}:{ok:false,error:'Файл в корзине; удаление связи не подтверждено'};
  } catch(error) {return {ok:false,error:error instanceof Error?error.message:String(error)};}
  finally {deleting.delete(key);}
}

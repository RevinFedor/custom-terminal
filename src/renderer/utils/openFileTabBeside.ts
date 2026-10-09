import {useWorkspaceStore} from '../store/useWorkspaceStore';
import {useUIStore} from '../store/useUIStore';
import {captureLinkedFileAction,linkedFileActionCurrent} from './linkedFileActions';
import {collectTabLinkedFileTree,linkedFileOwner} from './tabLinkedFiles.mjs';
import {resolveTabLinkNavigation} from './tabLinkNavigation.mjs';
import {isBareEmptyPane,paneDetachedTabs,paneHoldsTab} from './splitPanesModel.mjs';
import {dismissTabLinkedFile} from './tabLinkedFilePreview';
import type {LinkedFile} from '../components/Workspace/TabLinkedFiles';

/** Explicit file placement. Existing placements reveal through Root; a file
 * without a window opens to the right. The canonical link and bytes survive.
 * Placement happens before awaiting its save, so a late ACK cannot choose a
 * different focused pane or take focus back from subsequent navigation. */
export async function openFileTabBeside(projectId:string,tabId:string,expected?:LinkedFile) {
  const state=useWorkspaceStore.getState(),target=captureLinkedFileAction(projectId,tabId);
  const owner=linkedFileOwner(state.openProjects,tabId);
  const fail=(error:string)=>{console.warn('[FileTab:middle] rejected tab='+tabId+' reason='+error);
    useUIStore.getState().showToast(error,'warning');return false;};
  if(!target || state.tabCatalog?.[tabId]?.active===false)return fail('Файл больше не доступен');
  if(expected && (target.path!==expected.path || target.parent!==(expected.parentTabId || null)
    || owner?.tabId!==expected.ownerTabId || !collectTabLinkedFileTree(state.openProjects,expected.ownerTabId)
      .some((file:LinkedFile)=>file.id===tabId && file.projectId===projectId && file.path===expected.path)))
    return fail('Файл или его связь изменились');
  const place=resolveTabLinkNavigation(state,tabId);
  if(!place)return fail('Окно файла не найдено');
  if(!linkedFileActionCurrent(target))return false;
  if(place.kind!=='append') {
    const navigation=state.openTabById(tabId,{reason:'file-middle-reveal'});
    if(owner) dismissTabLinkedFile(owner.tabId);
    const opened=await navigation;
    console.log('[FileTab:middle] action=reveal tab='+tabId+' accepted='+opened);
    return opened;
  }
  const layout=place.spaceId===state.activeSpaceId?state:state.spaces.find(space=>space.id===place.spaceId)?.layout;
  const panes=layout?.splitPanes || [];
  const anchor=expected?panes.findIndex(pane=>paneHoldsTab(pane,expected.ownerTabId)):(layout?.splitFocusedIndex ?? 0);
  const vacancies=panes.flatMap((pane,index)=>isBareEmptyPane(pane)?[{pane,index}]:[]);
  // Closing a chip intentionally keeps its window. Reuse that window first,
  // then another vacant slot; do not accumulate empty columns on reopen.
  const vacant=vacancies.find(({pane})=>paneDetachedTabs(pane).some(entry=>entry.tabId===tabId))
    || vacancies.find(({pane,index})=>!pane.displayHidden && index>anchor)
    || vacancies.find(({pane})=>!pane.displayHidden) || vacancies[0];
  const hiddenVacancy=vacant?.pane.displayHidden===true;
  const anchorWindowId=panes[anchor]?.displayHidden===false || panes[anchor] && !panes[anchor].displayHidden
    ? panes[anchor].windowId:panes.find(pane=>!pane.displayHidden)?.windowId;
  if(hiddenVacancy && (!anchorWindowId || !vacant?.pane.windowId || place.spaceId!==state.activeSpaceId))
    return fail('Не удалось определить окно рядом');
  const result=state.commitWorkspaceWindowAction({sourceTabId:expected?.ownerTabId,
    target:{spaceId:place.spaceId,anchor:expected?'source':'focused',
      ...(expected?{anchorTabId:expected.ownerTabId}:{}),mode:vacant?'same-window':'new-window',side:'right',
      ...(vacant?{windowIndex:vacant.index}:{})},
    entries:[{projectId,tabId}],show:!hiddenVacancy,focus:!hiddenVacancy,reveal:!hiddenVacancy});
  if(result.ok!==true)return fail(result.reason==='window_capacity_reached'
    ? 'Нет места для окна справа' : 'Не удалось открыть файл сбоку');
  // A display profile can park the vacated file window. Bring that exact
  // window alongside the captured anchor without swapping the owner out.
  if(hiddenVacancy && !useWorkspaceStore.getState().showHiddenWindowAlongside(
    place.spaceId,anchorWindowId!,vacant!.pane.windowId!,'right'))return fail('Не удалось раскрыть окно файла рядом');
  if(owner) dismissTabLinkedFile(owner.tabId);
  useUIStore.getState().setActiveArea('workspace');
  console.log('[FileTab:middle] action=beside tab='+tabId+' space='+result.spaceId+' pane='+result.paneIndex);
  try { await useWorkspaceStore.getState().commitOrganization();
    console.log('[FileTab:middle] saved tab='+tabId+' space='+result.spaceId);return true; }
  catch(error) {console.warn('[FileTab:middle] save failed tab='+tabId,error);return fail('Сохранение окна не подтверждено');}
}

import React, {useState,useRef} from 'react';
import {useShallow} from 'zustand/react/shallow';
import WorkflowTabSidebar from './WorkflowTabSidebar';
import WorkflowGroupMenu from './WorkflowGroupMenu';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import {openTabLinkedFile} from '../../utils/tabLinkedFilePreview';
import {linkedFileOwner,collectTabLinkedFileTree} from '../../utils/tabLinkedFiles.mjs';
import {workflowDragRequest} from '../../utils/workflowDragModel.mjs';
import {workflowTabCatalog,workflowPlacedTabIds} from '../../utils/workflowReserve.mjs';
import {workflowGlobalGroupMembers} from '../../utils/workflowGlobalGroups.mjs';
import {captureSpaceLayout} from '../../utils/workspaceSpacesModel.mjs';
import {removeLayoutTabs} from '../../../shared/workflow-organization.cjs';
import {isExactGroupCloseGuard} from '../../utils/workflowOrganizationClient.mjs';
import type {SharedTabActivityMaps} from './TabSignals';
import {TabLocationLine} from './TabLocationLine';
import {paneChooserSlots} from '../../utils/splitPanesModel.mjs';

const {ipcRenderer} = window.require('electron');

export default function ConnectedWorkflowSidebar({activity}:{activity:SharedTabActivityMaps}) {
  const state = useWorkspaceStore(useShallow(state => ({openProjects:state.openProjects,spaces:state.spaces,
    activeSpaceId:state.activeSpaceId,splitPanes:state.splitPanes,splitFocusedIndex:state.splitFocusedIndex,
    centerStrips:state.centerStrips,activeSpaceTab:state.activeSpaceTab,windowDisplayLayouts:state.windowDisplayLayouts,
    tabWorkflowMembership:state.tabWorkflowMembership,pendingTabWorkflowMembership:state.pendingTabWorkflowMembership,
    tabCatalog:state.tabCatalog,globalGroups:state.globalGroups,
    workflowSidebarState:state.workflowSidebarState,activeProjectId:state.activeProjectId})));
  const [menu,setMenu] = useState<{id:string;x:number;y:number}|null>(null);
  const placed = workflowPlacedTabIds(state),presentedCatalog = {...state.tabCatalog};
  const represented = new Set<string>(placed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const owner of workflowTabCatalog(state).values()) {
      const parent = owner.tab.parentTabId || (owner.tab.tabType === 'file' && owner.tab.visualParentTabId);
      if (parent && represented.has(parent) && !represented.has(owner.tabId)) {
        represented.add(owner.tabId);presentedCatalog[owner.tabId] = {...presentedCatalog[owner.tabId],active:false};changed = true;
      }
    }
  }
  const presentation = {...state,tabCatalog:presentedCatalog,
    tabWorkflowMembership:{...state.tabWorkflowMembership,...state.pendingTabWorkflowMembership}};
  const current = state.spaces.find(space => space.id === state.activeSpaceId) as any;
  const view = state.workflowSidebarState[state.activeSpaceId] || {selectedTabIds:[],scrollTop:0};
  const [editingGroupId,setEditingGroupId] = useState<string|null>(null);
  const groupCloseRequests=useRef(new Map<string,()=>Promise<any>>());
  const groupCloseInFlight=useRef(new Map<string,Promise<boolean>>());
  const setView = (patch:any,workflowId=state.activeSpaceId) => {
    const store = useWorkspaceStore.getState();
    useWorkspaceStore.setState({workflowSidebarState:{...store.workflowSidebarState,
      [workflowId]:{...(store.workflowSidebarState[workflowId] || {}),...patch}}});
    store.saveSession();
  };
  const setSelection = (ids:string[]) => {
    const store = useWorkspaceStore.getState();
    for (const workspace of store.openProjects.values()) workspace.selectedTabIds = ids.filter(id => workspace.tabs.has(id));
    setView({selectedTabIds:ids,activeGroupId:null});
  };
  const group = menu && state.globalGroups?.groups.find((group:any) => group.id === menu.id);
  const members = group ? workflowGlobalGroupMembers(state.globalGroups,group.id,workflowTabCatalog(state)).map((owner:any) => ({...owner,
    namespace:owner.projectId,workflowId:state.tabWorkflowMembership[owner.tabId]?.workflowId,
    expectedMembershipRevision:state.tabWorkflowMembership[owner.tabId]?.revision,
    executionSubject:state.tabCatalog[owner.tabId]?.executionSubject,
    expectedExecutionStorageRevision:owner.tab.executionStorageRevision})) : [];
  const commitOutline = ({payload,workflowId}:any) => useWorkspaceStore.getState().commitWorkflowDrag(
    workflowDragRequest(payload.sourceContext,{workflowId,previewOutline:payload.previewOutline}),{isCurrent:payload.isCurrent});
  const closeGroupMembers = async (selected:any[],group:any,intent:any) => {
        const begun = await ipcRenderer.invoke('workflow:group-action',{kind:'close',groupId:group.id,members:selected,intent});
        if (begun?.success !== true) return begun || {success:false,error:'Закрытие группы не подтверждено'};
        if (begun.completed) return begun;
        // Owner close archives its typed file family. Visiting those files
        // afterwards lets Main return completed from the durable manifest.
        const order = [...selected].sort((left:any,right:any) => Number(left.tab?.tabType === 'file') - Number(right.tab?.tabType === 'file'));
        for (const member of order) {
          const namespace = (member.projectId || member.namespace)!;
          const checked = await ipcRenderer.invoke('workflow:group-close-step',{mutationId:intent.mutationId,tabId:member.tabId});
          if (checked?.success !== true) return checked || {success:false,error:'Нет подтверждения шага закрытия'};
          if (checked.completed) continue;
          if (!isExactGroupCloseGuard(checked.closeGuard,member.tabId,intent.mutationId))
            return {success:false,error:'Не подтверждена защита закрытия вкладки'};
          const closed = await useWorkspaceStore.getState().closeTab(namespace,member.tabId,{groupCloseGuard:checked.closeGuard});
          if (!closed) return {success:false,error:'Закрытие вкладки не подтверждено'};
          if (useWorkspaceStore.getState().openProjects.get(namespace)?.tabs.has(member.tabId)) return {success:false,error:'Вкладка осталась открыта'};
          const ack = await ipcRenderer.invoke('workflow:group-close-ack',{mutationId:intent.mutationId,tabId:member.tabId});
          if (!ack?.success && !ack?.completed) return ack || {success:false,error:'Нет подтверждения закрытия'};
        }
        return {success:true};
  };
  const pane=state.splitPanes[state.splitFocusedIndex];
  const chooser=!pane?.tabId && pane?.selectedSlotId?paneChooserSlots(pane).find((slot:any)=>slot.slotId===pane.selectedSlotId):null;
  const sourceTabId = chooser?undefined:pane?.tabId || state.activeSpaceTab?.tabId || state.openProjects.get(state.activeProjectId || '')?.activeTabId || undefined;
  const sourceOwner=sourceTabId?workflowTabCatalog(state).get(sourceTabId):null;
  return <div style={{display:'contents'}}>
    <WorkflowTabSidebar state={presentation} sharedActivity={activity} orderedTabIds={current?.reserveOrder || []}
      selectedTabIds={view.selectedTabIds || []} onSelectionChange={setSelection}
      activeGroupId={view.activeGroupId || null} onGroupFocus={id=>setView({activeGroupId:id})}
      editingGroupId={editingGroupId} onGroupRenameEnd={()=>setEditingGroupId(null)}
      onGroupRename={async(id,name)=>{
        const store=useWorkspaceStore.getState(),publication=store.globalGroups,group=publication.groups.find((g:any)=>g.id===id);
        if(!group)return false;
        const result=await store.mutateWorkflowGroup('rename',{version:1,mutationId:crypto.randomUUID(),groupId:id,name,
          expectedRevision:publication.revision,expectedGroupRevision:group.revision});
        return result?.success===true;
      }}
      onGroupClose={async id=>{
        const previous=groupCloseInFlight.current.get(id);if(previous)return previous;
        let run=groupCloseRequests.current.get(id);
        if(!run) {
          const store=useWorkspaceStore.getState(),publication=store.globalGroups,group=publication.groups.find((g:any)=>g.id===id);
          if(!group)return false;
          const members=workflowGlobalGroupMembers(publication,id,workflowTabCatalog(store)).map((owner:any)=>({...owner,
            namespace:owner.projectId,workflowId:store.tabWorkflowMembership[owner.tabId]?.workflowId,
            expectedMembershipRevision:store.tabWorkflowMembership[owner.tabId]?.revision,
            executionSubject:store.tabCatalog[owner.tabId]?.executionSubject,expectedExecutionStorageRevision:owner.tab.executionStorageRevision}));
          const intent={version:1,mutationId:crypto.randomUUID(),expectedRevision:publication.revision,expectedGroupRevision:group.revision};
          const deletion={...intent,mutationId:intent.mutationId+':remove-group',groupId:id};
          run=async()=>{
            if(members.length) {const closed=await closeGroupMembers(members,group,intent);if(closed?.success!==true)return closed;}
            return useWorkspaceStore.getState().mutateWorkflowGroup('delete',deletion);
          };
          groupCloseRequests.current.set(id,run);
        }
        const operation=(async()=>{try {
          const result=await run();
          if(result?.success===true) {groupCloseRequests.current.delete(id);return true;}
          useUIStore.getState().showToast(result?.error || 'Закрытие группы не подтверждено','warning');return false;
        } catch(error:any) {useUIStore.getState().showToast(error?.message || 'Закрытие группы не подтверждено','warning');return false;}
        finally{groupCloseInFlight.current.delete(id);}})();
        groupCloseInFlight.current.set(id,operation);return operation;
      }}
      sourceTabId={sourceTabId} scrollTop={view.scrollTop || 0}
      location={chooser?<TabLocationLine cwd={chooser.cwd || ''} onSelectDirectory={async()=>{
        const selected=await ipcRenderer.invoke('app:select-directory',{defaultPath:chooser.cwd,buttonLabel:'Выбрать'});
        if(selected)useWorkspaceStore.getState().setWindowTabChooserDirectory(chooser.slotId,selected);
      }}/>:sourceOwner?<TabLocationLine projectId={sourceOwner.projectId} tabId={sourceOwner.tabId}/>:null}
      onScrollOffsetChange={(_id,top) => setView({scrollTop:top})}
      onOpenTab={async (_namespace,id) => {
        const store=useWorkspaceStore.getState();
        const tab=store.openProjects.get(_namespace)?.tabs.get(id);
        const owner=tab?.tabType==='file' ? linkedFileOwner(store.openProjects,id):null;
        if(owner) {
          const file=collectTabLinkedFileTree(store.openProjects,owner.tabId).find(file=>file.id===id);
          if(!file)return false;
          return openTabLinkedFile(owner.projectId,file,()=>useWorkspaceStore.getState().openTabById(owner.tabId,{reason:'linked-file'}));
        }
        return store.openTabById(id,{reason:'workflow-reserve'});
      }}
      onOpenFile={(namespace,file) => void openTabLinkedFile(namespace,file,() => useWorkspaceStore.getState().openTabById(file.ownerTabId,{reason:'linked-file'}))}
      onCreateTab={async request => {
        const store = useWorkspaceStore.getState();
        const id = await store.createWorkflowTab({...request,tabOptions:{background:true,skipInitialRename:true,groupId:view.activeGroupId || undefined,
          ...(request.action && request.action!=='terminal'?{color:request.action,pendingAction:{type:request.action==='codex'?'codex-new':'claude-new'}}:{})}});
        if (!id) throw new Error('Не удалось создать вкладку');
        await store.commitOrganization();
        if(request.windowId){
          const current=useWorkspaceStore.getState(),index=current.splitPanes.findIndex(pane=>pane.windowId===request.windowId && !pane.displayHidden);
          const owner=workflowTabCatalog(current).get(id);
          if(current.activeSpaceId===request.workflowId && index>=0 && owner)current.addTabToSplitPaneStrip(index,owner.projectId,id);
        }
        return id;
      }}
      onCreateGroup={async workflowId => {
        const store = useWorkspaceStore.getState();
        const result=await store.mutateWorkflowGroup('create',{version:1,mutationId:crypto.randomUUID(),expectedRevision:store.globalGroups.revision,
          metadata:{name:'Новая группа',reserveWorkflowId:workflowId}});
        if(result?.success!==true || !result.groupId)throw new Error('Группа не создана');
        setView({activeGroupId:result.groupId},workflowId);setEditingGroupId(result.groupId);
      }}
      onGroupContextMenu={(_namespace,id,x,y) => setMenu({id,x,y})}
      onCommitOutline={commitOutline}
      onPlaceTabs={(entries,target,admission,options) => {
        if(!admission || JSON.stringify(entries)!==JSON.stringify(admission.paneEntries))return false;
        return useWorkspaceStore.getState().commitWorkflowDrag(workflowDragRequest(admission,{
          workflowId:target.spaceId || state.activeSpaceId,target}),options);
      }} />
    {group && menu && <WorkflowGroupMenu key={group.id} group={group} revision={state.globalGroups.revision}
      position={menu} members={members} workflows={state.spaces.map(space => ({id:space.id,name:space.name}))}
      statuses={useUIStore.getState().sessionStatuses} onDismiss={() => setMenu(null)}
      onRenameInline={()=>setEditingGroupId(group.id)}
      onMutate={(kind,request) => useWorkspaceStore.getState().mutateWorkflowGroup(kind,request)}
      onMoveMembers={async (workflowId,selected,group,intent) => {
        await useWorkspaceStore.getState().commitOrganization();
        const result = await ipcRenderer.invoke('workflow:group-action',{kind:'move',groupId:group.id,workflowId,
          members:selected,intent});
        if (!result?.success && !result?.completed) return result || {success:false,error:'Перенос группы не подтверждён'};
        await useWorkspaceStore.getState().refreshOrganizationCatalog();
        const store = useWorkspaceStore.getState(),family = new Set(selected.map(member => member.tabId));
        let added = true;
        while (added) {
          added = false;
          for (const workspace of store.openProjects.values()) for (const tab of workspace.tabs.values())
            if (!family.has(tab.id) && (family.has((tab as any).parentTabId || '') || tab.tabType === 'file' && family.has(tab.visualParentTabId || ''))) {
              family.add(tab.id);added = true;
            }
        }
        const ids = [...family];
        const spaces = store.spaces.map(space => ({...space,layout:removeLayoutTabs(
          space.id === store.activeSpaceId ? captureSpaceLayout(store) : space.layout,ids)}));
        useWorkspaceStore.setState({spaces,...spaces.find(space => space.id === store.activeSpaceId)!.layout});
        await store.commitOrganization();store.saveSession();
        return result;
      }}
      onCloseMembers={closeGroupMembers} />}
  </div>;
}

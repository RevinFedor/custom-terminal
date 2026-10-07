import React, {useState,useLayoutEffect,useRef} from 'react';
import {createPortal} from 'react-dom';
import {useShallow} from 'zustand/react/shallow';
import WorkflowTabSidebar from './WorkflowTabSidebar';
import WorkflowGroupMenu from './WorkflowGroupMenu';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import {openTabLinkedFile} from '../../utils/tabLinkedFilePreview';
import {commitPaneTabDrop} from '../../utils/paneTabDropCommit';
import {workflowTabCatalog,workflowPlacedTabIds} from '../../utils/workflowReserve.mjs';
import {workflowGlobalGroupMembers} from '../../utils/workflowGlobalGroups.mjs';
import {captureSpaceLayout} from '../../utils/workspaceSpacesModel.mjs';
import {removeLayoutTabs} from '../../../shared/workflow-organization.cjs';
import {isExactGroupCloseGuard} from '../../utils/workflowOrganizationClient.mjs';
import type {SharedTabActivityMaps} from './TabSignals';

const {ipcRenderer} = window.require('electron');

export default function ConnectedWorkflowSidebar({activity}:{activity:SharedTabActivityMaps}) {
  const state = useWorkspaceStore(useShallow(state => ({openProjects:state.openProjects,spaces:state.spaces,
    activeSpaceId:state.activeSpaceId,splitPanes:state.splitPanes,splitFocusedIndex:state.splitFocusedIndex,
    centerStrips:state.centerStrips,activeSpaceTab:state.activeSpaceTab,windowDisplayLayouts:state.windowDisplayLayouts,
    tabWorkflowMembership:state.tabWorkflowMembership,pendingTabWorkflowMembership:state.pendingTabWorkflowMembership,
    tabCatalog:state.tabCatalog,globalGroups:state.globalGroups,
    workflowSidebarState:state.workflowSidebarState,activeProjectId:state.activeProjectId})));
  const [menu,setMenu] = useState<{id:string;x:number;y:number}|null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [emptyGroupHost,setEmptyGroupHost] = useState<Element|null>(null);
  useLayoutEffect(() => {setEmptyGroupHost(root.current?.querySelector('.workflow-reserve-outline') || null);},[]);
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
  const emptyGroups = (state.globalGroups?.groups || []).filter((group:any) => group.reserveWorkflowId === state.activeSpaceId
    && !Object.values(state.globalGroups.tabGroups || {}).includes(group.id));
  const current = state.spaces.find(space => space.id === state.activeSpaceId) as any;
  const view = state.workflowSidebarState[state.activeSpaceId] || {selectedTabIds:[],scrollTop:0};
  const setView = (patch:any) => {
    const store = useWorkspaceStore.getState();
    useWorkspaceStore.setState({workflowSidebarState:{...store.workflowSidebarState,
      [store.activeSpaceId]:{...(store.workflowSidebarState[store.activeSpaceId] || {}),...patch}}});
    store.saveSession();
  };
  const setSelection = (ids:string[]) => {
    const store = useWorkspaceStore.getState();
    for (const workspace of store.openProjects.values()) workspace.selectedTabIds = ids.filter(id => workspace.tabs.has(id));
    setView({selectedTabIds:ids});
  };
  const group = menu && state.globalGroups?.groups.find((group:any) => group.id === menu.id);
  const members = group ? workflowGlobalGroupMembers(state.globalGroups,group.id,workflowTabCatalog(state)).map((owner:any) => ({...owner,
    namespace:owner.projectId,workflowId:state.tabWorkflowMembership[owner.tabId]?.workflowId,
    expectedMembershipRevision:state.tabWorkflowMembership[owner.tabId]?.revision,
    executionSubject:state.tabCatalog[owner.tabId]?.executionSubject,
    expectedExecutionStorageRevision:owner.tab.executionStorageRevision})) : [];
  const assign = async (ids:string[],groupId:string|null) => {
    const store = useWorkspaceStore.getState(),groups = store.globalGroups;
    if (!ids.length) return;
    await store.mutateWorkflowGroup('assign',{version:1,mutationId:crypto.randomUUID(),expectedRevision:groups.revision,
      groupId,tabIds:ids,expectedTabGroups:Object.fromEntries(ids.map(id => [id,groups.tabGroups[id] || null]))});
  };
  const updateOrder = (ids:string[],workflowId:string) => {
    const store = useWorkspaceStore.getState();
    const space = store.spaces.find(space => space.id === workflowId) as any;
    if (!space) return;
    const subset = new Set(ids),old = (space.reserveOrder || []) as string[];
    let at = 0;
    const order = old.map(id => subset.has(id) ? ids[at++] : id);
    order.push(...ids.slice(at));
    useWorkspaceStore.setState({spaces:store.spaces.map(space => space.id === workflowId ? {...space,reserveOrder:order} : space)});
  };
  const detach = async (request:any) => {
    const store = useWorkspaceStore.getState();
    const ids = request.entries.map((entry:any) => entry.tabId);
    for (const id of ids) if (request.expectedMembership[id]?.revision !== store.tabWorkflowMembership[id]?.revision) return false;
    if (!(await store.moveTabsToWorkflow(ids,request.workflowId))) return false;
    if (request.group) await assign(ids,request.group.groupId);
    const old = (useWorkspaceStore.getState().spaces.find(space => space.id === request.workflowId) as any)?.reserveOrder || [];
    const rest = old.filter((id:string) => !ids.includes(id));
    const at = request.beforeTabId ? Math.max(0,rest.indexOf(request.beforeTabId)) : rest.length;
    rest.splice(at,0,...ids); updateOrder(rest,request.workflowId);
    await store.commitOrganization(); store.saveSession(); return true;
  };
  const commitOutline = async ({payload,workflowId,expectedMembership}:any) => {
    const ids:string[] = [],assignments = new Map<string|null,string[]>(),parents = new Map<string,string|undefined>();
    const walk = (nodes:any[],groupId:string|null=null,parentId?:string) => {
      for (const node of nodes) {
        if (node.tabId) {
          ids.push(node.tabId);parents.set(node.tabId,parentId || node.contextParent?.tabId);
          assignments.set(groupId,[...(assignments.get(groupId) || []),node.tabId]);
        }
        walk(node.children || [],node.groupId || groupId,node.tabId || parentId);
      }
    };
    walk(payload.previewOutline);
    const store = useWorkspaceStore.getState();
    if (ids.some(id => expectedMembership[id]?.revision !== store.tabWorkflowMembership[id]?.revision)) return false;
    for (const [groupId,tabIds] of assignments) {
      const changed = tabIds.filter(id => (store.globalGroups.tabGroups[id] || null) !== groupId);
      await assign(changed,groupId);
    }
    for (const [id,parent] of parents) {
      const owner = workflowTabCatalog(useWorkspaceStore.getState()).get(id);
      if (owner && owner.tab.tabType !== 'file' && !owner.tab.parentTabId && owner.tab.visualParentTabId !== parent)
        store.setTabVisualParent(owner.projectId,id,parent);
    }
    updateOrder(ids,workflowId); await store.commitOrganization(); store.saveSession(); return true;
  };
  const sourceTabId = state.openProjects.get(state.activeProjectId || '')?.activeTabId || undefined;
  return <div ref={root} style={{display:'contents'}}>
    <WorkflowTabSidebar state={presentation} sharedActivity={activity} orderedTabIds={current?.reserveOrder || []}
      selectedTabIds={view.selectedTabIds || []} onSelectionChange={setSelection}
      sourceTabId={sourceTabId} scrollTop={view.scrollTop || 0}
      onScrollOffsetChange={(_id,top) => setView({scrollTop:top})}
      onOpenTab={(_namespace,id) => useWorkspaceStore.getState().openTabById(id,{reason:'workflow-reserve'})}
      onOpenFile={(namespace,file) => void openTabLinkedFile(namespace,file,() => useWorkspaceStore.getState().openTabById(file.ownerTabId,{reason:'linked-file'}))}
      onCreateTab={async request => {
        const store = useWorkspaceStore.getState();
        const id = await store.createWorkflowTab({...request,tabOptions:{background:true,skipInitialRename:true}});
        if (!id) throw new Error('Не удалось создать вкладку');
        await store.commitOrganization(); return id;
      }}
      onCreateGroup={async workflowId => {
        const store = useWorkspaceStore.getState();
        await store.mutateWorkflowGroup('create',{version:1,mutationId:crypto.randomUUID(),expectedRevision:store.globalGroups.revision,
          metadata:{name:'Новая группа',reserveWorkflowId:workflowId}});
      }}
      onGroupContextMenu={(_namespace,id,x,y) => setMenu({id,x,y})}
      onDetachTabs={detach} onCommitOutline={commitOutline}
      onPlaceTabs={async (entries,target,expected) => {
        const store = useWorkspaceStore.getState();
        if (entries.some(entry => expected[entry.tabId]?.revision !== store.tabWorkflowMembership[entry.tabId]?.revision)) return false;
        if (target.spaceId && target.spaceId !== store.activeSpaceId) store.switchWorkspaceSpace(target.spaceId);
        const result = commitPaneTabDrop({owner:'sidebar',entries,rootTabId:entries[0].tabId},target);
        if (!result) return false; await store.commitOrganization(); return true;
      }} />
    {emptyGroupHost && createPortal(emptyGroups.map((group:any) => <div key={group.id} className="workflow-reserve-row">
      <button className="workflow-reserve-group" data-reserve-group-id={group.id}
        data-execution-namespace="__tab_catalog_v2__"
        aria-label={`Группа ${group.name}`} style={{width:'100%',color:'inherit'}}
        onClick={event => {const rect = event.currentTarget.getBoundingClientRect();setMenu({id:group.id,x:rect.left,y:rect.bottom});}}
        onContextMenu={event => {event.preventDefault();setMenu({id:group.id,x:event.clientX,y:event.clientY});}}>
        <span>▾</span><span>{group.name}</span><small>0</small>
      </button>
    </div>),emptyGroupHost)}
    {group && menu && <WorkflowGroupMenu key={group.id} group={group} revision={state.globalGroups.revision}
      position={menu} members={members} workflows={state.spaces.map(space => ({id:space.id,name:space.name}))}
      statuses={useUIStore.getState().sessionStatuses} onDismiss={() => setMenu(null)}
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
            if (!family.has(tab.id) && (family.has(tab.parentTabId || '') || tab.tabType === 'file' && family.has(tab.visualParentTabId || ''))) {
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
      onCloseMembers={async (selected,group,intent) => {
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
      }} />}
  </div>;
}

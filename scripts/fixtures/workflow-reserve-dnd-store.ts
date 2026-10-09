import {create} from 'zustand';
import {emptySpaceLayout,captureSpaceLayout} from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import {applyDragLayout} from '../../src/shared/workflow-drag.cjs';
export const useWorkspaceStore=create<any>(()=>({}));
export const useUIStore=create<any>(()=>({tabSidebarWidth:260,tabsFontSize:16,activeArea:'sidebar',
  tabGeometry:{gap:6,paddingX:8,paddingY:4,borderRadius:5},sessionStatuses:[],statusMarker:{sizePx:6,shape:'circle'},
  setActiveArea:()=>{},showToast:()=>{}}));
const f=(window as any).fixture={commits:[],attempts:[],errors:[],reset:null,holdCommit:false,releaseCommit:null};
export function reset(options:any={}) {
  f.commits=[];f.attempts=[];f.holdCommit=false;f.releaseCommit=null;
  const rows=[['A',null],['Q',null],['B',null],['Z',null],['child','A']];
  const tabs=new Map(rows.map(([id,parent])=>[id,{id,name:id,cwd:'/fixture',tabType:'terminal',visualParentTabId:parent || undefined}]));
  if(options.file)Object.assign(tabs.get('child')!,{tabType:'file',filePath:'/fixture/linked.md'});
  if(options.physical)Object.assign(tabs.get('child')!,{parentTabId:'A',visualParentTabId:undefined});
  const layout={...emptySpaceLayout(),activeProjectId:'P',focusedProjectId:'P',
    splitPanes:[{windowId:'window-w1',projectId:'P',tabId:options.pane?'B':'',tabs:options.pane?['A','B'].map(tabId=>({projectId:'P',tabId})):[]}]};
  const other={...emptySpaceLayout(),activeProjectId:'P',focusedProjectId:'P',splitPanes:[{windowId:'window-w2',projectId:'P',tabId:'',tabs:[]}]};
  const methods={
    saveSession:()=>{},commitOrganization:async()=>{},getFocusedProjectId:()=> 'P',
    openTabById:async()=>true,renameTab:()=>{},
    switchWorkspaceSpace:(id:string)=>{
      const state=useWorkspaceStore.getState();if(id===state.activeSpaceId)return;
      const spaces=state.spaces.map((space:any)=>space.id===state.activeSpaceId?{...space,layout:captureSpaceLayout(state)}:space);
      useWorkspaceStore.setState({spaces,activeSpaceId:id,...spaces.find((space:any)=>space.id===id).layout});
    },
    commitWorkflowDrag:async(request:any,options:any={})=>{
      f.attempts.push(request);
      if(f.holdCommit)await new Promise(resolve=>{f.releaseCommit=resolve;});
      if(!request || options.isCurrent?.()===false)return false;
      f.commits.push({request,painted:[...document.querySelectorAll('[data-outline-dnd-row]')].map((row:any)=>row.dataset.nodeId)});
      const state=useWorkspaceStore.getState(),members={...state.tabWorkflowMembership},tabGroups={...state.globalGroups.tabGroups};
      for(const tab of request.tabs){members[tab.tabId]={...members[tab.tabId],workflowId:tab.workflowId};
        if(tab.groupId)tabGroups[tab.tabId]=tab.groupId;else delete tabGroups[tab.tabId];
        state.openProjects.get(tab.expected.namespace).tabs.get(tab.tabId).visualParentTabId=tab.visualParentTabId || undefined;}
      const spaces=state.spaces.map((space:any)=>{const change=request.workflows.find((row:any)=>row.workflowId===space.id);
        return change?{...space,reserveOrder:change.reserveOrder,reserveRootOrder:change.reserveRootOrder,layout:applyDragLayout(space.layout,change.beforeLayout,change.layout)}:space;});
      useWorkspaceStore.setState({spaces,tabWorkflowMembership:members,globalGroups:{...state.globalGroups,tabGroups},
        ...spaces.find((space:any)=>space.id===state.activeSpaceId).layout});return true;
    },
  };
  useWorkspaceStore.setState({...methods,...layout,organizationReady:true,organizationRevision:1,organizationGeneration:1,
    tabCatalog:Object.fromEntries(rows.map(([id],index)=>[id,{active:true,storageId:index+1,physicalParentTabId:null,executionSubject:{version:1,projectId:'P'}}])),
    openProjects:new Map([['P',{projectId:'P',tabs,tabGroups:[],selectedTabIds:[],activeTabId:'B'}]]),
    tabWorkflowMembership:Object.fromEntries(rows.map(([id])=>[id,{workflowId:options.destination && ['Q','Z'].includes(id!)?'w2':'w1',revision:1}])),pendingTabWorkflowMembership:{},
    globalGroups:{version:1,revision:1,
      groups:options.groups?['ga','gb','empty'].map(id=>({id,name:id,revision:1,reserveWorkflowId:'w1'})):[],
      tabGroups:options.groups?{A:'ga',child:'ga',Q:'ga',B:'gb',Z:'gb'}:{},membershipRevisions:{}},activeSpaceId:'w1',
    spaces:[{id:'w1',kind:'user',name:'First',layout,reserveOrder:['A','child','Q','B','Z']},
      {id:'w2',kind:'user',name:'Second',layout:other,reserveOrder:options.destination?['Q','Z']:[]}],
    workflowSidebarState:{w1:{selectedTabIds:options.selected || ['A','B'],scrollTop:0},w2:{selectedTabIds:[],scrollTop:0}},
  },true);
}
f.reset=reset;f.store=useWorkspaceStore;

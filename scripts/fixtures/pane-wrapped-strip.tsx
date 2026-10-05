import React from 'react';
import { createRoot } from 'react-dom/client';
import { SplitPaneAttachRow, splitPaneHeaderHeightVar } from '../../src/renderer/components/Workspace/SplitPaneChrome';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { paneSlots } from '../../src/renderer/utils/splitPanesModel.mjs';
import { getPaneTabDragSnapshot } from '../../src/renderer/utils/paneTabDragBridge';
import SpaceStrip from '../../src/renderer/components/Workspace/SpaceStrip';
import TabDragNavigationController from '../../src/renderer/components/Workspace/TabDragNavigationController';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import { getPaneTabPointerSnapshot } from '../../src/renderer/utils/paneTabPointerBridge';

const f = (window as any).pickerFixture;
const cwd = '/synthetic-wrap', p = 'p', q = 'q';
const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e75"/></svg>');
const owner = (id: string) => ['c','d'].includes(id) ? q : p;
const chip = (tabId: string) => ({ projectId: owner(tabId), tabId });
const tabs = [['a','Alpha task'],['b','Beta task'],['c','Gamma task'],['d','Delta task'],['e','Epsilon task'],['f','Another window'],['g','Second target'],['h','Hidden work']]
  .map(([id,name]) => ({ id,name,cwd,tabType:'terminal',color:'codex',sessionStatus:'working' }));
const initialPanes = [
  { ...chip('a'), windowId:'left', column:0, tabs:[chip('a'),chip('b'),{slotId:'choice',projectId:p,cwd},chip('c'),chip('d'),chip('e')] },
  { ...chip('f'), windowId:'right', column:1, tabs:[chip('f'),chip('g')] },
];
const layout = { ...emptySpaceLayout(),activeProjectId:p,focusedProjectId:p,activeSpaceTab:chip('a'),
  splitPanes:initialPanes,splitFocusedIndex:0,splitSizes:{cols:[.5,.5],rows:[[1],[1]]} };
const otherLayout = { ...layout, splitPanes: [{ ...chip('g'), windowId: 'other', column: 0, tabs: [chip('g')] }], splitFocusedIndex: 0 };
function reset() {
  useWorkspaceStore.setState({view:'workspace',isRestoring:false,...layout,
    openProjects:new Map([p,q].map(projectId=>[projectId,{projectId,projectPath:cwd,
      tabs:new Map(tabs.filter(t=>owner(t.id)===projectId).map(t=>[t.id,{...t}])),
      activeTabId:projectId===p?'a':'c',currentView:'terminal',tabGroups:[],tabHistory:[],selectedTabIds:[],sidebarOpen:false}])),
    activeSpaceId:'wrap-space',spaces:[{id:'wrap-space',name:'Wrap workflow',projectIds:[p,q],layout},
      {id:'other-space',name:'Other workflow',projectIds:[p,q],layout:otherLayout}],
    globalTabMru:[],windowDisplayKey:'test',workspaceDisplay:null,windowDisplayLayouts:{},
  } as any);
  useUIStore.setState({activeArea:'workspace',tabsFontSize:16,
    tabGeometry:{paddingX:6,paddingY:3,paddingLeft:16,borderRadius:6,gap:4}} as any);
}
useProjectsStore.setState({projects:{[p]:{id:p,name:'Project P',path:cwd,icon},[q]:{id:q,name:'Project Q',path:cwd,icon}}});
reset();
f.state=()=>{const s=useWorkspaceStore.getState();return{panes:s.splitPanes.map(pane=>({id:pane.windowId,
  shown:pane.tabId,slot:pane.selectedSlotId,ids:paneSlots(pane).map((x:any)=>x.tabId||x.slotId)})),focus:s.splitFocusedIndex,
  activeProjectId:s.activeProjectId,spaceId:s.activeSpaceId,mru:s.globalTabMru.map(x=>x.tabId),drag:getPaneTabDragSnapshot(),pointer:getPaneTabPointerSnapshot(),
  obsoleteKeys:Object.keys(useUIStore.getState()).filter(x=>/^paneTabStrip/.test(x))};};
function Fixture() {
  const panes=useWorkspaceStore(s=>s.splitPanes), focus=useWorkspaceStore(s=>s.splitFocusedIndex);
  const spaceId=useWorkspaceStore(s=>s.activeSpaceId);
  const [width,setWidth]=React.useState(410);
  const [sidebarVisible,setSidebarVisible]=React.useState(false);
  return <>
    <SpaceStrip processStatus={new Map()} busyTabs={new Map()} pasteBusyTabs={new Map()} inheritedBusyTabIds={new Set()} awaitingTabs={new Map()}/>
    <TabDragNavigationController onNavigateProject={()=>{}}/>
    <div data-terminal-pane-chrome-host style={{display:'flex',gap:16,padding:16}}>
      {panes.map((pane,i)=>pane.displayHidden?null:<section key={pane.windowId} data-test-pane={i} style={{width,flexShrink:0,height:360,position:'relative',border:'1px solid #666'}}>
        <SplitPaneAttachRow projectId={pane.projectId} tabId={pane.tabId} focused={focus===i} paneIndex={i}
          vacant={!pane.tabId} paneLayout={panes} spaceId={spaceId} />
        <div data-test-content={i} style={{position:'absolute',top:`var(${splitPaneHeaderHeightVar(i)},26px)`,left:0,right:0,bottom:0,padding:12}}>
          <label>Shown: {pane.tabId||pane.selectedSlotId}</label>
          <input data-test-input={i} defaultValue={'unchanged draft '+i} style={{display:'block',marginTop:12}} />
        </div>
      </section>)}
    </div>
    <button data-reset onClick={reset}>Reset synthetic layout</button>
    <label>Pane width<input data-pane-width type="number" value={width} onChange={e=>setWidth(Number(e.target.value))}/></label>
    <button data-large-font onClick={()=>useUIStore.setState({tabsFontSize:22} as any)}>22px cards</button>
    <button data-zero-gap onClick={()=>useUIStore.setState({tabGeometry:{paddingX:6,paddingY:3,paddingLeft:16,borderRadius:6,gap:0}} as any)}>Zero badge gap</button>
    <button data-add-hidden onClick={()=>useWorkspaceStore.setState(s=>({splitPanes:[...s.splitPanes.filter(x=>x.windowId!=='hidden'),
      {...chip('h'),windowId:'hidden',column:2,displayHidden:true,tabs:[chip('h')]}]}))}>Add hidden window</button>
    <button data-show-sidebar onClick={()=>setSidebarVisible(true)}>Show adoption sidebar</button>
    {sidebarVisible && <aside data-test-adoption style={{position:'absolute',left:16,top:470,width:310,height:170}}>
      <TabBar projectId={p} layout="vertical" sharedProcessStatus={new Map()} sharedBusyTabs={new Map()} sharedPasteBusyTabs={new Map()}/>
    </aside>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import PaneTabChip from '../../src/renderer/components/Workspace/PaneTabChip';
import TabCard from '../../src/renderer/components/Workspace/TabCard';
// Resolved only by the fixture builder to the immutable Git-before module.
import BaselineTabCard from '@visual-baseline/TabCard';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import FilePreview from '../../src/renderer/components/Workspace/FilePreview';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import { openTabLinkedFile } from '../../src/renderer/utils/tabLinkedFilePreview';
import { collectTabLinkedFiles } from '../../src/renderer/utils/tabLinkedFiles.mjs';
import { useTabLinkedFilePreviewBounds } from '../../src/renderer/utils/tabLinkedFilePreviewBounds';

const f = (window as any).linkedFixture, p = 'links', cwd = '/synthetic-links';
const owners = ['empty', 'one', 'many', 'other', 'long'].map(id => ({ id, name: id === 'many' ? 'Agent with tasks' : id === 'one' ? 'Single file owner' : id,
  cwd, commandType: 'generic', tabType: 'terminal', color: 'default',
  completionNotificationArmed: id === 'many',
  taskPlan: id === 'many' ? { items: [{ id: 'task', title: 'Task', subtasks: [] }], archivedItems: [] } : undefined }));
const link = (id: string, owner: string, filePath: string) => ({ id, name: filePath.split('/').pop(), cwd: filePath,
  tabType: 'file', filePath, visualParentTabId: owner, commandType: 'generic', color: 'default' });
const files = [link('one-md', 'one', '/same.md'), link('many-md', 'many', '/same.md'),
  link('many-json', 'many', '/config.json'), link('other-md', 'other', '/same.md'),
  link('long-md', 'long', '/' + 'pathological-name-'.repeat(35) + '.md'),
  link('long-second', 'long', '/details.txt'),
  link('child-md', 'child', '/descendant.md')];
const denseNames=['A','оптимизация запросов','браузер','позиционирование анализа конкурентов','установка и релиз','файлы и заметки',
  'реализация чипов диктовки','система ролей','AI дэшборд','задачи команды','скрипты','History','MCP timeline','визуал','Home','drag and drop','новые окна','контекст'];
const denseOwners=denseNames.map((name,index)=>({...owners[index%owners.length],id:'dense-'+index,name,
  sessionStatus:index===1?'fixture-status':undefined,
  taskPlan:index%3===0?{items:[{id:'task-'+index,title:'Task',subtasks:[]}],archivedItems:[]}:undefined}));
const denseFiles=denseOwners.flatMap((owner,index)=>index%3===2?[]:[link(owner.id+'-file',owner.id,'/query.md'),
  ...(index%3===1?[link(owner.id+'-second',owner.id,'/details.txt')]:[])]);
const base = { ...emptySpaceLayout(), activeProjectId: p, focusedProjectId: p,
  activeSpaceTab: { projectId: p, tabId: 'empty' } };
const tabs = [...owners, ...files,...denseOwners,...denseFiles, { ...owners[0], id: 'child', name: 'AI child', parentTabId: 'many' }];
useWorkspaceStore.setState({ ...base, view: 'workspace', isRestoring: false, activeSpaceId: 'fixture',
  spaces: [{ id: 'fixture', name: 'Fixture', projectIds: [p], layout: base }],
  openProjects: new Map([[p, { projectId: p, projectPath: cwd, tabs: new Map(tabs.map(tab => [tab.id, tab])),
    activeTabId: 'empty', currentView: 'terminal', tabGroups: [], tabHistory: [], selectedTabIds: [], sidebarOpen: false }],
    ['catalog-b', { projectId: 'catalog-b', projectPath: '/synthetic-other',
      tabs: new Map([['many-png', link('many-png', 'many', '/diagram.png')]]), currentView: 'terminal', tabHistory: [] }]]) } as any);
useUIStore.setState({ tabsFontSize: 14, filePreview: null, taskStatuses: [],
  sessionStatuses:[{id:'fixture-status',label:'Fixture status',color:'#c084fc'}],
  tabGeometry: { paddingX: 6, paddingY: 3, paddingLeft: 16, borderRadius: 6, gap: 4 } } as any);
f.navigate = (id: string) => useWorkspaceStore.getState().activateCenterTab(p, id);
f.close = () => useUIStore.getState().closeFilePreview();
f.geometry = (fontSize: number, paddingY: number) => useUIStore.setState(s => ({ tabsFontSize: fontSize,
  tabGeometry: { ...s.tabGeometry, paddingY } }));
f.open = (owner: string, id: string) => {
  const file = collectTabLinkedFiles(useWorkspaceStore.getState().openProjects, owner).find((x:any) => x.id === id);
  return openTabLinkedFile(p, file, () => f.navigate(owner));
};
f.preview = () => useUIStore.getState().filePreview;
f.closeOwner = () => useWorkspaceStore.getState().closeTab(p, 'many', { skipProcessCheck: true, archive: false });
f.tabIds = () => [...useWorkspaceStore.getState().openProjects.values()].flatMap(w => [...w.tabs.keys()]);
f.unlink = (id: string) => useWorkspaceStore.setState(s => {
  const projects = new Map(s.openProjects), project = projects.get(p)!;
  const tabs = new Map(project.tabs); tabs.delete(id); projects.set(p, { ...project, tabs });
  return { openProjects: projects };
});
f.replacePreview = () => useUIStore.getState().openFilePreview({ source: 'sidebar', path: '/replacement.md', content: '# Replacement', language: 'markdown' });

// Child layout effects run before this detached portal is attached. The card
// must wait for real font/layout, as retained application hosts sometimes do.
function AttachedAfterChild({children}:{children:React.ReactNode}) {
  const target=useRef<HTMLSpanElement>(null);
  const [host]=useState(()=>{const element=document.createElement('span');element.style.display='contents';return element;});
  useLayoutEffect(()=>{target.current?.append(host);return()=>host.remove();},[host]);
  return <><span ref={target} style={{display:'contents'}}/>{createPortal(children,host)}</>;
}
function Fixture() {
  const preview = useUIStore(s => s.filePreview);
  useTabLinkedFilePreviewBounds(preview);
  const active = useWorkspaceStore(s => s.openProjects.get(p)?.activeTabId), header = useRef<HTMLDivElement>(null);
  const [dense,setDense]=useState(false);f.dense=setDense;
  const [offset, setOffset] = useState(140), [bottom, setBottom] = useState(false), [split, setSplit] = useState(false);
  useEffect(() => {
    const ro = new ResizeObserver(() => setOffset((header.current?.getBoundingClientRect().bottom || 130) + 12));
    if (header.current) ro.observe(header.current); return () => ro.disconnect();
  }, []);
  f.bottom = (value: boolean) => setBottom(value);
  f.split = (value: boolean) => setSplit(value);
  if(dense) return <><div style={{padding:20}}>
    {[true,false].map(before=><section key={String(before)}>
      <h2 style={{fontSize:14,margin:'10px 0'}}> {before?'Git f9b45cc — before':'Current — measured title and file clearances'} </h2>
      <div {...(before?{'data-dense-before':true}:{'data-dense-current':true})}
        style={{display:'flex',flexWrap:'wrap',gap:4,alignItems:'flex-start',paddingBottom:30}}>
        {denseOwners.map(owner=>before?<BaselineTabCard key={owner.id} projectId={p} tabId={owner.id}/>
          :<AttachedAfterChild key={owner.id}><TabCard projectId={p} tabId={owner.id} onLinkedFileOpen={file=>void f.open(owner.id,file.id)}/></AttachedAfterChild>)}</div>
    </section>)}
  </div><FilePreview topOffset={600}/></>;
  return <><div data-workspace-center style={{ position: 'fixed', inset: 0 }}>
    <div data-tabbar-vertical style={{ position: 'absolute', top: 0, left: 0, width: 0 }} />
    <div data-terminal-pane-chrome-host={split ? 'fixture-pane' : undefined}
      style={split ? { position: 'absolute', left: 100, top: 100, width: 330, height: 360 } : { display: 'contents' }}>
    <div ref={header} data-fixture-header data-split-attach-row style={{ position: 'absolute', left: 20, top: bottom ? 470 : 30, width: split ? 280 : 430,
      display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'flex-start' }}>
      {owners.map((owner, index) => <PaneTabChip key={owner.id} projectId={p} tabId={owner.id} shown={active === owner.id}
        paneFocused paneIndex={null} inSplit={false} inStrip index={index}
        sharedActivity={{ processStatus: new Map([['many', true]]), busyTabs: new Map([['many', false]]) }} />)}
      <span data-not-pane><TabCard projectId={p} tabId="many" label="Run After reference" /></span>
    </div>
    </div>
    <FilePreview topOffset={offset} />
    <button data-outside style={{ position: 'absolute', top: 2, right: 10 }}>Outside</button>
  </div><TabBar projectId={p} menuOnlyForProject sharedProcessStatus={new Map()} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

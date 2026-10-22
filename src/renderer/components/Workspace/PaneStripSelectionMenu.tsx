import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronRight,Copy,Palette,RotateCw,Square,PanelLeftClose} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import {requireCodexSurfaceSessionId} from '../../utils/codexWriterIdentity';
import {resolvePtyAgentOwner} from '../../utils/ptyAgentOwner.mjs';
import {refreshGeneratedTabTitle} from '../../utils/generateTabTitle';
import {classifyPaneStripColorSelection} from '../../utils/paneStripSelectionModel.mjs';
import {readPaneStripActiveGroups,readPaneStripOwnerEntries,paneStripGroupActivityFingerprint} from '../../utils/paneStripGroupsModel.mjs';
import {notifyPaneStripSelection,openPaneStripSelectionBeside,removePaneStripSelection,
  paneStripSelectionTargets,tabSessionUuid,tabUuidPathText} from '../../utils/paneStripSelectionActions.mjs';
import {CONTEXT_MENU_COMPACT_ROW_STYLE,CONTEXT_MENU_ROW_STYLE,CONTEXT_MENU_TOP_DIVIDER_STYLE,CONTEXT_MENU_PANEL_STYLE} from '../UI/contextMenuMetrics.mjs';
import SideFlyout from '../UI/SideFlyout';
import TabNotificationControls from './TabNotificationControls';
import {TabIdActions} from './TabIdActions';
import PaneStripGroupColorPicker from './PaneStripGroupColorPicker';
import type {PaneStripSelectionLease} from './PaneStripSelection';

export type PaneSelectionRuntimePort={run:(action:'close'|'stop',lease:PaneStripSelectionLease)=>Promise<void>};
const button='min-w-0 text-[12px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-center disabled:text-[#555] disabled:cursor-not-allowed';

/** Content of the existing TabBar context-menu owner, not another menu host. */
export default function PaneStripSelectionMenu({lease,onClose,runtimePort,colorOnly=false}: {
  lease:PaneStripSelectionLease;onClose:()=>void;runtimePort?:PaneSelectionRuntimePort;colorOnly?:boolean;
}) {
  const showToast=useUIStore.getState().showToast;
  const [busy,setBusy]=useState(false),[colorOpen,setColorOpen]=useState(false);
  const anchor=useRef<HTMLButtonElement|null>(null),flyout=useRef<HTMLDivElement|null>(null),pointerDown=useRef(false);
  const mounted=useRef(true),inFlight=useRef(false);
  useWorkspaceStore(state=>state.spaces.find(space=>space.id===lease.workflowId)?.stripColorGroups);
  useWorkspaceStore(state=>paneStripGroupActivityFingerprint(state,lease.workflowId));
  const organizationReady=useWorkspaceStore(state=>state.organizationReady&&!state.isRestoring);
  const current=useRef({lease,onClose});current.current={lease,onClose};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    const closeIfStale=()=>{if(!lease.isCurrent())onClose();};
    const unsubscribe=useWorkspaceStore.subscribe(closeIfStale);
    const cancel=()=>onClose();
    window.addEventListener('blur',cancel);
    closeIfStale();return()=>{unsubscribe();window.removeEventListener('blur',cancel);};
  },[lease,onClose]);
  useEffect(()=>{
    if(!colorOpen)return;
    const inside=(rect:DOMRect|undefined,x:number,y:number)=>rect&&x>=rect.left-2&&x<=rect.right+2&&y>=rect.top-2&&y<=rect.bottom+2;
    const move=(event:MouseEvent)=>{if(!pointerDown.current&&!inside(anchor.current?.getBoundingClientRect(),event.clientX,event.clientY)
      &&!inside(flyout.current?.getBoundingClientRect(),event.clientX,event.clientY))setColorOpen(false);};
    const up=()=>{pointerDown.current=false;};
    window.addEventListener('mousemove',move);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);
    return()=>{window.removeEventListener('mousemove',move);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);};
  },[colorOpen]);
  const getAnchorRect=useCallback(()=>anchor.current?.getBoundingClientRect() || null,[]);
  let groups:any[]=[],colorError=false;
  try {groups=readPaneStripActiveGroups(useWorkspaceStore.getState(),lease.workflowId);}catch{colorError=true;}
  // A collapsed representative exposes GROUP SETTINGS without silently making
  // its single-tab Full/Stop command target all the hidden members.
  const represented=lease.entries.length===1?groups.find(group=>group.collapsed&&group.tabIds.includes(lease.entries[0].tabId)):null;
  const ownerEntries=represented?readPaneStripOwnerEntries(useWorkspaceStore.getState(),lease):null;
  const colorEntries=represented&&represented.tabIds.every(id=>ownerEntries?.some(entry=>entry.tabId===id))
    ?ownerEntries!.filter(entry=>represented.tabIds.includes(entry.tabId)):lease.entries;
  const colorLease=colorEntries===lease.entries?lease:{...lease,entries:colorEntries,isCurrent:()=>{
    if(!lease.isCurrent())return false;
    const current=readPaneStripOwnerEntries(useWorkspaceStore.getState(),lease);
    return !!current&&colorEntries.every(entry=>current.some(value=>value.tabId===entry.tabId&&value.projectId===entry.projectId));
  }};
  const choice=classifyPaneStripColorSelection(groups,colorEntries.map(entry=>entry.tabId));
  const colorUnavailable=!organizationReady||colorError||choice.kind==='disabled';
  const colorDisabled=colorUnavailable||busy;
  const color=choice.kind==='recolor'?choice.group.color:'#a855f7';
  const targets=lease.entries.flatMap(entry=>{
    const state=useWorkspaceStore.getState(),tab=state.openProjects.get(entry.projectId)?.tabs.get(entry.tabId);
    return tab?[{...entry,tab}]:[];
  });
  const ai=targets.filter(({tab})=>tab.tabType!=='file');
  const act=async (action:()=>void|Promise<void>,close=true)=>{
    if(inFlight.current||!lease.isCurrent())return;
    inFlight.current=true;setBusy(true);
    try {await action();if(close&&mounted.current&&current.current.lease===lease)onClose();}
    catch(error:any){
      const code=String(error?.code || error?.message || '');
      if(code.includes('workflow_strip_groups_')){
        await useWorkspaceStore.getState().refreshOrganizationCatalog().catch(()=>{});
        showToast('Состав или цвет группы изменились. Выберите цвет ещё раз.','warning');
      }else showToast(/^(strip_|selection_)/.test(code)
        ?'Выбор или состояние вкладок изменились. Откройте меню заново.':error?.message || 'Действие не подтверждено','warning');
    }
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  };
  const saveColor=async (next:string)=>{
    await act(async()=>{
      const result=await useWorkspaceStore.getState().commitPaneStripGroupColor(colorLease,next);
      if(!result||!Number.isSafeInteger(result.revision))throw Error('strip_group_save_unconfirmed');
      useWorkspaceStore.getState().saveSession();
    },false);
  };
  return <div data-pane-strip-selection-menu data-selection-count={lease.entries.length}
    data-pane-strip-selection-owner={JSON.stringify([lease.workflowId,lease.windowId??lease.paneIndex])}>
    {!colorOnly&&<>
    <div className="flex items-stretch w-full">
      <button type="button" className={button+' flex-1'} style={CONTEXT_MENU_COMPACT_ROW_STYLE} disabled={busy}
        data-tab-context-action="beside" onClick={()=>void act(()=>{openPaneStripSelectionBeside(useWorkspaceStore.getState,lease);})}>Open beside</button>
      <button type="button" className={button+' flex-1 border-l border-[#444]'} style={CONTEXT_MENU_COMPACT_ROW_STYLE} disabled={busy}
        data-tab-context-action="remove-from-window" onClick={()=>void act(()=>removePaneStripSelection(useWorkspaceStore.getState,lease))}>Убрать</button>
      <button type="button" className={button+' border-l border-[#444]'} style={{...CONTEXT_MENU_COMPACT_ROW_STYLE,color:runtimePort?'#f87171':undefined,minWidth:46}}
        data-tab-context-action="close" data-tab-close-scope="full" disabled={busy||!runtimePort}
        onClick={()=>void act(()=>runtimePort!.run('close',lease))}>Full</button>
    </div>
    <button type="button" className={button+' w-full'} style={{...CONTEXT_MENU_COMPACT_ROW_STYLE,...CONTEXT_MENU_TOP_DIVIDER_STYLE}}
      data-tab-context-action="stop" disabled={busy||!runtimePort||!ai.length}
      onClick={()=>void act(()=>runtimePort!.run('stop',lease))}><Square size={12}/>Stop</button>
    {ai.length>0&&<TabNotificationControls armed={ai.every(({tab})=>!!tab.completionNotificationArmed)}
      fired={ai.every(({tab})=>!!tab.completionNotificationFired)} persistent={ai.every(({tab})=>!!tab.completionNotificationPersistent)}
      onOnce={enabled=>{void act(()=>notifyPaneStripSelection(useWorkspaceStore.getState,lease,'once',enabled));}}
      onPersistent={enabled=>{void act(()=>notifyPaneStripSelection(useWorkspaceStore.getState,lease,'persistent',enabled));}} onAction={()=>{}}/>}
    </>}
    <div className="flex items-stretch w-full" style={CONTEXT_MENU_TOP_DIVIDER_STYLE}>
    <button type="button" className={button+' border-r border-[#444]'} style={{...CONTEXT_MENU_COMPACT_ROW_STYLE,minWidth:28}}
      data-tab-context-action="group-collapse" disabled={busy||colorUnavailable||choice.kind!=='recolor'}
      aria-label="Свернуть группу в одну вкладку" aria-pressed={choice.kind==='recolor'&&!!choice.group.collapsed}
      title={choice.kind==='recolor'&&choice.group.collapsed?'Показывать все вкладки':'Свернуть группу в одну вкладку'}
      onClick={()=>{if(choice.kind==='recolor')void act(async()=>{
        const result=await useWorkspaceStore.getState().commitPaneStripGroupPresentation(colorLease,choice.group.id,{collapsed:!choice.group.collapsed});
        if(!result||!Number.isSafeInteger(result.revision))throw Error('strip_group_save_unconfirmed');
        useWorkspaceStore.getState().saveSession();
      });}}><PanelLeftClose size={13}/></button>
    <button ref={anchor} type="button" data-tab-context-action="group-color" className={button+' flex-1 justify-between'}
      disabled={colorDisabled} style={CONTEXT_MENU_ROW_STYLE}
      title={colorDisabled?'Выберите свободные вкладки или всю одну цветную группу':undefined}
      onMouseEnter={()=>{if(!colorDisabled)setColorOpen(true);}} onClick={()=>{if(!colorDisabled)setColorOpen(open=>!open);}}>
      <span className="flex items-center gap-2"><Palette size={12} style={{color}}/>Цвет группы</span><ChevronRight size={12}/>
    </button>
    </div>
    {colorOpen&&!colorUnavailable&&createPortal(<SideFlyout ref={flyout} getAnchorRect={getAnchorRect} zIndex={100040}
      data-tab-context-menu data-pane-strip-color-submenu
      data-tab-menu-owner-id={lease.entries[0]?.tabId}
      data-pane-strip-selection-owner={JSON.stringify([lease.workflowId,lease.windowId??lease.paneIndex])}
      onPointerDownCapture={()=>{pointerDown.current=true;}} onMouseDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
      <div style={{...CONTEXT_MENU_PANEL_STYLE,background:'#2a2a2a',border:'1px solid #444'}}>
        <PaneStripGroupColorPicker key={choice.kind==='recolor'?choice.group.id:'new'} color={color} disabled={busy}
          onCommit={next=>{void saveColor(next);}}/>
      </div>
    </SideFlyout>,document.body)}
    {!colorOnly&&<>
    <div className="flex items-stretch w-full" style={CONTEXT_MENU_TOP_DIVIDER_STYLE}>
      <TabIdActions tabIds={lease.entries.map(entry=>entry.tabId)} onClose={onClose} showToast={showToast} isCurrent={lease.isCurrent}/>
      <button type="button" className={button+' flex-1 border-l border-[#444]'} style={CONTEXT_MENU_COMPACT_ROW_STYLE}
        data-tab-context-action="copy-session-id-path" disabled={busy||!targets.some(({tab})=>tabSessionUuid(tab)||resolvePtyAgentOwner(tab)==='codex')}
        onClick={()=>void act(async()=>{
          const captured=paneStripSelectionTargets(useWorkspaceStore.getState(),lease),rows=[];
          for(const {tab,tabId,workspace} of captured) {
            const uuid=resolvePtyAgentOwner(tab)==='codex'?await requireCodexSurfaceSessionId({tabId,operation:'скопировать UUID сессии'}):tabSessionUuid(tab);
            if(!lease.isCurrent())throw Error('strip_selection_changed');
            if(uuid)rows.push({uuid,cwd:tab.cwd || workspace.projectPath || '/'});
          }
          window.require('electron').clipboard.writeText(tabUuidPathText(rows));
          showToast(`Скопировано UUID + путей: ${rows.length}`,'success');
        })}><Copy size={12}/>UUID/Path</button>
    </div>
    <button type="button" className={button+' w-full justify-start'} style={CONTEXT_MENU_ROW_STYLE}
      data-tab-context-action="refresh-title" disabled={busy||!ai.length} onClick={()=>void act(async()=>{
        const captured=paneStripSelectionTargets(useWorkspaceStore.getState(),lease).filter(({tab})=>tab.tabType!=='file');
        for(const {tabId} of captured) {
          if(!lease.isCurrent())throw Error('strip_selection_changed');
          const store=useWorkspaceStore.getState();
          if(store.tabTitleNamingIds.has(tabId))throw Error('Название уже обновляется');
          store.setTabTitleNaming(tabId,true);
          try {
            const result=await refreshGeneratedTabTitle(tabId,{overrideManualName:true,markNameSetManually:true});
            if(!result.ok)throw Error(result.error || 'Не удалось обновить название вкладки');
          } finally {useWorkspaceStore.getState().setTabTitleNaming(tabId,false);}
        }
      })}><RotateCw size={12}/>Обновить название</button>
    </>}
  </div>;
}

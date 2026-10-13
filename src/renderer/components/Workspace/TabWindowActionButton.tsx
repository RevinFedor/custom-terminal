import React from 'react';
import {Columns2,Replace} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import {CONTEXT_MENU_COMPACT_ROW_STYLE,CONTEXT_MENU_ICON_SLOT_STYLE} from '../UI/contextMenuMetrics.mjs';
import type {TabWindowAction} from '../../utils/openFilePathTab';

/** The same exact-tab action in ordinary and linked-file context menus. */
export default function TabWindowActionButton({projectId,tabId,action,onClose,isCurrent}: {
  projectId:string;tabId:string;action:TabWindowAction;onClose:()=>void;isCurrent?:()=>boolean;
}) {
  const label=action==='beside'?'Open beside':'Replace current';
  return <button type="button" data-context-menu-row="compact" data-tab-context-action={action}
    className="flex-1 min-w-0 text-left text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center"
    style={{...CONTEXT_MENU_COMPACT_ROW_STYLE,whiteSpace:'nowrap'}}
    onClick={async event=>{
      event.stopPropagation();
      if (isCurrent?.()===false) return;
      const store=useWorkspaceStore.getState(),tab=store.openProjects.get(projectId)?.tabs.get(tabId);
      if (!tab || store.tabCatalog[tabId]?.active===false) return;
      onClose();
      const ok=await store.openTabById(tabId,{projectId,reason:'tab-context-'+action,windowAction:action});
      if (!ok) useUIStore.getState().showToast('Размещение вкладки не подтверждено','warning');
    }}>
    <span style={CONTEXT_MENU_ICON_SLOT_STYLE}>{action==='beside'?<Columns2 size={12}/>:<Replace size={12}/>}</span>
    {label}
  </button>;
}

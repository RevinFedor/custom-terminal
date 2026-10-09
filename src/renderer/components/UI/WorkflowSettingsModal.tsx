import React,{useEffect,useLayoutEffect,useRef} from 'react';
import {X} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import WorkflowSettings from './ProjectIconsSettings';
import WorkflowSourcesSettings from './WorkflowSourcesSettings';
import WorkflowDirectorySettings from './WorkflowDirectorySettings';

export const WORKFLOW_SETTINGS_OPEN='workflow-settings:open';
export function openWorkflowSettings(workflowId:string){
  window.dispatchEvent(new CustomEvent(WORKFLOW_SETTINGS_OPEN,{detail:{workflowId}}));
}

/** Settings belong to the workflow named by the context menu, not UI focus. */
export default function WorkflowSettingsModal(){
  const workflowId=useUIStore(state=>state.workflowSettingsId),panel=useRef<HTMLDivElement>(null);
  const setWorkflowId=(workflowSettingsId:string|null)=>useUIStore.setState({workflowSettingsId});
  const exists=useWorkspaceStore(state=>!!workflowId && state.spaces.some(space=>space.id===workflowId));
  const name=useWorkspaceStore(state=>state.spaces.find(space=>space.id===workflowId)?.name || 'Workflow');
  useEffect(()=>{
    const open=(event:Event)=>{
      const id=(event as CustomEvent).detail?.workflowId;
      if(typeof id!=='string' || !useWorkspaceStore.getState().spaces.some(space=>space.id===id))return;
      setWorkflowId(id);window.dispatchEvent(new CustomEvent('settings:opened'));
    };
    window.addEventListener(WORKFLOW_SETTINGS_OPEN,open);return()=>window.removeEventListener(WORKFLOW_SETTINGS_OPEN,open);
  },[]);
  useLayoutEffect(()=>{
    if(!workflowId)return;
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[workflowId]);
  useEffect(()=>{if(workflowId&&!exists)setWorkflowId(null);},[workflowId,exists]);
  if(!workflowId || !exists)return null;
  return <div data-workflow-settings-modal={workflowId} role="dialog" aria-modal="true" aria-label={`Workflow: ${name}`}
    onMouseDown={event=>{if(event.target===event.currentTarget)setWorkflowId(null);}}
    onKeyDown={event=>{
      event.stopPropagation();
      if(event.key==='Escape' && !event.defaultPrevented)setWorkflowId(null);
      if(event.key==='Tab' && panel.current?.contains(event.target as Node)){
        const controls=[...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length);
        const from=controls.indexOf(document.activeElement as HTMLElement);
        if(controls.length && (event.shiftKey?from<=0:from===controls.length-1)){
          event.preventDefault();controls[event.shiftKey?controls.length-1:0].focus();
        }
      }
    }}
    style={{position:'fixed',inset:0,zIndex:100000,display:'flex',alignItems:'center',justifyContent:'center',background:'#0008'}}>
    <div ref={panel} style={{width:'min(640px, calc(100vw - 32px))',maxHeight:'calc(100vh - 48px)',overflow:'auto',background:'#202022',color:'#ddd',border:'1px solid #444',borderRadius:8,padding:10}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
        <strong style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</strong>
        <button type="button" aria-label="Close workflow settings" onClick={()=>setWorkflowId(null)} style={{border:0,background:'transparent',color:'#aaa',padding:3,cursor:'pointer'}}><X size={18}/></button>
      </div>
      <WorkflowSettings workflowId={workflowId}/>
      <WorkflowDirectorySettings workflowId={workflowId}/>
      <WorkflowSourcesSettings workflowId={workflowId}/>
    </div>
  </div>;
}

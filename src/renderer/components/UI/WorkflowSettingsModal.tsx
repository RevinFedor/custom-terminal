import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import WorkflowSettings from './ProjectIconsSettings';
import WorkflowDirectorySettings,{type WorkflowDirectorySettingsHandle} from './WorkflowDirectorySettings';

export const WORKFLOW_SETTINGS_OPEN='workflow-settings:open';
export function openWorkflowSettings(workflowId:string){
  window.dispatchEvent(new CustomEvent(WORKFLOW_SETTINGS_OPEN,{detail:{workflowId}}));
}

/** Settings belong to the workflow named by the context menu, not UI focus. */
export default function WorkflowSettingsModal(){
  const workflowId=useUIStore(state=>state.workflowSettingsId),panel=useRef<HTMLDivElement>(null);
  const directories=useRef<WorkflowDirectorySettingsHandle>(null),closing=useRef<Promise<boolean>|null>(null);
  const closeRef=useRef<()=>Promise<boolean>>(async()=>true),openSequence=useRef(0);
  const [error,setError]=useState('');
  const setWorkflowId=(workflowSettingsId:string|null)=>useUIStore.setState({workflowSettingsId});
  const exists=useWorkspaceStore(state=>!!workflowId && state.spaces.some(space=>space.id===workflowId));
  const name=useWorkspaceStore(state=>state.spaces.find(space=>space.id===workflowId)?.name || 'Workflow');
  useEffect(()=>{
    const open=(event:Event)=>{void (async()=>{
      const id=(event as CustomEvent).detail?.workflowId;
      if(typeof id!=='string' || !useWorkspaceStore.getState().spaces.some(space=>space.id===id))return;
      const sequence=++openSequence.current;
      const previous=useUIStore.getState().workflowSettingsId;
      if(previous && previous!==id && !await closeRef.current())return;
      if(sequence!==openSequence.current)return;
      setError('');
      setWorkflowId(id);window.dispatchEvent(new CustomEvent('settings:opened'));
    })();};
    window.addEventListener(WORKFLOW_SETTINGS_OPEN,open);return()=>window.removeEventListener(WORKFLOW_SETTINGS_OPEN,open);
  },[]);
  useLayoutEffect(()=>{
    if(!workflowId)return;
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[workflowId]);
  useEffect(()=>{if(workflowId&&!exists)setWorkflowId(null);},[workflowId,exists]);
  const close=()=>{
    if(closing.current)return closing.current;
    const id=workflowId;
    if(!id)return Promise.resolve(true);
    (panel.current?.contains(document.activeElement)?document.activeElement as HTMLElement:null)?.blur();
    const pending=(async()=>{
      try{
        await directories.current?.flush();
        const store=useWorkspaceStore.getState();
        if(store.spaces.some(space=>space.id===id)){
          if(!store.organizationReady || store.isRestoring)throw Error('Сохранение пока недоступно.');
          const receipt=await store.commitOrganization();
          if(!receipt || receipt.success===false || receipt.ok===false)throw Error('Сохранение не подтверждено.');
          store.saveSession();
        }
        if(useUIStore.getState().workflowSettingsId===id)setWorkflowId(null);
        return true;
      }catch(e:any){if(useUIStore.getState().workflowSettingsId===id)setError(String(e.message || e));return false;}
    })().finally(()=>{if(closing.current===pending)closing.current=null;});
    closing.current=pending;return pending;
  };
  closeRef.current=close;
  if(!workflowId || !exists)return null;
  return <div data-workflow-settings-modal={workflowId} role="dialog" aria-modal="true" aria-label={`Workflow: ${name}`}
    onMouseDown={event=>{if(event.target===event.currentTarget)void close();}}
    onKeyDown={event=>{
      event.stopPropagation();
      if(event.key==='Escape' && !event.defaultPrevented)void close();
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
        <strong style={{flex:1}}>Настройки</strong>
        <button type="button" aria-label="Close workflow settings" onClick={()=>void close()} style={{border:0,background:'transparent',color:'#aaa',padding:3,cursor:'pointer'}}><X size={18}/></button>
      </div>
      <WorkflowSettings workflowId={workflowId}/>
      <WorkflowDirectorySettings key={workflowId} ref={directories} workflowId={workflowId}/>
      {error&&<div role="alert" style={{fontSize:12,color:'#fca5a5',paddingTop:4}}>{error}</div>}
    </div>
  </div>;
}

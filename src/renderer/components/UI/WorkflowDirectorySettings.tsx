import React,{useEffect,useRef,useState} from 'react';
import {FolderOpen,Save} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
const control:React.CSSProperties={border:'1px solid #444',borderRadius:4,background:'#252526',color:'#ccc',padding:'3px 5px',fontSize:12,cursor:'pointer'};
export default function WorkflowDirectorySettings({workflowId}:{workflowId:string}){
  const value=useWorkspaceStore(state=>{const cwd=state.spaces.find(space=>space.id===workflowId)?.defaultCwd;return typeof cwd==='string'?cwd:'';});
  const [draft,setDraft]=useState(value),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const scope=useRef(workflowId),alive=useRef(true),lock=useRef(false);
  scope.current=workflowId;
  useEffect(()=>{setDraft(value);setError('');},[workflowId,value]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const current=(id:string)=>alive.current&&scope.current===id&&useWorkspaceStore.getState().spaces.some(space=>space.id===id);
  const save=async()=>{
    if(lock.current)return;
    const next=draft.trim() || null,id=workflowId;
    if(next && !next.startsWith('/')){setError('Укажите абсолютный путь.');return;}
    lock.current=true;setBusy(true);setError('');
    try{
      const store=useWorkspaceStore.getState();
      if(!current(id))return;
      const changed=await store.updateWorkspaceSpaceMetadata(id,{defaultCwd:next});
      if(!changed && (store.spaces.find(space=>space.id===id)?.defaultCwd || null)!==next)throw Error('Не удалось изменить директорию.');
      await store.commitOrganization();
    }catch(e:any){if(current(id))setError(String(e.message || e));}
    finally{lock.current=false;if(current(id))setBusy(false);}
  };
  const choose=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);const id=workflowId;
    try{const path=await window.require('electron').ipcRenderer.invoke('app:select-directory',{defaultPath:draft || undefined});
      if(current(id)&&typeof path==='string')setDraft(path);
    }catch(e:any){if(current(id))setError(String(e.message || e));}
    finally{lock.current=false;if(current(id))setBusy(false);}
  };
  return <section data-workflow-default-directory style={{marginTop:8}}>
    <label htmlFor={'workflow-directory-'+workflowId} style={{fontSize:12,color:'#aaa'}}>Default directory</label>
    <form onSubmit={event=>{event.preventDefault();void save();}} style={{display:'flex',alignItems:'center',gap:4,marginTop:4}}>
      <input id={'workflow-directory-'+workflowId} aria-label="Workflow default directory" value={draft} disabled={busy}
        onChange={event=>setDraft(event.target.value)} placeholder="Not set" style={{...control,flex:1,minWidth:0,cursor:'text'}}/>
      <button type="button" aria-label="Choose workflow directory" title="Choose directory" disabled={busy} style={control} onClick={()=>void choose()}><FolderOpen size={14}/></button>
      <button type="submit" aria-label="Save workflow directory" title="Save" disabled={busy} style={control}><Save size={14}/></button>
    </form>
    {error&&<div role="alert" style={{fontSize:12,color:'#fca5a5',paddingTop:3}}>{error}</div>}
  </section>;
}

import React,{forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {FolderOpen,Plus,X} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {createWorkflowDirectoryDraft} from '../../utils/workflowDirectoryDraft.mjs';

const control:React.CSSProperties={border:'1px solid #444',borderRadius:4,background:'#252526',color:'#ccc',padding:'3px 5px',fontSize:12,cursor:'pointer'};
export type WorkflowDirectorySettingsHandle={flush:()=>Promise<void>};

export default forwardRef<WorkflowDirectorySettingsHandle,{workflowId:string}>(function WorkflowDirectorySettings({workflowId},ref){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [,render]=useState(0),chooser=useRef<Promise<void>|null>(null),mountedId=useRef(workflowId);
  const modelRef=useRef<any>(null);
  useEffect(()=>()=>{mountedId.current='';},[]);
  if(!modelRef.current || mountedId.current!==workflowId){
    mountedId.current=workflowId;
    const space=useWorkspaceStore.getState().spaces.find(space=>space.id===workflowId) as any;
    modelRef.current=createWorkflowDirectoryDraft({initial:{defaultCwd:space?.defaultCwd || '',promptDirectories:space?.promptDirectories || []},
      apply:(next:any)=>{
        const store=useWorkspaceStore.getState();
        if(mountedId.current!==workflowId || !store.spaces.some(space=>space.id===workflowId))throw Error('Рабочее пространство закрыто.');
        store.updateWorkspaceSpaceMetadata(workflowId,next);
      },
      commit:async()=>{
        const store=useWorkspaceStore.getState();
        if(!store.organizationReady || store.isRestoring)throw Error('Сохранение пока недоступно.');
        const receipt=await store.commitOrganization();
        if(!receipt || receipt.success===false || receipt.ok===false)throw Error('Сохранение не подтверждено.');
        store.saveSession();
      }});
  }
  const model=modelRef.current,draft=model.get();
  const edit=(patch:any)=>{model.edit(patch);setError('');render(value=>value+1);};
  const flush=async()=>{
    setBusy(true);
    try{if(chooser.current)await chooser.current;await model.flush();setError('');}
    catch(e:any){setError(String(e.message || e));throw e;}
    finally{setBusy(false);}
  };
  useImperativeHandle(ref,()=>({flush}));
  const saveOnBlur=()=>{void flush().catch(()=>{});};
  const choose=(index:number|null)=>{
    if(chooser.current)return;
    const id=workflowId;
    const pending=(async()=>{
      const path=await window.require('electron').ipcRenderer.invoke('app:select-directory',{
        defaultPath:index===null?model.get().defaultCwd || undefined:model.get().promptDirectories[index] || undefined});
      if(typeof path!=='string' || mountedId.current!==id || !useWorkspaceStore.getState().spaces.some(space=>space.id===id))return;
      if(index===null)edit({defaultCwd:path});
      else {const paths=model.get().promptDirectories.slice();if(index===paths.length)paths.push(path);else paths[index]=path;edit({promptDirectories:paths});}
    })();
    chooser.current=pending;
    void pending.catch((e:any)=>setError(String(e.message || e))).finally(()=>{
      if(chooser.current===pending)chooser.current=null;
      if(mountedId.current===id)void flush().catch(()=>{});
    });
  };
  const pathInput=(value:string,onChange:(text:string)=>void,label:string)=><input aria-label={label} value={value}
    onChange={event=>onChange(event.target.value)} onBlur={saveOnBlur}
    onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}}
    placeholder="Не задана" style={{...control,flex:1,minWidth:0,cursor:'text'}}/>;
  return <section data-workflow-directories={workflowId} aria-busy={busy} style={{marginTop:8}}>
    <label style={{fontSize:12,color:'#aaa'}}>Основная директория</label>
    <div style={{display:'flex',alignItems:'center',gap:4,marginTop:4}}>
      {pathInput(draft.defaultCwd || '',text=>edit({defaultCwd:text}),'Workflow default directory')}
      <button type="button" aria-label="Choose workflow directory" onClick={()=>choose(null)} style={control}><FolderOpen size={14}/></button>
    </div>
    <div style={{fontSize:12,color:'#aaa',marginTop:8}}>Дополнительные директории</div>
    {draft.promptDirectories.map((path:string,index:number)=><div key={index} style={{display:'flex',alignItems:'center',gap:4,marginTop:4}}>
      {pathInput(path,text=>{const paths=model.get().promptDirectories.slice();paths[index]=text;edit({promptDirectories:paths});},`Additional workflow directory ${index+1}`)}
      <button type="button" aria-label={`Choose additional directory ${index+1}`} style={control} onClick={()=>choose(index)}><FolderOpen size={14}/></button>
      <button type="button" aria-label={`Remove additional directory ${index+1}`} style={control} onClick={()=>{
        edit({promptDirectories:model.get().promptDirectories.filter((_:string,at:number)=>at!==index)});saveOnBlur();
      }}><X size={13}/></button>
    </div>)}
    <button type="button" style={{...control,display:'inline-flex',alignItems:'center',gap:4,marginTop:5}}
      onClick={()=>choose(model.get().promptDirectories.length)}><Plus size={13}/> Добавить директорию</button>
    <div style={{fontSize:11,color:'#888',marginTop:5}}>Промпты из docs этих директорий доступны всем вкладкам рабочего пространства.</div>
    {error&&<div role="alert" style={{fontSize:12,color:'#fca5a5',paddingTop:3}}>{error}</div>}
  </section>;
});

import React,{useCallback,useEffect,useRef,useState} from 'react';
import {FolderPlus,Settings2,RefreshCw} from 'lucide-react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {promptRootChoices,togglePromptRoot,tabPromptBindingRequest,validatePromptRootSnapshot} from '../Workspace/promptTabSourcesModel.mjs';
import DirectoryRootsSettings from './DirectoryRootsSettings';

const control:React.CSSProperties={border:'1px solid #444',borderRadius:4,background:'#252526',color:'#ccc',padding:'3px 5px',fontSize:12,cursor:'pointer'};
const ipc=()=>window.require('electron').ipcRenderer;

function TabSources({tabId,workflowId}:{tabId:string;workflowId:string}){
  const [snapshot,setSnapshot]=useState<any>(null),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [pending,setPending]=useState<any>(null);
  const alive=useRef(true),generation=useRef(0),lock=useRef(false);
  const current=()=>alive.current && useWorkspaceStore.getState().tabWorkflowMembership?.[tabId]?.workflowId===workflowId;
  const load=useCallback(async()=>{
    const n=++generation.current;setBusy(true);setError('');
    try{const value=await ipc().invoke('workflow:tab-roots',tabId);validatePromptRootSnapshot(value);
      if(current()&&n===generation.current){setSnapshot(value);setIds(value.rootIds || []);setPending(null);}}
    catch(e:any){if(current()&&n===generation.current)setError(String(e.message || e));}
    finally{if(current()&&n===generation.current)setBusy(false);}
  },[tabId,workflowId]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;generation.current++;};},[load]);
  const save=async()=>{
    if(lock.current || !snapshot || !current())return;
    const request=pending || tabPromptBindingRequest(snapshot,tabId,ids,crypto.randomUUID());
    lock.current=true;setBusy(true);setError('');setPending(request);
    try{
      const result=await ipc().invoke('project-prompts:set-tab-sources',request);
      if(!current())return;
      if(result?.success!==true){if(result?.success===false)setPending(null);throw Error(result?.error || 'Сохранение не подтверждено');}
      setPending(null);await load();
    }catch(e:any){if(current())setError(String(e.message || e));}
    finally{lock.current=false;if(current())setBusy(false);}
  };
  const add=async()=>{
    if(lock.current || !snapshot || pending || !current())return;
    lock.current=true;setBusy(true);setError('');
    try{
      const folder=await ipc().invoke('app:select-directory');if(!folder || !current())return;
      const existing=snapshot.roots.find((root:any)=>root.path===folder);
      if(existing){setIds(value=>togglePromptRoot(value,existing.id,true));return;}
      const result=await ipc().invoke('workflow:save-root',{path:folder,kind:'prompt-source',enabled:true,expectedRevision:snapshot.revision,mutationId:crypto.randomUUID()});
      if(!current())return;
      const next=await ipc().invoke('workflow:tab-roots',tabId);validatePromptRootSnapshot(next);
      if(!current())return;
      if(!result?.id || next.revision!==result.revision)throw Error('Список папок изменился. Обновите его перед сохранением.');
      setSnapshot(next);setIds(value=>togglePromptRoot(value,result.id,true));
    }catch(e:any){if(current())setError(String(e.message || e));}
    finally{lock.current=false;if(current())setBusy(false);}
  };
  return <div data-workflow-tab-sources={tabId} aria-busy={busy}>
    {snapshot && promptRootChoices(snapshot).map((root:any)=><label key={root.id} title={root.path}
      style={{display:'flex',alignItems:'center',gap:5,padding:'2px 0',fontSize:12,cursor:'pointer'}}>
      <input type="checkbox" data-prompt-source-root-id={root.id} checked={ids.includes(root.id)}
        disabled={busy || !!pending || root.removed&&!ids.includes(root.id)} onChange={event=>setIds(value=>togglePromptRoot(value,root.id,event.target.checked))}/>
      <span style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{root.name || root.sourceName || root.path}</span>
      {(root.removed || root.enabled===false || root.exists===false) && <span style={{color:'#888'}}>{root.removed?'удалена':root.enabled===false?'выключена':'недоступна'}</span>}
    </label>)}
    {!snapshot && busy && <span style={{fontSize:12,color:'#888'}}>Loading…</span>}
    {error && <div role="alert" style={{fontSize:12,color:'#fca5a5',padding:'3px 0'}}>{error}</div>}
    <div style={{display:'flex',gap:4,paddingTop:4}}>
      <button type="button" style={control} disabled={busy || !!pending || !snapshot} onClick={()=>void add()}><FolderPlus size={12} style={{display:'inline'}}/> Add folder</button>
      <button type="button" style={control} disabled={busy || !snapshot} onClick={()=>void save()}>{pending?'Retry':'Save'}</button>
      <button type="button" style={control} disabled={busy || !!pending} onClick={()=>void load()} aria-label="Refresh tab sources"><RefreshCw size={12}/></button>
    </div>
  </div>;
}

export default function WorkflowSourcesSettings({workflowId}:{workflowId:string}){
  const [open,setOpen]=useState(false),[selected,setSelected]=useState(''),[manage,setManage]=useState(false);
  const serialized=useWorkspaceStore(state=>JSON.stringify([...state.openProjects?.values() || []].flatMap(ws=>[...ws.tabs.values()])
    .filter(tab=>tab.tabType!=='file' && state.tabWorkflowMembership?.[tab.id]?.workflowId===workflowId)
    .map(tab=>({id:tab.id,name:tab.name || tab.id}))));
  const tabs: {id:string;name:string}[]=JSON.parse(serialized);
  const tabId=tabs.some(tab=>tab.id===selected)?selected:tabs[0]?.id || '';
  useEffect(()=>{setSelected('');setOpen(false);setManage(false);},[workflowId]);
  return <section data-workflow-sources style={{marginTop:8,borderTop:'1px solid #333',paddingTop:6}}>
    <button type="button" style={{...control,border:0,padding:'2px 0',display:'flex',alignItems:'center',gap:5}} aria-expanded={open} onClick={()=>setOpen(!open)}><Settings2 size={13}/> Sources</button>
    {open && <div style={{paddingTop:5}}>
      {tabs.length>0 ? <><label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,marginBottom:5}}>Tab
        <select aria-label="Tab prompt sources" value={tabId} onChange={event=>setSelected(event.target.value)} style={{...control,minWidth:0,flex:1}}>
          {tabs.map(tab=><option key={tab.id} value={tab.id}>{tab.name}</option>)}
        </select></label><TabSources key={tabId} tabId={tabId} workflowId={workflowId}/></>
        : <div style={{fontSize:12,color:'#888'}}>Нет вкладок для выбора источников.</div>}
      <button type="button" style={{...control,marginTop:6}} aria-expanded={manage} onClick={()=>setManage(!manage)}>Manage folders</button>
      {manage && <DirectoryRootsSettings compact/>}
    </div>}
  </section>;
}

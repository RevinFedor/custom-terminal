import React,{useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {SiSublimetext} from 'react-icons/si';
import gtEditorIcon from '../../assets/workflow-icons/original/gt-editor-original.b64?raw';
import {useUIStore} from '../../store/useUIStore';
import ControlHint from '../UI/ControlHint';

const actionStyle:React.CSSProperties={height:26,minWidth:26,padding:'0 4px',display:'inline-flex',alignItems:'center',
  justifyContent:'center',gap:3,flexShrink:0,border:0,borderRadius:4,background:'transparent',color:'#bbb',cursor:'pointer',fontSize:12,lineHeight:1};
const gtIcon=`data:image/png;base64,${gtEditorIcon.trim()}`;

export default function FilePreviewHeader({path,copied,openingSublime,onCopy,onOpenSublime,onClose}:{
  path:string;copied:boolean;openingSublime:boolean;onCopy:()=>void;onOpenSublime:()=>void;onClose:()=>void;
}) {
  const [opening,setOpening]=useState(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const openGT=async()=>{
    if(opening)return;setOpening(true);
    try {
      const result=await window.require('electron').ipcRenderer.invoke('file:open-in-gt-editor',path);
      if(alive.current && result?.success!==true)useUIStore.getState().showToast(`GT Editor: ${result?.error || 'failed to open file'}`,'error');
    }catch(error:any){if(alive.current)useUIStore.getState().showToast(`GT Editor: ${error?.message || error}`,'error');}
    finally{if(alive.current)setOpening(false);}
  };
  return <div data-file-preview-header style={{display:'flex',alignItems:'center',gap:4,height:30,minHeight:30,flexShrink:0,
    padding:'0 4px 0 6px',borderBottom:'1px solid #333',background:'#292929'}}>
    <span data-file-preview-name title={path} style={{flex:1,minWidth:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontSize:14,fontWeight:600,color:'#ddd'}}>
      {path.split('/').pop() || path}
    </span>
    <div data-file-preview-actions style={{display:'flex',alignItems:'center',gap:2,flexShrink:0}}>
      <ControlHint label="Open in GT Editor"><button type="button" aria-label="Open in GT Editor" disabled={opening} aria-busy={opening || undefined}
        onClick={()=>void openGT()} style={{...actionStyle,cursor:opening?'default':'pointer'}} className="hover:bg-white/10">
        <img src={gtIcon} alt="" draggable={false} width={18} height={18}/>
      </button></ControlHint>
      <ControlHint label="Open in Sublime Text"><button type="button" aria-label="Open in Sublime Text" disabled={openingSublime} aria-busy={openingSublime || undefined}
        onClick={onOpenSublime} style={{...actionStyle,cursor:openingSublime?'default':'pointer'}} className="hover:bg-white/10">
        <SiSublimetext size={17} color="#f39a38" aria-hidden/>
      </button></ControlHint>
      <button type="button" data-file-preview-copy onClick={onCopy} style={{...actionStyle,color:copied?'#b8a6df':'#bbb'}} className="hover:bg-white/10">
        {copied?'✓ Copied':'Copy All'}
      </button>
      <ControlHint label="Close"><button type="button" aria-label="Close file preview" onClick={onClose} style={actionStyle} className="hover:bg-white/10"><X size={17} aria-hidden/></button></ControlHint>
    </div>
  </div>;
}

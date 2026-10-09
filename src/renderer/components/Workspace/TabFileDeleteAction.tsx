import React,{useState} from 'react';
import {Trash2} from 'lucide-react';
import {captureLinkedFileAction,deleteLinkedFile,unlinkLinkedFile} from '../../utils/linkedFileActions';
import {useUIStore} from '../../store/useUIStore';

export default function TabFileDeleteAction({projectId,tabId,style,isCurrent,onDone,unlink=false}:{
  projectId:string;tabId:string;style:React.CSSProperties;isCurrent:()=>boolean;onDone:()=>void;
  unlink?:boolean;
}) {
  const [target]=useState(()=>captureLinkedFileAction(projectId,tabId));
  const [busy,setBusy]=useState(false);
  return <button data-context-menu-row="ordinary" data-tab-context-action={unlink?'unlink-file':'delete-file'}
    className="w-full text-left text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer flex items-center"
    style={{...style,gap:6}} disabled={busy || !target} title={unlink?'Убрать связь, сохранив файл на диске':'Переместить файл в корзину и убрать связь'}
    onClick={async()=>{
      if(busy || !isCurrent())return;
      setBusy(true);
      const result=await (unlink?unlinkLinkedFile(target):deleteLinkedFile(target));
      if(result.ok)onDone();
      else useUIStore.getState().showToast(result.error || 'Удаление не подтверждено','error');
      setBusy(false);
    }}>{!unlink && <Trash2 size={13}/>} {busy?'Удаляем…':unlink?'Unlink File':'Delete File'}</button>;
}

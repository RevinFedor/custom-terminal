import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowGroupMenu, { type WorkflowGlobalGroup, type WorkflowGroupMember, type WorkflowGroupMemberIntent } from '../../src/renderer/components/Workspace/WorkflowGroupMenu';
const f = (window as any).groupFixture = { calls: [], receipts: {}, dismisses: 0, fail: false, lose: false, delay: false };
const initial = (): WorkflowGlobalGroup => ({ id:'g',name:'Ответственность',revision:2,color:'purple',collapsed:true,sessionStatus:'busy',future:{keep:4} });
const initialMembers = (): WorkflowGroupMember[] => [{tabId:'T',namespace:'P'}, {tabId:'U',namespace:'Q'}, {tabId:'V2',namespace:'__tab_catalog_v2__'}, {tabId:'ARCHIVE',namespace:'P',archived:true}];
function Fixture() {
  const [group,setGroup] = useState(initial),[revision,setRevision] = useState(7),[members,setMembers] = useState(initialMembers);
  const [opened,setOpened] = useState(true),[key,setKey] = useState(0),[position,setPosition] = useState({x:220,y:120});
  f.open = (pos = {x:220,y:120}) => { setGroup(initial());setRevision(7);setMembers(initialMembers());setPosition(pos);setKey(x=>x+1);setOpened(true); };
  f.changeMembers = () => setMembers([{tabId:'replacement',namespace:'foreign'}]);
  const run = async (type: string, payload: any) => {
    f.calls.push({type,payload:structuredClone(payload)});
    if(f.delay) await new Promise(resolve=>{f.release=resolve;});
    const mutationId=payload.request?.mutationId || payload.intent?.mutationId;
    if(f.receipts[mutationId]) return f.receipts[mutationId];
    if(f.fail) return {success:false,error:'Изменение отклонено'};
    if(payload.request && (payload.request.expectedRevision!==revision || payload.request.expectedGroupRevision!==group.revision)) return {success:false,error:'stale_revision'};
    f.receipts[mutationId]={success:true};
    if(type==='rename'){setGroup(old=>({...old,name:payload.request.name,revision:old.revision+1}));setRevision(x=>x+1);}
    if(f.lose){f.lose=false;throw new Error('Ответ потерян после commit');}
    return f.receipts[mutationId];
  };
  const close=(exact:WorkflowGroupMember[],current:WorkflowGlobalGroup,intent:WorkflowGroupMemberIntent)=>run('close',{members:exact,group:current,intent});
  return <div style={{padding:24,color:'#aaa',fontFamily:'Arial'}}>
    <p>Приватный пример меню глобальной группы</p><button id="outside">Вне меню</button>
    {opened&&<WorkflowGroupMenu key={key} group={group} revision={revision} members={members}
      position={position} workflows={[{id:'main',name:'Main'},{id:'inbox',name:'Inbox'}]}
      statuses={[{id:'busy',name:'В работе',color:'#eab308'},{id:'done',name:'Готово',color:'#22c55e'}]}
      onMutate={(kind,request)=>run(kind,{request})}
      onMoveMembers={(workflowId,exact,current,intent)=>run('move',{workflowId,members:exact,group:current,intent})}
      onCloseMembers={close} onDismiss={()=>{f.dismisses++;setOpened(false);}} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

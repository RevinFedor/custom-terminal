import React,{useState,useRef,memo} from 'react';
import {createRoot} from 'react-dom/client';
import {useOutlineDnd} from '@noted/structured-dnd/react';
import {FileOutlineExplorer} from '@noted/file-explorer';
import {useCommandHierarchyHint} from '../../src/renderer/hooks/useCommandHierarchyHint';
import '@noted/file-explorer/styles.css';

const f=(window as any).fixture={commits:[],logs:[],renders:0,previewCommands:[],panels:{}};
window.addEventListener('keydown',e=>{if(e.key==='Meta'||e.key==='Shift')f.previewCommands.push({key:e.key,prevented:e.defaultPrevented});});
const initial=()=>[{id:'a',label:'Alpha',children:[]},{id:'b',label:'Beta',children:[]},
  {id:'folder',label:'Folder',kind:'folder',collapsible:true,expanded:false,children:[{id:'child',label:'Inside',children:[]}]},
  {id:'c',label:'Charlie',children:[]}];
function Outline({id,modifier}:{id:string;modifier?:'meta'}) {
  const [outline,setOutline]=useState(initial),[revision,setRevision]=useState(0);
  const dnd=useOutlineDnd({outline,hierarchyModifier:modifier,scopeKey:id+revision,
    outsidePointerPolicy:'horizontal-corridor',
    onCommit:p=>{f.commits.push({id,source:p.sourceId,tree:p.previewOutline});setOutline(p.previewOutline);},
    onExpansionRequest:({nodeId,expanded})=>setOutline(items=>items.map(n=>n.id===nodeId?{...n,expanded}:n)),
    onLog:event=>{if(!['layout-animation'].includes(event.type))f.logs.push({id,...event});}});
  useCommandHierarchyHint(dnd.scrollerRef,modifier==='meta');
  f.panels[id]={reset:()=>{setOutline(initial());setRevision(n=>n+1);},state:()=>dnd.dragState};
  const nodes=new Map();const visit=(tree:any[])=>tree.forEach(n=>{nodes.set(n.id,n);visit(n.children||[]);});visit(dnd.previewOutline);
  f.renders++;
  return <section data-panel={id}><header>{id}</header><div ref={dnd.scrollerRef} style={{height:300,overflow:'auto',padding:12}}>
    {dnd.rows.map(row=><div key={row.id} {...dnd.getRowProps(row)} style={{marginLeft:row.depth*18,marginBottom:4,
      height:32,boxSizing:'border-box',border:'1px solid #657080',borderRadius:5,background:'#28303a',padding:'5px 8px'}}>
      <span>{nodes.get(row.id).label}</span>
      {dnd.dragState?.sourceId===row.id&&dnd.dragState.feedback && <span data-feedback>{dnd.dragState.feedback.direction}{dnd.dragState.feedback.blocked?' blocked':''}</span>}
    </div>)}<div {...dnd.scrollSpacerProps}/>
  </div></section>;
}
function Files(){
  const [layout,setLayout]=useState(null),root=useRef<HTMLDivElement>(null);
  useCommandHierarchyHint(root);
  const treeData=[{id:'/fixture/one.md',name:'one.md',isDirectory:false},{id:'/fixture/two.md',name:'two.md',isDirectory:false},
    {id:'/fixture/folder',name:'folder',isDirectory:true,children:[{id:'/fixture/folder/nested.md',name:'nested.md',isDirectory:false}]}];
  return <section ref={root} data-panel="file-explorer"><header>Terminal file explorer</header>
    <FileOutlineExplorer hierarchyModifier="meta" treeData={treeData} folderPath="/fixture" sidebarLayout={layout}
      initialExpanded={{'/fixture/folder':true}} onApplySidebarLayout={next=>{f.commits.push({id:'file-explorer',layout:next});setLayout(next);}}
      onMoveItems={()=>{throw Error('Fixture has no filesystem transport');}} onFileSelect={()=>{}}/>
  </section>;
}
const Retained=memo(()=>{f.retainedRenders=(f.retainedRenders||0)+1;return <div data-retained style={{display:'none'}}>
  {Array.from({length:2000},(_,i)=><span key={i}>Retained {i}</span>)}</div>;});
createRoot(document.getElementById('root')!).render(<><div style={{display:'flex',gap:20}}>
  <Outline id="terminal" modifier="meta"/><Outline id="legacy"/><Files/></div><Retained/>
  <button data-outside>Outside standalone action</button></>);

import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import Tooltip from '../../src/renderer/components/UI/Tooltip';
import {useCmdKey,useCmdHoverPopover} from '../../src/renderer/hooks/useCmdHoverPopover';
import {useCommandHierarchyHint} from '../../src/renderer/hooks/useCommandHierarchyHint';

const metrics=(window as any).cmdFeedback={tooltipRenders:0,ownerRenders:0,keys:[]};
window.addEventListener('keydown',event=>{if(event.key==='Meta'||event.key==='Shift')metrics.keys.push({key:event.key,prevented:event.defaultPrevented});});
function Owner({id}:{id:number}) {
  const [hovered,setHovered]=useState(false),held=useCmdKey(hovered);
  metrics.ownerRenders++;
  return <section data-owner={id} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}>
    <span data-local-mode={held}>Owner {id}</span>
    {Array.from({length:40},(_,i)=><Tooltip key={i} interactive={i===0} content={`Help ${id}:${i}`}>
      <button data-tip={`${id}:${i}`}>Control {i}</button>
    </Tooltip>)}
  </section>;
}
function Pinned() {
  const held=useCmdKey(),popover=useCmdHoverPopover<string>(held);
  return <><button data-pin-trigger {...popover.triggerProps('pin')}>Pin</button>
    {popover.isVisible&&<div data-cmd-hover-popover data-pin-body {...popover.popoverProps}>Pinned={String(popover.isLocked)}</div>}</>;
}
function App() {
  const root=useRef<HTMLDivElement>(null);useCommandHierarchyHint(root);
  return <><div ref={root} data-outline-host><div data-node-id="a" data-outline-hierarchy-modifier="meta" data-outline-dnd-row>
    <span data-hover-label>Hover then Cmd</span><button data-no-drag>Separate</button>
  </div></div><Owner id={0}/><Pinned/><button data-outside>Outside</button>
    <div data-retained style={{position:'absolute',left:0,top:500,opacity:0,pointerEvents:'none',height:100,overflow:'hidden'}}>
      {Array.from({length:31},(_,i)=><Owner key={i} id={i+1}/>)}
    </div></>;
}
const root=createRoot(document.getElementById('root')!);let generation=0;
metrics.reset=()=>root.render(<App key={++generation}/>);
root.render(<App/>);

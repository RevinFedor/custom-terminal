import React,{useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {readPaneTabStripChips} from '../../utils/paneTabStripGeometry.mjs';
import {buildPaneStripGroupOutlines} from '../../utils/paneStripGroupOutline.mjs';
import {resolveTabCardMetrics} from '../../utils/tabCardVisual.mjs';
import {useUIStore} from '../../store/useUIStore';

export type PaneStripColorGroup={id:string;color:string;tabIds:string[];revision?:number};
type Rect={left:number;right:number;top:number;bottom:number};
const box=(rect:DOMRect,origin:DOMRect):Rect=>({left:rect.left-origin.left,right:rect.right-origin.left,top:rect.top-origin.top,bottom:rect.bottom-origin.top});

/** Shared chip geometry plus an explicit child file-chip read. Only an owned
 * layout/resize/child-list invalidation schedules one coalesced observation.
 * No pointer listener, per-move scan, catalog serialization or store geometry. */
export default function PaneStripGroupOutline({rootRef,scrollerRef,entriesKey,layoutKey='',groups,presented=true}: {
  rootRef:React.RefObject<HTMLDivElement|null>;scrollerRef:React.RefObject<HTMLDivElement|null>;
  entriesKey:string;layoutKey?:string;groups:PaneStripColorGroup[];presented?:boolean;
}) {
  const [layout,setLayout]=useState<{chips:any[];rows:any[];entriesKey:string;layoutKey:string}>({chips:[],rows:[],entriesKey:'',layoutKey:''});
  const lastSignature=useRef('');
  const clipPrefix=useId().replace(/:/g,'');
  const configuredRadius=useUIStore(state=>state.tabGeometry.borderRadius);
  const radius=resolveTabCardMetrics({borderRadius:configuredRadius}).borderRadius;
  const enabled=presented&&groups.length>0;
  useLayoutEffect(()=>{
    const root=rootRef.current,strip=scrollerRef.current;
    if(!enabled||!root||!strip)return;
    let retired=false,frame:number|null=null;
    const measure=()=>{
      frame=null;if(retired||!root.isConnected||!strip.isConnected)return;
      const origin=root.getBoundingClientRect();
      const boxes=readPaneTabStripChips(strip);
      const nodes=new Map(Array.from(strip.querySelectorAll<HTMLElement>('[data-strip-item]'),node=>[node.dataset.stripTabId,node]));
      const chips=boxes.map(rect=>{
        const node=nodes.get(rect.id),card=node?.querySelector<HTMLElement>('[data-tab-card]');
        return {...rect,left:rect.left-origin.left,right:rect.right-origin.left,top:rect.top-origin.top,bottom:rect.bottom-origin.top,
          card:card?box(card.getBoundingClientRect(),origin):undefined,
          files:Array.from(node?.querySelectorAll<HTMLElement>('[data-tab-linked-files]')||[],file=>box(file.getBoundingClientRect(),origin))};
      });
      const header=root.closest('[data-split-attach-row]'),bounds=header?.getBoundingClientRect();
      const actions=header?.querySelector<HTMLElement>('[data-split-pane-actions]')?.getBoundingClientRect();
      // Continuation reaches the pane divider, including the header padding.
      // The first row still stops before its reserved window actions.
      const left=bounds?bounds.left-origin.left:0,right=bounds?bounds.right-origin.left:origin.width;
      const rows=[...new Set(chips.map(chip=>chip.top))].map(top=>({top,left,
        right:actions&&origin.top+top<actions.bottom&&origin.top+top>=actions.top-1?Math.min(right,actions.left-origin.left):right}));
      const signature=JSON.stringify({chips,rows,entriesKey,layoutKey});
      if(signature!==lastSignature.current){lastSignature.current=signature;setLayout({chips,rows,entriesKey,layoutKey});}
    };
    const invalidate=()=>{if(!retired&&frame===null)frame=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(invalidate);
    const targets=new Set<Element>();
    const bind=()=>{
      const next=new Set<Element>([root,strip,...strip.querySelectorAll('[data-strip-item],[data-tab-linked-files]')]);
      for(const target of targets)if(!next.has(target)){observer.unobserve(target);targets.delete(target);}
      for(const target of next)if(!targets.has(target)){observer.observe(target);targets.add(target);}
      invalidate();
    };
    bind();
    // File hover can scale its existing chip without a border-box resize.
    // Observe that one publication, never pointer moves or arbitrary styles.
    const mutations=new MutationObserver(bind);mutations.observe(strip,{childList:true,subtree:true,
      attributes:true,attributeFilter:['data-linked-files-hovered']});
    window.addEventListener('resize',invalidate);
    window.addEventListener('scroll',invalidate,true);
    return()=>{retired=true;if(frame!==null)cancelAnimationFrame(frame);mutations.disconnect();observer.disconnect();
      window.removeEventListener('resize',invalidate);window.removeEventListener('scroll',invalidate,true);};
  },[enabled,entriesKey,layoutKey,rootRef,scrollerRef]);
  const outlines=useMemo(()=>buildPaneStripGroupOutlines({...layout,groups,radius}),[layout,groups,radius]);
  if(!enabled||layout.entriesKey!==entriesKey||layout.layoutKey!==layoutKey)return null;
  return <svg data-pane-strip-group-outlines aria-hidden="true"
    style={{position:'absolute',inset:0,width:'100%',height:'100%',overflow:'visible',pointerEvents:'none',zIndex:10}}>
    <defs>{outlines.map((outline,index)=>outline.clip&&<clipPath key={outline.id} id={`${clipPrefix}-${index}`} clipPathUnits="userSpaceOnUse">
      <rect x={outline.clip.left} y={outline.clip.top} width={outline.clip.right-outline.clip.left} height={outline.clip.bottom-outline.clip.top}/>
    </clipPath>)}</defs>
    {outlines.map((outline,index)=><g key={outline.id} data-pane-strip-color-group={outline.groupId} fill="none" stroke={outline.color} strokeWidth="1" strokeLinecap="round"
      clipPath={outline.clip?`url(#${clipPrefix}-${index})`:undefined}>
      <path d={outline.solid}/>{outline.dashed&&<path d={outline.dashed} strokeDasharray="3 3"/>}
    </g>)}
  </svg>;
}

import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
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
export default function PaneStripGroupOutline({rootRef,scrollerRef,entriesKey,layoutKey='',groups,presented=true,onMeasured}: {
  rootRef:React.RefObject<HTMLElement|null>;scrollerRef:React.RefObject<HTMLElement|null>;
  entriesKey:string;layoutKey?:string;groups:PaneStripColorGroup[];presented?:boolean;
  onMeasured?:(chips:Array<{id:string;left:number;right:number;top:number;bottom:number}>)=>void;
}) {
  const [layout,setLayout]=useState<{chips:any[];entriesKey:string;layoutKey:string}>({chips:[],entriesKey:'',layoutKey:''});
  const lastSignature=useRef('');
  const measuredCallback=useRef(onMeasured);measuredCallback.current=onMeasured;
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
      const signature=JSON.stringify({chips,entriesKey,layoutKey});
      if(signature!==lastSignature.current){lastSignature.current=signature;setLayout({chips,entriesKey,layoutKey});measuredCallback.current?.(chips);}
    };
    const invalidate=()=>{if(!retired&&frame===null)frame=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(invalidate);
    const targets=new Set<Element>();
    const bind=()=>{
      const next=new Set<Element>([root,strip,...strip.querySelectorAll('[data-strip-item],[data-tab-linked-files]')]);
      for(const target of targets)if(!next.has(target)){observer.unobserve(target);targets.delete(target);}
      for(const target of next)if(!targets.has(target)){observer.observe(target);targets.add(target);}
    };
    bind();
    // A committed layout key must get its matching contour before paint. Waiting
    // for rAF while render rejects the previous key produces a blank frame.
    measure();
    // File hover can scale its existing chip without a border-box resize.
    // Observe that one publication, never pointer moves or arbitrary styles.
    const mutations=new MutationObserver(records=>{
      const relevant=records.some(record=>{
        const target=record.target as Element;
        if(target.closest?.('[data-pane-strip-group-outlines]'))return false;
        const group=target.closest?.('[data-pane-strip-collapsed-group]');
        // Nested absolute groups own their contour; opening them changes no
        // neighbouring flow box. Their SVG/hover mutations are not our layout.
        return !group||group===strip;
      });
      if(relevant){bind();invalidate();}
    });mutations.observe(strip,{childList:true,subtree:true,
      attributes:true,attributeFilter:['data-linked-files-hovered','data-linked-files-opening']});
    window.addEventListener('resize',invalidate);
    window.addEventListener('scroll',invalidate,true);
    return()=>{retired=true;if(frame!==null)cancelAnimationFrame(frame);mutations.disconnect();observer.disconnect();
      window.removeEventListener('resize',invalidate);window.removeEventListener('scroll',invalidate,true);};
  },[enabled,entriesKey,layoutKey,rootRef,scrollerRef]);
  const outlines=useMemo(()=>buildPaneStripGroupOutlines({...layout,groups,radius}),[layout,groups,radius]);
  if(!enabled||layout.entriesKey!==entriesKey||layout.layoutKey!==layoutKey)return null;
  return <svg data-pane-strip-group-outlines aria-hidden="true"
    style={{position:'absolute',inset:0,width:'100%',height:'100%',overflow:'visible',pointerEvents:'none',zIndex:10}}>
    {outlines.map(outline=><g key={outline.id} data-pane-strip-color-group={outline.groupId} fill="none" stroke={outline.color} strokeWidth="1" strokeLinecap="butt">
      <path d={outline.solid}/>
    </g>)}
  </svg>;
}

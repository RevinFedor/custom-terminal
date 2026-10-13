import {useLayoutEffect,useState,type RefObject} from 'react';

// One cap/descender envelope per font: names and attachment counts must not
// create different card heights within the same strip/sidebar.
export const TAB_TITLE_GLYPHS='HРрgjpqy';
type FontProfile={ascent:number;descent:number;baseline:number;lineHeight:number};
type FontCache={profiles:Map<string,FontProfile>;context?:CanvasRenderingContext2D;defaultFont?:string};
const caches=new WeakMap<Document,FontCache>();

function fontProfile(element:HTMLElement):FontProfile|null {
  if(!element.isConnected)return null;
  const doc=element.ownerDocument,style=getComputedStyle(element);
  if(!(Number.parseFloat(style.fontSize)>0))return null;
  const font=style.font||[style.fontStyle,style.fontWeight,style.fontSize,style.fontFamily].join(' ');
  const key=font+'|'+style.lineHeight;
  let cache=caches.get(doc);
  if(!cache){cache={profiles:new Map()};caches.set(doc,cache);doc.fonts?.addEventListener('loadingdone',()=>cache!.profiles.clear());}
  // The glyphs still get fresh metrics on every measurement. Only the private
  // canvas/context is reused, avoiding one new canvas per retained title/RO.
  // Explicitly set font again so font loading and inherited font changes keep
  // the same refresh path. A lost/unavailable context can recover next time.
  let context=cache.context;
  if(!context||context.isContextLost?.()){
    context=doc.createElement('canvas').getContext('2d')||undefined;
    if(!context)return null;
    cache.context=context;
    cache.defaultFont=context.font;
  }
  // Canvas ignores an unsupported font assignment. Reset its original default
  // first, so a rejected value cannot inherit the preceding title's font.
  context.font=cache.defaultFont!;
  context.font=font;
  const ink=context.measureText(TAB_TITLE_GLYPHS);
  const saved=cache.profiles.get(key);if(saved)return {...saved,ascent:ink.actualBoundingBoxAscent,descent:ink.actualBoundingBoxDescent};
  // One tiny baseline probe per font profile, outside application layout.
  // No measurement is scheduled by hover, pointer movement or unrelated saves.
  const probe=doc.createElement('span'),baseline=doc.createElement('span');
  Object.assign(probe.style,{position:'fixed',top:'0',left:'-10000px',display:'inline-block',
    visibility:'hidden',pointerEvents:'none',contain:'layout style',font,
    lineHeight:style.lineHeight,whiteSpace:'nowrap',padding:'0',margin:'0',border:'0'});
  Object.assign(baseline.style,{display:'inline-block',width:'0',height:'0',verticalAlign:'baseline'});
  probe.append(TAB_TITLE_GLYPHS,baseline);doc.body.append(probe);
  let result:FontProfile;
  try{const rect=probe.getBoundingClientRect();result={ascent:ink.actualBoundingBoxAscent,
    descent:ink.actualBoundingBoxDescent,baseline:baseline.getBoundingClientRect().top-rect.top,
    lineHeight:Number.parseFloat(style.lineHeight)||rect.height};}
  finally{probe.remove();}
  if(!Number.isFinite(result.ascent+result.descent+result.baseline)||result.ascent<=0)return null;
  cache.profiles.set(key,result);return result;
}

export function linkedTitleLayout(profile:FontProfile,{paddingY,gap,chipHeight}:{paddingY:number;gap:number;chipHeight:number}) {
  const inkHeight=profile.ascent+profile.descent;
  // The title moves 1px down from the previous 1px top inset. Let the chip
  // paint above touching descenders, and use the WHOLE configured row gap.
  // Its bottom stays exactly 1px before the next card, even with large padding.
  const overhang=Math.max(0,gap)-1;
  const height=Math.max(Math.ceil(profile.lineHeight+2*paddingY+2),Math.ceil(3+inkHeight+chipHeight-overhang));
  const chipTop=height+overhang-chipHeight,inkTop=chipTop-inkHeight;
  return {height,chipTop:chipTop-1, // absolute positioning starts inside the border
    titleOffset:inkTop+profile.ascent-((height-profile.lineHeight)/2+profile.baseline),
    titleCenter:inkTop+inkHeight/2-1,inkHeight,overhang};
}

export function useLinkedTitleLayout(ref:RefObject<HTMLElement|null>,enabled:boolean,
  options:{text:string;fontSize:number;paddingY:number;gap:number;chipHeight:number;fontWeight?:string|number;fontFamily?:string}) {
  const [layout,setLayout]=useState<ReturnType<typeof linkedTitleLayout>|null>(null);
  const {text,fontSize,paddingY,gap,chipHeight,fontWeight,fontFamily}=options;
  useLayoutEffect(()=>{
    if(!enabled){setLayout(null);return;}
    let alive=true;
    const measure=()=>{
      const element=ref.current;if(!alive||!element)return;
      const profile=fontProfile(element);if(!profile)return;
      const next=linkedTitleLayout(profile,{paddingY,gap,chipHeight});
      setLayout(previous=>previous&&(Object.keys(next) as Array<keyof typeof next>).every(key=>previous[key]===next[key])?previous:next);
    };
    measure();const fonts=ref.current?.ownerDocument.fonts;
    // Retained/portalled headers can settle their inherited font after mount.
    // The title's own size changes then; transform/hover does not retrigger RO.
    const observer=new ResizeObserver(measure);
    if(ref.current)observer.observe(ref.current);
    fonts?.addEventListener('loadingdone',measure);
    return()=>{alive=false;observer.disconnect();fonts?.removeEventListener('loadingdone',measure);};
  },[ref,enabled,text,fontSize,paddingY,gap,chipHeight,fontWeight,fontFamily]);
  return enabled?layout:null;
}

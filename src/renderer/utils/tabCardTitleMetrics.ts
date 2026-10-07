import {useLayoutEffect,useState,type RefObject} from 'react';

// Use cap height and descenders even in a lowercase title. Accents/other scripts
// in the actual name extend that envelope only when they really occur.
export const TAB_TITLE_GLYPHS='HРрgjpqy';
type FontProfile={ascent:number;descent:number;baseline:number;lineHeight:number};
const caches=new WeakMap<Document,Map<string,FontProfile>>();

function fontProfile(element:HTMLElement,text:string):FontProfile|null {
  if(!element.isConnected)return null;
  const doc=element.ownerDocument,style=getComputedStyle(element);
  if(!(Number.parseFloat(style.fontSize)>0))return null;
  const font=style.font||[style.fontStyle,style.fontWeight,style.fontSize,style.fontFamily].join(' ');
  const key=font+'|'+style.lineHeight;
  let cache=caches.get(doc);
  if(!cache){cache=new Map();caches.set(doc,cache);doc.fonts?.addEventListener('loadingdone',()=>cache!.clear());}
  const canvas=doc.createElement('canvas'),context=canvas.getContext('2d');if(!context)return null;
  context.font=font;
  const ink=context.measureText(TAB_TITLE_GLYPHS+text);
  const saved=cache.get(key);if(saved)return {...saved,ascent:ink.actualBoundingBoxAscent,descent:ink.actualBoundingBoxDescent};
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
  cache.set(key,result);return result;
}

export function linkedTitleLayout(profile:FontProfile,{paddingY,gap,chipHeight}:{paddingY:number;gap:number;chipHeight:number}) {
  const inkHeight=profile.ascent+profile.descent;
  // Border + 1px above the highest glyph; 1px below the lowest glyph.
  const inkTop=2,chipTop=inkTop+inkHeight+1;
  const overhang=Math.min(Math.max(0,gap-1),Math.floor(chipHeight/3));
  const height=Math.max(profile.lineHeight+2*paddingY+2,Math.ceil(chipTop+chipHeight-overhang));
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
      const profile=fontProfile(element,text);if(!profile)return;
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

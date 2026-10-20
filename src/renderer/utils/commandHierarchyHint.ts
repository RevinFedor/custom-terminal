import {currentUIActionId,uiPerformancePhaseForAction} from './uiPerformanceDiagnostics.mjs';

// A single, passive pointer presentation owner. No React/store broadcast on
// Meta: only the hovered outline's small out-of-flow badge changes.
const roots = new Set<HTMLElement>();
let stop: (()=>void) | null = null;
let refresh: (()=>void) | null = null;

function install() {
  let held=false,point:{x:number;y:number}|null=null,badge:HTMLDivElement|null=null,ownerId='';
  const hide=()=>{badge?.remove();badge=null;ownerId='';};
  const paint=()=>{
    if(!held || !point){hide();return;}
    const hitStart=performance.now();
    const hit=document.elementFromPoint(point.x,point.y);
    const hitTestMs=performance.now()-hitStart;
    const row=hit?.closest<HTMLElement>('[data-outline-hierarchy-modifier="meta"]');
    if(!row || ![...roots].some(root=>root.isConnected&&root.contains(row))
      || hit?.closest('input,textarea,select,[contenteditable="true"],[data-no-drag],[data-tab-linked-files],button:not([data-tab-card])')){hide();return hitTestMs;}
    if(!badge){
      badge=document.createElement('div');badge.dataset.commandHierarchyHint='true';badge.setAttribute('aria-hidden','true');
      badge.textContent='⌘ ↔ ⤷';badge.title='Изменить вложенность';
      Object.assign(badge.style,{position:'fixed',left:'0',top:'0',zIndex:'100050',pointerEvents:'none',
        padding:'2px 5px',borderRadius:'4px',background:'#191b22f2',color:'#c4d9ff',font:'12px/16px system-ui',
        whiteSpace:'nowrap',boxShadow:'0 1px 4px #0008',contain:'layout paint style'});
      document.body.appendChild(badge);
    }
    ownerId=row.dataset.nodeId || '';badge.dataset.owner=ownerId;
    badge.style.transform=`translate3d(${Math.max(0,Math.min(innerWidth-70,point.x+14))}px,${Math.max(0,Math.min(innerHeight-24,point.y+16))}px,0)`;
    return hitTestMs;
  };
  const move=(event:PointerEvent)=>{
    point={x:event.clientX,y:event.clientY};
    // Visible unfocused windows receive hover but may never receive the keyup
    // sent to another application. Each pointer event carries current truth.
    held=event.metaKey;paint();
  };
  const key=(event:KeyboardEvent)=>{if(event.key==='Meta'){
    const actionId=currentUIActionId(),started=performance.now();
    held=event.type==='keydown';const hitTestMs=paint() || 0;
    uiPerformancePhaseForAction(actionId,'command-hierarchy-feedback',{held,shown:!!badge,ownerId,hitTestMs,ms:performance.now()-started});
  }};
  const blur=()=>{held=false;point=null;hide();};
  const leave=(event:PointerEvent)=>{if(!event.relatedTarget){point=null;hide();}};
  window.addEventListener('pointermove',move,true);
  window.addEventListener('pointerover',move,true);
  window.addEventListener('pointerout',leave,true);
  window.addEventListener('keydown',key,true);window.addEventListener('keyup',key,true);
  window.addEventListener('blur',blur);window.addEventListener('pointercancel',blur,true);
  window.addEventListener('scroll',paint,true);
  refresh=paint;
  return ()=>{
    hide();refresh=null;
    window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerover',move,true);
    window.removeEventListener('pointerout',leave,true);window.removeEventListener('keydown',key,true);
    window.removeEventListener('keyup',key,true);window.removeEventListener('blur',blur);
    window.removeEventListener('pointercancel',blur,true);
    window.removeEventListener('scroll',paint,true);
  };
}

export function registerCommandHierarchyHint(root:HTMLElement) {
  roots.add(root);stop ||= install();
  return ()=>{roots.delete(root);if(!roots.size){stop?.();stop=null;}else refresh?.();};
}

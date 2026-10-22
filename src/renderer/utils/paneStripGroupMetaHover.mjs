import {paneStripGroupMetaStep} from './paneStripCollapseModel.mjs';
// Only the actually hovered group owns these listeners. Retained panels do not
// subscribe to modifier React state or receive a global key publication.
let active=null;
export function ownPaneStripGroupMetaHover(owner,toggle,target=window,isInside=null) {
  if(active?.owner===owner)return active.release;
  active?.release();let key={};
  const down=event=>{key=paneStripGroupMetaStep(key,{type:'down',key:event.key,repeat:event.repeat});};
  const up=event=>{key=paneStripGroupMetaStep(key,{type:'up',key:event.key});if(key.toggle)toggle();};
  const pointer=()=>{key=paneStripGroupMetaStep(key,{type:'pointer'});};
  const blur=()=>{key={};release();};
  const move=event=>{if(isInside&&!isInside(event))release();};
  const release=()=>{target.removeEventListener('keydown',down,true);target.removeEventListener('keyup',up,true);
    target.removeEventListener('pointerdown',pointer,true);target.removeEventListener('blur',blur);
    if(isInside)target.removeEventListener('mousemove',move);
    if(active?.release===release)active=null;};
  target.addEventListener('keydown',down,true);target.addEventListener('keyup',up,true);
  target.addEventListener('pointerdown',pointer,true);target.addEventListener('blur',blur);
  if(isInside)target.addEventListener('mousemove',move);
  active={owner,release};return release;
}

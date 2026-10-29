import {CHIP_HOVER_MS} from './chipHoverIntent.mjs';

export const PANE_STRIP_BADGE_HOVER_ANIMATION='pane-strip-badge-hover-intent';

/** Badge-only finite intent. No store subscription, DOM inventory or frame loop.
 * Like the linked-file chip, animationend is the finite intent clock. */
export function createPaneStripBadgeHover({target,getControl,isInstant,publish=(_active)=>{},phase=(_phase)=>{},now=()=>performance.now()}) {
  let pending=null;
  const cancel=()=>{
    const old=pending;pending=null;
    if(!old)return;
    old.node.removeAttribute('data-group-badge-opening');old.release();publish(false);phase('cancelled');
  };
  const enter=node=>{
    cancel();const control=getControl();
    if(!control||control.available===false||control.count<1||control.open||control.busy)return;
    const groupId=control.groupId,revision=control.revision;
    const valid=()=>{const now=getControl();return !!node?.isConnected&&node.matches(':hover')
      &&now?.groupId===groupId&&now?.revision===revision&&now.available!==false&&now.count>0&&!now.open&&!now.busy;};
    if(isInstant()){if(valid()){phase('instant');getControl().hover();}return;}
    const intent={node,valid,startedAt:now(),release:()=>{}};pending=intent;
    const escape=event=>{if(event.key==='Escape')cancel();};
    target.addEventListener('pointerdown',cancel,true);target.addEventListener('keydown',escape,true);target.addEventListener('blur',cancel);
    intent.release=()=>{target.removeEventListener('pointerdown',cancel,true);target.removeEventListener('keydown',escape,true);target.removeEventListener('blur',cancel);};
    node.setAttribute('data-group-badge-opening','1');publish(true);phase('started');
  };
  const finish=event=>{
    const intent=pending;
    if(!intent||event.target!==intent.node||event.currentTarget!==intent.node
      ||event.animationName!==PANE_STRIP_BADGE_HOVER_ANIMATION||now()-intent.startedAt<CHIP_HOVER_MS)return;
    if(!intent.valid()){cancel();return;}
    pending=null;intent.node.removeAttribute('data-group-badge-opening');intent.release();publish(false);
    phase('completed');getControl().hover();
  };
  return {enter,cancel,finish};
}

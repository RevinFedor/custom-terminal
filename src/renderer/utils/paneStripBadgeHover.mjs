import {beginNavigationDwell} from './navigationDwell.mjs';

/** Badge-only finite intent. No store subscription, DOM inventory or frame loop.
 * Reading metadata/hover at the deadline does not manufacture readiness. */
export function createPaneStripBadgeHover({target,getControl,isInstant,publish,phase=(_phase)=>{}}) {
  let pending=null;
  const cancel=()=>{
    const old=pending;pending=null;
    if(!old)return;
    old.stop?.();old.release?.();publish(false);phase('cancelled');
  };
  const enter=node=>{
    cancel();const control=getControl();
    if(!control||control.available===false||control.count<1||control.open||control.busy)return;
    const groupId=control.groupId,revision=control.revision;
    const valid=()=>{const now=getControl();return !!node?.isConnected&&node.matches(':hover')
      &&now?.groupId===groupId&&now?.revision===revision&&now.available!==false&&now.count>0&&!now.open&&!now.busy;};
    if(isInstant()){if(valid()){phase('instant');getControl().hover();}return;}
    const intent={};pending=intent;publish(true);phase('started');
    const escape=event=>{if(event.key==='Escape')cancel();};
    target.addEventListener('pointerdown',cancel,true);target.addEventListener('keydown',escape,true);target.addEventListener('blur',cancel);
    intent.release=()=>{target.removeEventListener('pointerdown',cancel,true);target.removeEventListener('keydown',escape,true);target.removeEventListener('blur',cancel);};
    intent.stop=beginNavigationDwell({schedule:(fn,ms)=>target.setTimeout(fn,ms),cancel:id=>target.clearTimeout(id),
      isCurrent:()=>{if(pending===intent&&valid())return true;cancel();return false;},
      onComplete:()=>{if(pending!==intent)return;pending=null;intent.release();publish(false);phase('completed');getControl().hover();}});
  };
  return {enter,cancel};
}

const registries=new WeakMap();
/** One event owner, enrolled only while there are local selections. It consumes
 * the existing drag signal; no pointer geometry, store subscription or polling. */
export function registerPaneStripOutsideSelection({target,ownerKey,containsChip,clear,isDragging,subscribeDrag}) {
  let registry=registries.get(target);
  if(!registry) {
    const entries=new Set();let dragSincePress=false,releaseDrag=null;
    const noteDrag=()=>{if(isDragging())dragSincePress=true;};
    const press=()=>{dragSincePress=isDragging();};
    const nativeDrag=()=>{dragSincePress=true;};
    const click=event=>{
      if(event.button!==0||event.metaKey||event.shiftKey||event.altKey||event.ctrlKey||dragSincePress||isDragging())return;
      const chip=event.target?.closest?.('[data-split-pane-tab-chip]');
      const menu=event.target?.closest?.('[data-pane-strip-selection-owner]');
      for(const item of [...entries]) {
        if(chip&&item.containsChip(chip))continue;
        if(menu?.dataset?.paneStripSelectionOwner===item.ownerKey)continue;
        item.clear();
      }
    };
    registry={entries,start(){noteDrag();releaseDrag=subscribeDrag(noteDrag);
      target.addEventListener('pointerdown',press,true);target.addEventListener('dragstart',nativeDrag,true);target.addEventListener('click',click,true);},
      stop(){releaseDrag?.();target.removeEventListener('pointerdown',press,true);target.removeEventListener('dragstart',nativeDrag,true);target.removeEventListener('click',click,true);}};
    registries.set(target,registry);
  }
  const item={ownerKey,containsChip,clear};registry.entries.add(item);
  if(registry.entries.size===1)registry.start();
  return()=>{registry.entries.delete(item);if(!registry.entries.size){registry.stop();registries.delete(target);}};
}

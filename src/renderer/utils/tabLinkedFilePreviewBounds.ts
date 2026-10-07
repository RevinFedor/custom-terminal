import { useLayoutEffect } from 'react';

/** Scope the existing reader below the header's visual edge. Absolute file
 * chips may overhang without increasing the strip's layout height. */
export function useTabLinkedFilePreviewBounds(preview: { ownerTabId?: string } | null) {
  useLayoutEffect(() => {
    if (!preview?.ownerTabId) return;
    const selector = `[data-split-pane-tab-chip][data-tab-id="${CSS.escape(preview.ownerTabId)}"][data-pane-chip-preview-only="0"]`;
    const card = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(node => node.getBoundingClientRect().width > 0);
    const header = card?.closest<HTMLElement>('[data-split-attach-row]');
    const view = card?.closest<HTMLElement>('[data-terminal-pane-chrome-host]')
      || card?.closest<HTMLElement>('[data-workspace-center]');
    const reader = document.querySelector<HTMLElement>('[data-file-preview-root]');
    if (!header || !view || !reader) return;
    const place = () => {
      const bounds = view.getBoundingClientRect();
      const chips = Array.from(header.querySelectorAll<HTMLElement>('[data-tab-linked-files]'));
      const rectangles = chips.map(chip => chip.getBoundingClientRect()).filter(rect => rect.width > 0);
      const edge = Math.max(header.getBoundingClientRect().bottom, ...rectangles.map(rect => rect.bottom));
      reader.dataset.linkedFileView = preview.ownerTabId;
      const values = {left:bounds.left,top:edge,width:bounds.width,height:Math.max(0,bounds.bottom-edge)};
      for (const [field,value] of Object.entries(values)) {
        const key=`--linked-file-preview-${field}`,text=`${value}px`;
        if(reader.style.getPropertyValue(key)!==text)reader.style.setProperty(key,text);
      }
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(header); observer.observe(view);
    const observedChips=new Set<HTMLElement>();
    let frame=0;
    const observeChips=()=>{
      const current=new Set(header.querySelectorAll<HTMLElement>('[data-tab-linked-files]'));
      for(const chip of observedChips)if(!current.has(chip)){observer.unobserve(chip);observedChips.delete(chip);}
      for(const chip of current)if(!observedChips.has(chip)){observer.observe(chip);observedChips.add(chip);}
      // Do not force layout inside a mutation observer after another owner's
      // style writes. Coalesce structural/header edits before the next paint.
      if(!frame)frame=requestAnimationFrame(()=>{frame=0;place();});
    };
    observeChips();
    const children=new MutationObserver(observeChips);children.observe(header,{childList:true,subtree:true});
    window.addEventListener('resize', place);
    return () => {
      if(frame)cancelAnimationFrame(frame);
      children.disconnect(); observer.disconnect(); window.removeEventListener('resize', place);
      delete reader.dataset.linkedFileView;
      for (const field of ['left', 'top', 'width', 'height']) reader.style.removeProperty(`--linked-file-preview-${field}`);
    };
  }, [preview]);
}

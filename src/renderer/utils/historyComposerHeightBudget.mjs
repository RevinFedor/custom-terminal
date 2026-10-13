// The row preference is a ceiling, not permission to consume the reader.
// Keep two transcript lines (at least48px, including the compact task strip).
export function resolveHistoryComposerHeightBudget({surfaceHeight,chromeHeight,minHeight,maxHeight,transcriptLineHeight}) {
  if (![surfaceHeight,chromeHeight,minHeight,maxHeight,transcriptLineHeight].every(Number.isFinite)
      || surfaceHeight <= 0 || chromeHeight < 0) return null;
  const reserve = Math.max(48, Math.ceil(transcriptLineHeight * 2));
  const max = Math.max(1, Math.min(maxHeight, Math.floor(surfaceHeight - chromeHeight - reserve)));
  return {minHeight: Math.min(minHeight, max), maxHeight: max};
}

export function observeHistoryComposerHeight({editor,controls,minHeight,maxHeight,transcriptLineHeight,onMeasure,ResizeObserver:Observer=globalThis.ResizeObserver}) {
  const dom=editor?.dom;
  if (!dom || !controls) return () => {};
  const surface=controls.closest('[data-history-owner], [data-history-composer-boundary]');
  let previous='',active=true;
  const measure=()=>{
    if (!active || !dom.isConnected || !controls.isConnected) return;
    const box=dom.getBoundingClientRect();
    const limits=surface ? resolveHistoryComposerHeightBudget({
      surfaceHeight:surface.getBoundingClientRect().height,
      chromeHeight:Math.max(0,controls.getBoundingClientRect().height-box.height),
      minHeight,maxHeight,transcriptLineHeight,
    }) : {minHeight,maxHeight};
    if (!limits || box.width<=0) return; // Hidden geometry is not a new budget.
    const key=[Math.round(box.width*2),limits.minHeight,limits.maxHeight].join(':');
    if (key===previous) return;
    previous=key;
    onMeasure(limits);
  };
  const observer=typeof Observer==='function' ? new Observer(measure) : null;
  observer?.observe(dom);observer?.observe(controls);if(surface)observer?.observe(surface);
  measure();
  return ()=>{active=false;observer?.disconnect();};
}

/** @type {{panel: import('react').CSSProperties, header: import('react').CSSProperties, details: import('react').CSSProperties}} */
export const taskPlanHeightLayout = {
  panel: {display:'flex',flexDirection:'column',minHeight:0,maxHeight:'100%'},
  header: {flexShrink:0},
  details: {minHeight:0},
};
/** @returns {import('react').CSSProperties} */
export function taskPlanHostHeightLayout(bottomInset=0) {
  return {display:'flex',flexDirection:'column',minHeight:0,
    maxHeight:`max(0px, calc(100% - ${Math.max(0,Number.isFinite(bottomInset)?bottomInset:0)+2}px))`};
}

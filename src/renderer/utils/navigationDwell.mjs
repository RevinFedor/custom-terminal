// The workflow hover-navigation deadline and glyph palette. Also used by the
// group badge: finite hover intent, never readiness polling or per-frame state.
export const TAB_DRAG_NAVIGATION_DWELL_MS=500;
export const NAVIGATION_DWELL_COLOR='#c4b5fd';
export const NAVIGATION_DWELL_TRACK='rgba(196,181,253,0.32)';
export function beginNavigationDwell({isCurrent,onComplete,schedule=(fn,ms)=>window.setTimeout(fn,ms),cancel=id=>window.clearTimeout(id)}) {
  let active=true;
  const timer=schedule(()=>{if(!active)return;active=false;if(isCurrent())onComplete();},TAB_DRAG_NAVIGATION_DWELL_MS);
  return ()=>{if(active){active=false;cancel(timer);}};
}

import {paneStripGroupOffsets} from './paneStripCollapseModel.mjs';

/** The entry decides dismissal once. Enabling click-only can later promote a
 * temporary view, but disabling it never demotes an already sticky view. */
export function paneStripGroupOpenMode(entry,closeOnClick) {
  return entry==='click'||closeOnClick===true?'click':'hover';
}

/** Direction is geometry, never a durable-order edit. The representative's
 * physical box stays at offset zero on either side. Other members follow the
 * SAME logical order away from it: physical LTR on the right, RTL on the left.
 * The existing captured strip receipt translates physical gaps to logical
 * indices. No inverse/rotation/MRU sort and no default OPEN-fit change. */
export function directionalPaneStripGroup({ids,representative,widths,anchorLeft,viewportLeft=0,viewportRight,gap=6}) {
  const at=ids.indexOf(representative);
  if(at<0||new Set(ids).size!==ids.length||!Number.isFinite(anchorLeft)||!Number.isFinite(viewportLeft)
    ||!Number.isFinite(viewportRight)||viewportRight<=viewportLeft||!Number.isFinite(gap)||gap<0
    ||ids.some(id=>!Number.isFinite(widths.get(id))||widths.get(id)<=0))throw Error('strip_group_geometry_unavailable');
  const width=ids.reduce((sum,id)=>sum+widths.get(id),0)+gap*(ids.length-1);
  const ownWidth=widths.get(representative);
  const forward=paneStripGroupOffsets(ids,widths,gap,representative);
  const forwardRight=Math.max(...ids.map(id=>forward.get(id)+widths.get(id)));
  const direction=anchorLeft+forwardRight<=viewportRight+.5?'right':'left';
  // Reflect each member's BOX, not just its left edge: mixed widths still
  // leave exactly `gap`, and the same representative keeps its exact X/Y.
  const offsets=direction==='right'?forward:
    new Map(ids.map(id=>[id,ownWidth-widths.get(id)-forward.get(id)]));
  const left=Math.min(...offsets.values()),right=Math.max(...ids.map(id=>offsets.get(id)+widths.get(id)));
  return {order:[...ids],direction,width,anchorOffset:0,
    overflow:anchorLeft+left<viewportLeft-.5||anchorLeft+right>viewportRight+.5,offsets};
}

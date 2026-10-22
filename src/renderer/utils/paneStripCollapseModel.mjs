/** Only presentation. IDs/order still come from the existing window writer. */
export function paneStripGroupRepresentative(group,entries,shownTabId,recentIds=[]) {
  const members=new Set(group.tabIds),present=new Set(entries.map(entry=>entry.tabId));
  return [shownTabId,...recentIds,...group.tabIds].find(id=>members.has(id)&&present.has(id)) || null;
}

/** Group only contiguous members actually placed in this strip. Unknown/missing
 * members keep the ordinary presentation, rather than disappearing as "closed". */
export function paneStripCollapsedRuns(items,groups,shownTabId,recentIds=[]) {
  const byId=new Map(groups.filter(group=>group.collapsed).map(group=>[group.id,group]));
  const membership=new Map();for(const group of byId.values())for(const id of group.tabIds)membership.set(id,group);
  const out=[];
  for(let i=0;i<items.length;) {
    const item=items[i],group=item.kind==='tab'?membership.get(item.tabId):null;
    if(!group){out.push(item);i++;continue;}
    const run=[];let end=i;
    while(end<items.length&&items[end].kind==='tab'&&membership.get(items[end].tabId)?.id===group.id)run.push(items[end++]);
    if(run.length!==group.tabIds.length){out.push(...run);i=end;continue;}
    out.push({kind:'collapsed-group',group,entries:run,
      representative:paneStripGroupRepresentative(group,run,shownTabId,recentIds)});i=end;
  }
  return out;
}

/** Preserve all other members in order; move ONLY the representative as little
 * as necessary to fit around its unchanged physical box. No inverse/MRU sort. */
export function fitPaneStripGroupAtAnchor({ids,representative,widths,anchorLeft,viewportLeft=0,viewportRight,gap=6}) {
  const at=ids.indexOf(representative),width=id=>typeof widths?.get==='function'?widths.get(id):widths[id];
  if(at<0||!Number.isFinite(anchorLeft)||!Number.isFinite(viewportRight)||viewportRight<=viewportLeft
    ||ids.some(id=>!Number.isFinite(width(id))||width(id)<=0))throw Error('strip_group_geometry_unavailable');
  const others=ids.filter(id=>id!==representative),ownWidth=width(representative),leftSpace=anchorLeft-viewportLeft,
    rightSpace=viewportRight-anchorLeft-ownWidth;
  const prefix=[0];for(const id of others)prefix.push(prefix.at(-1)+width(id)+gap);
  const options=Array.from({length:ids.length},(_,index)=>{
    const left=prefix[index],right=prefix.at(-1)-left;
    return {index,left,right,overflow:Math.max(0,left-leftSpace)+Math.max(0,right-rightSpace)};
  });
  const fitting=options.filter(option=>option.overflow<.5);
  const best=(fitting.length?fitting:options).sort((a,b)=>
    (fitting.length?0:a.overflow-b.overflow)||Math.abs(a.index-at)-Math.abs(b.index-at)||a.index-b.index)[0];
  const order=[...others.slice(0,best.index),representative,...others.slice(best.index)];
  return {order,changed:order.some((id,index)=>id!==ids[index]),left:-best.left,
    width:ownWidth+prefix.at(-1),overflow:!fitting.length};
}

/** Coordinates after a preview reorder. Representative moves only during the
 * explicit drag, never as a side effect of merely opening the group. */
export function paneStripGroupOffsets(ids,widths,gap,anchorId,anchorOffset=0) {
  let x=0;const positions=new Map();
  for(const id of ids){positions.set(id,x);x+=(widths.get(id)||0)+gap;}
  const origin=(positions.get(anchorId)||0)-anchorOffset;
  return new Map([...positions].map(([id,left])=>[id,left-origin]));
}

/** Hover dismissal is re-armed only by a real re-entry after a drag release
 * outside. A click-open panel ignores hover departure altogether. */
export function paneStripGroupHoverStep(state,event) {
  if(event==='drag-start')return {...state,dragging:true,close:false};
  if(event==='drag-end')return {...state,dragging:false,waitForReentry:!state.inside,close:false};
  if(event==='enter')return {...state,inside:true,waitForReentry:false,close:false};
  if(event==='leave')return {...state,inside:false,
    close:state.mode==='hover'&&!state.dragging&&!state.waitForReentry};
  return state;
}

/** A Cmd+click/chord must never also toggle a hovered group on keyup. */
export function paneStripGroupMetaStep(state,event) {
  if(event.type==='down'&&event.key==='Meta')return {armed:!event.repeat,used:false};
  if(event.type==='down'||event.type==='pointer')return state.armed?{...state,used:true}:state;
  if(event.type==='up'&&event.key==='Meta')return {armed:false,used:false,toggle:!!state.armed&&!state.used};
  return {armed:false,used:false};
}

/** Map a gap in measured visible boxes to the SAME owner's full POST-removal
 * order. A closed group is one visible block; open groups supply one box each.
 * Incomplete/stale coverage is unknown, never an invented representative index. */
export function paneStripVisibleInsertion({fullIds,blocks,excludedIds=[],at,rowStartId,scopeId}) {
  const excluded=new Set(excludedIds),rest=fullIds.filter(id=>!excluded.has(id));
  const visible=[];
  for(const block of blocks) {
    const ids=block.ids.filter(id=>!excluded.has(id));if(!ids.length)continue;
    if(excluded.has(block.visibleId))return null;
    visible.push({...block,ids});
  }
  if(JSON.stringify(visible.flatMap(block=>block.ids))!==JSON.stringify(rest)
    ||!Number.isInteger(at)||at<0)return null;
  if(scopeId) {
    const start=blocks.findIndex(block=>block.openGroupId===scopeId);
    if(start<0)return null;
    let end=start;while(end<blocks.length&&blocks[end].openGroupId===scopeId)end++;
    if(blocks.slice(end).some(block=>block.openGroupId===scopeId))return null;
    const members=blocks.slice(start,end);
    const direction=members[0].openGroupDirection===undefined?'right':members[0].openGroupDirection;
    if(direction!=='right'&&direction!=='left'||members.some(block=>block.ids.length!==1||block.ids[0]!==block.visibleId
      ||(block.openGroupDirection===undefined?'right':block.openGroupDirection)!==direction))return null;
    const count=members.filter(block=>!excluded.has(block.visibleId)).length;
    if(at>count)return null;
    const before=blocks.slice(0,start).reduce((n,block)=>n+block.ids.filter(id=>!excluded.has(id)).length,0);
    const row=members.find(block=>block.visibleId===rowStartId&&!excluded.has(block.visibleId));
    // The shared geometry counts physical left-to-right gaps. A left-opening
    // selected-first row is physical RTL, while durable IDs stay in their
    // original logical order. Convert only this scoped POST-removal ordinal.
    // Its physical left/end gap cannot manufacture a logical wrapping start.
    return {at:before+(direction==='left'?count-at:at),rowStartId:direction==='left'?null:row?row.visibleId:null};
  }
  if(at>visible.length)return null;
  const row=blocks.find(block=>block.visibleId===rowStartId);
  return {at:visible.slice(0,at).reduce((n,block)=>n+block.ids.length,0),
    rowStartId:row?row.ids.find(id=>!excluded.has(id)):rowStartId};
}

/** Select an OPEN absolute row from the existing captured rectangles. Cards
 * underneath it are still canonical neighbours, but cannot own a drop inside
 * this row. Keep the lease's logical chip sequence intact in either direction;
 * physical gaps are converted by paneStripVisibleInsertion after exclusions.
 * Gaps use the same row bounds; ambiguous coverage stays unknown. */
export function paneStripOpenGroupGeometry({chips,blocks,clientX,clientY,preferredGroupId}) {
  const membership=new Map(blocks.filter(block=>block.openGroupId).map(block=>[block.visibleId,block.openGroupId]));
  const groups=new Map();
  for(const chip of chips) {
    const id=membership.get(chip.id);if(!id)continue;
    const group=groups.get(id)||[];group.push(chip);groups.set(id,group);
  }
  if(preferredGroupId) {
    const members=groups.get(preferredGroupId);
    return members?{chips:members,scopeId:preferredGroupId}:null;
  }
  const candidates=[...groups].filter(([,members])=>clientX>=Math.min(...members.map(chip=>chip.left))
    &&clientX<=Math.max(...members.map(chip=>chip.right))&&clientY>=Math.min(...members.map(chip=>chip.top))
    &&clientY<=Math.max(...members.map(chip=>chip.bottom)));
  if(candidates.length>1)return null;
  return candidates.length?{scopeId:candidates[0][0],chips:candidates[0][1]}:undefined;
}

export {paneStripGroupDragBoundary,clampPaneStripGroupInsertion} from '../../shared/pane-strip-drag-boundary.cjs';

const orderedIds = entries => [...new Set((entries || []).map(entry => typeof entry === 'string' ? entry : entry?.tabId).filter(Boolean))];

/** Selection belongs to one strip, never execution/sidebar membership. */
export function prunePaneStripSelection(selection, entries) {
  const order=orderedIds(entries), selected=new Set(selection?.tabIds || []);
  return {tabIds:order.filter(id=>selected.has(id)),anchor:order.includes(selection?.anchor)?selection.anchor:null};
}

export function selectPaneStripTab(selection, entries, tabId, {metaKey=false,shiftKey=false}={}) {
  const order=orderedIds(entries), current=prunePaneStripSelection(selection,order);
  if(!order.includes(tabId))return {selection:current,activate:false};
  if(shiftKey) {
    const anchor=current.anchor || current.tabIds[0] || tabId;
    const a=order.indexOf(anchor),b=order.indexOf(tabId);
    return {selection:{tabIds:order.slice(Math.min(a,b),Math.max(a,b)+1),anchor},activate:false};
  }
  if(metaKey) {
    const ids=new Set(current.tabIds);ids.has(tabId)?ids.delete(tabId):ids.add(tabId);
    return {selection:{tabIds:order.filter(id=>ids.has(id)),anchor:tabId},activate:false};
  }
  return {selection:{tabIds:[tabId],anchor:tabId},activate:true};
}

export function paneStripSelectionEntries(selection, entries, sourceId) {
  const selected=new Set(prunePaneStripSelection(selection,entries).tabIds);
  return (entries || []).filter(entry=>selected.has(sourceId)?selected.has(entry.tabId):entry.tabId===sourceId);
}

/** A color edit never implicitly reassigns, merges or reorders members. */
export function classifyPaneStripColorSelection(groups, selectedIds) {
  const ids=orderedIds(selectedIds), selected=new Set(ids);
  if(!ids.length)return {kind:'disabled',reason:'empty-selection'};
  const touched=(groups || []).filter(group=>(group.tabIds || []).some(id=>selected.has(id)));
  if(!touched.length)return {kind:'create',tabIds:ids};
  if(touched.length===1) {
    const group=touched[0],members=orderedIds(group.tabIds);
    if(members.length===ids.length && members.every(id=>selected.has(id)))return {kind:'recolor',group};
  }
  return {kind:'disabled',reason:'mixed-or-partial-membership'};
}

export function normalizeStripGroupColor(value) {
  if(typeof value!=='string'||!/^#[\da-f]{6}$/i.test(value))throw Object.assign(Error('strip_group_color_invalid'),{code:'strip_group_color_invalid'});
  return value.toLowerCase();
}

/** Pure candidate; the existing persistence/ACK owner must accept it first. */
export function editPaneStripColorGroups(groups, selectedIds, color, newId) {
  const selection=classifyPaneStripColorSelection(groups,selectedIds),nextColor=normalizeStripGroupColor(color);
  if(selection.kind==='disabled')throw Object.assign(Error('strip_group_selection_changed'),{code:'strip_group_selection_changed'});
  if(selection.kind==='recolor')return groups.map(group=>group.id===selection.group.id && group.color!==nextColor
    ?{...group,color:nextColor,revision:(group.revision ?? 1)+1}:group);
  if(typeof newId!=='string'||!newId||groups.some(group=>group.id===newId))throw Error('strip_group_id_invalid');
  return [...groups,{id:newId,color:nextColor,tabIds:selection.tabIds,revision:1}];
}

/** Missing clearance is vertical only and reserved even without any group. */
export function paneStripOutlineGap(currentGap, lowerOverhang) {
  return Math.max(Number(currentGap)||0,(Number(lowerOverhang)||0)+2);
}


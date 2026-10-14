// Host opt-in only. The legacy/default Cmd navigation contract stays intact.
export function usesCommandHierarchy(modifier) {
  return modifier === 'meta';
}

export function commandNavigationMode(modifier, held) {
  // Opted-in hosts use Cmd exclusively for X. Folder hover has its own dwell
  // within the same gesture and must never put Y/X into the legacy pause.
  return !usesCommandHierarchy(modifier) && held;
}

export function usesFolderHover(modifier, drag) {
  return drag.navigationMode || usesCommandHierarchy(modifier);
}

// A card's grab offset can cross the reorder midpoint while the pointer is
// still in the gap before a folder. Let the pointer reach/pass the header;
// otherwise the folder escapes before plain hover ever receives it.
export function folderApproachBlocksSlot({from,to,pointerY,rows,protectedIds=[]}) {
  if (from === to) return false;
  return rows.slice(Math.min(from,to),Math.max(from,to)).some(row =>
    row.collapsible && row.hasChildren && !protectedIds.includes(row.id)
    && Number.isFinite(row.top) && Number.isFinite(row.bottom)
    && (to < from ? pointerY >= row.top : pointerY <= row.bottom));
}

export function rebaseHierarchyModifier(drag, held, modifier) {
  if (!usesCommandHierarchy(modifier) || drag.hierarchyMode === held) return drag;
  return {...drag,hierarchyMode:held,horizontalBaseX:drag.pointerX,horizontalBaseY:drag.pointerY,
    axisLock:null,feedback:null,blockedDirection:null};
}

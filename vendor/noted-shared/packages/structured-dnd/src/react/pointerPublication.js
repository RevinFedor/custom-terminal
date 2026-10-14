// Opt-in hosts already paint their floating pointer preview independently.
// A silent update retains the acknowledged semantic receipt unchanged.
const sameSlot = (a, b) => a === b || !!(a && b
  && a.parentId === b.parentId && a.index === b.index && a.depth === b.depth && a.boundary === b.boundary);

export function canRetainPointerPublication({ current, next, painted, outline, previousOutline, lease,
  previousLease, controlledOutline, revision, ownerEpoch, validatedImmutableOutline, pendingLayout, inside }) {
  if (!inside || pendingLayout || !current || !next || !painted
    || current.phase !== 'dragging' || next.phase !== 'dragging'
    || current.externalReleasePending || next.externalReleasePending
    || current.ownerEpoch !== ownerEpoch || next.ownerEpoch !== ownerEpoch
    || painted.ownerEpoch !== ownerEpoch || painted.revision !== revision
    || current.renderRevision !== revision || painted.sessionId !== current.sessionId
    || painted.drag?.sessionId !== current.sessionId
    || outline !== painted.outline || outline !== previousOutline || outline !== validatedImmutableOutline
    || lease !== previousLease || current.lastControlledOutline !== controlledOutline) return false;
  for (const key of ['sessionId','sourceId','pointerId','externalOwnerKey','externalReleaseOwner','sourceContext',
    'sourceIds','sourceRootIds','prepared','boundary','pointerBoundary','preferredDepth','resolvedDepth','currentParentId',
    'navigationMode','hierarchyMode','layoutChangeAxis','scrollReserve','scrollCeiling','naturalScrollMax','lastAnchor'])
    if (current[key] !== next[key] || current[key] !== painted.drag[key]) return false;
  if (!sameSlot(current.slot,next.slot) || !sameSlot(current.slot,painted.drag.slot)) return false;
  if(current.edgeGesture?.zone !== next.edgeGesture?.zone || current.edgeGesture?.zone !== painted.drag.edgeGesture?.zone) return false;
  for (const drag of [current,next,painted.drag]) {
    if (drag.navigationMode || drag.hierarchyMode || drag.externalTarget != null || drag.feedback != null
      || drag.blockedDirection != null || drag.folderHoverTargetId != null || drag.navigationDwell != null
      || drag.edge != null || drag.edgeGesture?.active
      || drag.pendingExpansionIds?.size) return false;
  }
  return true;
}

// Only plain data is frozen; opt-in hosts own an immutable, data-only outline.
// Unsupported payloads retain the old publication path instead of being edited.
export function freezeOutlineData(value) {
  const seen=new WeakSet(),objects=[];
  const visit=node=>{
    if(node===null || node===undefined || ['string','number','boolean'].includes(typeof node))return true;
    if(typeof node!=='object')return false;
    if(seen.has(node))return true;seen.add(node);
    if(!Array.isArray(node) && ![Object.prototype,null].includes(Object.getPrototypeOf(node)))return false;
    const descriptors=Object.getOwnPropertyDescriptors(node);
    if(Object.values(descriptors).some(descriptor=>!('value' in descriptor)))return false;
    objects.push(node);return Object.values(descriptors).every(descriptor=>visit(descriptor.value));
  };
  if(!visit(value))return false;
  for(const object of objects.reverse())Object.freeze(object);
  return true;
}

// Fresh small DTOs, no aliases to engine maps, receipt objects or callbacks.
// Forest/context payloads stay at their existing compiler boundary.
export function readonlyDragSnapshot(drag, publicState) {
  if(!drag)return null;
  const copy=value=>{
    if(value===null || value===undefined || typeof value!=='object')return typeof value==='function'?undefined:value;
    if(Array.isArray(value))return Object.freeze(value.map(copy));
    if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return undefined;
    return Object.freeze(Object.fromEntries(Object.entries(value)
      .filter(([key])=>key!=='sourceContext' && key!=='previewOutline').map(([key,value])=>[key,copy(value)])));
  };
  const {sourceContext,...state}=publicState;
  return copy({...state,gestureId:sourceContext?.gestureId ?? null,ownerEpoch:drag.ownerEpoch,
    releasePending:!!drag.externalReleasePending});
}

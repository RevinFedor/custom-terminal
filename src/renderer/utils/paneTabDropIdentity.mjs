export function isSamePaneDrop(source, target, activeSpaceId) {
  if (!source || !target || source.sourcePaneKey !== target.paneKey) return false;
  const targetSpaceId = target.spaceId || activeSpaceId || null;
  return source.sourceSpaceId ? source.sourceSpaceId === targetSpaceId : true;
}

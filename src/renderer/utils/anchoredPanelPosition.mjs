// Only scrolling an anchor's ancestor can move its viewport rectangle.
// History, graph contents and sibling editors must not remeasure a toolbar.
export function scrollMovesAnchor(target, anchor) {
  if (!anchor || anchor.isConnected === false) return false;
  const doc = anchor.ownerDocument;
  return (!!doc && (target === doc || target === doc.defaultView))
    || (target !== anchor && typeof target?.contains === 'function' && target.contains(anchor));
}

// A fresh but equal object schedules React work for the complete graph.
export function retainPanelPosition(previous, next) {
  return ['left', 'top', 'width', 'height'].every(key => previous[key] === next[key]) ? previous : next;
}

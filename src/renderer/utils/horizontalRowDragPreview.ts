/** Cursor feedback is a clone; the original keeps the future slot in the row. */
export function createHorizontalRowDragPreview(source: HTMLElement,
  onMove?: (sample: Record<string,number>) => void,
  onPickup?: (sample: Record<string,number>) => void) {
  const rect = source.getBoundingClientRect();
  onPickup?.({left:rect.left,top:rect.top,width:rect.width,height:rect.height});
  const host = document.createElement('div');
  host.dataset.horizontalRowCursorChip = '1';
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed', left: '0', top: '0', zIndex: '2147483647',
    width: `${rect.width}px`, height: `${rect.height}px`,
    pointerEvents: 'none', transition: 'none', willChange: 'transform',
    borderRadius: '4px', background: '#202024', boxShadow: '0 5px 18px #0008',
  });
  const clone = source.cloneNode(true) as HTMLElement;
  // Feedback cannot become a second target, project chip or DOM id.
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name === 'id' || attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
    }
    node.removeAttribute('title');
    node.removeAttribute('draggable');
    node.tabIndex = -1;
  }
  Object.assign(clone.style, {
    width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: 'border-box',
    maxWidth: 'none', margin: '0', opacity: '1', transform: 'none',
    translate: 'none', transition: 'none', pointerEvents: 'none',
  });
  host.appendChild(clone);
  document.body.appendChild(host);
  return {
    element: host,
    move: (x: number, y: number) => {
      host.style.transform = `translate3d(${x - rect.width / 2}px, ${y - rect.height / 2}px, 0)`;
      onMove?.({x,y,left:x-rect.width/2,top:y-rect.height/2,width:rect.width,height:rect.height});
    },
    remove: () => host.remove(),
  };
}

// Visual grouping only. Original indices still own each preview/popover;
// non-whitespace text stays at its exact position between attachments.
export function historyImageRuns(parts) {
  const result = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.kind !== 'image') { result.push({ kind: 'part', part, index }); continue; }
    const items = [{ part, index }];
    while (index + 1 < parts.length) {
      let next = index + 1;
      while (parts[next]?.kind === 'text' && !String(parts[next].text || '').trim()) next++;
      if (parts[next]?.kind !== 'image') break;
      index = next; items.push({ part: parts[index], index });
    }
    result.push({ kind: 'images', items, index: items[0].index });
  }
  return result;
}

// An occurrence is addressed by the same part index/id as its sent chip. Equal
// paths or non-monotonic ids must not deduplicate or reorder the gallery.
export function historyImagePreviewPart(parts, partKey) {
  const match = /^image:(\d+):(.*)$/.exec(partKey || '');
  const part = match ? parts[Number(match[1])] : null;
  return part?.kind === 'image' && String(part.id) === match[2] ? part : null;
}

export function historyImagePreviewStep(parts, partKey, direction) {
  if (!historyImagePreviewPart(parts, partKey) || (direction !== -1 && direction !== 1)) return partKey;
  const current = Number(partKey.split(':')[1]);
  for (let index = current + direction; index >= 0 && index < parts.length; index += direction) {
    if (parts[index]?.kind === 'image') return `image:${index}:${parts[index].id}`;
  }
  return partKey; // The missing neighbour is a no-op, not wraparound.
}

/** Installed only while an image preview is open. Capture plain arrows before
 * the still-focused composer can move its caret; modified arrows keep their
 * existing shortcuts. A retained/inert History is never a keyboard owner. */
export function bindHistoryImagePreviewKeys({ target, anchor, navigate }) {
  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey
      || event.altKey || event.shiftKey) return;
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!direction || !anchor?.isConnected) return;
    const owner = anchor.closest('[data-history-owner]');
    if (!owner || owner.getAttribute('data-history-presented') !== '1' || owner.hasAttribute('inert')) return;
    // Also consumed at an edge: falling through would move the underlying
    // draft or terminal even though the image preview is still open.
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(direction);
  };
  target.addEventListener('keydown', onKeyDown, true);
  return () => target.removeEventListener('keydown', onKeyDown, true);
}

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

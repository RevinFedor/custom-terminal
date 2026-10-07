export function projectTimelineWorkingFileMarkers(entries, files, cwd, pathApi) {
  if (!Array.isArray(entries) || !Array.isArray(files) || !files.length) return entries;
  const identity = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    if (!pathApi.isAbsolute(value) && !cwd) return null;
    return pathApi.resolve(cwd || '/', value);
  };
  const linked = new Set(files.map(file => identity(file.path)).filter(Boolean));
  let changed = false;
  const projected = entries.map(entry => {
    if (!Array.isArray(entry?.fileEdits)) return entry;
    const edited = new Set(entry.docsEdited || []);
    for (const file of entry.fileEdits) {
      const target = identity(file);
      if (!target || !linked.has(target)) continue;
      // The existing knowledge marker already owns docs and CLAUDE.md edits.
      if (target.split(pathApi.sep).some(part => part.toLowerCase() === 'docs')
        || pathApi.basename(target) === 'CLAUDE.md') continue;
      edited.add(target);
    }
    if (edited.size === (entry.docsEdited?.length || 0)) return entry;
    changed = true;
    return { ...entry, docsEdited: [...edited] };
  });
  return changed ? projected : entries;
}

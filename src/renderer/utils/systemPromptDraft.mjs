const fields = ['name', 'content', 'color', 'showInContextMenu', 'model', 'thinkingLevel', 'filePaths', 'position'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// External writes update clean fields while preserving a user's unsaved draft.
// A conflict in the same field retains the old CAS revision so blur cannot
// silently replace the external edit with the older local draft.
export function mergeSystemPromptDraft(base, draft, incoming) {
  const next = { ...draft };
  const conflicts = [];
  for (const field of fields) {
    if (equal(draft[field], base[field])) next[field] = incoming[field];
    else if (!equal(incoming[field], base[field]) && !equal(draft[field], incoming[field])) conflicts.push(field);
  }
  return { draft: next, conflicts,
    baseline: conflicts.length ? { ...incoming,
      ...Object.fromEntries(conflicts.map(field => [field, base[field]])), revision: base.revision } : incoming };
}

/**
 * Resolve the previous/next saved-prompt preview in the exact order supplied
 * by the composer host. Paste/image chips deliberately stay out of this list:
 * their position belongs to the editable text, while saved prompts form the
 * left-to-right attachment band above the input.
 */
export function resolveOrderedPreviewNavigation(rawIds, expandedId) {
  const ids = [];
  const seen = new Set();
  for (const value of Array.isArray(rawIds) ? rawIds : []) {
    const id = String(value || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const currentIndex = ids.indexOf(String(expandedId || ''));
  if (currentIndex < 0 || ids.length < 2) return null;

  return {
    currentId: ids[currentIndex],
    currentIndex,
    count: ids.length,
    previousId: currentIndex > 0 ? ids[currentIndex - 1] : null,
    nextId: currentIndex + 1 < ids.length ? ids[currentIndex + 1] : null,
  };
}

export function resolveComposerPromptPreviewNavigation(chips, expandedChipId) {
  const ids = [];
  const seen = new Set();

  for (const chip of Array.isArray(chips) ? chips : []) {
    const id = String(chip?.id || '');
    const hasPreview = typeof chip?.text === 'string'
      || chip?.expandedPreview != null
      || chip?.imagePreview != null;
    if (
      !id
      || seen.has(id)
      || chip?.kind !== 'prompt'
      || chip?.expandable === false
      || chip?.disabled === true
      || !hasPreview
    ) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  return resolveOrderedPreviewNavigation(ids, expandedChipId);
}

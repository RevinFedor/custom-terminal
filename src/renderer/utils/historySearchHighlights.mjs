// Highlight rules live in the application stylesheet. Mounting a <style> for
// each search invalidated every retained History (60k elements in the proof),
// even when the query was empty. Owners share the two rules, not their ranges.
export const HISTORY_SEARCH_HIGHLIGHT = 'hp-search';
export const HISTORY_SEARCH_CURRENT_HIGHLIGHT = 'hp-search-current';

export function createHistorySearchHighlights(highlights, HighlightType) {
  const owners = new Map();
  const publish = () => {
    for (const [name, field] of [
      [HISTORY_SEARCH_HIGHLIGHT, 'all'],
      [HISTORY_SEARCH_CURRENT_HIGHLIGHT, 'current'],
    ]) {
      const highlight = new HighlightType();
      for (const ranges of owners.values()) {
        for (const range of ranges[field]) highlight.add(range);
      }
      if (highlight.size) highlights.set(name, highlight);
      else highlights.delete(name);
    }
  };
  return {
    set(lease, all, current) {
      if (!all.length && !current.length) return this.clear(lease);
      owners.set(lease, { all, current });
      publish();
    },
    clear(lease) {
      if (owners.delete(lease)) publish();
    },
  };
}

let registry = null;
export function setHistorySearchHighlights(lease, all, current) {
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  registry ||= createHistorySearchHighlights(globalThis.CSS.highlights, globalThis.Highlight);
  registry.set(lease, all, current);
}
export function clearHistorySearchHighlights(lease) {
  registry?.clear(lease);
}

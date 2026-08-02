/**
 * Remembered scroll offset per previewed file.
 *
 * Keyed by absolute file path, not by tab: the same file opened from the tab
 * bar and from the file sidebar is the same reading position to the user, and
 * a sidebar preview has no tab to hang the position on in the first place.
 *
 * The map is capped and evicted least-recently-used, because it grows with
 * every file the user has ever peeked at and is mirrored into SQLite whole.
 */

export const FILE_PREVIEW_SCROLL_LIMIT = 200;

export function normalizeScrollTop(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}

export function readScrollMemory(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [path, entry] of Object.entries(raw)) {
    if (!path) continue;
    // Legacy/simple shape: a bare number instead of {top, at}.
    const top = normalizeScrollTop(typeof entry === 'object' && entry !== null ? entry.top : entry);
    if (top <= 0) continue;
    const at = typeof entry === 'object' && entry !== null ? Number(entry.at) : 0;
    out[path] = { top, at: Number.isFinite(at) && at > 0 ? at : 0 };
  }
  return out;
}

export function getRememberedScrollTop(memory, path) {
  if (!path) return 0;
  const entry = memory?.[path];
  return normalizeScrollTop(entry && typeof entry === 'object' ? entry.top : entry);
}

/**
 * Returns the next map, or the SAME reference when nothing changes — callers
 * use identity to skip a persist round-trip on every scroll event.
 */
export function rememberScrollTop(memory, path, scrollTop, now, limit = FILE_PREVIEW_SCROLL_LIMIT) {
  if (!path) return memory;
  const current = memory && typeof memory === 'object' ? memory : {};
  const top = normalizeScrollTop(scrollTop);
  const previous = current[path];
  const previousTop = normalizeScrollTop(previous && typeof previous === 'object' ? previous.top : previous);

  // Top of the file is the default, so it is stored as "no memory" rather than
  // as a zero entry that would occupy a slot forever.
  if (top === 0) {
    if (previousTop === 0 && !(path in current)) return memory;
    const next = { ...current };
    delete next[path];
    return next;
  }
  if (previousTop === top) return memory;

  const stamp = Number.isFinite(Number(now)) ? Number(now) : 0;
  const next = { ...current, [path]: { top, at: stamp } };

  const paths = Object.keys(next);
  if (paths.length > limit) {
    paths
      .sort((a, b) => (next[a]?.at || 0) - (next[b]?.at || 0))
      .slice(0, paths.length - limit)
      .forEach((stale) => { delete next[stale]; });
  }
  return next;
}

export function forgetScrollTop(memory, path) {
  if (!path || !memory || !(path in memory)) return memory;
  const next = { ...memory };
  delete next[path];
  return next;
}

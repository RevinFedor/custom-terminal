// Shared "does this linked file still exist on disk?" tracker.
//
// One probe surface for every consumer (TabBar sidebar rows, Ctrl+Tab
// switcher, Home history cards): batch IPC `file:exists-batch`, module-level
// cache, subscribers notified only when a verdict actually flips. A missing
// file is marked red everywhere and skipped by the switcher — the tab itself
// is NOT auto-closed (user decision).

const { ipcRenderer } = window.require('electron');

const cache = new Map<string, boolean>(); // path -> exists
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let lastProbeAt = 0;
const PROBE_TTL_MS = 5000;

export function fileExistsVerdict(path: string | undefined | null): boolean | undefined {
  if (!path) return undefined;
  return cache.get(path);
}

export function isFileMissing(path: string | undefined | null): boolean {
  if (!path) return false;
  return cache.get(path) === false;
}

export function subscribeMissingFiles(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Probe the given paths (deduped, TTL-throttled). Safe to call from render
// effects on every open/interaction; the actual IPC fires at most once per
// TTL window unless `force`.
export function probeFiles(paths: string[], force = false): void {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return;
  const now = Date.now();
  if (!force && inFlight) return;
  if (!force && now - lastProbeAt < PROBE_TTL_MS && unique.every((p) => cache.has(p))) return;
  lastProbeAt = now;
  inFlight = ipcRenderer.invoke('file:exists-batch', unique)
    .then((res: Record<string, boolean>) => {
      if (!res) return;
      let changed = false;
      for (const [p, exists] of Object.entries(res)) {
        if (cache.get(p) !== exists) { cache.set(p, exists); changed = true; }
      }
      if (changed) listeners.forEach((fn) => { try { fn(); } catch {} });
    })
    .catch(() => {})
    .finally(() => { inFlight = null; });
}

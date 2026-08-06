/**
 * Universal localStorage ↔ SQLite mirror for UI settings.
 *
 * Why this exists:
 *   Renderer settings (font sizes, panel widths, copy flags…) were originally
 *   stored only in `localStorage`. On packaged builds that's fine — the file://
 *   origin is stable across launches. On dev however, vite picks a free port
 *   each run; the origin (http://localhost:5181 vs 5182 vs …) differs, so each
 *   port has its own isolated localStorage bucket. Result: every `npm run dev`
 *   the user loses their settings.
 *
 * The fix:
 *   - Boot-time: synchronously pull every `noted-terminal-*` (and `sidebarWidth`)
 *     row out of SQLite and write them into localStorage BEFORE any Zustand
 *     store factory reads `localStorage.getItem(...)`. The store therefore sees
 *     the right values on first render.
 *   - Runtime: monkey-patch `localStorage.setItem` / `removeItem` so every
 *     write to a tracked key also fires a synchronous IPC into main → SQLite.
 *     Writes stay durable across dev-port shuffles.
 *
 * Tracked-key rule: any key matching `MIRROR_PREFIXES`. Adding a new prefix is
 * the only required change when introducing a new setting bucket.
 */

const MIRROR_PREFIXES = ['noted-terminal-', 'sidebarWidth'];

const shouldMirror = (key: string): boolean => {
  for (const p of MIRROR_PREFIXES) {
    if (key === p || key.startsWith(p)) return true;
  }
  return false;
};

let ipcRenderer: any = null;
try {
  ipcRenderer = (window as any).require?.('electron')?.ipcRenderer ?? null;
} catch {
  ipcRenderer = null;
}

/**
 * Pulls every mirrored row from SQLite and writes it into localStorage. Idempotent
 * (overwrites localStorage with SQLite values). Must run BEFORE Zustand store
 * factories — so we synchronously call it at module-load time inside renderer entry.
 */
export function hydrateLocalStorageFromSQLite(): void {
  if (!ipcRenderer) return;
  try {
    // We pull each prefix in one round-trip and merge — `getAllAppStateRaw`
    // accepts an optional prefix, so we can be efficient.
    const merged: Record<string, string> = {};
    for (const prefix of MIRROR_PREFIXES) {
      const rows = ipcRenderer.sendSync('app:hydrateLocalStorageSync', { prefix });
      if (rows && typeof rows === 'object') Object.assign(merged, rows);
    }
    let restored = 0;
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value !== 'string') continue;
      // Only write if missing OR different — minimises pointless storage events.
      const cur = localStorage.getItem(key);
      if (cur !== value) {
        localStorage.setItem(key, value);
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[persistedStorage] Hydrated ${restored} localStorage keys from SQLite`);
    }
  } catch (e) {
    console.warn('[persistedStorage] hydrate failed:', e);
  }
}

/**
 * Monkey-patch `localStorage.setItem` and `removeItem` so writes to mirrored
 * keys fan out to SQLite. Only patches once; safe to call multiple times.
 *
 * Runtime writes go through ASYNC `send`, not `sendSync`. The sync variant
 * parked the RENDERER until main replied — and during a tab switch main is
 * busy with the switch's own IPC (plus git:status), so one settings write
 * inside a cleanup effect blocked the whole UI. Measured live (05.08, CPU
 * profile of the user's freeze): 746ms of `Storage.setItem → sendSync` inside
 * the React commit phase — the single largest slice of the 600-900ms
 * tab-switch long task. Ordering is still guaranteed (same channel, main
 * drains in arrival order), and durability across a window close is restored
 * by the pagehide replay below: every key written this session is re-sent
 * synchronously right before the window goes away — the one moment blocking
 * is correct.
 */
let patched = false;
const dirtyMirrorKeys = new Set<string>();
export function installLocalStorageMirror(): void {
  if (patched || !ipcRenderer) return;
  patched = true;

  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;

  Storage.prototype.setItem = function (key: string, value: string) {
    // Always write to localStorage first (preserves existing semantics — readers
    // that fire immediately after see the new value).
    origSet.call(this, key, value);
    // Only `window.localStorage` (this === localStorage) gets mirrored — we don't
    // want to copy sessionStorage. The `this === localStorage` check is the
    // simplest way without relying on call-site identity.
    if (this !== localStorage) return;
    if (!shouldMirror(key)) return;
    dirtyMirrorKeys.add(key);
    try {
      ipcRenderer.send('app:mirrorLocalStorageSync', { key, value: String(value) });
    } catch {
      // Swallow — losing one mirror write is preferable to breaking setItem.
    }
  };

  Storage.prototype.removeItem = function (key: string) {
    origRemove.call(this, key);
    if (this !== localStorage) return;
    if (!shouldMirror(key)) return;
    dirtyMirrorKeys.add(key);
    try {
      ipcRenderer.send('app:mirrorLocalStorageSync', { key, value: null });
    } catch {}
  };

  // Shutdown replay: async sends issued moments before destruction may not
  // survive the renderer going away, so the final state of every key touched
  // this session is pushed once more, synchronously. `pagehide` fires for
  // both window close and reload; the handler is idempotent (current values,
  // last-write-wins on the main side).
  window.addEventListener('pagehide', () => {
    for (const key of dirtyMirrorKeys) {
      try {
        ipcRenderer.sendSync('app:mirrorLocalStorageSync', {
          key,
          value: localStorage.getItem(key),
        });
      } catch {}
    }
    dirtyMirrorKeys.clear();
  });
}

/** Convenience: run both at boot — call from renderer entry before app code. */
export function bootstrapPersistedStorage(): void {
  hydrateLocalStorageFromSQLite();
  installLocalStorageMirror();
}

/**
 * One listener per channel, delivered only to the addressed tab.
 *
 * Main broadcasts PTY output and agent lifecycle events to the window, and
 * every mounted Terminal used to subscribe to each channel and open with
 * `if (payload.tabId !== tabId) return;`. With ~116 live terminals that is 116
 * function calls, 116 closure frames and 115 immediate rejections for every
 * chunk of output from ANY tab — while the user is typing or switching.
 *
 * Measured on the 01.11 build (boot mvx7g97w, 02:31 UTC): `ipc:terminal:data`
 * appeared in the attribution of 84 long tasks, 11 855ms of delivery time in
 * total, and held the main thread directly in tasks of up to 189ms. That is
 * the lag felt as "switched workspaces, tried to scroll, it stalls".
 *
 * This dispatcher keeps the semantics identical — same payload, same order,
 * same `this` — and only removes the fan-out: one real listener per channel
 * does a Map lookup and calls the handlers of that one tab.
 *
 * Deliberately independent of the perf probe: the probe wraps `ipcRenderer.on`,
 * so registering once here means the attribution also stops reporting a
 * channel 116 times per chunk.
 */

type IpcRendererLike = {
  on: (channel: string, listener: (...args: any[]) => void) => unknown;
  removeListener: (channel: string, listener: (...args: any[]) => void) => unknown;
};

type TabPayload = { tabId?: string | null };
type Handler = (event: unknown, payload: any) => void;

const channels = new Map<string, {
  byTab: Map<string, Set<Handler>>;
  listener: (event: unknown, payload: any) => void;
}>();

let cachedIpc: IpcRendererLike | null | undefined;
function getIpc(): IpcRendererLike | null {
  if (cachedIpc !== undefined) return cachedIpc;
  try { cachedIpc = (window as any).require?.('electron')?.ipcRenderer || null; }
  catch { cachedIpc = null; }
  return cachedIpc;
}

/**
 * Subscribes `handler` to `channel`, but only for payloads whose `tabId`
 * matches. Returns the unsubscribe function.
 *
 * A tab may legitimately have more than one subscriber for the same channel
 * (a retained pane and a visible one), so handlers are held in a Set per tab
 * and each is removed independently.
 */
export function onTabScopedIpcMessage(channel: string, tabId: string, handler: Handler): () => void {
  const ipc = getIpc();
  if (!ipc) return () => {};

  let entry = channels.get(channel);
  if (!entry) {
    const byTab = new Map<string, Set<Handler>>();
    const listener = (event: unknown, payload: TabPayload) => {
      const target = payload?.tabId;
      if (typeof target !== 'string') return;
      const handlers = byTab.get(target);
      if (!handlers || handlers.size === 0) return;
      // Snapshot: a handler may unsubscribe (or mount another pane) while this
      // delivery is in flight, and mutating the live Set mid-iteration would
      // silently skip a sibling.
      for (const current of Array.from(handlers)) {
        // One faulty subscriber must not starve the others. This is the exact
        // failure that broke History on 01.11, when a throwing listener on a
        // plain EventEmitter stopped every later subscriber of that event.
        try { current(event, payload); }
        catch (error: any) {
          console.error('[TabScopedIpc] handler failed channel=' + channel
            + ' tab=' + String(target).slice(-12)
            + ' error=' + String(error?.message || error).slice(0, 300));
        }
      }
    };
    entry = { byTab, listener };
    channels.set(channel, entry);
    ipc.on(channel, listener);
  }

  let handlers = entry.byTab.get(tabId);
  if (!handlers) { handlers = new Set(); entry.byTab.set(tabId, handlers); }
  handlers.add(handler);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = channels.get(channel);
    if (!current) return;
    const set = current.byTab.get(tabId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) current.byTab.delete(tabId);
    // Keep the real listener registered while any tab still wants the channel.
    // Tearing it down on the last unsubscribe and re-adding it on the next
    // mount would reorder this listener against the other subscribers of the
    // same channel elsewhere in the app.
    if (current.byTab.size === 0) {
      channels.delete(channel);
      getIpc()?.removeListener(channel, current.listener);
    }
  };
}

/** Diagnostics only: how many channels and handlers are currently routed. */
export function tabScopedIpcStats(): { channels: number; tabs: number; handlers: number } {
  let tabs = 0, handlers = 0;
  for (const entry of channels.values()) {
    tabs += entry.byTab.size;
    for (const set of entry.byTab.values()) handlers += set.size;
  }
  return { channels: channels.size, tabs, handlers };
}

// The complete per-monitor size contract. Geometry, wrapping and History
// spacing intentionally stay global. Bounds match the existing Settings UI.
export const DISPLAY_SIZE_LIMITS = Object.freeze({
  terminalFontSize: [8, 24, 13],
  tabsFontSize: [10, 20, 14],
  projectTabsFontSize: [10, 16, 12],
  sidebarFontSize: [10, 20, 13],
  filePreviewFontSize: [10, 24, 13],
  promptPickerFontSize: [9, 20, 12],
  timelineFontSize: [10, 18, 12],
  timelineSummaryFontSize: [10, 22, 13],
  historyFontSize: [8, 24, 13],
  historyComposerFontSize: [8, 24, 12],
  aiSecondaryFontSize: [8, 18, 11],
  promptQueueChipFontSize: [9, 18, 11],
  promptQueueEditorFontSize: [10, 24, 12],
  notesSidebarFontSize: [10, 28, 14],
  notesExpandedFontSize: [10, 28, 14],
  notesTooltipFontSize: [10, 28, 14],
  tabSidebarWidth: [140, 400, 200],
  sidebarWidth: [180, 500, 280],
});
export const DISPLAY_SIZE_KEYS = Object.freeze(Object.keys(DISPLAY_SIZE_LIMITS));
export const DISPLAY_PROFILES_STORAGE_KEY = 'noted-terminal-display-size-profiles';
export const DISPLAY_CONTEXT_CHANNEL = 'display-profiles:get-context';
export const DISPLAY_CHANGED_CHANNEL = 'display-profiles:changed';

const same = (a, b) => Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every((key) => a[key] === b[key]);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function pickDisplaySizes(source = {}) {
  return Object.fromEntries(DISPLAY_SIZE_KEYS.map((key) => {
    const [min, max, fallback] = DISPLAY_SIZE_LIMITS[key];
    return [key, finite(source[key]) ? Math.max(min, Math.min(max, source[key])) : fallback];
  }));
}

function normalizeContext(display) {
  if (!display || typeof display.key !== 'string' || !display.key
    || ['__proto__', 'constructor', 'prototype'].includes(display.key)) return null;
  if (!finite(display.width) || !finite(display.height)
    || display.width <= 0 || display.height <= 0) return null;
  return {
    key: display.key,
    label: typeof display.label === 'string' ? display.label : display.key,
    internal: display.internal === true,
    width: display.width,
    height: display.height,
    scaleFactor: finite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1,
  };
}

export function readDisplayProfileMemory(raw, legacySizes = {}) {
  const fallback = pickDisplaySizes(legacySizes);
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const profiles = {};
    for (const [key, profile] of Object.entries(parsed?.profiles || {})) {
      const display = normalizeContext(profile?.display);
      if (display?.key === key) {
        profiles[key] = { display, sizes: pickDisplaySizes({ ...fallback, ...profile.sizes }) };
      }
    }
    return { displayProfiles: profiles, sizes: pickDisplaySizes({ ...fallback, ...parsed?.fallbackSizes }) };
  } catch {
    return { displayProfiles: {}, sizes: fallback };
  }
}

export function serializeDisplayProfileMemory(state) {
  return JSON.stringify({ version: 1, profiles: state.displayProfiles, fallbackSizes: pickDisplaySizes(state) });
}

// Pure transitions return ONE Zustand patch. Consumers never see new monitor
// metadata with old sizes, or a live size without its corresponding profile.
export function applyDisplayContext(state, snapshot) {
  const current = normalizeContext(snapshot?.current);
  if (!current) return {};
  const connected = new Map();
  for (const candidate of snapshot.displays || []) {
    const display = normalizeContext(candidate);
    if (display) connected.set(display.key, display);
  }
  connected.set(current.key, current);
  const connectedDisplays = [...connected.values()];
  const inherited = pickDisplaySizes(state);
  let displayProfiles = state.displayProfiles;
  const write = (key, profile) => {
    if (displayProfiles === state.displayProfiles) displayProfiles = { ...displayProfiles };
    displayProfiles[key] = profile;
  };
  const leaving = displayProfiles[state.activeDisplayKey];
  if (leaving && !same(leaving.sizes, inherited)) {
    write(state.activeDisplayKey, { ...leaving, sizes: inherited });
  }
  for (const display of connectedDisplays) {
    const profile = displayProfiles[display.key];
    if (!profile) write(display.key, { display, sizes: { ...inherited } });
    else if (!same(profile.display, display)) write(display.key, { ...profile, display });
  }
  const patch = {};
  const activeSizes = displayProfiles[current.key].sizes;
  for (const key of DISPLAY_SIZE_KEYS) {
    if (state[key] !== activeSizes[key]) patch[key] = activeSizes[key];
  }
  if (state.activeDisplayKey !== current.key) patch.activeDisplayKey = current.key;
  if (displayProfiles !== state.displayProfiles) patch.displayProfiles = displayProfiles;
  if (JSON.stringify(connectedDisplays) !== JSON.stringify(state.connectedDisplays)) {
    patch.connectedDisplays = connectedDisplays;
  }
  return patch;
}

export function updateDisplayProfileSizes(state, key, requested) {
  key = key ?? state.activeDisplayKey;
  const active = key === null || key === state.activeDisplayKey;
  const profile = key ? state.displayProfiles[key] : null;
  if (key && !profile) return {};
  const previous = active ? pickDisplaySizes(state) : profile.sizes;
  const sizes = { ...previous };
  for (const field of DISPLAY_SIZE_KEYS) {
    if (!finite(requested?.[field])) continue;
    const [min, max] = DISPLAY_SIZE_LIMITS[field];
    sizes[field] = Math.max(min, Math.min(max, requested[field]));
  }
  if (same(previous, sizes)) return {};
  const patch = {};
  if (active) {
    for (const field of DISPLAY_SIZE_KEYS) {
      if (state[field] !== sizes[field]) patch[field] = sizes[field];
    }
  }
  if (profile) {
    patch.displayProfiles = { ...state.displayProfiles, [key]: { ...profile, sizes } };
  }
  return patch;
}

const SURFACE_FONTS = {
  history: ['historyFontSize', 'historyComposerFontSize', 'aiSecondaryFontSize', 'timelineFontSize', 'timelineSummaryFontSize'],
  terminal: ['terminalFontSize'],
  file: ['filePreviewFontSize'],
  navigation: ['terminalFontSize', 'tabsFontSize', 'projectTabsFontSize', 'sidebarFontSize'],
};

export function surfaceFontSizePatch(state, surface, delta) {
  if (delta !== 1 && delta !== -1) return {};
  return Object.fromEntries((SURFACE_FONTS[surface] || []).map((field) => [field, state[field] + delta]));
}

export function fontSizeShortcutDelta(event) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return 0;
  if (event.code === 'Equal' || event.code === 'NumpadAdd') return 1;
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') return -1;
  return 0;
}

export function fontSurfaceFromElement(element) {
  if (typeof element?.closest !== 'function') return null;
  if (element.closest('[inert], [data-history-presented="0"], [data-terminal-layer-presented="0"]')) return null;
  // Floating raw terminals may be inside an AI wrapper: closest wins.
  const root = element.closest('[data-history-owner], [data-history-composer-tab-id], [data-timeline], [data-timeline-portal], [data-terminal-layer-tab-id], .xterm');
  if (!root) return null;
  return root.matches('[data-terminal-layer-tab-id], .xterm') ? 'terminal' : 'history';
}

export function installSurfaceFontShortcuts(target, readContext, adjust) {
  let remembered = null;
  const remember = (event) => {
    const surface = fontSurfaceFromElement(event.target);
    const record = surface ? { surface, element: event.target, tabId: readContext().tabId } : null;
    remembered = record;
    // Pane focus is committed by the click handler later in the same event.
    // Bind the clicked surface to that pane, without a timer or a subscription.
    if (record && event.type === 'pointerdown') queueMicrotask(() => {
      if (remembered === record) record.tabId = readContext().tabId;
    });
  };
  const onKeyDown = (event) => {
    const delta = fontSizeShortcutDelta(event);
    if (!delta) return;
    // Capture beats composer/xterm key handlers and Chromium's default zoom.
    event.preventDefault();
    event.stopImmediatePropagation();
    const context = readContext();
    if (context.blocked) return;
    let surface = 'navigation';
    if (context.view === 'workspace' && context.activeArea === 'workspace') {
      const rememberedSurface = remembered?.tabId === context.tabId
        && remembered.element.isConnected !== false
        && fontSurfaceFromElement(remembered.element);
      surface = rememberedSurface || fontSurfaceFromElement(event.target) || context.fallbackSurface;
    }
    if (surface) adjust(surface, delta);
  };
  target.addEventListener('pointerdown', remember, true);
  target.addEventListener('focusin', remember, true);
  target.addEventListener('keydown', onKeyDown, true);
  return () => {
    target.removeEventListener('pointerdown', remember, true);
    target.removeEventListener('focusin', remember, true);
    target.removeEventListener('keydown', onKeyDown, true);
  };
}

// Subscribe before the initial request. A window move can arrive while invoke
// is in flight; its newer event must win over the older response.
export function subscribeDisplayContext(ipc, apply, onError = console.warn) {
  let disposed = false;
  let eventVersion = 0;
  const onChanged = (_event, context) => {
    eventVersion += 1;
    if (!disposed) apply(context);
  };
  ipc.on(DISPLAY_CHANGED_CHANNEL, onChanged);
  const requestedAt = eventVersion;
  ipc.invoke(DISPLAY_CONTEXT_CHANNEL).then((context) => {
    if (!disposed && requestedAt === eventVersion) apply(context);
  }).catch((error) => {
    if (!disposed) onError('[DisplayProfiles] Cannot read window display', error);
  });
  return () => {
    disposed = true;
    ipc.removeListener(DISPLAY_CHANGED_CHANNEL, onChanged);
  };
}

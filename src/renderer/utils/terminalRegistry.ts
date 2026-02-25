import { Terminal as XTerminal, IMarker } from '@xterm/xterm';
import { SearchAddon, ISearchOptions } from '@xterm/addon-search';

// Global registry to access terminal instances from anywhere
const terminals = new Map<string, XTerminal>();
const searchAddons = new Map<string, SearchAddon>();

// Store current search state per tab
interface SearchState {
  term: string;
  resultIndex: number;
  resultCount: number;
}
const searchStates = new Map<string, SearchState>();

// Viewport state for scroll sync
interface ViewportState {
  top: number;
  bottom: number;
  total: number;
}
const viewportStates = new Map<string, ViewportState>();

// Marker tracking for timeline entry navigation
interface TrackedEntry {
  uuid: string;
  marker: IMarker | null;
  isReachable: boolean;
}
// Map<tabId, Map<uuid, TrackedEntry>>
const entryMarkers = new Map<string, Map<string, TrackedEntry>>();

// Callbacks
type SearchResultsCallback = (results: { resultIndex: number; resultCount: number }) => void;
const searchCallbacks = new Map<string, SearchResultsCallback>();

type ViewportCallback = (viewport: ViewportState) => void;
const viewportCallbacks = new Map<string, ViewportCallback>();

const defaultSearchOptions: ISearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  decorations: {
    matchOverviewRuler: '#888888',
    activeMatchColorOverviewRuler: '#ffcc00',
    matchBackground: '#515c6a',
    activeMatchBackground: '#613214'
  }
};

export const terminalRegistry = {
  register(tabId: string, terminal: XTerminal, searchAddon?: SearchAddon) {
    terminals.set(tabId, terminal);
    if (searchAddon) {
      searchAddons.set(tabId, searchAddon);

      // Subscribe to search results changes
      searchAddon.onDidChangeResults((results) => {
        const state = searchStates.get(tabId) || { term: '', resultIndex: 0, resultCount: 0 };
        state.resultIndex = results?.resultIndex ?? -1;
        state.resultCount = results?.resultCount ?? 0;
        searchStates.set(tabId, state);

        // Notify callback if exists
        const callback = searchCallbacks.get(tabId);
        if (callback) {
          callback({ resultIndex: state.resultIndex + 1, resultCount: state.resultCount });
        }
      });
    }
  },

  unregister(tabId: string) {
    terminals.delete(tabId);
    searchAddons.delete(tabId);
    searchStates.delete(tabId);
    searchCallbacks.delete(tabId);
    viewportStates.delete(tabId);
    viewportCallbacks.delete(tabId);
    entryMarkers.delete(tabId);
  },

  get(tabId: string): XTerminal | undefined {
    return terminals.get(tabId);
  },

  updateViewport(tabId: string, top: number, bottom: number, total: number) {
    const state = { top, bottom, total };
    viewportStates.set(tabId, state);
    const callback = viewportCallbacks.get(tabId);
    if (callback) callback(state);
  },

  onViewportChange(tabId: string, callback: ViewportCallback) {
    viewportCallbacks.set(tabId, callback);
  },

  offViewportChange(tabId: string) {
    viewportCallbacks.delete(tabId);
  },

  getViewportState(tabId: string) {
    return viewportStates.get(tabId);
  },

  getSelection(tabId: string): string {
    const terminal = terminals.get(tabId);
    if (!terminal) return '';
    return terminal.getSelection() || '';
  },

  hasSelection(tabId: string): boolean {
    const terminal = terminals.get(tabId);
    if (!terminal) return false;
    return terminal.hasSelection();
  },

  // Subscribe to search results changes
  onSearchResults(tabId: string, callback: SearchResultsCallback) {
    searchCallbacks.set(tabId, callback);
  },

  // Unsubscribe from search results
  offSearchResults(tabId: string) {
    searchCallbacks.delete(tabId);
  },

  // Get current search state
  getSearchState(tabId: string): SearchState | undefined {
    return searchStates.get(tabId);
  },

  // Search for text in terminal buffer and scroll to it
  // Returns true if found, false otherwise
  searchAndScroll(tabId: string, searchText: string): boolean {
    const searchAddon = searchAddons.get(tabId);
    const terminal = terminals.get(tabId);
    if (!searchAddon) {
      console.warn('[terminalRegistry.searchAndScroll] No SearchAddon for tab:', tabId);
      return false;
    }

    // Update search state
    const state = searchStates.get(tabId) || { term: '', resultIndex: 0, resultCount: 0 };
    state.term = searchText;
    searchStates.set(tabId, state);

    // Search with highlighting
    const found = searchAddon.findNext(searchText, defaultSearchOptions);

    if (terminal) {
      const buf = terminal.buffer.active;
      console.log('[terminalRegistry.searchAndScroll] found:', found, '| len:', searchText.length, '| viewportY:', buf.viewportY);
    }

    return found;
  },

  // Helper to check if current selection looks like a valid user prompt match
  isValidMatch(terminal: XTerminal): boolean {
    const selection = terminal.getSelectionPosition();
    if (!selection) return false;
    
    const buf = terminal.buffer.active;
    // selection.start.y is absolute buffer index in xterm.js
    const line = buf.getLine(selection.start.y);
    if (!line) return false;
    
    // Get prefix before the match
    const prefix = line.translateToString(true).slice(0, selection.start.x);
    
    // 1. Strict prompt check (same as Timeline)
    // Only ❯ (U+276F) and ⏵ (U+23F5) — NOT '>' which matches markdown blockquotes
    const hasPrompt = prefix.includes('\u276F') || prefix.includes('\u23F5');
    // 2. Relaxed check (whitespace, bullets)
    const isValidIndent = /^[\s*·\-\.]*$/.test(prefix);
    
    return hasPrompt || isValidIndent;
  },

  // Search for the Nth occurrence of text (0-indexed) and scroll to it.
  // Used for duplicate timeline entries with identical search keys.
  searchAndScrollToNth(tabId: string, searchText: string, occurrenceIndex: number, skipValidation: boolean = false): boolean {
    const searchAddon = searchAddons.get(tabId);
    const terminal = terminals.get(tabId);
    if (!searchAddon || !terminal) return false;

    // Reset search state so findNext starts from the beginning
    searchAddon.clearDecorations();
    terminal.clearSelection();

    // Update search state
    const state = searchStates.get(tabId) || { term: '', resultIndex: 0, resultCount: 0 };
    state.term = searchText;
    searchStates.set(tabId, state);

    // Find the Nth VALID occurrence (0-indexed)
    let found = false;
    let validCount = 0;
    
    // Limit iterations to prevent freezing on large buffers with many matches
    for (let i = 0; i < 2000; i++) {
      found = searchAddon.findNext(searchText, defaultSearchOptions);
      if (!found) break; // End of buffer reached
      
      // Check if this match is a valid user entry (not a random substring)
      if (skipValidation || this.isValidMatch(terminal)) {
        if (validCount === occurrenceIndex) {
          // Found it! 
          // xterm.js findNext scrolls it into view, but we want to CENTER it.
          const selection = terminal.getSelectionPosition();
          if (selection) {
             const line = selection.start.y;
             const rows = terminal.rows;
             // Calculate line to scroll to so that 'line' is in the middle
             const centerLine = Math.max(0, line - Math.floor(rows / 2));
             terminal.scrollToLine(centerLine);
             console.log('[terminalRegistry.searchAndScrollToNth] Found and centered target occurrence:', occurrenceIndex, 'at line:', line);
          }
          return true;
        }
        validCount++;
      } else {
        // console.log('[terminalRegistry] Skipping invalid match (inside content)');
      }
    }

    console.log('[terminalRegistry.searchAndScrollToNth] key:', JSON.stringify(searchText), 'occurrence:', occurrenceIndex, 'found:', found, 'validMatches:', validCount);
    return false;
  },

  // Find next occurrence
  findNext(tabId: string, searchText: string): boolean {
    const searchAddon = searchAddons.get(tabId);
    if (!searchAddon) return false;
    return searchAddon.findNext(searchText, defaultSearchOptions);
  },

  // Find previous occurrence
  findPrevious(tabId: string, searchText: string): boolean {
    const searchAddon = searchAddons.get(tabId);
    if (!searchAddon) return false;
    return searchAddon.findPrevious(searchText, defaultSearchOptions);
  },

  // Clear search decorations
  clearSearch(tabId: string) {
    const searchAddon = searchAddons.get(tabId);
    if (searchAddon) {
      searchAddon.clearDecorations();
    }
    searchStates.delete(tabId);

    // Notify callback that search is cleared
    const callback = searchCallbacks.get(tabId);
    if (callback) {
      callback({ resultIndex: 0, resultCount: 0 });
    }
  },

  // === Marker Tracking API ===

  // Register a marker at the current cursor line for a given entry UUID
  registerEntryMarker(tabId: string, uuid: string): boolean {
    const terminal = terminals.get(tabId);
    if (!terminal) return false;

    let tabMarkers = entryMarkers.get(tabId);
    if (!tabMarkers) {
      tabMarkers = new Map();
      entryMarkers.set(tabId, tabMarkers);
    }

    // Don't re-register if already tracked with a live marker
    const existing = tabMarkers.get(uuid);
    if (existing?.marker && !existing.marker.isDisposed) {
      return true;
    }

    const marker = terminal.registerMarker(0);
    if (!marker) {
      console.warn('[terminalRegistry.registerEntryMarker] Failed to create marker for', uuid);
      tabMarkers.set(uuid, { uuid, marker: null, isReachable: false });
      return false;
    }

    const tracked: TrackedEntry = { uuid, marker, isReachable: true };
    marker.onDispose(() => {
      tracked.isReachable = false;
      tracked.marker = null;
    });
    tabMarkers.set(uuid, tracked);
    console.log('[terminalRegistry.registerEntryMarker] Registered marker for', uuid, 'at line', marker.line);
    return true;
  },

  // Scroll to an entry using its marker. Returns true if successful.
  scrollToEntry(tabId: string, uuid: string): boolean {
    const terminal = terminals.get(tabId);
    const tabMarkers = entryMarkers.get(tabId);
    if (!terminal || !tabMarkers) return false;

    const tracked = tabMarkers.get(uuid);
    if (!tracked?.marker || tracked.marker.isDisposed) {
      console.log('[terminalRegistry.scrollToEntry] Marker not available for', uuid);
      return false;
    }

    const line = tracked.marker.line;
    console.log('[terminalRegistry.scrollToEntry] Scrolling to line', line, 'for', uuid);
    terminal.scrollToLine(line);
    return true;
  },

  // Check if an entry's marker is still reachable (not disposed by scrollback trim)
  isEntryReachable(tabId: string, uuid: string): boolean {
    const tabMarkers = entryMarkers.get(tabId);
    if (!tabMarkers) return true; // No markers tracked yet — assume reachable
    const tracked = tabMarkers.get(uuid);
    if (!tracked) return true; // Not tracked yet — assume reachable
    return tracked.isReachable;
  },

  // Get the buffer line number for a tracked entry, or null
  getEntryMarkerLine(tabId: string, uuid: string): number | null {
    const tabMarkers = entryMarkers.get(tabId);
    if (!tabMarkers) return null;
    const tracked = tabMarkers.get(uuid);
    if (!tracked?.marker || tracked.marker.isDisposed) return null;
    return tracked.marker.line;
  },

  // Retrospective binding: search for text, find its position, register marker there
  bindEntryBySearch(tabId: string, uuid: string, searchText: string): boolean {
    const terminal = terminals.get(tabId);
    const searchAddon = searchAddons.get(tabId);
    if (!terminal || !searchAddon) return false;

    // Skip if already bound with a live marker
    const tabMarkers = entryMarkers.get(tabId);
    if (tabMarkers) {
      const existing = tabMarkers.get(uuid);
      if (existing?.marker && !existing.marker.isDisposed) {
        return true; // Already bound
      }
    }

    // Skip if user has active text selection — findNext would destroy it
    if (terminal.hasSelection()) return false;

    // Find the text in the buffer
    const found = searchAddon.findNext(searchText, { ...defaultSearchOptions, decorations: undefined });
    if (!found) {
      console.log('[terminalRegistry.bindEntryBySearch] Text not found for', uuid, ':', searchText.slice(0, 30));
      return false;
    }

    // Get selection position (the found match)
    const selection = terminal.getSelectionPosition();
    if (!selection) {
      searchAddon.clearDecorations();
      terminal.clearSelection();
      return false;
    }

    // Register marker at the found line
    // We need to compute the offset from current cursor to the found line
    const buf = terminal.buffer.active;
    const foundAbsoluteLine = selection.start.y + buf.viewportY;
    const cursorAbsoluteLine = buf.cursorY + buf.baseY;
    const offset = foundAbsoluteLine - cursorAbsoluteLine;

    let markers = entryMarkers.get(tabId);
    if (!markers) {
      markers = new Map();
      entryMarkers.set(tabId, markers);
    }

    const marker = terminal.registerMarker(offset);
    if (marker) {
      const tracked: TrackedEntry = { uuid, marker, isReachable: true };
      marker.onDispose(() => {
        tracked.isReachable = false;
        tracked.marker = null;
      });
      markers.set(uuid, tracked);
      console.log('[terminalRegistry.bindEntryBySearch] Bound', uuid, 'at line', marker.line);
    }

    // Clean up search state
    searchAddon.clearDecorations();
    terminal.clearSelection();
    return !!marker;
  },

  // Get all entry markers for a tab (used by Timeline for reachability checks)
  getEntryMarkers(tabId: string): Map<string, TrackedEntry> | undefined {
    return entryMarkers.get(tabId);
  },

  // Get visible text in the current terminal viewport (for Timeline visibility check)
  getVisibleText(tabId: string): string {
    const terminal = terminals.get(tabId);
    if (!terminal) return '';
    const buf = terminal.buffer.active;
    const startLine = buf.viewportY;
    const endLine = Math.min(startLine + terminal.rows, buf.length);
    const parts: string[] = [];
    for (let i = startLine; i < endLine; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      if (i > startLine && !line.isWrapped) parts.push('\n');
      // Preserve trailing spaces on lines that wrap to next (the space is content, not padding)
      const nextLine = (i + 1 < buf.length) ? buf.getLine(i + 1) : null;
      parts.push(line.translateToString(!nextLine?.isWrapped));
    }
    return parts.join('');
  },

  // Get full buffer text (viewport + scrollback) for reachability checks
  getFullBufferText(tabId: string): string {
    const terminal = terminals.get(tabId);
    if (!terminal) return '';
    const buf = terminal.buffer.active;
    const parts: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      if (i > 0 && !line.isWrapped) parts.push('\n');
      // Preserve trailing spaces on lines that wrap to next (the space is content, not padding)
      const nextLine = (i + 1 < buf.length) ? buf.getLine(i + 1) : null;
      parts.push(line.translateToString(!nextLine?.isWrapped));
    }
    return parts.join('');
  }
};

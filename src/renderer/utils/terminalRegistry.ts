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

// Prompt boundary markers injected via OSC 7777 from main.js
// Map<tabId, Map<seq, IMarker>>
const promptBoundaries = new Map<string, Map<number, IMarker>>();

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
    promptBoundaries.delete(tabId);
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

  // === Prompt Boundary API (OSC 7777 markers from main.js) ===

  // Register a prompt boundary marker at the current cursor position.
  // Called from OSC 7777 handler when main.js injects prompt:<seq> into PTY stream.
  registerPromptBoundary(tabId: string, seq: number): void {
    const terminal = terminals.get(tabId);
    if (!terminal) return;

    let tabBoundaries = promptBoundaries.get(tabId);
    if (!tabBoundaries) {
      tabBoundaries = new Map();
      promptBoundaries.set(tabId, tabBoundaries);
    }

    // Don't re-register same sequence
    if (tabBoundaries.has(seq)) return;

    const marker = terminal.registerMarker(0);
    if (marker) {
      tabBoundaries.set(seq, marker);
      marker.onDispose(() => tabBoundaries!.delete(seq));
      console.log('[terminalRegistry] Prompt boundary #' + seq + ' at line ' + marker.line);
    }
  },

  // Bind a timeline entry UUID to the Nth prompt boundary marker.
  // Returns true if bound successfully. Entry N maps to prompt boundary N.
  bindEntryToPromptBoundary(tabId: string, uuid: string, promptSeq: number): boolean {
    const tabBoundaries = promptBoundaries.get(tabId);
    if (!tabBoundaries) return false;

    const marker = tabBoundaries.get(promptSeq);
    if (!marker || marker.isDisposed) return false;

    // Skip if already bound with a live marker
    const tabMarkers = entryMarkers.get(tabId);
    if (tabMarkers) {
      const existing = tabMarkers.get(uuid);
      if (existing?.marker && !existing.marker.isDisposed) return true;
    }

    let markers = entryMarkers.get(tabId);
    if (!markers) {
      markers = new Map();
      entryMarkers.set(tabId, markers);
    }

    const tracked: TrackedEntry = { uuid, marker, isReachable: true };
    marker.onDispose(() => {
      tracked.isReachable = false;
      tracked.marker = null;
    });
    markers.set(uuid, tracked);
    console.log('[terminalRegistry] Bound entry', uuid, 'to prompt boundary #' + promptSeq, 'at line', marker.line);
    return true;
  },

  // Get the number of prompt boundaries detected for a tab
  getPromptBoundaryCount(tabId: string): number {
    return promptBoundaries.get(tabId)?.size ?? 0;
  },

  // Get buffer row position from an entry's marker (Claude only).
  // Returns -1 if marker doesn't exist or has been disposed.
  getMarkerRow(tabId: string, uuid: string): number {
    const tabMarkers = entryMarkers.get(tabId);
    if (!tabMarkers) return -1;
    const tracked = tabMarkers.get(uuid);
    if (!tracked?.marker || tracked.marker.isDisposed) return -1;
    return tracked.marker.line;
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
  },

  // Build position index for multiple entries in a single buffer pass (Gemini).
  // Entries must be in chronological order. Uses anchored search: each entry
  // is found after the previous one's position, avoiding false duplicates.
  // Returns array of buffer rows (-1 if not found).
  buildPositionIndex(tabId: string, searchEntries: { searchLines: string[] }[]): number[] {
    const terminal = terminals.get(tabId);
    if (!terminal) return searchEntries.map(() => -1);

    const buf = terminal.buffer.active;

    // Build logical lines once (handles Ink TUI wrapping)
    const logicalLines: { text: string; bufRow: number }[] = [];
    let currentText = '';
    let currentStartRow = 0;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      if (i > 0 && !line.isWrapped) {
        logicalLines.push({ text: currentText, bufRow: currentStartRow });
        currentText = '';
        currentStartRow = i;
      }
      const nextLine = (i + 1 < buf.length) ? buf.getLine(i + 1) : null;
      currentText += line.translateToString(!nextLine?.isWrapped);
    }
    if (currentText) logicalLines.push({ text: currentText, bufRow: currentStartRow });
    if (logicalLines.length === 0) return searchEntries.map(() => -1);

    // Line matcher (same logic as scrollToTextInBuffer/findTextBufferRow)
    const nonAlphaRe = /[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/;
    const matchLine = (haystack: string, needle: string, strict: boolean, isolated: boolean): boolean => {
      if (strict) {
        const trimmed = haystack.trim();
        if (trimmed === needle) return true;
        if (trimmed.length > needle.length + 4) return false;
        const pos = trimmed.indexOf(needle);
        if (pos < 0) return false;
        if (pos === 0) return true;
        return !nonAlphaRe.test(trimmed.slice(0, pos));
      }
      if (isolated) {
        const trimmed = haystack.trim();
        if (trimmed.length > needle.length + 25) return false;
        const pos = trimmed.indexOf(needle);
        if (pos < 0) return false;
        if (pos === 0) return true;
        return !nonAlphaRe.test(trimmed.slice(0, pos));
      }
      if (needle.length >= 5) return haystack.includes(needle);
      let from = 0;
      while (true) {
        const pos = haystack.indexOf(needle, from);
        if (pos === -1) return false;
        const before = pos > 0 ? haystack[pos - 1] : ' ';
        const after = pos + needle.length < haystack.length ? haystack[pos + needle.length] : ' ';
        const boundaryRe = /[\s\.,;:!?\-—–()\[\]{}<>\/\\|"'`~@#$%^&*+=]/;
        if ((pos === 0 || boundaryRe.test(before)) && (pos + needle.length === haystack.length || boundaryRe.test(after))) {
          return true;
        }
        from = pos + 1;
      }
    };

    const results: number[] = [];
    let searchFromIdx = 0;

    for (const { searchLines } of searchEntries) {
      if (searchLines.length === 0) { results.push(-1); continue; }

      const firstLine = searchLines[0];
      const isStrict = searchLines.length === 1 && firstLine.length < 5;
      const isIsolated = searchLines.length === 1 && firstLine.length < 30;

      let found = -1;
      for (let i = searchFromIdx; i < logicalLines.length; i++) {
        if (!matchLine(logicalLines[i].text, firstLine, isStrict, isIsolated)) continue;

        let allMatch = true;
        if (searchLines.length > 1) {
          let bufIdx = i + 1;
          for (let j = 1; j < searchLines.length; j++) {
            let lineFound = false;
            for (let gap = 0; gap < 5 && bufIdx < logicalLines.length; gap++, bufIdx++) {
              if (matchLine(logicalLines[bufIdx].text, searchLines[j], false, false)) {
                lineFound = true; bufIdx++; break;
              }
            }
            if (!lineFound) { allMatch = false; break; }
          }
          if (!allMatch) {
            allMatch = searchLines.slice(1).every(cl => logicalLines[i].text.includes(cl));
          }
          // Truncation fallback: only for single-line entries.
          // Multi-line entries (e.g. "[Claude Sub-Agent Response]\nUnique text...")
          // MUST match on line 2+ to disambiguate identical first lines.
          if (!allMatch && firstLine.length >= 15 && searchLines.length <= 1) allMatch = true;
        }

        if (allMatch) {
          found = logicalLines[i].bufRow;
          searchFromIdx = i + 1;
          break;
        }
      }

      // Fallback: if anchored search failed, retry from beginning.
      // Anchoring can miss entries when a false positive in an AI response
      // advances searchFromIdx past the actual user message position.
      if (found < 0 && searchFromIdx > 0) {
        for (let i = 0; i < searchFromIdx; i++) {
          if (!matchLine(logicalLines[i].text, firstLine, isStrict, isIsolated)) continue;

          let allMatch = true;
          if (searchLines.length > 1) {
            let bufIdx = i + 1;
            for (let j = 1; j < searchLines.length; j++) {
              let lineFound = false;
              for (let gap = 0; gap < 5 && bufIdx < logicalLines.length; gap++, bufIdx++) {
                if (matchLine(logicalLines[bufIdx].text, searchLines[j], false, false)) {
                  lineFound = true; bufIdx++; break;
                }
              }
              if (!lineFound) { allMatch = false; break; }
            }
            if (!allMatch) {
              allMatch = searchLines.slice(1).every(cl => logicalLines[i].text.includes(cl));
            }
            if (!allMatch && firstLine.length >= 15 && searchLines.length <= 1) allMatch = true;
          }

          if (allMatch) {
            found = logicalLines[i].bufRow;
            // Don't advance searchFromIdx — preserve ordering for subsequent entries
            break;
          }
        }
      }

      results.push(found);
    }

    return results;
  },

  // Buffer-text based search + scroll. Used for Gemini where xterm search addon
  // validation (❯/⏵ prompt markers) doesn't apply.
  // Searches full buffer text for multi-line content patterns and scrolls to match.
  //
  // startAfterRow: if provided, only consider matches starting after this buffer row.
  // Used by Gemini click handler to anchor navigation: find current entry only AFTER
  // the previous entry's position, avoiding false matches in earlier AI responses.
  //
  // Returns true if found and scrolled.
  scrollToTextInBuffer(tabId: string, contentLines: string[], occurrenceIndex: number, startAfterRow: number = -1): boolean {
    const terminal = terminals.get(tabId);
    if (!terminal) return false;

    const buf = terminal.buffer.active;

    // Build line-to-bufferRow mapping: logical line index → first buffer row
    // (accounts for wrapped lines being part of the same logical line)
    const logicalLines: { text: string; bufRow: number }[] = [];
    let currentText = '';
    let currentStartRow = 0;

    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;

      if (i > 0 && !line.isWrapped) {
        // New logical line — flush previous
        logicalLines.push({ text: currentText, bufRow: currentStartRow });
        currentText = '';
        currentStartRow = i;
      }
      const nextLine = (i + 1 < buf.length) ? buf.getLine(i + 1) : null;
      currentText += line.translateToString(!nextLine?.isWrapped);
    }
    // Flush last
    if (currentText) {
      logicalLines.push({ text: currentText, bufRow: currentStartRow });
    }

    if (logicalLines.length === 0 || contentLines.length === 0) return false;

    // Matching logic: for very short single-line entries (< 5 chars, e.g. "да"),
    // require the buffer line to be a near-exact match (trimmed line ≈ search text),
    // otherwise "да" would match "да Добавь также..." which is a different entry.
    const isStrictShort = contentLines.length === 1 && contentLines[0].length < 5;

    // Isolated match: for single-line entries that are short-ish (< 30 chars),
    // common words like "continue", "yes", "done" appear in AI responses too.
    // Require the buffer line (trimmed) to be close in length to the needle:
    // the line should not have much more content beyond the match + prompt prefix.
    // This prevents "continue" from matching "Let me continue working on docs..."
    const isIsolatedShort = contentLines.length === 1 && contentLines[0].length < 30;

    function lineContains(haystack: string, needle: string): boolean {
      if (isStrictShort) {
        // Strict: very short entries (< 5 chars, e.g. "да", "yes", "ok").
        // Trimmed line must be the needle alone, or needle with a short non-alphanumeric
        // prefix (prompt chars like "> "). This prevents matching "года" or "тогда"
        // where "да" appears at the end of a word.
        const trimmed = haystack.trim();
        if (trimmed === needle) return true;
        if (trimmed.length > needle.length + 4) return false;
        const pos = trimmed.indexOf(needle);
        if (pos < 0) return false;
        if (pos === 0) return true;
        // Prefix must be non-alphanumeric (prompt chars, punctuation, spaces)
        const prefix = trimmed.slice(0, pos);
        return !/[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(prefix);
      }
      if (isIsolatedShort) {
        // Isolated: short entries (5-29 chars, e.g. "continue", "done").
        // Needle must appear near the START of trimmed line (user typed it at prompt),
        // not mid-sentence in AI text. Prefix before needle must be non-alphanumeric.
        // This prevents "continue" from matching AI lines like "OK, continue." or
        // "Sure, I'll continue working..." where the word is embedded in a sentence.
        // Gemini TUI adds indentation/decorations, so allow generous prefix (+25 chars).
        const trimmed = haystack.trim();
        if (trimmed.length > needle.length + 25) return false;
        const pos = trimmed.indexOf(needle);
        if (pos < 0) return false;
        if (pos === 0) return true;
        // Prefix before needle must contain no letters/digits (just prompt/punctuation)
        const prefix = trimmed.slice(0, pos);
        return !/[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(prefix);
      }
      if (needle.length >= 5) return haystack.includes(needle);
      // Word-boundary: check chars before and after the match aren't word chars
      let from = 0;
      while (true) {
        const pos = haystack.indexOf(needle, from);
        if (pos === -1) return false;
        const before = pos > 0 ? haystack[pos - 1] : ' ';
        const after = pos + needle.length < haystack.length ? haystack[pos + needle.length] : ' ';
        const boundaryRe = /[\s\.,;:!?\-—–()\[\]{}<>\/\\|"'`~@#$%^&*+=]/;
        if ((pos === 0 || boundaryRe.test(before)) && (pos + needle.length === haystack.length || boundaryRe.test(after))) {
          return true;
        }
        from = pos + 1;
      }
    }

    // Search for multi-line match: all contentLines must match logical lines.
    // Buffer may have empty lines between content (Gemini TUI formatting),
    // so we skip empty lines when matching subsequent contentLines.
    const firstLine = contentLines[0];
    let validCount = 0;

    for (let i = 0; i < logicalLines.length; i++) {
      // Skip lines before startAfterRow (anchored search for ordered entries)
      if (startAfterRow >= 0 && logicalLines[i].bufRow <= startAfterRow) continue;

      // First content line must be found within this logical line
      if (!lineContains(logicalLines[i].text, firstLine)) continue;

      let allMatch = true;

      if (contentLines.length > 1) {
        // Multi-line match: check remaining content lines in subsequent logical lines
        // allowing up to 5 gap lines (empty, separators, TUI formatting) between matches.
        let bufIdx = i + 1;
        for (let j = 1; j < contentLines.length; j++) {
          let found = false;
          const maxGap = 5;
          for (let gap = 0; gap < maxGap && bufIdx < logicalLines.length; gap++, bufIdx++) {
            if (lineContains(logicalLines[bufIdx].text, contentLines[j])) {
              found = true;
              bufIdx++;
              break;
            }
          }
          if (!found) {
            allMatch = false;
            break;
          }
        }

        // Same-line fallback: Gemini Ink TUI may collapse multi-line user input
        // into a single logical line. If multi-line match failed, check if ALL
        // remaining content lines exist as substrings within the same logical line.
        if (!allMatch) {
          const sameLine = logicalLines[i].text;
          allMatch = contentLines.slice(1).every(cl => sameLine.includes(cl));
        }

        // Truncation fallback: Gemini TUI truncates long user messages in display.
        // If first line (up to 50 chars) is found but remaining lines are absent
        // from the buffer entirely, accept first-line-only match when it's long enough.
        if (!allMatch && firstLine.length >= 15) {
          allMatch = true;
        }
      }

      if (!allMatch) continue;

      if (validCount === occurrenceIndex) {
        // Found target — scroll to center
        const targetRow = logicalLines[i].bufRow;
        const centerRow = Math.max(0, targetRow - Math.floor(terminal.rows / 2));
        terminal.scrollToLine(centerRow);
        console.log('[terminalRegistry.scrollToTextInBuffer] Found at logicalLine:', i, 'bufRow:', targetRow, 'occurrence:', occurrenceIndex, 'startAfterRow:', startAfterRow);
        return true;
      }
      validCount++;
    }

    console.log('[terminalRegistry.scrollToTextInBuffer] NOT found. contentLines[0]:', JSON.stringify(firstLine), 'occurrence:', occurrenceIndex, 'validMatches:', validCount, 'startAfterRow:', startAfterRow);
    return false;
  },

  // Find the buffer row of a text match WITHOUT scrolling.
  // Used by Gemini click handler to find previous entry positions for anchored search.
  // Returns the buffer row number, or -1 if not found.
  findTextBufferRow(tabId: string, contentLines: string[], occurrenceIndex: number, startAfterRow: number = -1): number {
    const terminal = terminals.get(tabId);
    if (!terminal) return -1;

    const buf = terminal.buffer.active;

    // Build logical lines (same as scrollToTextInBuffer)
    const logicalLines: { text: string; bufRow: number }[] = [];
    let currentText = '';
    let currentStartRow = 0;

    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;

      if (i > 0 && !line.isWrapped) {
        logicalLines.push({ text: currentText, bufRow: currentStartRow });
        currentText = '';
        currentStartRow = i;
      }
      const nextLine = (i + 1 < buf.length) ? buf.getLine(i + 1) : null;
      currentText += line.translateToString(!nextLine?.isWrapped);
    }
    if (currentText) {
      logicalLines.push({ text: currentText, bufRow: currentStartRow });
    }

    if (logicalLines.length === 0 || contentLines.length === 0) return -1;

    const isStrictShort = contentLines.length === 1 && contentLines[0].length < 5;
    const isIsolatedShort = contentLines.length === 1 && contentLines[0].length < 30;

    function lineContains(haystack: string, needle: string): boolean {
      if (isStrictShort) {
        // Strict: very short entries (< 5 chars). Prefix must be non-alphanumeric.
        const trimmed = haystack.trim();
        if (trimmed === needle) return true;
        if (trimmed.length > needle.length + 4) return false;
        const pos = trimmed.indexOf(needle);
        if (pos < 0) return false;
        if (pos === 0) return true;
        const prefix = trimmed.slice(0, pos);
        return !/[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(prefix);
      }
      if (isIsolatedShort) {
        // Isolated: needle must appear near the START of trimmed line (user-typed text),
        // not mid-sentence in AI responses. Prefix must be non-alphanumeric.
        // Gemini TUI adds indentation/decorations, so allow generous prefix (+25 chars).
        const trimmed = haystack.trim();
        if (trimmed.length > needle.length + 25) return false;
        const pos = trimmed.indexOf(needle);
        if (pos < 0) return false;
        if (pos === 0) return true;
        const prefix = trimmed.slice(0, pos);
        return !/[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(prefix);
      }
      if (needle.length >= 5) return haystack.includes(needle);
      let from = 0;
      while (true) {
        const pos = haystack.indexOf(needle, from);
        if (pos === -1) return false;
        const before = pos > 0 ? haystack[pos - 1] : ' ';
        const after = pos + needle.length < haystack.length ? haystack[pos + needle.length] : ' ';
        const boundaryRe = /[\s\.,;:!?\-—–()\[\]{}<>\/\\|"'`~@#$%^&*+=]/;
        if ((pos === 0 || boundaryRe.test(before)) && (pos + needle.length === haystack.length || boundaryRe.test(after))) {
          return true;
        }
        from = pos + 1;
      }
    }

    const firstLine = contentLines[0];
    let validCount = 0;

    for (let i = 0; i < logicalLines.length; i++) {
      if (startAfterRow >= 0 && logicalLines[i].bufRow <= startAfterRow) continue;

      if (!lineContains(logicalLines[i].text, firstLine)) continue;

      let allMatch = true;

      if (contentLines.length > 1) {
        // Allow up to 5 gap lines (empty, separators, TUI formatting) between matches
        let bufIdx = i + 1;
        for (let j = 1; j < contentLines.length; j++) {
          let found = false;
          const maxGap = 5;
          for (let gap = 0; gap < maxGap && bufIdx < logicalLines.length; gap++, bufIdx++) {
            if (lineContains(logicalLines[bufIdx].text, contentLines[j])) {
              found = true;
              bufIdx++;
              break;
            }
          }
          if (!found) {
            allMatch = false;
            break;
          }
        }

        // Same-line fallback: Gemini Ink TUI may collapse multi-line user input
        // into a single logical line. Check if all remaining content lines exist
        // as substrings within the same logical line.
        if (!allMatch) {
          const sameLine = logicalLines[i].text;
          allMatch = contentLines.slice(1).every(cl => sameLine.includes(cl));
        }

        // Truncation fallback: Gemini TUI truncates long user messages in display.
        // Accept first-line-only match when it's long enough (>= 30 chars).
        if (!allMatch && firstLine.length >= 15) {
          allMatch = true;
        }
      }

      if (!allMatch) continue;

      if (validCount === occurrenceIndex) {
        return logicalLines[i].bufRow;
      }
      validCount++;
    }

    return -1;
  }
};

// Expose for testing (accessed via page.evaluate in Playwright tests)
(window as any).__terminalRegistry = terminalRegistry;

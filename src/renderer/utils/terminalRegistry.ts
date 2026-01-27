import { Terminal as XTerminal } from '@xterm/xterm';
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

// Callbacks for search results changes
type SearchResultsCallback = (results: { resultIndex: number; resultCount: number }) => void;
const searchCallbacks = new Map<string, SearchResultsCallback>();

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
  },

  get(tabId: string): XTerminal | undefined {
    return terminals.get(tabId);
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
    if (!searchAddon) {
      console.warn('[terminalRegistry] No SearchAddon for tab:', tabId);
      return false;
    }

    // Update search state
    const state = searchStates.get(tabId) || { term: '', resultIndex: 0, resultCount: 0 };
    state.term = searchText;
    searchStates.set(tabId, state);

    // Search with highlighting
    const found = searchAddon.findNext(searchText, defaultSearchOptions);
    return found;
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
  }
};

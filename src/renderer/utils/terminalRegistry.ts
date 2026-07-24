import type { Terminal as XTerminal, IMarker } from '@xterm/xterm';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search';
import {
  findLastCodexComposerPromptIndex,
  hasCodexComposerPromptGlyph,
} from './codexComposerGlyphs.mjs';

// Global registry to access terminal instances from anywhere
interface TerminalRegistryStore {
  terminals: Map<string, XTerminal>;
  terminalWaiters: Map<string, Set<(terminal: XTerminal | undefined) => void>>;
  searchAddons: Map<string, SearchAddon>;
  searchStates: Map<string, SearchState>;
  viewportStates: Map<string, ViewportState>;
  entryMarkers: Map<string, Map<string, TrackedEntry>>;
  promptBoundaries: Map<string, Map<number, IMarker>>;
  promptBoundaryLatestSeq: Map<string, number>;
  promptBoundaryWaiters: Map<string, Set<(seq: number) => void>>;
  searchCallbacks: Map<string, SearchResultsCallback>;
  viewportCallbacks: Map<string, ViewportCallback>;
}

type TerminalRegistryGlobal = typeof globalThis & {
  __notedTerminalRegistryStore?: TerminalRegistryStore;
};

// Store current search state per tab
interface SearchState {
  term: string;
  resultIndex: number;
  resultCount: number;
}

// Viewport state for scroll sync
interface ViewportState {
  top: number;
  bottom: number;
  total: number;
}

// Marker tracking for timeline entry navigation
interface TrackedEntry {
  uuid: string;
  marker: IMarker | null;
  isReachable: boolean;
}

// Callbacks
type SearchResultsCallback = (results: { resultIndex: number; resultCount: number }) => void;

type ViewportCallback = (viewport: ViewportState) => void;

const registryStore = ((globalThis as TerminalRegistryGlobal).__notedTerminalRegistryStore ||= {
  terminals: new Map<string, XTerminal>(),
  terminalWaiters: new Map<string, Set<(terminal: XTerminal | undefined) => void>>(),
  searchAddons: new Map<string, SearchAddon>(),
  searchStates: new Map<string, SearchState>(),
  viewportStates: new Map<string, ViewportState>(),
  entryMarkers: new Map<string, Map<string, TrackedEntry>>(),
  promptBoundaries: new Map<string, Map<number, IMarker>>(),
  promptBoundaryLatestSeq: new Map<string, number>(),
  promptBoundaryWaiters: new Map<string, Set<(seq: number) => void>>(),
  searchCallbacks: new Map<string, SearchResultsCallback>(),
  viewportCallbacks: new Map<string, ViewportCallback>(),
});
registryStore.terminalWaiters ||= new Map<string, Set<(terminal: XTerminal | undefined) => void>>();
registryStore.promptBoundaryWaiters ||= new Map<string, Set<(seq: number) => void>>();
registryStore.promptBoundaryLatestSeq ||= new Map<string, number>();

const terminals = registryStore.terminals;
const terminalWaiters = registryStore.terminalWaiters;
const searchAddons = registryStore.searchAddons;
const searchStates = registryStore.searchStates;
const viewportStates = registryStore.viewportStates;
const entryMarkers = registryStore.entryMarkers;
const promptBoundaries = registryStore.promptBoundaries;
const promptBoundaryLatestSeq = registryStore.promptBoundaryLatestSeq;
const promptBoundaryWaiters = registryStore.promptBoundaryWaiters;
const searchCallbacks = registryStore.searchCallbacks;
const viewportCallbacks = registryStore.viewportCallbacks;

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

const GEMINI_BRAILLE_RE = /[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/;
const CODEX_NON_DRAFT_LINE_RE = /(OpenAI Codex|model:|directory:|permissions:|Use \/skills|Full Access|Context \d+%|weekly \d+%|Starting MCP|esc to interrupt|Select Model|Tip:|Model changed|^╭|^╰|^│)/i;
const CODEX_EMPTY_COMPOSER_HINT_RE = /Use \/skills to list available skills/i;

interface LogicalCell {
  ch: string;
  dim: boolean;
}

interface LogicalLineSnapshot {
  text: string;
  cells: LogicalCell[];
}

interface CodexDraftState {
  hasDraft: boolean | null;
  preview: string;
  source: string;
  debug?: string;
  success?: boolean;
  timedOut?: boolean;
  checks?: number;
}

function getLogicalLineSnapshotAt(buf: any, row: number): LogicalLineSnapshot {
  if (!buf || row < 0 || row >= buf.length) return { text: '', cells: [] };
  let start = row;
  let line = buf.getLine(start);
  while (line?.isWrapped && start > 0) {
    start -= 1;
    line = buf.getLine(start);
  }

  const cells: LogicalCell[] = [];
  for (let i = start; i < buf.length; i++) {
    const cur = buf.getLine(i);
    if (!cur) break;
    const next = i + 1 < buf.length ? buf.getLine(i + 1) : null;

    for (let x = 0; x < cur.length; x++) {
      const cell = cur.getCell(x);
      if (!cell || cell.getWidth?.() === 0) continue;
      const ch = cell.getChars?.() || ' ';
      cells.push({
        ch: ch || ' ',
        dim: !!cell.isDim?.(),
      });
    }
    if (!next?.isWrapped) break;
  }

  while (cells.length > 0 && !cells[cells.length - 1].ch.trim()) cells.pop();
  return { text: cells.map((cell) => cell.ch).join(''), cells };
}

function extractCodexDraftFromLine(snapshotOrLine: LogicalLineSnapshot | string): { hasDraft: boolean | null; preview: string; sourceSuffix?: string } {
  const snapshot: LogicalLineSnapshot = typeof snapshotOrLine === 'string'
    ? { text: snapshotOrLine, cells: [] }
    : snapshotOrLine;
  const normalized = String(snapshot.text || '')
    .replace(/\u00a0/g, ' ')
    .trimEnd();
  const normalizedClean = normalized.replace(/[▌█]/g, '');
  if (!normalizedClean.trim()) return { hasDraft: false, preview: '' };

  const promptIdx = findLastCodexComposerPromptIndex(normalized);
  if (promptIdx >= 0) {
    const afterPrompt = normalized.slice(promptIdx + 1).replace(/[▌█]/g, '').trim();
    if (!afterPrompt) return { hasDraft: false, preview: '' };
    const afterPromptCells = snapshot.cells
      .slice(promptIdx + 1)
      .filter((cell) => cell.ch.trim() && cell.ch !== '▌' && cell.ch !== '█');
    if (afterPromptCells.length > 0 && afterPromptCells.every((cell) => cell.dim)) {
      return { hasDraft: false, preview: afterPrompt.slice(0, 120), sourceSuffix: ':dim-hint' };
    }
    if (CODEX_EMPTY_COMPOSER_HINT_RE.test(afterPrompt)) {
      return { hasDraft: false, preview: afterPrompt.slice(0, 120), sourceSuffix: ':idle-hint' };
    }
    if (CODEX_NON_DRAFT_LINE_RE.test(afterPrompt)) return { hasDraft: null, preview: afterPrompt.slice(0, 120) };
    return { hasDraft: true, preview: afterPrompt.slice(0, 120) };
  }

  const nonBlankCells = snapshot.cells
    .filter((cell) => cell.ch.trim() && cell.ch !== '▌' && cell.ch !== '█');
  if (nonBlankCells.length > 0 && nonBlankCells.every((cell) => cell.dim)) {
    return { hasDraft: false, preview: normalizedClean.trim().slice(0, 120), sourceSuffix: ':dim-hint' };
  }
  if (CODEX_EMPTY_COMPOSER_HINT_RE.test(normalizedClean.trim())) {
    return { hasDraft: false, preview: normalizedClean.trim().slice(0, 120), sourceSuffix: ':idle-hint' };
  }
  if (CODEX_NON_DRAFT_LINE_RE.test(normalizedClean.trim())) return { hasDraft: null, preview: normalizedClean.trim().slice(0, 120) };

  return { hasDraft: null, preview: normalizedClean.trim().slice(0, 120) };
}

function extractCodexDraftAfterEmptyPrompt(buf: any, promptRow: number): { hasDraft: true; preview: string; sourceSuffix: string } | null {
  if (!buf || promptRow < 0 || promptRow >= buf.length) return null;
  const end = Math.min(buf.length, promptRow + 18);
  for (let row = promptRow + 1; row < end; row++) {
    const line = buf.getLine(row);
    if (!line) break;

    const snapshot = getLogicalLineSnapshotAt(buf, row);
    const raw = String(line.translateToString?.(true) || '');
    const normalized = (String(snapshot.text || '') || raw)
      .replace(/\u00a0/g, ' ')
      .replace(/[▌█]/g, '')
      .trimEnd();
    const rawNormalized = raw
      .replace(/\u00a0/g, ' ')
      .replace(/[▌█]/g, '')
      .trimEnd();
    const withoutBorder = normalized.replace(/^\s*[│┃║]\s?/, '');
    const rawWithoutBorder = rawNormalized.replace(/^\s*[│┃║]\s?/, '');
    const candidate = withoutBorder.trim();
    const rawCandidate = rawWithoutBorder.trim();
    const effectiveCandidate = candidate || rawCandidate;
    if (!effectiveCandidate) continue;
    if (/^[╭╰]/.test(effectiveCandidate)) return null;

    const candidateCells = snapshot.cells
      .filter((cell) => cell.ch.trim() && cell.ch !== '▌' && cell.ch !== '█' && !/[│┃║]/.test(cell.ch));
    if (candidateCells.length > 0 && candidateCells.every((cell) => cell.dim)) return null;
    if (CODEX_EMPTY_COMPOSER_HINT_RE.test(effectiveCandidate)) return null;
    if (CODEX_NON_DRAFT_LINE_RE.test(effectiveCandidate)) return null;

    return { hasDraft: true, preview: effectiveCandidate.slice(0, 120), sourceSuffix: ':multiline-draft-row-' + row };
  }
  return null;
}

function describeCodexDraftProbeRow(buf: any, row: number): string {
  if (!buf || row < 0 || row >= buf.length) return `row=${row}:out-of-range`;
  const raw = String(buf.getLine(row)?.translateToString?.(true) || '').replace(/\s+/g, ' ').slice(0, 140);
  const snapshot = getLogicalLineSnapshotAt(buf, row);
  const parsed = extractCodexDraftFromLine(snapshot);
  const text = snapshot.text.replace(/\s+/g, ' ').slice(0, 180);
  const hasPrompt = hasCodexComposerPromptGlyph(snapshot.text);
  return `row=${row}:prompt=${hasPrompt}:parsed=${parsed.hasDraft}:suffix=${parsed.sourceSuffix || ''}:raw=${JSON.stringify(raw)}:logical=${JSON.stringify(text)}`;
}

function buildCodexProbeDebug(buf: any, terminal: XTerminal, cursorRows: number[], visibleStart: number, visibleEnd: number, reason: string): string {
  const tailStart = Math.max(0, buf.length - Math.max(12, Math.min(terminal.rows || 12, 32)));
  const sampleRows = Array.from(new Set([
    ...cursorRows,
    ...Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, i) => visibleStart + i),
    ...Array.from({ length: Math.max(0, buf.length - tailStart) }, (_, i) => tailStart + i),
  ])).filter((row) => row >= 0 && row < buf.length);
  return [
    `reason=${reason}`,
    `rows=${terminal.rows}`,
    `cols=${terminal.cols}`,
    `bufLength=${buf.length}`,
    `baseY=${buf.baseY}`,
    `cursorY=${buf.cursorY}`,
    `viewportY=${buf.viewportY}`,
    `visible=${visibleStart}-${visibleEnd}`,
    `tail=${tailStart}-${buf.length}`,
    `cursorRows=${cursorRows.join(',') || 'none'}`,
    `samples=[${sampleRows.map((row) => describeCodexDraftProbeRow(buf, row)).join(' | ')}]`,
  ].join(' ');
}

function describeXtermCellStyle(cell: any): string {
  if (!cell) return 'empty';
  const read = (name: string) => {
    const value = cell?.[name];
    return typeof value === 'function' ? value.call(cell) : value;
  };
  const parts: string[] = [];
  const fgMode = read('getFgColorMode');
  const fgColor = read('getFgColor');
  const bgMode = read('getBgColorMode');
  const bgColor = read('getBgColor');
  parts.push('fg=' + (fgMode ?? '-') + ':' + (fgColor ?? '-'));
  parts.push('bg=' + (bgMode ?? '-') + ':' + (bgColor ?? '-'));
  if (read('isInverse')) parts.push('inverse');
  if (read('isBold')) parts.push('bold');
  if (read('isDim')) parts.push('dim');
  if (read('isItalic')) parts.push('italic');
  if (read('isUnderline')) parts.push('underline');
  if (read('isBlink')) parts.push('blink');
  if (read('isInvisible')) parts.push('invisible');
  return parts.join(',');
}

function xtermStyleHasNonDefaultBg(style: string): boolean {
  const match = /bg=([^,\s]+)/.exec(style);
  if (!match) return false;
  const bg = match[1];
  return bg !== '0:-1' && bg !== '-:-' && bg !== '-:-1' && bg !== 'none';
}

function summarizeXtermLineStyles(line: any): { styles: string[]; firstTextStyle: string; hasInverse: boolean; hasNonDefaultBg: boolean } {
  if (!line) return { styles: [], firstTextStyle: 'none', hasInverse: false, hasNonDefaultBg: false };
  const counts = new Map<string, number>();
  let firstTextStyle = 'none';
  let hasInverse = false;
  let hasNonDefaultBg = false;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth?.() === 0) continue;
    const ch = cell.getChars?.() || ' ';
    if (!String(ch).trim()) continue;
    const style = describeXtermCellStyle(cell);
    if (firstTextStyle === 'none') firstTextStyle = style;
    if (style.includes('inverse')) hasInverse = true;
    if (xtermStyleHasNonDefaultBg(style)) hasNonDefaultBg = true;
    counts.set(style, (counts.get(style) || 0) + 1);
  }
  const styles = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([style, count]) => style + ' x' + count);
  return { styles, firstTextStyle, hasInverse, hasNonDefaultBg };
}

export const terminalRegistry = {
  /** Check if Gemini spinner (Braille characters) is visible on screen for a given tab */
  hasSpinnerOnScreen(tabId: string): boolean {
    const term = terminals.get(tabId);
    if (!term) return false;
    const buf = term.buffer.active;
    // Check last 5 visible lines for Braille (spinner is at bottom of Ink TUI)
    for (let i = 0; i < 5; i++) {
      const lineIdx = buf.baseY + buf.cursorY - i;
      if (lineIdx < 0) break;
      const line = buf.getLine(lineIdx);
      if (line && GEMINI_BRAILLE_RE.test(line.translateToString())) return true;
    }
    return false;
  },

  register(tabId: string, terminal: XTerminal, searchAddon?: SearchAddon) {
    terminals.set(tabId, terminal);
    const waiters = terminalWaiters.get(tabId);
    if (waiters) {
      terminalWaiters.delete(tabId);
      waiters.forEach((resolve) => resolve(terminal));
    }
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

  getVisibleSnapshot(tabId: string): {
    success: boolean;
    error?: string;
    rows?: number;
    cols?: number;
    baseY?: number;
    viewportY?: number;
    cursorX?: number;
    cursorY?: number;
    bufferType?: string;
    lines?: { row: number; text: string; wrapped: boolean; firstTextStyle?: string; styles?: string[]; hasInverse?: boolean; hasNonDefaultBg?: boolean; activeByInverse?: boolean }[];
    codexActivePrompt?: { row: number; text: string; firstTextStyle: string; styles: string[]; hasInverse?: boolean; hasNonDefaultBg?: boolean } | null;
  } {
    const terminal = terminals.get(tabId);
    if (!terminal) return { success: false, error: 'no-terminal' };
    const buf = terminal.buffer.active;
    const startLine = buf.viewportY;
    const endLine = Math.min(startLine + terminal.rows, buf.length);
    const lines: { row: number; text: string; wrapped: boolean; firstTextStyle?: string; styles?: string[]; hasInverse?: boolean; hasNonDefaultBg?: boolean; activeByInverse?: boolean }[] = [];
    let codexActivePrompt: { row: number; text: string; firstTextStyle: string; styles: string[]; hasInverse?: boolean; hasNonDefaultBg?: boolean } | null = null;
    for (let i = startLine; i < endLine; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      const isPromptLine = hasCodexComposerPromptGlyph(text);
      lines.push({
        row: i,
        text,
        wrapped: !!line.isWrapped,
      });
      if (!isPromptLine) continue;
      const summary = summarizeXtermLineStyles(line);
      const last = lines[lines.length - 1];
      last.firstTextStyle = summary.firstTextStyle;
      last.styles = summary.styles;
      last.hasInverse = summary.hasInverse;
      last.hasNonDefaultBg = summary.hasNonDefaultBg;
      const isActivePrompt = summary.hasInverse;
      last.activeByInverse = isActivePrompt;
      if (isActivePrompt) {
        const logical = getLogicalLineSnapshotAt(buf, i);
        codexActivePrompt = {
          row: i,
          text: logical.text || text,
          firstTextStyle: summary.firstTextStyle,
          styles: summary.styles,
          hasInverse: summary.hasInverse,
          hasNonDefaultBg: summary.hasNonDefaultBg,
        };
      }
    }
    return {
      success: true,
      rows: terminal.rows,
      cols: terminal.cols,
      baseY: buf.baseY,
      viewportY: buf.viewportY,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      bufferType: buf.type,
      lines,
      codexActivePrompt,
    };
  },

  logCodexOverlayStyleSnapshot(tabId: string, reason: string): void {
    const terminal = terminals.get(tabId);
    if (!terminal) {
      console.warn('[CodexOverlayStyle] tab=' + tabId.slice(-8) + ' reason=' + reason + ' no-terminal');
      return;
    }
    const buf = terminal.buffer.active;
    const startLine = buf.viewportY;
    const endLine = Math.min(startLine + terminal.rows, buf.length);
    const rows: Array<{
      row: number;
      wrapped: boolean;
      marker: boolean;
      text: string;
      firstTextStyle: string;
      styles: string[];
      hasInverse: boolean;
      hasNonDefaultBg: boolean;
    }> = [];

    for (let i = startLine; i < endLine; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = String(line.translateToString?.(true) || '').replace(/\u00a0/g, ' ');
      const compactText = text.replace(/\s+/g, ' ').trim();
      if (!compactText && rows.length > 0 && rows.length > 28) continue;
      const summary = summarizeXtermLineStyles(line);
      rows.push({
        row: i,
        wrapped: !!line.isWrapped,
        marker: hasCodexComposerPromptGlyph(text),
        text: compactText.slice(0, 180),
        firstTextStyle: summary.firstTextStyle,
        styles: summary.styles,
        hasInverse: summary.hasInverse,
        hasNonDefaultBg: summary.hasNonDefaultBg,
      });
    }

    console.log('[CodexOverlayStyle] tab=' + tabId.slice(-8)
      + ' reason=' + reason
      + ' buffer=' + buf.type
      + ' rows=' + terminal.rows
      + ' cols=' + terminal.cols
      + ' baseY=' + buf.baseY
      + ' viewportY=' + buf.viewportY
      + ' cursor=' + buf.cursorX + ',' + buf.cursorY
      + ' visible=' + startLine + '-' + endLine
      + ' lines=' + JSON.stringify(rows.slice(-32)));
  },

  waitForTerminal(tabId: string, timeoutMs = 2500): Promise<XTerminal | undefined> {
    const existing = terminals.get(tabId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (terminal: XTerminal | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const waiters = terminalWaiters.get(tabId);
        if (waiters) {
          waiters.delete(finish);
          if (waiters.size === 0) terminalWaiters.delete(tabId);
        }
        resolve(terminal);
      };

      const waiters = terminalWaiters.get(tabId) || new Set<(terminal: XTerminal | undefined) => void>();
      waiters.add(finish);
      terminalWaiters.set(tabId, waiters);
      timer = setTimeout(() => finish(undefined), timeoutMs);
    });
  },

  getCodexDraftState(tabId: string): CodexDraftState {
    const terminal = terminals.get(tabId);
    if (!terminal) return { hasDraft: null, preview: '', source: 'no-terminal', debug: 'reason=no-terminal' };

    const buf = terminal.buffer.active;
    const visibleEnd = Math.min(buf.viewportY + terminal.rows, buf.length);
    const visibleStart = Math.max(buf.viewportY, visibleEnd - 10);
    const cursorRows = Array.from(new Set([
      buf.baseY + buf.cursorY,
      buf.cursorY,
    ])).filter((row) => row >= 0 && row < buf.length);

    for (const row of cursorRows) {
      const parsed = extractCodexDraftFromLine(getLogicalLineSnapshotAt(buf, row));
      if (parsed.hasDraft !== null) {
        const multilineDraft = parsed.hasDraft === false && !parsed.preview
          ? extractCodexDraftAfterEmptyPrompt(buf, row)
          : null;
        if (multilineDraft) {
          return { ...multilineDraft, source: 'cursor:' + row + multilineDraft.sourceSuffix };
        }
        const debug = parsed.hasDraft === false && !parsed.preview
          ? buildCodexProbeDebug(buf, terminal, cursorRows, visibleStart, visibleEnd, 'cursor-empty-false')
          : undefined;
        return { ...parsed, source: 'cursor:' + row + (parsed.sourceSuffix || ''), debug };
      }
    }

    for (let row = visibleEnd - 1; row >= visibleStart; row--) {
      const snapshot = getLogicalLineSnapshotAt(buf, row);
      if (!hasCodexComposerPromptGlyph(snapshot.text)) continue;
      const parsed = extractCodexDraftFromLine(snapshot);
      if (parsed.hasDraft !== null) {
        const multilineDraft = parsed.hasDraft === false && !parsed.preview
          ? extractCodexDraftAfterEmptyPrompt(buf, row)
          : null;
        if (multilineDraft) {
          return { ...multilineDraft, source: 'viewport:' + row + multilineDraft.sourceSuffix };
        }
        const debug = parsed.hasDraft === false && !parsed.preview
          ? buildCodexProbeDebug(buf, terminal, cursorRows, visibleStart, visibleEnd, 'viewport-empty-false')
          : undefined;
        return { ...parsed, source: 'viewport:' + row + (parsed.sourceSuffix || ''), debug };
      }
    }

    // If the desktop terminal is scrolled away from bottom, viewport rows can be
    // unrelated to the live Codex composer. The cursor row is normally enough,
    // but after TUI redraws it can lag for one frame. Scan the buffer tail too:
    // the prompt line lives there even when the visible viewport is stale.
    const tailStart = Math.max(0, buf.length - Math.max(12, Math.min(terminal.rows || 12, 32)));
    for (let row = buf.length - 1; row >= tailStart; row--) {
      if (row >= visibleStart && row < visibleEnd) continue;
      if (cursorRows.includes(row)) continue;
      const snapshot = getLogicalLineSnapshotAt(buf, row);
      if (!hasCodexComposerPromptGlyph(snapshot.text)) continue;
      const parsed = extractCodexDraftFromLine(snapshot);
      if (parsed.hasDraft !== null) {
        const multilineDraft = parsed.hasDraft === false && !parsed.preview
          ? extractCodexDraftAfterEmptyPrompt(buf, row)
          : null;
        if (multilineDraft) {
          return { ...multilineDraft, source: 'tail:' + row + multilineDraft.sourceSuffix };
        }
        const debug = parsed.hasDraft === false && !parsed.preview
          ? buildCodexProbeDebug(buf, terminal, cursorRows, visibleStart, visibleEnd, 'tail-empty-false')
          : undefined;
        return { ...parsed, source: 'tail:' + row + (parsed.sourceSuffix || ''), debug };
      }
    }

    const debug = buildCodexProbeDebug(buf, terminal, cursorRows, visibleStart, visibleEnd, 'no-definitive-codex-composer-row');
    return { hasDraft: null, preview: '', source: 'unknown', debug };
  },

  waitForCodexDraftState(tabId: string, expected: boolean, timeoutMs = 900): Promise<CodexDraftState> {
    const terminal = terminals.get(tabId);
    if (!terminal) {
      return Promise.resolve({ success: false, hasDraft: null, preview: '', source: 'no-terminal', debug: 'reason=no-terminal' });
    }

    let checks = 0;
    const read = () => {
      checks += 1;
      return this.getCodexDraftState(tabId);
    };
    const first = read();
    if (first.hasDraft === expected) {
      return Promise.resolve({ ...first, success: true, timedOut: false, checks });
    }

    return new Promise((resolve) => {
      let settled = false;
      let sub: { dispose?: () => void } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (state: CodexDraftState, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { sub?.dispose?.(); } catch {}
        resolve({ ...state, success: true, timedOut, checks });
      };
      const check = () => {
        const state = read();
        if (state.hasDraft === expected) finish(state, false);
      };

      const onWriteParsed = (terminal as any).onWriteParsed;
      const onRender = (terminal as any).onRender;
      if (typeof onWriteParsed === 'function') {
        sub = onWriteParsed.call(terminal, check);
      } else if (typeof onRender === 'function') {
        sub = onRender.call(terminal, check);
      }
      timer = setTimeout(() => finish(read(), true), timeoutMs);
    });
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

  // Restore non-visual OSC marker metadata after a cold renderer xterm is
  // hydrated from a serialized main/headless buffer. SerializeAddon preserves
  // cells but intentionally omits OSC commands, so their exact lines travel as
  // snapshot metadata instead.
  restorePromptBoundaries(
    tabId: string,
    terminal: XTerminal,
    boundaries: Array<{ seq: number; line: number }>,
  ): number {
    if (!tabId || !terminal || !Array.isArray(boundaries)) return 0;

    const restored = new Map<number, IMarker>();
    const buffer = terminal.buffer.active;
    const currentLine = buffer.baseY + buffer.cursorY;
    const maxLine = Math.max(0, buffer.length - 1);

    for (const boundary of boundaries) {
      const seq = Number(boundary?.seq);
      const line = Number(boundary?.line);
      if (!Number.isFinite(seq) || !Number.isFinite(line) || line < 0 || line > maxLine) continue;
      if (restored.has(seq)) continue;

      const marker = terminal.registerMarker(line - currentLine);
      if (!marker) continue;
      restored.set(seq, marker);
      marker.onDispose(() => {
        if (restored.get(seq) === marker) restored.delete(seq);
      });
      promptBoundaryLatestSeq.set(tabId, Math.max(promptBoundaryLatestSeq.get(tabId) || 0, seq));
    }

    promptBoundaries.set(tabId, restored);
    return restored.size;
  },

  clearPromptBoundaries(tabId: string): void {
    const boundaries = promptBoundaries.get(tabId);
    if (boundaries) {
      for (const marker of boundaries.values()) {
        try { marker.dispose(); } catch {}
      }
    }
    promptBoundaries.delete(tabId);
    promptBoundaryLatestSeq.delete(tabId);
  },

  registerPromptBoundaryForTerminal(
    tabId: string,
    terminal: XTerminal,
    seq: number,
  ): void {
    if (!tabId || !terminal || !Number.isFinite(seq)) return;
    const previousLatest = promptBoundaryLatestSeq.get(tabId) || 0;
    if (seq > previousLatest) {
      promptBoundaryLatestSeq.set(tabId, seq);
      const waiters = promptBoundaryWaiters.get(tabId);
      if (waiters) {
        for (const resolve of Array.from(waiters)) resolve(seq);
      }
    }

    let tabBoundaries = promptBoundaries.get(tabId);
    if (!tabBoundaries) {
      tabBoundaries = new Map();
      promptBoundaries.set(tabId, tabBoundaries);
    }
    if (tabBoundaries.has(seq)) return;

    const marker = terminal.registerMarker(0);
    if (!marker) return;
    tabBoundaries.set(seq, marker);
    marker.onDispose(() => tabBoundaries!.delete(seq));
    console.log('[terminalRegistry] Prompt boundary #' + seq + ' at line ' + marker.line);
  },

  // Register a prompt boundary marker at the current cursor position.
  // Called from the direct main-process event and, separately, from OSC 7777
  // when xterm registers a line marker for timeline navigation.
  registerPromptBoundary(tabId: string, seq: number): void {
    if (!tabId || !Number.isFinite(seq)) return;
    const previousLatest = promptBoundaryLatestSeq.get(tabId) || 0;
    if (seq > previousLatest) {
      promptBoundaryLatestSeq.set(tabId, seq);
      const waiters = promptBoundaryWaiters.get(tabId);
      if (waiters) {
        for (const resolve of Array.from(waiters)) resolve(seq);
      }
    }

    const terminal = terminals.get(tabId);
    if (!terminal) return;
    this.registerPromptBoundaryForTerminal(tabId, terminal, seq);
  },

  getLatestPromptBoundarySeq(tabId: string): number {
    const latestSeq = promptBoundaryLatestSeq.get(tabId) || 0;
    const tabBoundaries = promptBoundaries.get(tabId);
    if (!tabBoundaries || tabBoundaries.size === 0) return latestSeq;
    return Math.max(latestSeq, ...Array.from(tabBoundaries.keys()));
  },

  waitForPromptBoundaryAfter(tabId: string, afterSeq: number, timeoutMs = 6000): Promise<number | null> {
    const latest = this.getLatestPromptBoundarySeq(tabId);
    if (latest > afterSeq) return Promise.resolve(latest);

    return new Promise((resolve) => {
      let settled = false;
      let waiters = promptBoundaryWaiters.get(tabId);
      if (!waiters) {
        waiters = new Set();
        promptBoundaryWaiters.set(tabId, waiters);
      }
      const finish = (seq: number | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        waiters!.delete(onBoundary);
        if (waiters!.size === 0) promptBoundaryWaiters.delete(tabId);
        resolve(seq);
      };
      const onBoundary = (seq: number) => {
        if (seq > afterSeq) finish(seq);
      };
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      waiters.add(onBoundary);
    });
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

  // Get sorted line positions of all live prompt boundaries for a tab.
  // Used by Timeline to map entries to buffer positions when entry markers don't exist.
  getPromptBoundaryLines(tabId: string): number[] {
    const tabBoundaries = promptBoundaries.get(tabId);
    if (!tabBoundaries || tabBoundaries.size === 0) return [];
    return [...tabBoundaries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([_, m]) => m.line);
  },

  getPromptBoundarySnapshot(tabId: string): Array<{ seq: number; line: number }> {
    const tabBoundaries = promptBoundaries.get(tabId);
    if (!tabBoundaries || tabBoundaries.size === 0) return [];
    return [...tabBoundaries.entries()]
      .filter(([, marker]) => marker && !marker.isDisposed && marker.line >= 0)
      .sort((a, b) => a[0] - b[0])
      .map(([seq, marker]) => ({ seq, line: marker.line }));
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
          // Truncation fallback: Gemini TUI truncates long messages (~137 chars).
          // Multi-line entries with short first lines (e.g. "[Claude Sub-Agent Response]")
          // MUST match on line 2+ to disambiguate identical first lines.
          // But long unique first lines (>= 30 chars) are safe — false positive is negligible.
          if (!allMatch && firstLine.length >= 15 && (searchLines.length <= 1 || firstLine.length >= 30)) allMatch = true;
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
            if (!allMatch && firstLine.length >= 15 && (searchLines.length <= 1 || firstLine.length >= 30)) allMatch = true;
          }

          if (allMatch) {
            found = logicalLines[i].bufRow;
            // Don't advance searchFromIdx — preserve ordering for subsequent entries
            break;
          }
        }
      }

      // Diagnostic: log misses for future debugging (goes to logs/dev.log via [Tag] interceptor)
      if (found < 0 && firstLine.length >= 5) {
        const shortNeedle = firstLine.slice(0, 15);
        let hasPartial = false;
        for (let i = 0; i < logicalLines.length; i++) {
          if (logicalLines[i].text.includes(shortNeedle)) { hasPartial = true; break; }
        }
        // MISS logged silently — check dev.log if debugging timeline positioning
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
        // Short first lines (e.g. "[Claude Sub-Agent Response]") with multi-line entries
        // MUST match on L2+ to disambiguate. But long unique first lines (>= 30 chars)
        // are safe — false positive is negligible.
        if (!allMatch && firstLine.length >= 15 && (contentLines.length <= 1 || firstLine.length >= 30)) {
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
        // Accept first-line-only match when it's long enough (>= 15 chars).
        // ONLY for single-line entries — multi-line entries have unique L2/L3 lines.
        if (!allMatch && firstLine.length >= 15 && contentLines.length <= 1) {
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

import { create } from 'zustand';
import { PROMPT_SUMMARY_PROMPT_ID, usePromptsStore } from './usePromptsStore';
import { generateTimelinePromptSummaryFromPrompt, isEligibleTabTitleEntry, trimTimelinePromptSummarySource, type TabTitleSourceEntry } from '../utils/generateTabTitle';
import { useWorkspaceStore } from './useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

export type TimelineSummaryTool = 'claude' | 'codex';

export interface TimelinePromptSummary {
  toolType: TimelineSummaryTool;
  sessionId: string;
  entryUuid: string;
  summary: string;
  sourceHash?: string | null;
  model?: string | null;
  promptId?: string | null;
  thinkingLevel?: string | null;
  promptTokens?: number;
  candidateTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  updatedAt?: number;
}

export interface TimelineSummaryEntry extends TabTitleSourceEntry {
  uuid: string;
  timestamp?: string;
}

export interface TimelineSummaryBatchProgress {
  running: boolean;
  tabId: string;
  toolType: TimelineSummaryTool;
  sessionId: string;
  done: number;
  total: number;
  error?: string;
}

const GLOBAL_AUTO_KEY = 'noted-terminal-timeline-summary-global-auto';
const GLOBAL_AUTO_SINCE_KEY = 'noted-terminal-timeline-summary-global-auto-since';
const TAB_AUTO_KEY = 'noted-terminal-timeline-summary-auto-tabs';
const TAB_AUTO_SINCE_KEY = 'noted-terminal-timeline-summary-auto-since-tabs';
const APP_STATE_GLOBAL_AUTO_KEY = 'timelineSummaryGlobalAuto';
const APP_STATE_GLOBAL_AUTO_SINCE_KEY = 'timelineSummaryGlobalAutoSince';
const APP_STATE_TAB_AUTO_KEY = 'timelineSummaryAutoTabs';
const APP_STATE_TAB_AUTO_SINCE_KEY = 'timelineSummaryAutoSinceTabs';
const PREVIOUS_USER_CONTEXT_COUNT_KEY = 'noted-terminal-timeline-summary-previous-user-count';
const APP_STATE_PREVIOUS_USER_CONTEXT_COUNT_KEY = 'timelineSummaryPreviousUserContextCount';
const DEFAULT_PREVIOUS_USER_CONTEXT_COUNT = 1;
const MAX_PREVIOUS_USER_CONTEXT_COUNT = 10;

export function timelineSummaryKey(toolType: TimelineSummaryTool, sessionId: string, entryUuid: string): string {
  return `${toolType}:${sessionId}:${entryUuid}`;
}

export function timelineSummarySourceHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function parsePersistedBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function normalizeBoolMap(value: unknown): Record<string, boolean> {
  try {
    const raw = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (parsePersistedBool(val)) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeNumberMap(value: unknown, autoByTab: Record<string, boolean>): Record<string, number> {
  try {
    const raw = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, number> = {};
    for (const tabId of Object.keys(autoByTab || {})) {
      const n = Number((raw as Record<string, unknown>)[tabId] || 0);
      if (Number.isFinite(n) && n > 0) out[tabId] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function clampPreviousUserContextCount(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PREVIOUS_USER_CONTEXT_COUNT;
  return Math.max(0, Math.min(MAX_PREVIOUS_USER_CONTEXT_COUNT, n));
}

function readPreviousUserContextCount(): number {
  try {
    const raw = localStorage.getItem(PREVIOUS_USER_CONTEXT_COUNT_KEY);
    if (raw !== null) return clampPreviousUserContextCount(raw);
  } catch {}
  return DEFAULT_PREVIOUS_USER_CONTEXT_COUNT;
}

function persistAppState(key: string, value: unknown) {
  try {
    ipcRenderer.invoke('app:setState', { key, value }).catch(() => {});
  } catch {}
}

function persistPreviousUserContextCount(value: number) {
  const clamped = clampPreviousUserContextCount(value);
  try {
    localStorage.setItem(PREVIOUS_USER_CONTEXT_COUNT_KEY, String(clamped));
  } catch {}
  persistAppState(APP_STATE_PREVIOUS_USER_CONTEXT_COUNT_KEY, clamped);
}

function readGlobalAuto(): boolean {
  try {
    return localStorage.getItem(GLOBAL_AUTO_KEY) === '1';
  } catch {
    return false;
  }
}

function readGlobalAutoSince(): number {
  if (!readGlobalAuto()) return 0;
  try {
    const raw = Number(localStorage.getItem(GLOBAL_AUTO_SINCE_KEY) || 0);
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {}
  const now = Date.now();
  try { localStorage.setItem(GLOBAL_AUTO_SINCE_KEY, String(now)); } catch {}
  return now;
}

function readTabAuto(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TAB_AUTO_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readTabAutoSince(autoByTab: Record<string, boolean>): Record<string, number> {
  let parsed: Record<string, number> = {};
  try {
    const raw = localStorage.getItem(TAB_AUTO_SINCE_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const tabId of Object.keys(autoByTab || {})) {
    const value = Number(parsed[tabId] || 0);
    out[tabId] = Number.isFinite(value) && value > 0 ? value : now;
  }
  try { localStorage.setItem(TAB_AUTO_SINCE_KEY, JSON.stringify(out)); } catch {}
  return out;
}

function persistGlobalAuto(value: boolean) {
  try {
    localStorage.setItem(GLOBAL_AUTO_KEY, value ? '1' : '0');
  } catch {}
  persistAppState(APP_STATE_GLOBAL_AUTO_KEY, value);
}

function persistGlobalAutoSince(value: number) {
  try {
    if (value > 0) localStorage.setItem(GLOBAL_AUTO_SINCE_KEY, String(value));
    else localStorage.removeItem(GLOBAL_AUTO_SINCE_KEY);
  } catch {}
  persistAppState(APP_STATE_GLOBAL_AUTO_SINCE_KEY, value);
}

function persistTabAuto(value: Record<string, boolean>) {
  try {
    localStorage.setItem(TAB_AUTO_KEY, JSON.stringify(value));
  } catch {}
  persistAppState(APP_STATE_TAB_AUTO_KEY, value);
}

function persistTabAutoSince(value: Record<string, number>) {
  try {
    localStorage.setItem(TAB_AUTO_SINCE_KEY, JSON.stringify(value));
  } catch {}
  persistAppState(APP_STATE_TAB_AUTO_SINCE_KEY, value);
}

function normalizeRows(rows: any[]): Record<string, TimelinePromptSummary> {
  const out: Record<string, TimelinePromptSummary> = {};
  for (const row of rows || []) {
    if (!row?.toolType || !row?.sessionId || !row?.entryUuid || !row?.summary) continue;
    out[timelineSummaryKey(row.toolType, row.sessionId, row.entryUuid)] = row;
  }
  return out;
}

function inferProjectName(projectPath?: string): string | null {
  const clean = String(projectPath || '').replace(/\/+$/, '');
  if (!clean) return null;
  return clean.split('/').filter(Boolean).pop() || clean;
}

function getUsageMetadata(args: {
  tabId: string;
  toolType: TimelineSummaryTool;
  sessionId: string;
  entryUuid: string;
  iterationIndex?: number | null;
}) {
  const workspaceState = useWorkspaceStore.getState();
  for (const workspace of workspaceState.openProjects.values()) {
    const tab = workspace.tabs.get(args.tabId);
    if (!tab) continue;
    return {
      projectId: workspace.projectId,
      projectName: inferProjectName(workspace.projectPath),
      projectPath: workspace.projectPath,
      tabId: args.tabId,
      tabName: tab.name,
      toolType: args.toolType,
      sessionId: args.sessionId,
      entryUuid: args.entryUuid,
      iterationIndex: args.iterationIndex || null,
    };
  }
  return {
    tabId: args.tabId,
    toolType: args.toolType,
    sessionId: args.sessionId,
    entryUuid: args.entryUuid,
    iterationIndex: args.iterationIndex || null,
  };
}

interface TimelineSummaryStore {
  summaries: Record<string, TimelinePromptSummary>;
  loadingKeys: Set<string>;
  loadedSessionKeys: Set<string>;
  batchProgressByTab: Record<string, TimelineSummaryBatchProgress>;
  autoByTab: Record<string, boolean>;
  autoSinceByTab: Record<string, number>;
  globalAuto: boolean;
  globalAutoSince: number;
  previousUserContextCount: number;
  loadSummaries: (toolType: TimelineSummaryTool, sessionId: string) => Promise<void>;
  setTabAuto: (tabId: string, value: boolean) => void;
  setGlobalAuto: (value: boolean) => void;
  setPreviousUserContextCount: (value: number) => void;
  generateSummary: (args: {
    tabId: string;
    toolType: TimelineSummaryTool;
    sessionId: string;
    entry: TimelineSummaryEntry;
    previousUserMessages?: string[];
    iterationIndex?: number | null;
    force?: boolean;
  }) => Promise<TimelinePromptSummary | null>;
  refreshEntriesForTab: (args: {
    tabId: string;
    toolType: TimelineSummaryTool;
    sessionId: string;
    entries: TimelineSummaryEntry[];
  }) => Promise<void>;
}

const initialAutoByTab = readTabAuto();
const initialAutoSinceByTab = readTabAutoSince(initialAutoByTab);
const initialGlobalAuto = readGlobalAuto();
const initialGlobalAutoSince = readGlobalAutoSince();
const initialPreviousUserContextCount = readPreviousUserContextCount();

export const useTimelineSummaryStore = create<TimelineSummaryStore>((set, get) => ({
  summaries: {},
  loadingKeys: new Set(),
  loadedSessionKeys: new Set(),
  batchProgressByTab: {},
  autoByTab: initialAutoByTab,
  autoSinceByTab: initialAutoSinceByTab,
  globalAuto: initialGlobalAuto,
  globalAutoSince: initialGlobalAutoSince,
  previousUserContextCount: initialPreviousUserContextCount,

  loadSummaries: async (toolType, sessionId) => {
    if (!toolType || !sessionId) return;
    try {
      const result = await ipcRenderer.invoke('timeline-prompt-summaries:get', { toolType, sessionId });
      if (!result?.success || !Array.isArray(result.data)) return;
      const nextRows = normalizeRows(result.data);
      set((state) => {
        const nextLoaded = new Set(state.loadedSessionKeys);
        nextLoaded.add(`${toolType}:${sessionId}`);
        return { summaries: { ...state.summaries, ...nextRows }, loadedSessionKeys: nextLoaded };
      });
    } catch (err) {
      console.warn('[TimelineSummary] load failed:', err);
    }
  },

  setTabAuto: (tabId, value) => {
    set((state) => {
      const next = { ...state.autoByTab };
      const nextSince = { ...state.autoSinceByTab };
      if (value) next[tabId] = true;
      else delete next[tabId];
      if (value) nextSince[tabId] = Date.now();
      else delete nextSince[tabId];
      persistTabAuto(next);
      persistTabAutoSince(nextSince);
      return { autoByTab: next, autoSinceByTab: nextSince };
    });
  },

  setGlobalAuto: (value) => {
    const since = value ? Date.now() : 0;
    persistGlobalAuto(value);
    persistGlobalAutoSince(since);
    set({ globalAuto: value, globalAutoSince: since });
  },

  setPreviousUserContextCount: (value) => {
    const clamped = clampPreviousUserContextCount(value);
    persistPreviousUserContextCount(clamped);
    set({ previousUserContextCount: clamped });
  },

  generateSummary: async ({ tabId, toolType, sessionId, entry, previousUserMessages = [], iterationIndex = null, force = false }) => {
    const content = String(entry?.content || '').trim();
    if (!tabId || !sessionId || !entry?.uuid || !content || !isEligibleTabTitleEntry(entry)) return null;

    const key = timelineSummaryKey(toolType, sessionId, entry.uuid);
    const contextMessages = previousUserMessages.map((msg) => String(msg || '').trim()).filter(Boolean);
    const promptConfig = usePromptsStore.getState().getPromptById(PROMPT_SUMMARY_PROMPT_ID);
    // Cached text belongs to both the immutable source snapshot and the user's
    // current AI configuration. Editing Prompt Summary/model/thinking must not
    // silently reuse output generated under the previous configuration.
    const sourceHash = timelineSummarySourceHash(JSON.stringify({
      version: 2,
      content,
      contextMessages,
      promptId: promptConfig?.id || PROMPT_SUMMARY_PROMPT_ID,
      promptContent: promptConfig?.content || '',
      model: promptConfig?.model || 'gemini-3.5-flash-lite',
      thinkingLevel: promptConfig?.thinkingLevel || 'NONE',
    }));
    const existing = get().summaries[key];
    if (!force && existing?.summary && existing.sourceHash === sourceHash) return existing;
    if (get().loadingKeys.has(key)) return null;

    set((state) => {
      const next = new Set(state.loadingKeys);
      next.add(key);
      return { loadingKeys: next };
    });

    try {
      const source = trimTimelinePromptSummarySource(content);
      const generated = await generateTimelinePromptSummaryFromPrompt(source, promptConfig, {
        previousUserMessages: contextMessages,
        usageMetadata: getUsageMetadata({
          tabId,
          toolType,
          sessionId,
          entryUuid: entry.uuid,
          iterationIndex,
        }),
      });
      if (!generated) return null;

      const row: TimelinePromptSummary = {
        toolType,
        sessionId,
        entryUuid: entry.uuid,
        summary: generated,
        sourceHash,
        model: promptConfig?.model || 'gemini-3.5-flash-lite',
        promptId: promptConfig?.id || PROMPT_SUMMARY_PROMPT_ID,
        thinkingLevel: promptConfig?.thinkingLevel || 'NONE',
      };
      await ipcRenderer.invoke('timeline-prompt-summaries:save', row);
      set((state) => ({ summaries: { ...state.summaries, [key]: row } }));
      return row;
    } catch (err) {
      console.warn('[TimelineSummary] generate failed:', err);
      return null;
    } finally {
      set((state) => {
        const next = new Set(state.loadingKeys);
        next.delete(key);
        return { loadingKeys: next };
      });
    }
  },

  refreshEntriesForTab: async ({ tabId, toolType, sessionId, entries }) => {
    const eligible = entries.filter((entry) => entry?.uuid && isEligibleTabTitleEntry(entry));
    set((state) => ({
      batchProgressByTab: {
        ...state.batchProgressByTab,
        [tabId]: { running: true, tabId, toolType, sessionId, done: 0, total: eligible.length },
      },
    }));

    let done = 0;
    let lastError = '';
    const contextCount = get().previousUserContextCount;
    for (let currentIndex = 0; currentIndex < eligible.length; currentIndex++) {
      const entry = eligible[currentIndex];
      try {
        const previousUserMessages = contextCount > 0
          ? eligible.slice(Math.max(0, currentIndex - contextCount), currentIndex).map((candidate) => String(candidate.content || ''))
          : [];
        await get().generateSummary({
          tabId,
          toolType,
          sessionId,
          entry,
          previousUserMessages,
          iterationIndex: currentIndex >= 0 ? currentIndex + 1 : null,
          force: true,
        });
      } catch (err: any) {
        lastError = err?.message || String(err);
      } finally {
        done += 1;
        set((state) => ({
          batchProgressByTab: {
            ...state.batchProgressByTab,
            [tabId]: { running: true, tabId, toolType, sessionId, done, total: eligible.length, error: lastError || undefined },
          },
        }));
      }
    }

    set((state) => ({
      batchProgressByTab: {
        ...state.batchProgressByTab,
        [tabId]: { running: false, tabId, toolType, sessionId, done, total: eligible.length, error: lastError || undefined },
      },
    }));
  },
}));

function writeLocalAutoMirror(args: {
  globalAuto: boolean;
  globalAutoSince: number;
  autoByTab: Record<string, boolean>;
  autoSinceByTab: Record<string, number>;
  previousUserContextCount: number;
}) {
  try { localStorage.setItem(GLOBAL_AUTO_KEY, args.globalAuto ? '1' : '0'); } catch {}
  try {
    if (args.globalAutoSince > 0) localStorage.setItem(GLOBAL_AUTO_SINCE_KEY, String(args.globalAutoSince));
    else localStorage.removeItem(GLOBAL_AUTO_SINCE_KEY);
  } catch {}
  try { localStorage.setItem(TAB_AUTO_KEY, JSON.stringify(args.autoByTab)); } catch {}
  try { localStorage.setItem(TAB_AUTO_SINCE_KEY, JSON.stringify(args.autoSinceByTab)); } catch {}
  try { localStorage.setItem(PREVIOUS_USER_CONTEXT_COUNT_KEY, String(args.previousUserContextCount)); } catch {}
}

(async () => {
  try {
    const [dbGlobalAuto, dbGlobalSince, dbTabAuto, dbTabSince, dbPreviousCount] = await Promise.all([
      ipcRenderer.invoke('app:getState', APP_STATE_GLOBAL_AUTO_KEY),
      ipcRenderer.invoke('app:getState', APP_STATE_GLOBAL_AUTO_SINCE_KEY),
      ipcRenderer.invoke('app:getState', APP_STATE_TAB_AUTO_KEY),
      ipcRenderer.invoke('app:getState', APP_STATE_TAB_AUTO_SINCE_KEY),
      ipcRenderer.invoke('app:getState', APP_STATE_PREVIOUS_USER_CONTEXT_COUNT_KEY),
    ]);

    const hasGlobalAuto = dbGlobalAuto !== null && dbGlobalAuto !== undefined;
    const hasGlobalSince = dbGlobalSince !== null && dbGlobalSince !== undefined;
    const hasTabAuto = dbTabAuto !== null && dbTabAuto !== undefined;
    const hasTabSince = dbTabSince !== null && dbTabSince !== undefined;
    const hasPreviousCount = dbPreviousCount !== null && dbPreviousCount !== undefined;

    if (!hasGlobalAuto) persistAppState(APP_STATE_GLOBAL_AUTO_KEY, initialGlobalAuto);
    if (!hasGlobalSince) persistAppState(APP_STATE_GLOBAL_AUTO_SINCE_KEY, initialGlobalAutoSince);
    if (!hasTabAuto) persistAppState(APP_STATE_TAB_AUTO_KEY, initialAutoByTab);
    if (!hasTabSince) persistAppState(APP_STATE_TAB_AUTO_SINCE_KEY, initialAutoSinceByTab);
    if (!hasPreviousCount) persistAppState(APP_STATE_PREVIOUS_USER_CONTEXT_COUNT_KEY, initialPreviousUserContextCount);

    const nextGlobalAuto = hasGlobalAuto ? parsePersistedBool(dbGlobalAuto) : initialGlobalAuto;
    const nextGlobalSinceRaw = hasGlobalSince ? Number(dbGlobalSince || 0) : initialGlobalAutoSince;
    const nextGlobalSince = nextGlobalAuto && Number.isFinite(nextGlobalSinceRaw) && nextGlobalSinceRaw > 0
      ? nextGlobalSinceRaw
      : 0;
    const nextAutoByTab = hasTabAuto ? normalizeBoolMap(dbTabAuto) : initialAutoByTab;
    let nextAutoSinceByTab = hasTabSince ? normalizeNumberMap(dbTabSince, nextAutoByTab) : initialAutoSinceByTab;
    const nextPreviousUserContextCount = hasPreviousCount ? clampPreviousUserContextCount(dbPreviousCount) : initialPreviousUserContextCount;

    const now = Date.now();
    let changedSince = false;
    nextAutoSinceByTab = { ...nextAutoSinceByTab };
    for (const tabId of Object.keys(nextAutoByTab)) {
      if (!nextAutoSinceByTab[tabId]) {
        nextAutoSinceByTab[tabId] = now;
        changedSince = true;
      }
    }
    if (changedSince) persistAppState(APP_STATE_TAB_AUTO_SINCE_KEY, nextAutoSinceByTab);

    writeLocalAutoMirror({
      globalAuto: nextGlobalAuto,
      globalAutoSince: nextGlobalSince,
      autoByTab: nextAutoByTab,
      autoSinceByTab: nextAutoSinceByTab,
      previousUserContextCount: nextPreviousUserContextCount,
    });

    useTimelineSummaryStore.setState({
      globalAuto: nextGlobalAuto,
      globalAutoSince: nextGlobalSince,
      autoByTab: nextAutoByTab,
      autoSinceByTab: nextAutoSinceByTab,
      previousUserContextCount: nextPreviousUserContextCount,
    });
  } catch (err: any) {
    console.warn('[TimelineSummary] auto-settings hydrate failed:', err?.message || err);
  }
})();

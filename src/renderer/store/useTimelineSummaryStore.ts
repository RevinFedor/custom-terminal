import { create } from 'zustand';
import { PROMPT_SUMMARY_PROMPT_ID, usePromptsStore } from './usePromptsStore';
import { generateTimelinePromptSummaryFromPrompt, isEligibleTabTitleEntry, trimTabTitlePrompt, type TabTitleSourceEntry } from '../utils/generateTabTitle';

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
const TAB_AUTO_KEY = 'noted-terminal-timeline-summary-auto-tabs';

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

function readGlobalAuto(): boolean {
  try {
    return localStorage.getItem(GLOBAL_AUTO_KEY) === '1';
  } catch {
    return false;
  }
}

function readTabAuto(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TAB_AUTO_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistGlobalAuto(value: boolean) {
  try {
    localStorage.setItem(GLOBAL_AUTO_KEY, value ? '1' : '0');
  } catch {}
}

function persistTabAuto(value: Record<string, boolean>) {
  try {
    localStorage.setItem(TAB_AUTO_KEY, JSON.stringify(value));
  } catch {}
}

function normalizeRows(rows: any[]): Record<string, TimelinePromptSummary> {
  const out: Record<string, TimelinePromptSummary> = {};
  for (const row of rows || []) {
    if (!row?.toolType || !row?.sessionId || !row?.entryUuid || !row?.summary) continue;
    out[timelineSummaryKey(row.toolType, row.sessionId, row.entryUuid)] = row;
  }
  return out;
}

interface TimelineSummaryStore {
  summaries: Record<string, TimelinePromptSummary>;
  loadingKeys: Set<string>;
  loadedSessionKeys: Set<string>;
  batchProgressByTab: Record<string, TimelineSummaryBatchProgress>;
  autoByTab: Record<string, boolean>;
  globalAuto: boolean;
  loadSummaries: (toolType: TimelineSummaryTool, sessionId: string) => Promise<void>;
  setTabAuto: (tabId: string, value: boolean) => void;
  setGlobalAuto: (value: boolean) => void;
  generateSummary: (args: {
    tabId: string;
    toolType: TimelineSummaryTool;
    sessionId: string;
    entry: TimelineSummaryEntry;
    force?: boolean;
  }) => Promise<TimelinePromptSummary | null>;
  refreshEntriesForTab: (args: {
    tabId: string;
    toolType: TimelineSummaryTool;
    sessionId: string;
    entries: TimelineSummaryEntry[];
  }) => Promise<void>;
}

export const useTimelineSummaryStore = create<TimelineSummaryStore>((set, get) => ({
  summaries: {},
  loadingKeys: new Set(),
  loadedSessionKeys: new Set(),
  batchProgressByTab: {},
  autoByTab: readTabAuto(),
  globalAuto: readGlobalAuto(),

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
      if (value) next[tabId] = true;
      else delete next[tabId];
      persistTabAuto(next);
      return { autoByTab: next };
    });
  },

  setGlobalAuto: (value) => {
    persistGlobalAuto(value);
    set({ globalAuto: value });
  },

  generateSummary: async ({ tabId, toolType, sessionId, entry, force = false }) => {
    const content = String(entry?.content || '').trim();
    if (!tabId || !sessionId || !entry?.uuid || !content || !isEligibleTabTitleEntry(entry)) return null;

    const key = timelineSummaryKey(toolType, sessionId, entry.uuid);
    const sourceHash = timelineSummarySourceHash(content);
    const existing = get().summaries[key];
    if (!force && existing?.summary && existing.sourceHash === sourceHash) return existing;
    if (get().loadingKeys.has(key)) return null;

    set((state) => {
      const next = new Set(state.loadingKeys);
      next.add(key);
      return { loadingKeys: next };
    });

    try {
      const promptConfig = usePromptsStore.getState().getPromptById(PROMPT_SUMMARY_PROMPT_ID);
      const source = trimTabTitlePrompt(content);
      const generated = await generateTimelinePromptSummaryFromPrompt(source, promptConfig);
      if (!generated) return null;

      const row: TimelinePromptSummary = {
        toolType,
        sessionId,
        entryUuid: entry.uuid,
        summary: generated,
        sourceHash,
        model: promptConfig?.model || 'gemini-3.1-flash-lite',
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
    for (const entry of eligible) {
      try {
        await get().generateSummary({ tabId, toolType, sessionId, entry, force: true });
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

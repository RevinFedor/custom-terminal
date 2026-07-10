import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

export type TimelineOutlineTool = 'claude' | 'codex';

export interface TimelineOutlineMember {
  uuid: string;
  role?: 'implementation' | 'clarification' | 'verification' | 'fix' | 'documentation' | 'meta' | 'other';
  description?: string;
  detail?: string;
}

export interface TimelineSemanticGroup {
  id: string;
  title: string;
  description: string;
  startUuid: string;
  endUuid: string;
  memberUuids: string[];
  members?: TimelineOutlineMember[];
}

export interface TimelineMetaPrompt {
  uuid: string;
  presetId: string;
  title: string;
}

export interface TimelineOutlinePayload {
  schemaVersion: number;
  groups: TimelineSemanticGroup[];
  ungrouped: string[];
  metaPrompts?: TimelineMetaPrompt[];
  compactCount?: number;
}

export interface TimelineOutlineRecord {
  toolType: TimelineOutlineTool;
  sessionId: string;
  schemaVersion: number;
  sourceHash: string;
  sourceUuids: string[];
  sourceEntryCount: number;
  sourceLastUuid?: string | null;
  outline: TimelineOutlinePayload;
  model?: string | null;
  promptId?: string | null;
  thinkingLevel?: string | null;
  promptTokens?: number;
  candidateTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  sourceChars?: number;
  updatedAt?: number;
}

export interface TimelineOutlineTarget {
  tabId: string;
  toolType: TimelineOutlineTool;
  sessionId: string;
  cwd?: string;
  projectId?: string | null;
  projectName?: string | null;
  tabName?: string | null;
}

interface TimelineOutlineStore {
  outlines: Record<string, TimelineOutlineRecord>;
  loadedKeys: Set<string>;
  loadingKeys: Set<string>;
  generatingKeys: Set<string>;
  eligibleUuidsByKey: Record<string, string[]>;
  errorsByKey: Record<string, string>;
  loadOutline: (toolType: TimelineOutlineTool, sessionId: string) => Promise<TimelineOutlineRecord | null>;
  generateOutline: (target: TimelineOutlineTarget) => Promise<TimelineOutlineRecord | null>;
  syncEligibleUuids: (toolType: TimelineOutlineTool, sessionId: string, uuids: string[]) => void;
}

export function timelineOutlineKey(toolType: TimelineOutlineTool, sessionId: string): string {
  return `${toolType}:${sessionId}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || 'Timeline grouping failed');
}

function normalizeRecord(value: any): TimelineOutlineRecord | null {
  if (!value || !value.toolType || !value.sessionId || !value.outline) return null;
  const groups = Array.isArray(value.outline.groups) ? value.outline.groups : [];
  const ungrouped = Array.isArray(value.outline.ungrouped) ? value.outline.ungrouped : [];
  return {
    ...value,
    schemaVersion: Number(value.schemaVersion || value.outline.schemaVersion || 1),
    sourceUuids: Array.isArray(value.sourceUuids) ? value.sourceUuids.map(String) : [],
    sourceEntryCount: Number(value.sourceEntryCount || value.sourceUuids?.length || 0),
    outline: {
      ...value.outline,
      schemaVersion: Number(value.outline.schemaVersion || value.schemaVersion || 1),
      groups,
      ungrouped,
      metaPrompts: Array.isArray(value.outline.metaPrompts) ? value.outline.metaPrompts : [],
    },
  } as TimelineOutlineRecord;
}

export function timelineOutlineNewCount(
  record: TimelineOutlineRecord | null | undefined,
  currentUuids: string[] | null | undefined,
): number {
  if (!record || !Array.isArray(currentUuids)) return 0;
  const covered = new Set(record.sourceUuids || []);
  return currentUuids.reduce((count, uuid) => count + (covered.has(uuid) ? 0 : 1), 0);
}

export const useTimelineOutlineStore = create<TimelineOutlineStore>((set, get) => ({
  outlines: {},
  loadedKeys: new Set(),
  loadingKeys: new Set(),
  generatingKeys: new Set(),
  eligibleUuidsByKey: {},
  errorsByKey: {},

  loadOutline: async (toolType, sessionId) => {
    if (!toolType || !sessionId) return null;
    const key = timelineOutlineKey(toolType, sessionId);
    if (get().loadingKeys.has(key)) return get().outlines[key] || null;
    set((state) => ({ loadingKeys: new Set(state.loadingKeys).add(key) }));
    try {
      const result = await ipcRenderer.invoke('timeline-outline:get', { toolType, sessionId });
      if (!result?.success) throw new Error(result?.error || 'Could not load Timeline groups');
      const record = normalizeRecord(result.data);
      set((state) => {
        const loadedKeys = new Set(state.loadedKeys);
        loadedKeys.add(key);
        const outlines = { ...state.outlines };
        if (record) outlines[key] = record;
        else delete outlines[key];
        const errorsByKey = { ...state.errorsByKey };
        delete errorsByKey[key];
        return { loadedKeys, outlines, errorsByKey };
      });
      return record;
    } catch (error) {
      const message = errorMessage(error);
      set((state) => ({ errorsByKey: { ...state.errorsByKey, [key]: message } }));
      console.warn('[TimelineOutline] load failed:', message);
      return null;
    } finally {
      set((state) => {
        const loadingKeys = new Set(state.loadingKeys);
        loadingKeys.delete(key);
        return { loadingKeys };
      });
    }
  },

  generateOutline: async (target) => {
    const { toolType, sessionId } = target;
    if (!toolType || !sessionId || !target.tabId) return null;
    const key = timelineOutlineKey(toolType, sessionId);
    if (get().generatingKeys.has(key)) return null;
    set((state) => {
      const generatingKeys = new Set(state.generatingKeys);
      generatingKeys.add(key);
      const errorsByKey = { ...state.errorsByKey };
      delete errorsByKey[key];
      return { generatingKeys, errorsByKey };
    });
    try {
      const result = await ipcRenderer.invoke('timeline-outline:generate', target);
      if (!result?.success) throw new Error(result?.error || 'Timeline grouping failed');
      const record = normalizeRecord(result.data);
      if (!record) throw new Error('Timeline grouping returned no outline');
      set((state) => {
        const loadedKeys = new Set(state.loadedKeys);
        loadedKeys.add(key);
        return {
          outlines: { ...state.outlines, [key]: record },
          loadedKeys,
          eligibleUuidsByKey: {
            ...state.eligibleUuidsByKey,
            [key]: state.eligibleUuidsByKey[key] || [...record.sourceUuids],
          },
        };
      });
      return record;
    } catch (error) {
      const message = errorMessage(error);
      set((state) => ({ errorsByKey: { ...state.errorsByKey, [key]: message } }));
      console.warn('[TimelineOutline] generation failed:', message);
      return null;
    } finally {
      set((state) => {
        const generatingKeys = new Set(state.generatingKeys);
        generatingKeys.delete(key);
        return { generatingKeys };
      });
    }
  },

  syncEligibleUuids: (toolType, sessionId, uuids) => {
    if (!toolType || !sessionId) return;
    const key = timelineOutlineKey(toolType, sessionId);
    const normalized = uuids.map(String);
    const previous = get().eligibleUuidsByKey[key] || [];
    if (previous.length === normalized.length && previous.every((uuid, index) => uuid === normalized[index])) return;
    set((state) => ({
      eligibleUuidsByKey: { ...state.eligibleUuidsByKey, [key]: normalized },
    }));
  },
}));

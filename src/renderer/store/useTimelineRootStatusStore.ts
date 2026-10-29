import { create } from 'zustand';
import historyPrimaryRollout from '../../shared/history-primary-rollout.cjs';
// Scalar status of mounted readers only. No summaries, outline, UUID inventory,
// documents, measured-height history or entry cache lives in this store.
export type TimelineRootStatus = {
  lease: object; sessionId: string; legacy?: boolean; ready?: boolean;
  summaryCount?: number; outlineCount?: number; outlineNewCount?: number; eligibleCount?: number;
};
export const useTimelineRootStatusStore = create<{ byTab: Record<string, TimelineRootStatus> }>(() => ({ byTab: {} }));
export function timelineRootCandidate(toolType: string | undefined) {
  return toolType === 'codex' && historyPrimaryRollout.historyPrimaryRootEnabled(window.require('node:process').env);
}
export function publishTimelineRootStatus(tabId: string, value: TimelineRootStatus) {
  useTimelineRootStatusStore.setState(state => ({ byTab: { ...state.byTab, [tabId]: value } }));
}
export function clearTimelineRootStatus(tabId: string, lease: object) {
  useTimelineRootStatusStore.setState(state => {
    if (state.byTab[tabId]?.lease !== lease) return state;
    const byTab = { ...state.byTab }; delete byTab[tabId]; return { byTab };
  });
}

import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useProjectsStore } from '../store/useProjectsStore';
import { resolvePtyAgentOwner } from '../utils/ptyAgentOwner.mjs';
import { getBusyTabsSnapshot } from './usePromptQueueRunner';
import { resolveAgentBusyPresentation } from '../utils/agentBusyPresentation.mjs';
import { automationInventory } from '../utils/runAfterInventory.mjs';

export type AutomationTab = {
  id: string; name: string; projectId: string; projectName: string;
  projectIcon: string | null; workflowId: string; provider: 'claude' | 'codex';
  sessionId: string | null; color?: string; tabType?: string;
  membershipRevision?: number;
};
const EMPTY_INVENTORY = {tabs: [] as AutomationTab[], groups: [] as any[]};
// null = the complete opened editor. A closed trigger needs only the exact IDs
// that contribute to its queue/compaction counters; no executor uses this hook.
export function useAutomationInventory(tabIds: ReadonlySet<string> | null = null) {
  const fingerprint = useWorkspaceStore((state) => tabIds?.size === 0 ? '' : JSON.stringify({
    membership:tabIds ? Object.fromEntries([...tabIds].map(id=>[id,state.tabWorkflowMembership[id]]))
      : state.tabWorkflowMembership,organizationReady:state.organizationReady,
    spaces: state.spaces.map((s) => ({ id: s.id, name: s.name, projectIds: s.projectIds || [], icon: s.icon })),
    projects: [...state.openProjects].map(([id, ws]) => ({ id, path: ws.projectPath,
      tabs: [...ws.tabs.values()].filter((t) => (!tabIds || tabIds.has(t.id))
        && t.tabType !== 'claude-sdk' && resolvePtyAgentOwner(t))
        .map((t) => ({ id: t.id, name: t.name, provider: resolvePtyAgentOwner(t),
          sessionId: resolvePtyAgentOwner(t) === 'codex' ? t.codexSessionId : t.claudeSessionId,
          color: t.color, tabType: t.tabType })),
    })),
  }));
  const projectMetadata = useProjectsStore((state) => tabIds?.size === 0 ? '' : JSON.stringify(Object.entries(state.projects)
    .map(([id, p]) => [id, p.name, p.icon, p.path])));
  return useMemo(() => {
    if (tabIds?.size === 0) return EMPTY_INVENTORY;
    return automationInventory(useWorkspaceStore.getState(), useProjectsStore.getState().projects, tabIds) as {
      tabs: AutomationTab[]; groups: any[];
    };
  }, [fingerprint, projectMetadata, tabIds]);
}

export function useAutomationBusyTabs() {
  const [busy, setBusy] = useState(() => getBusyTabsSnapshot());
  useEffect(() => {
    const { ipcRenderer } = window.require('electron');
    const handler = (_event: unknown, data: { tabId: string; busy: boolean; reason?: string; activityBusy?: boolean }) => {
      if (!data?.tabId || data.reason === 'spinner') return;
      const activityBusy = resolveAgentBusyPresentation(data);
      setBusy((previous) => {
        if (previous.get(data.tabId) === activityBusy) return previous;
        const next = new Map(previous); next.set(data.tabId, activityBusy); return next;
      });
    };
    const channels = ['claude:busy-state', 'codex:busy-state', 'gemini:busy-state'];
    for (const channel of channels) ipcRenderer.on(channel, handler);
    return () => { for (const channel of channels) ipcRenderer.removeListener(channel, handler); };
  }, []);
  return busy;
}

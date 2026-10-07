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
export function useAutomationInventory() {
  const fingerprint = useWorkspaceStore((state) => JSON.stringify({
    membership:state.tabWorkflowMembership,organizationReady:state.organizationReady,
    spaces: state.spaces.map((s) => ({ id: s.id, name: s.name, projectIds: s.projectIds || [], icon: s.icon })),
    projects: [...state.openProjects].map(([id, ws]) => ({ id, path: ws.projectPath,
      tabs: [...ws.tabs.values()].filter((t) => t.tabType !== 'claude-sdk' && resolvePtyAgentOwner(t))
        .map((t) => ({ id: t.id, name: t.name, provider: resolvePtyAgentOwner(t),
          sessionId: resolvePtyAgentOwner(t) === 'codex' ? t.codexSessionId : t.claudeSessionId,
          color: t.color, tabType: t.tabType })),
    })),
  }));
  const projectMetadata = useProjectsStore((state) => JSON.stringify(Object.entries(state.projects)
    .map(([id, p]) => [id, p.name, p.icon, p.path])));
  return useMemo(() => {
    return automationInventory(useWorkspaceStore.getState(), useProjectsStore.getState().projects) as {
      tabs: AutomationTab[]; groups: any[];
    };
  }, [fingerprint, projectMetadata]);
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

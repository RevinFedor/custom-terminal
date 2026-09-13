import { useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useProjectsStore } from '../store/useProjectsStore';
import { resolvePtyAgentOwner } from '../utils/ptyAgentOwner.mjs';
import { automationWorkflowForProject, UNPLACED_AUTOMATION_WORKFLOW } from '../utils/autoCompactPolicy.mjs';
import { getBusyTabsSnapshot } from './usePromptQueueRunner';
import { resolveAgentBusyPresentation } from '../utils/agentBusyPresentation.mjs';

export type AutomationTab = {
  id: string; name: string; projectId: string; projectName: string;
  projectIcon: string | null; workflowId: string; provider: 'claude' | 'codex';
  sessionId: string | null; color?: string; tabType?: string;
};
export function useAutomationInventory() {
  const fingerprint = useWorkspaceStore((state) => JSON.stringify({
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
    const state = JSON.parse(fingerprint);
    const metadata = new Map<string, any[]>(JSON.parse(projectMetadata).map(([id, ...values]: any[]) => [id, values]));
    const projects = state.projects.map((p: any) => ({ ...p,
      name: metadata.get(p.id)?.[0] || p.path?.split('/').filter(Boolean).pop() || p.id,
      icon: metadata.get(p.id)?.[1] || null,
    }));
    const tabs: AutomationTab[] = projects.flatMap((p: any) => p.tabs.map((t: any) => ({ ...t,
      projectId: p.id, projectName: p.name, projectIcon: p.icon,
      workflowId: automationWorkflowForProject(state.spaces, p.id),
    })));
    const groups = [...state.spaces, { id: UNPLACED_AUTOMATION_WORKFLOW, name: 'Без workflow', projectIds: [] }]
      .map((s: any) => ({ ...s,
        projectNames: s.id === UNPLACED_AUTOMATION_WORKFLOW
          ? projects.filter((p: any) => automationWorkflowForProject(state.spaces, p.id) === s.id).map((p: any) => p.name)
          : (s.projectIds || []).map((id: string) => metadata.get(id)?.[0]
            || metadata.get(id)?.[2]?.split('/').filter(Boolean).pop() || id),
        tabs: tabs.filter((t) => t.workflowId === s.id),
      }));
    return { tabs, groups };
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

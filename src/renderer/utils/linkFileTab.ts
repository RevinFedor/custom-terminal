import { useWorkspaceStore } from '../store/useWorkspaceStore';

const path = window.require('path');

export type LinkFileTabResult = {
  projectId: string;
  parentTabId: string;
  fileTabId: string;
  filePath: string;
  reused: boolean;
};

function isAiSessionTab(tab: any): boolean {
  if (!tab || tab.parentTabId || tab.tabType === 'file') return false;
  if (tab.tabType === 'claude-sdk') return true;
  return tab.commandType === 'claude' || tab.commandType === 'codex' || tab.commandType === 'gemini';
}

export async function linkFileTab(filePath: string, targetTabId: string): Promise<LinkFileTabResult> {
  if (!filePath || !targetTabId) throw new Error('filePath and targetTabId are required');
  const normalizedPath = path.resolve(String(filePath).trim());

  const state = useWorkspaceStore.getState();
  let targetProjectId: string | null = null;
  let targetWorkspace: any = null;
  let targetTab: any = null;

  for (const [projectId, workspace] of state.openProjects) {
    const candidate = workspace.tabs.get(targetTabId);
    if (!candidate) continue;
    targetProjectId = projectId;
    targetWorkspace = workspace;
    targetTab = candidate;
    break;
  }

  if (!targetProjectId || !targetWorkspace || !targetTab) {
    throw new Error('target tab is not open');
  }
  if (!isAiSessionTab(targetTab)) {
    throw new Error('target tab is not an AI session');
  }

  for (const tab of targetWorkspace.tabs.values()) {
    if (tab.tabType !== 'file' || tab.visualParentTabId !== targetTabId || !tab.filePath) continue;
    if (path.resolve(tab.filePath) !== normalizedPath) continue;
    return {
      projectId: targetProjectId,
      parentTabId: targetTabId,
      fileTabId: tab.id,
      filePath: normalizedPath,
      reused: true,
    };
  }

  const fileTabId = await state.createTabAfterCurrent(
    targetProjectId,
    path.basename(normalizedPath),
    targetTab.cwd || path.dirname(normalizedPath),
    {
      tabType: 'file',
      filePath: normalizedPath,
      color: 'purple',
      nameSetManually: true,
      background: true,
      afterTabId: targetTabId,
      visualParentTabId: targetTabId,
      groupId: targetTab.groupId,
    },
  );

  return {
    projectId: targetProjectId,
    parentTabId: targetTabId,
    fileTabId,
    filePath: normalizedPath,
    reused: false,
  };
}

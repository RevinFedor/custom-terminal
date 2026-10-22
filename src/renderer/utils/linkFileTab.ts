import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { collectTabLinkedFileTree } from './tabLinkedFiles.mjs';

const path = window.require('path');
const MAX_LINKED_FILES_PER_AI = 10;

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
  if (targetTab.aiClosing) throw new Error('target tab is closing');

  let publicationError = 'target tab changed before file link committed';
  const canPublish = () => {
    publicationError = 'target tab changed before file link committed';
    const openProjects = useWorkspaceStore.getState().openProjects;
    const current = openProjects.get(targetProjectId!);
    const owner = current?.tabs.get(targetTabId);
    if (current !== targetWorkspace || !isAiSessionTab(owner) || owner?.aiClosing) return false;
    // Count the current file-only family, including nested files, but stop at
    // independent AI children. The creation queue repeats this before persist
    // and publish, so concurrent links cannot both take the last free place.
    if (collectTabLinkedFileTree(openProjects, targetTabId).length >= MAX_LINKED_FILES_PER_AI) {
      publicationError = `You can link up to ${MAX_LINKED_FILES_PER_AI} files to an AI tab. Unlink a file before adding another (the file stays on disk).`;
      return false;
    }
    return true;
  };

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

  // Existing exact links above remain reusable even for an over-limit owner.
  if (!canPublish()) throw new Error(publicationError);

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
      canPublish,
    },
  );
  if (!fileTabId) throw new Error(publicationError);

  return {
    projectId: targetProjectId,
    parentTabId: targetTabId,
    fileTabId,
    filePath: normalizedPath,
    reused: false,
  };
}

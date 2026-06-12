import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

export interface CodexRunPayloadBase {
  tabId: string;
  command: string;
  sessionId?: string;
  cwd?: string;
}

export interface CodexRunPayload extends CodexRunPayloadBase {
  model?: string;
  effort?: string;
}

const cleanSetting = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return undefined;
  return trimmed;
};

const findCodexTabState = (tabId: string): { codexModel?: string; codexEffort?: string } => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      return {
        codexModel: tab.codexModel,
        codexEffort: tab.codexEffort,
      };
    }
  }
  return {};
};

export const getCodexLaunchOptions = (tabId: string): { model?: string; effort?: string } => {
  const tab = findCodexTabState(tabId);
  const ui = useUIStore.getState();
  const model = cleanSetting(tab.codexModel) ?? cleanSetting(ui.defaultCodexModel);
  const effort = cleanSetting(tab.codexEffort) ?? cleanSetting(ui.defaultCodexEffort);

  return {
    model,
    effort,
  };
};

export const buildCodexRunPayload = (base: CodexRunPayloadBase): CodexRunPayload => {
  const { model, effort } = getCodexLaunchOptions(base.tabId);
  return {
    ...base,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
};

import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

export interface CodexRunPayloadBase {
  tabId: string;
  command: string;
  sessionId?: string;
  cwd?: string;
  developerInstructions?: string;
}

export interface CodexRunPayload extends CodexRunPayloadBase {
  model?: string;
  effort?: string;
  modelSource?: 'tab' | 'global';
  effortSource?: 'tab' | 'global';
  modelMigrationPending?: boolean;
}

const cleanSetting = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return undefined;
  return trimmed;
};

const cleanPersistentEffort = (value: unknown): string | undefined => {
  const effort = cleanSetting(value);
  return effort === 'ultra' ? undefined : effort;
};

const findCodexTabState = (tabId: string): {
  codexModel?: string;
  codexEffort?: string;
  codexModelMigrationPending?: boolean;
} => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      return {
        codexModel: tab.codexModel,
        codexEffort: tab.codexEffort,
        codexModelMigrationPending: tab.codexModelMigrationPending,
      };
    }
  }
  return {};
};

export const getCodexLaunchOptions = (tabId: string): {
  model?: string;
  effort?: string;
  modelSource?: 'tab' | 'global';
  effortSource?: 'tab' | 'global';
  modelMigrationPending?: boolean;
} => {
  const tab = findCodexTabState(tabId);
  if (tab.codexModelMigrationPending === true) {
    return { modelMigrationPending: true };
  }
  const ui = useUIStore.getState();
  const tabModel = cleanSetting(tab.codexModel);
  const tabEffort = cleanPersistentEffort(tab.codexEffort);
  const globalModel = cleanSetting(ui.defaultCodexModel);
  const globalEffort = cleanPersistentEffort(ui.defaultCodexEffort);
  const model = tabModel ?? globalModel;
  const effort = tabEffort ?? globalEffort;

  return {
    model,
    effort,
    ...(model ? { modelSource: tabModel ? 'tab' as const : 'global' as const } : {}),
    ...(effort ? { effortSource: tabEffort ? 'tab' as const : 'global' as const } : {}),
  };
};

export const buildCodexRunPayload = (base: CodexRunPayloadBase): CodexRunPayload => {
  const {
    model,
    effort,
    modelSource,
    effortSource,
    modelMigrationPending,
  } = getCodexLaunchOptions(base.tabId);
  return {
    ...base,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(modelSource ? { modelSource } : {}),
    ...(effortSource ? { effortSource } : {}),
    ...(modelMigrationPending ? { modelMigrationPending: true } : {}),
  };
};

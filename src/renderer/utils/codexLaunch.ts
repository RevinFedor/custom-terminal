import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { hasCodexNextLaunchSettingsIntent } from './codexEffectiveSettings.mjs';

export interface CodexRunPayloadBase {
  tabId: string;
  command: string;
  sessionId?: string;
  cwd?: string;
  developerInstructions?: string;
  launchSource?: 'auto-resume' | 'explicit';
}

export interface CodexRunPayload extends CodexRunPayloadBase {
  model?: string;
  effort?: string;
  modelSource?: 'tab' | 'global';
  effortSource?: 'tab' | 'global';
  modelMigrationPending?: boolean;
  settingsIntent?: 'next-launch';
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
  codexSettingsProofAt?: number;
  codexSettingsProofSessionId?: string;
  codexModelMigrationPending?: boolean;
  codexLiveModel?: string;
  codexLiveEffort?: string;
  codexLiveSettingsSessionId?: string;
  codexLiveServiceTier?: string;
  codexLiveServiceTierSessionId?: string;
} => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      return {
        codexModel: tab.codexModel,
        codexEffort: tab.codexEffort,
        codexSettingsProofAt: tab.codexSettingsProofAt,
        codexSettingsProofSessionId: tab.codexSettingsProofSessionId,
        codexModelMigrationPending: tab.codexModelMigrationPending,
        codexLiveModel: tab.codexLiveModel,
        codexLiveEffort: tab.codexLiveEffort,
        codexLiveSettingsSessionId: tab.codexLiveSettingsSessionId,
        codexLiveServiceTier: tab.codexLiveServiceTier,
        codexLiveServiceTierSessionId: tab.codexLiveServiceTierSessionId,
      };
    }
  }
  return {};
};

export const getCodexHistoryMutationSettingsProof = (
  tabId: string,
  sessionId: string,
): { model: string; effort: string; proofAt: number; sessionId: string; fast?: boolean } | null => {
  const tab = findCodexTabState(tabId);
  const proofAt = Number(tab.codexSettingsProofAt || 0);
  if (!Number.isFinite(proofAt) || proofAt <= 0) return null;
  const liveOwner = cleanSetting(tab.codexLiveSettingsSessionId);
  const liveModel = cleanSetting(tab.codexLiveModel);
  const liveEffort = cleanSetting(tab.codexLiveEffort);
  const tierOwner = cleanSetting(tab.codexLiveServiceTierSessionId);
  const fast = tierOwner === sessionId && tab.codexLiveServiceTier
    ? tab.codexLiveServiceTier === 'priority'
    : undefined;
  if (liveOwner === sessionId && liveModel && liveEffort) {
    return {
      model: liveModel,
      effort: liveEffort,
      proofAt,
      sessionId,
      ...(typeof fast === 'boolean' ? { fast } : {}),
    };
  }
  const model = cleanSetting(tab.codexModel);
  const effort = cleanSetting(tab.codexEffort);
  const owner = cleanSetting(tab.codexSettingsProofSessionId);
  if (owner === sessionId && model && effort) {
    return { model, effort, proofAt, sessionId, ...(typeof fast === 'boolean' ? { fast } : {}) };
  }
  // An explicit pair selected while the tab is stopped is intentionally
  // ownerless until its next launch. It is still a user-authorized exact pair,
  // unlike global defaults, and can seed the edited child safely.
  if (!owner && model && effort && effort !== 'ultra') {
    return { model, effort, proofAt, sessionId, ...(typeof fast === 'boolean' ? { fast } : {}) };
  }
  return null;
};

export const getCodexLaunchOptions = (tabId: string): {
  model?: string;
  effort?: string;
  modelSource?: 'tab' | 'global';
  effortSource?: 'tab' | 'global';
  modelMigrationPending?: boolean;
  settingsIntent?: 'next-launch';
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
  const nextLaunchIntent = hasCodexNextLaunchSettingsIntent({
    model: tabModel,
    effort: tabEffort,
    proofAt: tab.codexSettingsProofAt,
    proofSessionId: tab.codexSettingsProofSessionId,
    modelMigrationPending: tab.codexModelMigrationPending,
  });

  return {
    model,
    effort,
    ...(model ? { modelSource: tabModel ? 'tab' as const : 'global' as const } : {}),
    ...(effort ? { effortSource: tabEffort ? 'tab' as const : 'global' as const } : {}),
    ...(nextLaunchIntent ? { settingsIntent: 'next-launch' as const } : {}),
  };
};

export const buildCodexRunPayload = (base: CodexRunPayloadBase): CodexRunPayload => {
  const {
    model,
    effort,
    modelSource,
    effortSource,
    modelMigrationPending,
    settingsIntent,
  } = getCodexLaunchOptions(base.tabId);
  return {
    ...base,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(modelSource ? { modelSource } : {}),
    ...(effortSource ? { effortSource } : {}),
    ...(modelMigrationPending ? { modelMigrationPending: true } : {}),
    ...(settingsIntent ? { settingsIntent } : {}),
  };
};

export const buildCodexHistoryMutationResumePayload = (
  base: CodexRunPayloadBase,
  proof?: { model: string; effort: string; proofAt: number } | null,
): CodexRunPayload => {
  const payload = buildCodexRunPayload(base);
  if (!proof?.model || !proof?.effort || !Number.isFinite(Number(proof.proofAt))) {
    return payload;
  }
  // This is not a guessed default. It is the exact pair captured before the
  // mutation stopped the writer (or returned by validated child creation).
  // Marking it as next-launch lets a legacy rollout with no turn_context be
  // restored after a pre-publication failure without weakening normal Resume.
  return {
    ...payload,
    model: proof.model,
    effort: proof.effort,
    modelSource: 'tab',
    effortSource: 'tab',
    settingsIntent: 'next-launch',
  };
};

export type AgentThinkingMode = 'adaptive' | 'enabled' | 'disabled';

export type AgentSettingsIntent = Readonly<
  | { kind: 'none' }
  | {
      kind: 'explicit-change';
      model?: string;
      effort?: string;
      thinking?: AgentThinkingMode;
    }
>;

export type AgentHistoryRestartSettings = Readonly<
  | {
      kind: 'codex-runtime-proof';
      model: string;
      effort: string;
      owner: Readonly<{
        kind: 'writer' | 'launch';
        id: string;
      }>;
      proofAt: number;
    }
  | {
      kind: 'codex-launch-settings';
      model: string;
      effort: string;
      modelSource?: 'tab' | 'global';
      effortSource?: 'tab' | 'global';
    }
  | {
      kind: 'codex-settings-unavailable';
      reason: 'model-migration-pending' | 'pair-missing' | 'live-proof-required';
    }
>;

export type CodexStopCapturedSettingsProof = Readonly<{
  kind: 'codex-stop-captured-settings';
  model: string;
  effort: string;
  scope: 'persistent-default' | 'conversation-only';
  owner: Readonly<{ kind: 'writer' | 'launch'; id: string }>;
  observedAt: number;
  authority: Readonly<{
    lifecycleGeneration: string;
    runSeq: number;
    inputRevision: number;
    mirrorGeneration: string;
    committedFrameGeneration: number;
    writeSeq: number;
  }>;
}>;

export const AGENT_SETTINGS_INTENT_NONE: AgentSettingsIntent = Object.freeze({
  kind: 'none' as const,
});

const cleanValue = (value: unknown, { allowNone = false } = {}): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || (!allowNone && normalized === 'none')) return undefined;
  return normalized;
};

/**
 * The untyped HTTP/IPC edge is the only place where loose external fields are
 * converted into a product intent. Once inside the send scenario, an ambient
 * ControlBar value can no longer masquerade as a settings mutation merely by
 * occupying a `model` or `effort` property.
 */
export function createAgentSettingsIntent({
  provider,
  model,
  effort,
  thinking,
}: {
  provider?: 'claude' | 'codex';
  model?: unknown;
  effort?: unknown;
  thinking?: unknown;
} = {}): AgentSettingsIntent {
  const normalizedModel = cleanValue(model);
  const normalizedEffort = cleanValue(effort);
  const thinkingText = provider === 'codex'
    ? ''
    : (typeof thinking === 'string' ? thinking.trim().toLowerCase() : '');
  const normalizedThinking = thinkingText && thinkingText !== 'none'
    ? thinkingText
    : undefined;
  if (!normalizedModel && !normalizedEffort && !normalizedThinking) {
    return AGENT_SETTINGS_INTENT_NONE;
  }
  return Object.freeze({
    kind: 'explicit-change' as const,
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
    ...(normalizedThinking ? { thinking: normalizedThinking as AgentThinkingMode } : {}),
  });
}

export function createAgentHistoryRestartSettings({
  source,
  model,
  effort,
  ownerKind,
  ownerId,
  proofAt,
  modelSource,
  effortSource,
  reason,
}: {
  source?: unknown;
  model?: unknown;
  effort?: unknown;
  ownerKind?: unknown;
  ownerId?: unknown;
  proofAt?: unknown;
  modelSource?: unknown;
  effortSource?: unknown;
  reason?: unknown;
}): AgentHistoryRestartSettings | undefined {
  const normalizedSource = source === 'exact-session-proof'
    || source === 'launch-intent'
    || source === 'unavailable'
    ? source
    : null;
  if (!normalizedSource) return undefined;
  if (normalizedSource === 'unavailable') {
    const normalizedReason = reason === 'model-migration-pending'
      ? 'model-migration-pending'
      : reason === 'live-proof-required'
        ? 'live-proof-required'
        : 'pair-missing';
    return Object.freeze({
      kind: 'codex-settings-unavailable' as const,
      reason: normalizedReason,
    });
  }
  const normalizedModel = cleanValue(model);
  const normalizedEffort = cleanValue(effort);
  if (!normalizedModel || !normalizedEffort) return undefined;
  const normalizedOwnerKind = ownerKind === 'writer' || ownerKind === 'launch'
    ? ownerKind
    : null;
  const normalizedOwnerId = cleanValue(ownerId, { allowNone: true });
  const normalizedProofAt = Number(proofAt);
  if (normalizedSource === 'exact-session-proof') {
    if (
      !normalizedModel
      || !normalizedEffort
      || !normalizedOwnerKind
      || !normalizedOwnerId
      || !Number.isFinite(normalizedProofAt)
      || normalizedProofAt <= 0
    ) {
      throw new Error('Exact restart settings proof is incomplete');
    }
  }
  if (normalizedSource === 'exact-session-proof') {
    return Object.freeze({
      kind: 'codex-runtime-proof' as const,
      model: normalizedModel!,
      effort: normalizedEffort!,
      owner: Object.freeze({
        kind: normalizedOwnerKind!,
        id: normalizedOwnerId!,
      }),
      proofAt: normalizedProofAt,
    });
  }
  return Object.freeze({
    kind: 'codex-launch-settings' as const,
    model: normalizedModel,
    effort: normalizedEffort,
    ...(modelSource === 'tab' || modelSource === 'global' ? { modelSource } : {}),
    ...(effortSource === 'tab' || effortSource === 'global' ? { effortSource } : {}),
  });
}

/** Runtime guard for JavaScript callers and bridge payloads. */
export function agentSendSettingsContractError({
  recordWithoutReply,
  toolType,
  settingsIntent,
  historyRestartSettings,
}: {
  recordWithoutReply?: boolean;
  toolType: 'claude' | 'codex';
  settingsIntent: AgentSettingsIntent;
  historyRestartSettings?: AgentHistoryRestartSettings;
}): string | null {
  if (settingsIntent?.kind !== 'none' && settingsIntent?.kind !== 'explicit-change') {
    return 'Agent send settings intent is missing or invalid';
  }
  if (settingsIntent.kind === 'explicit-change') {
    if (!settingsIntent.model && !settingsIntent.effort && !settingsIntent.thinking) {
      return 'Explicit agent settings change is empty';
    }
    if (toolType === 'codex' && settingsIntent.thinking) {
      return 'Codex settings change cannot contain Claude thinking';
    }
    if (settingsIntent.thinking
      && settingsIntent.thinking !== 'adaptive'
      && settingsIntent.thinking !== 'enabled'
      && settingsIntent.thinking !== 'disabled') {
      return 'Claude thinking mode is invalid';
    }
  }
  if (
    historyRestartSettings
    && historyRestartSettings.kind !== 'codex-runtime-proof'
    && historyRestartSettings.kind !== 'codex-launch-settings'
    && historyRestartSettings.kind !== 'codex-settings-unavailable'
  ) {
    return 'Agent history restart settings are invalid';
  }
  if (historyRestartSettings && toolType !== 'codex') {
    return 'History restart settings belong only to Codex';
  }
  if (historyRestartSettings?.kind === 'codex-runtime-proof') {
    if (
      !cleanValue(historyRestartSettings.model)
      || !cleanValue(historyRestartSettings.effort)
      || !historyRestartSettings.owner
      || (historyRestartSettings.owner.kind !== 'writer'
        && historyRestartSettings.owner.kind !== 'launch')
      || !cleanValue(historyRestartSettings.owner.id, { allowNone: true })
      || !Number.isFinite(Number(historyRestartSettings.proofAt))
      || Number(historyRestartSettings.proofAt) <= 0
    ) {
      return 'Codex runtime restart proof is incomplete';
    }
  }
  if (historyRestartSettings?.kind === 'codex-launch-settings') {
    if (
      !cleanValue(historyRestartSettings.model)
      || !cleanValue(historyRestartSettings.effort)
    ) {
      return 'Codex launch restart settings are incomplete';
    }
  }
  if (historyRestartSettings?.kind === 'codex-settings-unavailable'
    && historyRestartSettings.reason !== 'model-migration-pending'
    && historyRestartSettings.reason !== 'pair-missing'
    && historyRestartSettings.reason !== 'live-proof-required') {
    return 'Codex restart settings unavailable reason is invalid';
  }
  if (recordWithoutReply === true && settingsIntent.kind === 'explicit-change') {
    return 'Record-without-reply cannot also request a settings change';
  }
  if (recordWithoutReply !== true && historyRestartSettings) {
    return 'History restart settings are only valid for record-without-reply';
  }
  return null;
}

export function isCodexStopCapturedSettingsProof(
  value: unknown,
): value is CodexStopCapturedSettingsProof {
  const proof = value as any;
  return proof?.kind === 'codex-stop-captured-settings'
    && !!cleanValue(proof.model)
    && !!cleanValue(proof.effort)
    && (proof.scope === 'persistent-default' || proof.scope === 'conversation-only')
    && (proof.owner?.kind === 'writer' || proof.owner?.kind === 'launch')
    && !!cleanValue(proof.owner?.id, { allowNone: true })
    && Number.isFinite(Number(proof.observedAt))
    && !!cleanValue(proof.authority?.lifecycleGeneration, { allowNone: true })
    && Number.isInteger(Number(proof.authority?.runSeq))
    && Number(proof.authority.runSeq) > 0
    && Number.isInteger(Number(proof.authority?.inputRevision))
    && Number(proof.authority.inputRevision) >= 0
    && !!cleanValue(proof.authority?.mirrorGeneration, { allowNone: true })
    && Number.isInteger(Number(proof.authority?.committedFrameGeneration))
    && Number(proof.authority.committedFrameGeneration) >= 0
    && Number.isInteger(Number(proof.authority?.writeSeq))
    && Number(proof.authority.writeSeq) > 0;
}

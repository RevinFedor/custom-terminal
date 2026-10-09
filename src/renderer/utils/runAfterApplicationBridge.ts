import { createRunAfterRemote } from './runAfterRemote.mjs';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useProjectsStore } from '../store/useProjectsStore';
import { useUIStore } from '../store/useUIStore';
import { usePromptQueueStore, isPromptQueueStoreHydrated, serializePromptQueueCore,
  getPromptQueueEditorLock, acquirePromptQueueEditorLock, releasePromptQueueEditorLock,
  takePromptQueuePersistence, hasPendingPromptQueueContinuation, isLoopPromptActive,
  queueSendTransferredOwnership, materializeQueuedPromptRecord, readPromptQueueCountdown } from '../store/usePromptQueueStore';
import { useAutoCompactStore, takeAutoCompactPersistence } from '../store/useAutoCompactStore';
import { getPromptQueueRuntimeSnapshot, cancelPendingAutoCompact, requestAutoCompactNow } from '../hooks/usePromptQueueRunner';
import { shouldArmQueueForTrigger } from './promptTriggerArm.mjs';
import { shouldDisarmAfterTriggerClear } from './runAfterTriggerClear.mjs';
import { runAfterActionModels } from './runAfterActionModels';
import { sendQueuedPromptNow } from './runAfterSendNow';
import { inspectPromptImageAttachments } from './promptImageAttachments.mjs';
import { normalizeComposerChips } from './composerChips.mjs';
import { dictationBlocksSend } from './dictationChips.mjs';
import { getAppRuntimeIdentity } from './appRuntimeIdentity';

const { ipcRenderer } = window.require('electron');
const rendererEpoch = crypto.randomUUID();
let mainEpoch: string | null = null;
const failure = (code: string, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

async function actions(provider: string, tabId: string) {
  const settings = useUIStore.getState();
  const providerState = provider === 'claude'
    ? await ipcRenderer.invoke('provider:get-status', { tabId }).catch(() => null) : { type: 'codex' };
  const live = provider === 'codex'
    ? await ipcRenderer.invoke('codex:list-models').catch(() => null) : null;
  const models = runAfterActionModels({ provider, providerType: providerState?.type,
    claudeSettings: settings.claudeCodeSettings, codexSettings: settings.codexSettings, liveCodexModels: live?.models || [] });
  return { provider, providerType: providerState?.type || null,
    modelEffortSupported: provider === 'codex' || providerState?.type === 'anthropic', models,
    liveCatalogAvailable: provider === 'codex' ? Array.isArray(live?.models) : null,
    kinds: ['restart', 'rewind', 'stop', 'close-tab', ...(models.length ? ['model-effort'] : [])],
    perPromptThinking: false, perPromptFast: false };
}

async function validateAction(value: any, scope: any) {
  if (!value || typeof value !== 'object') throw failure('run_after_action_invalid', 400);
  if (Object.keys(value).some(key => !['kind', 'toolType', 'model', 'effort', 'targetUuid', 'targetText',
    'sourceSessionId', 'targetIteration', 'id', 'title'].includes(key))) throw failure('run_after_action_field_unsupported', 400);
  if (['restart', 'stop', 'close-tab'].includes(value.kind)) return { kind: value.kind };
  if (value.kind === 'rewind' && value.toolType === scope.provider
    && ['targetUuid', 'targetText', 'sourceSessionId'].every(key => typeof value[key] === 'string')
    && value.targetUuid && value.sourceSessionId) {
    return { kind: value.kind, toolType: value.toolType, targetUuid: value.targetUuid,
      targetText: value.targetText, sourceSessionId: value.sourceSessionId,
      ...(Number.isSafeInteger(value.targetIteration) && value.targetIteration > 0 ? { targetIteration: value.targetIteration } : {}) };
  }
  if (value.kind === 'model-effort' && value.toolType === scope.provider) {
    const catalog = await actions(scope.provider, scope.tabId);
    const model = catalog.models.find((entry: any) => entry.id === value.model);
    if (!catalog.modelEffortSupported || !model || !model.efforts.includes(value.effort)) throw failure('run_after_model_effort_unsupported', 422);
    return { kind: value.kind, toolType: value.toolType, model: model.id, effort: value.effort };
  }
  throw failure('run_after_action_invalid', 400);
}

function authoring(args: any) {
  const prepared: any = {};
  if ('title' in args && typeof args.title !== 'string') throw failure('run_after_text_required', 400);
  if ('images' in args) {
    if (!Number.isSafeInteger(args.images) || args.images < 0) throw failure('run_after_images_invalid', 400);
    prepared.images = args.images;
  }
  if ('text' in args) {
    if (typeof args.text !== 'string') throw failure('run_after_text_required', 400);
    prepared.text = args.text;
  }
  if ('chips' in args) {
    if (!Array.isArray(args.chips) || args.chips.some((chip: any) => !chip || !['prompt', 'paste'].includes(chip.kind)
      || typeof chip.id !== 'string' || !chip.id || typeof chip.text !== 'string')) throw failure('run_after_chips_invalid', 400);
    prepared.chips = normalizeComposerChips(args.chips);
    if (prepared.chips.length !== args.chips.length) throw failure('run_after_chips_invalid', 400);
  }
  if ('imagePaths' in args) {
    if (!Array.isArray(args.imagePaths)) throw failure('run_after_images_invalid', 400);
    prepared.imagePaths = clone(args.imagePaths);
  }
  return prepared;
}

const remote = createRunAfterRemote({ queue: usePromptQueueStore, autoCompact: useAutoCompactStore,
  workspace: () => useWorkspaceStore.getState(), projects: () => useProjectsStore.getState().projects,
  epoch: () => mainEpoch ? mainEpoch + ':' + rendererEpoch : null,
  hydrated: isPromptQueueStoreHydrated, core: serializePromptQueueCore,
  countdown: readPromptQueueCountdown,
  editorLock: getPromptQueueEditorLock, acquireEditor: acquirePromptQueueEditorLock, releaseEditor: releasePromptQueueEditorLock,
  runtimeState: getPromptQueueRuntimeSnapshot, hasPending: hasPendingPromptQueueContinuation, loopActive: isLoopPromptActive,
  queuePersistence: takePromptQueuePersistence, policyPersistence: takeAutoCompactPersistence,
  armForTrigger: shouldArmQueueForTrigger, disarmAfterTriggerClear: shouldDisarmAfterTriggerClear,
  mainInstanceId: async () => {
    const identity = await getAppRuntimeIdentity();
    if (!identity?.instanceId) throw failure('run_after_instance_unavailable', 503);
    return identity.instanceId;
  },
  prepareAuthoring: authoring, validateAction,
  validateScope: (ticket: any) => ipcRenderer.invoke('run-after:validate-scope', { ticket }),
  prepareTransfer: async (item: any, ticket: any) => {
    if (dictationBlocksSend(item.text)) throw failure('run_after_dictation_pending', 423);
    const prepared = await materializeQueuedPromptRecord(item);
    const inspection = inspectPromptImageAttachments(prepared.text, prepared.imagePaths || []);
    if (inspection.blocking) throw failure('run_after_image_identity_invalid', 422);
    const snapshot = clone(prepared);
    const staged = await ipcRenderer.invoke('run-after:stage', { ticket, result: { draft: snapshot },
      assetIds: (snapshot.imagePaths || []).flatMap((ref: any) => ref.assetId ? [ref.assetId] : []) });
    if (!staged?.result?.prepared) throw failure(staged?.error || 'run_after_draft_stage_unknown', 503);
    return snapshot;
  },
  sendNow: (tabId: string, item: any, scope: any) => sendQueuedPromptNow(tabId, item, scope.provider),
  transferred: queueSendTransferredOwnership,
  ownerBusyProof: async (tabId: string, scope: any, ticket: any) => {
    const result = await ipcRenderer.invoke('run-after:owner-busy-proof', { tabId, scope, ticket });
    // Busy proof controls only auto-arm. Unknown must not disable the existing
    // ability to stage a Compact card in a fresh/provisional/stopped tab.
    return result?.known === true ? result : { known: false, error: result?.error || 'run_after_owner_busy_unknown' };
  },
  commit: async (ticket: any, result: any, writes: any, retainAssets = false) => {
    const response = await ipcRenderer.invoke('run-after:commit', { ticket, result, writes, retainAssets });
    if (response?.error && response?.committed !== true) throw failure(response.error, response.statusCode || 503);
    return response;
  },
  cancelAutoCompact: (tabId: string, activityId: string) => {
    const activity = useAutoCompactStore.getState().activities[tabId];
    const phase = activity?.phase;
    if (activity?.handoffId !== activityId) return false;
    if (phase === 'compacting' || phase === 'resuming') return false;
    return cancelPendingAutoCompact(tabId, activityId);
  },
  requestAutoCompact: requestAutoCompactNow,
});

async function validateMain(payload: any) {
  const current = await ipcRenderer.invoke('run-after:main-epoch');
  if (!current?.epoch || current.epoch !== payload?.mainEpoch) throw failure('run_after_scope_changed');
  mainEpoch = current.epoch;
}

export function currentRunAfterMetadata(tabId: string) {
  if (!mainEpoch) return null;
  try { return remote.read(tabId).runAfter; } catch { return null; }
}

export function currentRunAfterEpoch() { return mainEpoch ? mainEpoch + ':' + rendererEpoch : null; }

export async function handleRunAfterApplicationRead(payload: any) {
  await validateMain(payload);
  if (payload.kind === 'overview') return remote.overview();
  if (payload.kind === 'auto-compact') return remote.policyRead();
  const response = remote.read(payload.target);
  if (payload.includeActions) {
    const catalog = await actions(response.runAfter.scope.provider, payload.target);
    const current = remote.read(payload.target);
    if (current.runAfter.scopeKey !== response.runAfter.scopeKey) throw failure('run_after_scope_changed');
    return { ...current, actions: catalog };
  }
  return response;
}

export async function handleRunAfterApplicationMutation(payload: any) {
  try {
    await validateMain(payload);
    return payload.kind === 'auto-compact'
      ? await remote.mutatePolicy(payload.input, payload.ticket)
      : await remote.mutate(payload.target, payload.input, payload.ticket);
  } catch (reason: any) {
    // Validation failures are not unknown delivery. After a state/provider
    // side effect, only the exact Main receipt may settle the outcome.
    if (!reason?.mutationMayHaveApplied) {
      return ipcRenderer.invoke('run-after:commit', { ticket: payload.ticket, rejected: true,
        result: { error: reason?.code || reason?.message || 'run_after_rejected', statusCode: reason?.statusCode || 409 } });
    }
    throw reason;
  }
}

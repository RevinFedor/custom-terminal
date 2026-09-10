import {
  useUIStore,
  type HistoryPromptDraftChip,
  type HistoryPromptDraftImageRef,
} from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import {
  buildCodexRunPayload,
  buildCodexHistoryMutationResumePayload,
  getCodexHistoryMutationSettingsProof,
} from './codexLaunch';
import { stopClaudePtyProcess } from './claudePtyActions';
import { restoreComposerDraftFromHistoryPresentation } from './composerChips.mjs';
import { mergeFailedHistoryAuthoringSnapshot } from './historyDraftOwnership.mjs';
import { beginHistoryOperationActivity } from './historyOperationActivity.mjs';

const { ipcRenderer } = window.require('electron');
const historyRewriteRewindInflightTabs = new Set<string>();

export type HistoryRewriteRewindTool = 'claude' | 'codex';

export type HistoryRewriteRewindTarget = {
  uuid: string;
  text: string;
  endUuid?: string;
  promptChips?: HistoryPromptDraftChip[];
  imagePaths?: HistoryPromptDraftImageRef[];
};

export class HistoryRewriteRewindError extends Error {
  historyMutated: boolean;

  constructor(message: string, historyMutated: boolean) {
    super(message);
    this.name = 'HistoryRewriteRewindError';
    this.historyMutated = historyMutated;
  }
}

type TimelineRow = {
  uuid?: string;
  type?: string;
  content?: string;
  isCompactSummary?: boolean;
  promptChips?: HistoryPromptDraftChip[];
  imagePaths?: HistoryPromptDraftImageRef[];
};

type ResolvedHistoryRewriteRange = {
  sessionId: string;
  targetText: string;
  endUuid: string;
  promptChips: HistoryPromptDraftChip[];
  imagePaths: HistoryPromptDraftImageRef[];
};

async function resolveCurrentRange({
  tabId,
  toolType,
  sessionId,
  cwd,
  target,
  rangeMode = 'tail',
}: {
  tabId: string;
  toolType: HistoryRewriteRewindTool;
  sessionId: string;
  cwd?: string;
  target: HistoryRewriteRewindTarget;
  rangeMode?: 'tail' | 'single';
}): Promise<ResolvedHistoryRewriteRange> {
  if (target.endUuid) {
    return {
      sessionId,
      targetText: target.text.trim(),
      endUuid: target.endUuid,
      promptChips: Array.isArray(target.promptChips) ? target.promptChips : [],
      imagePaths: Array.isArray(target.imagePaths) ? target.imagePaths : [],
    };
  }
  const result = toolType === 'codex'
    ? await ipcRenderer.invoke('agent-transcript:get-timeline', {
        toolType: 'codex',
        tabId,
        sessionId,
        cwd,
        source: 'PromptQueue.historyRewriteRewind',
        reason: 'resolve-current-tail',
        visible: false,
      })
    : await ipcRenderer.invoke('claude:get-timeline', {
        sessionId,
        cwd,
        source: 'PromptQueue.historyRewriteRewind',
        reason: 'resolve-current-tail',
        tabId,
        visible: false,
      });
  if (!result?.success) {
    throw new Error(result?.error || 'Не удалось прочитать текущую Timeline');
  }
  const entries = Array.isArray(result.entries) ? result.entries as TimelineRow[] : [];
  const selected = entries.find((entry) => entry.uuid === target.uuid);
  if (!selected || selected.type !== 'user' || selected.isCompactSummary) {
    throw new Error('Выбранная точка Rewind больше не существует в текущей истории');
  }
  const endUuid = rangeMode === 'single'
    ? selected.uuid
    : entries[entries.length - 1]?.uuid;
  if (!endUuid) throw new Error('В текущей истории нет хвоста для Rewind');
  const resolvedSessionId = toolType === 'claude' && typeof result.latestSessionId === 'string'
    ? result.latestSessionId
    : sessionId;
  const targetText = String(selected.content || target.text || '').trim();
  if (!targetText) throw new Error('У выбранной точки Rewind нет текста для возврата в input');
  return {
    sessionId: resolvedSessionId,
    targetText,
    endUuid,
    promptChips: Array.isArray(target.promptChips)
      ? target.promptChips
      : Array.isArray(selected.promptChips) ? selected.promptChips : [],
    imagePaths: Array.isArray(target.imagePaths)
      ? target.imagePaths
      : Array.isArray(selected.imagePaths) ? selected.imagePaths : [],
  };
}

async function stopCodexForHistoryRewrite(tabId: string, sessionId: string): Promise<void> {
  const commandState = await ipcRenderer.invoke('terminal:getCommandState', {
    tabId,
    caller: 'PromptQueue.codexHistoryRewind',
    expectedProcess: 'codex',
    allowProcessTreeLookup: true,
  });
  if (commandState?.processLookupUnknown && !commandState?.isRunning) {
    throw new Error('Не удалось проверить процесс Codex; история не изменена');
  }
  if (!sessionId) throw new Error('Нет Codex-сессии для Rewind');
  if (!commandState?.isRunning) return;
  const stopped = await ipcRenderer.invoke('terminal:stop-ai-process', {
    tabId,
    toolType: 'codex',
    reason: 'prompt-queue-history-rewind',
  });
  if (!stopped?.success) throw new Error(stopped?.error || 'Не удалось остановить Codex');
}

export async function executeHistoryRewriteRewindScenario({
  tabId,
  toolType,
  sessionId,
  cwd,
  target,
  restoreDraft = true,
  rangeMode = 'tail',
}: {
  tabId: string;
  toolType: HistoryRewriteRewindTool;
  sessionId: string;
  cwd?: string;
  target: HistoryRewriteRewindTarget;
  rangeMode?: 'tail' | 'single';
  /**
   * Desktop History returns the removed prompt to its own composer. External
   * chat owners (Inbox/Voice Record) restore their composer themselves and must
   * not leave a second hidden draft in Noted Terminal.
   */
  restoreDraft?: boolean;
}): Promise<{ sessionId: string; newSessionId?: string; fileDeleted?: boolean }> {
  if (historyRewriteRewindInflightTabs.has(tabId)) {
    throw new HistoryRewriteRewindError('Rewind уже выполняется', false);
  }
  historyRewriteRewindInflightTabs.add(tabId);
  const activity = beginHistoryOperationActivity({
    tabId, sourceSessionId: sessionId, kind: rangeMode === 'single' ? 'delete' : 'rewind',
    startUuid: target.uuid, endUuid: rangeMode === 'single' ? target.uuid : target.endUuid,
  });
  if (!activity) {
    historyRewriteRewindInflightTabs.delete(tabId);
    throw new HistoryRewriteRewindError('Операция над историей уже выполняется', false);
  }
  let activityError: string | null = null;
  let historyMutated = false;
  let stopped = false;
  let codexChildAdopted = false;
  let mutationSessionId = sessionId;
  let codexSettingsProof: ReturnType<typeof getCodexHistoryMutationSettingsProof> = null;
  try {
    const range = await resolveCurrentRange({
      tabId,
      toolType,
      sessionId,
      cwd,
      target,
      rangeMode,
    });
    mutationSessionId = range.sessionId;
    const restoredDraft = restoreDraft
      ? restoreComposerDraftFromHistoryPresentation({
          text: range.targetText,
          chips: range.promptChips,
          imagePaths: range.imagePaths,
        })
      : null;

    if (toolType === 'codex') {
      codexSettingsProof = getCodexHistoryMutationSettingsProof(tabId, mutationSessionId);
      const preflight = await ipcRenderer.invoke('codex:delete-range', {
        sessionId: mutationSessionId,
        cwd,
        startUuid: target.uuid,
        endUuid: range.endUuid,
        validateOnly: true,
        ...(codexSettingsProof ? { codexSettingsProof } : {}),
      });
      if (!preflight?.success) {
        throw new Error(preflight?.error || 'Codex Rewind validation failed');
      }
      codexSettingsProof = preflight.codexSettingsProof || codexSettingsProof;
      activity.setPhase('stopping');
      await stopCodexForHistoryRewrite(tabId, mutationSessionId);
    } else {
      activity.setPhase('stopping');
      const stopResult = await stopClaudePtyProcess(tabId, {
        reason: 'prompt-queue-history-rewrite-rewind',
      });
      if (stopResult?.success === false) {
        throw new Error(stopResult.error || 'Не удалось остановить Claude перед Rewind');
      }
    }
    stopped = true;

    if (toolType === 'codex') {
      const nativeRewindRecovery = await ipcRenderer.invoke(
        'codex:reconcile-native-rewind-before-history-rewrite',
        {
          tabId,
          sessionId: mutationSessionId,
        },
      );
      if (nativeRewindRecovery?.success !== true) {
        const reason = nativeRewindRecovery?.error
          || nativeRewindRecovery?.reason
          || 'codex_rewind_recovery_pending_before_history_rewrite';
        throw new Error(
          'Предыдущий native Rewind ещё не подтверждён; сохранённая история не изменена: '
          + reason,
        );
      }
    }

    const channel = toolType === 'codex' ? 'codex:delete-range' : 'claude:delete-range';
    activity.setPhase('rewriting');
    const result = await ipcRenderer.invoke(channel, {
      sessionId: mutationSessionId,
      cwd,
      startUuid: target.uuid,
      endUuid: range.endUuid,
      ...(toolType === 'codex' && codexSettingsProof ? { codexSettingsProof } : {}),
    });
    if (!result?.success) {
      throw new Error(result?.error || 'Не удалось обрезать историю для Rewind');
    }
    historyMutated = true;
    activity.setPhase('restarting');
    // The user may type while stop/delete/restart is in flight. Re-read the
    // current composer only after the mutation commits and prepend the restored
    // prompt instead of overwriting newer text, chips or images.
    if (restoredDraft) {
      const uiState = useUIStore.getState();
      const currentText = uiState.historyPromptDrafts[tabId] || '';
      const currentChips = uiState.historyPromptDraftChips[tabId] || [];
      const currentImages = uiState.historyPromptDraftImages[tabId] || [];
      const hasCurrentDraft = !!currentText
        || currentChips.length > 0
        || currentImages.length > 0;
      const nextDraft = hasCurrentDraft
        ? mergeFailedHistoryAuthoringSnapshot({
            currentText,
            currentChips,
            currentImages,
            snapshotText: restoredDraft.text,
            snapshotChips: restoredDraft.chips,
            snapshotImages: restoredDraft.imagePaths,
          })
        : {
            text: restoredDraft.text,
            chips: restoredDraft.chips,
            images: restoredDraft.imagePaths,
          };
      useUIStore.getState().setHistoryPromptDraft(tabId, nextDraft.text, {
        chips: nextDraft.chips,
        images: nextDraft.images,
      });
    }

    if (toolType === 'codex') {
      if (!result.newSessionId) throw new Error('Codex Rewind не вернул новую сессию');
      const committed = await useWorkspaceStore.getState().setCodexSessionId(
        tabId,
        result.newSessionId,
        'deleteRange',
        result.codexSettingsProof || codexSettingsProof
          ? { codexSettingsProof: result.codexSettingsProof || codexSettingsProof }
          : {},
      );
      if (!committed) throw new Error('Не удалось сохранить новую Codex-сессию во вкладке');
      codexChildAdopted = true;
      const launched = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
        tabId,
        command: 'codex-c',
        sessionId: result.newSessionId,
        cwd,
      }));
      if (launched?.success === false) {
        throw new Error(launched.error || launched.reason || 'Не удалось перезапустить Codex после Rewind');
      }
      window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId } }));
      return { sessionId: mutationSessionId, newSessionId: result.newSessionId };
    }

    if (result.fileDeleted) {
      useWorkspaceStore.getState().setClaudeSessionId(tabId, '', 'timelineChain');
      window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId } }));
      return { sessionId: mutationSessionId, fileDeleted: true };
    }
    const launched = await ipcRenderer.invoke('claude:run-command', {
      tabId,
      command: 'claude-c',
      sessionId: mutationSessionId,
    });
    if (launched?.success === false || launched?.accepted === false) {
      throw new Error(launched?.error || launched?.reason || 'Не удалось перезапустить Claude после Rewind');
    }
    window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId } }));
    return { sessionId: mutationSessionId };
  } catch (error: any) {
    const message = String(error?.message || error || 'Rewind failed');
    activityError = message;
    const historyApplied = toolType === 'codex' ? codexChildAdopted : historyMutated;
    if (!historyApplied && stopped) {
      try {
        if (toolType === 'codex') {
          const restored = await ipcRenderer.invoke('codex:run-command', buildCodexHistoryMutationResumePayload(
            {
              tabId,
              command: 'codex-c',
              sessionId: mutationSessionId,
              cwd,
            },
            codexSettingsProof,
          ));
          if (restored?.success === false || restored?.accepted === false) {
            throw new Error(restored?.error || restored?.reason || 'Codex source restart failed');
          }
        } else {
          const restored = await ipcRenderer.invoke('claude:run-command', {
            tabId,
            command: 'claude-c',
            sessionId: mutationSessionId,
          });
          if (restored?.success === false || restored?.accepted === false) {
            throw new Error(restored?.error || restored?.reason || 'Claude source restart failed');
          }
        }
      } catch (restartError) {
        console.warn('[HistoryRewriteRewind] source restart failed:', restartError);
      }
    }
    throw new HistoryRewriteRewindError(message, historyApplied);
  } finally {
    historyRewriteRewindInflightTabs.delete(tabId);
    activity.finish(activityError);
  }
}

/**
 * Remove exactly one semantic iteration: the selected user prompt and the
 * provider response which belongs to it. Both range backends already expand a
 * single-point range through assistant/tool records and stop at the next real
 * user prompt; reusing the shared rewrite transaction keeps stop, Codex child
 * adoption, Claude restart and failure recovery identical to JSONL Rewind.
 */
export async function executeHistoryDeleteIterationScenario({
  tabId,
  toolType,
  sessionId,
  cwd,
  target,
}: {
  tabId: string;
  toolType: HistoryRewriteRewindTool;
  sessionId: string;
  cwd?: string;
  target: HistoryRewriteRewindTarget;
}): Promise<{ sessionId: string; newSessionId?: string; fileDeleted?: boolean }> {
  return executeHistoryRewriteRewindScenario({
    tabId,
    toolType,
    sessionId,
    cwd,
    target,
    // A one-point range is intentionally not the same as the rewind tail.
    // Main expands it only through this prompt's response and stops before the
    // following human prompt. Resolving Timeline first also proves that the
    // hovered durable row still exists before either agent is stopped.
    rangeMode: 'single',
    restoreDraft: false,
  });
}

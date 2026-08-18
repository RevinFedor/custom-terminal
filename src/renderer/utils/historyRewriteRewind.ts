import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import {
  buildCodexRunPayload,
  buildCodexHistoryMutationResumePayload,
  getCodexHistoryMutationSettingsProof,
} from './codexLaunch';
import { stopClaudePtyProcess } from './claudePtyActions';

const { ipcRenderer } = window.require('electron');

export type HistoryRewriteRewindTool = 'claude' | 'codex';

export type HistoryRewriteRewindTarget = {
  uuid: string;
  text: string;
  endUuid?: string;
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
};

async function resolveCurrentRange({
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
}): Promise<{ sessionId: string; targetText: string; endUuid: string }> {
  if (target.endUuid) {
    return { sessionId, targetText: target.text.trim(), endUuid: target.endUuid };
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
  const endUuid = entries[entries.length - 1]?.uuid;
  if (!endUuid) throw new Error('В текущей истории нет хвоста для Rewind');
  const resolvedSessionId = toolType === 'claude' && typeof result.latestSessionId === 'string'
    ? result.latestSessionId
    : sessionId;
  const targetText = String(selected.content || target.text || '').trim();
  if (!targetText) throw new Error('У выбранной точки Rewind нет текста для возврата в input');
  return { sessionId: resolvedSessionId, targetText, endUuid };
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
}: {
  tabId: string;
  toolType: HistoryRewriteRewindTool;
  sessionId: string;
  cwd?: string;
  target: HistoryRewriteRewindTarget;
}): Promise<{ sessionId: string; newSessionId?: string; fileDeleted?: boolean }> {
  let historyMutated = false;
  let stopped = false;
  let codexChildAdopted = false;
  let mutationSessionId = sessionId;
  let codexSettingsProof: ReturnType<typeof getCodexHistoryMutationSettingsProof> = null;
  try {
    const range = await resolveCurrentRange({ tabId, toolType, sessionId, cwd, target });
    mutationSessionId = range.sessionId;

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
      await stopCodexForHistoryRewrite(tabId, mutationSessionId);
    } else {
      const stopResult = await stopClaudePtyProcess(tabId, {
        reason: 'prompt-queue-history-rewrite-rewind',
      });
      if (stopResult?.success === false) {
        throw new Error(stopResult.error || 'Не удалось остановить Claude перед Rewind');
      }
    }
    stopped = true;

    const channel = toolType === 'codex' ? 'codex:delete-range' : 'claude:delete-range';
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
    useUIStore.getState().setHistoryPromptDraft(tabId, range.targetText);

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
  }
}

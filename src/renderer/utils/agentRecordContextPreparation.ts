import type {
  AgentPtyStatus,
  HistoryAgentRuntime,
  AgentSendPromptOptions,
} from './historyAgentRuntimes';
import type { AgentSendProviderContract } from './agentSendProviderContract';
import {
  isCodexStopCapturedSettingsProof,
  type AgentHistoryRestartSettings,
  type CodexStopCapturedSettingsProof,
} from './agentSendSettingsContract';
import { cancelCoordinatedAgentSendFollowers } from './agentActionCoordinator.mjs';

export interface AgentRecordContextPreparation {
  historyContextResult: any;
  restartPerformed: boolean;
  restartSessionId?: string | null;
  complete: boolean;
  result?: any;
}

const restartSettingsError = (code: string, message: string, reason?: string) => Object.assign(
  new Error(message),
  { code, ...(reason ? { reason } : {}) },
);

function resolveStoppedRecordContextRestartSettings({
  runtime,
  historySession,
  requested,
}: {
  runtime: HistoryAgentRuntime;
  historySession: { sessionId: string | null; authority: string };
  requested?: AgentHistoryRestartSettings;
}): AgentHistoryRestartSettings | undefined {
  if (runtime.toolType !== 'codex') {
    if (requested) throw restartSettingsError(
      'agent_restart_settings_provider_mismatch',
      'Restart settings are only valid for Codex history recording',
    );
    return undefined;
  }

  if (requested?.kind === 'codex-settings-unavailable') {
    throw restartSettingsError(
      'codex_history_context_settings_required',
      requested.reason === 'model-migration-pending'
        ? 'Codex model migration must finish before recording context'
        : 'Codex restart settings are unavailable before recording context',
      requested.reason,
    );
  }
  if (requested?.kind === 'codex-runtime-proof') {
    if (
      requested.owner.kind !== 'writer'
      || !historySession.sessionId
      || requested.owner.id !== historySession.sessionId
    ) {
      throw restartSettingsError(
        'codex_restart_settings_proof_mismatch',
        'Codex restart settings proof does not own the stopped history session',
      );
    }
    return requested;
  }
  if (requested?.kind === 'codex-launch-settings') return requested;
  throw restartSettingsError(
    'codex_history_context_settings_required',
    'Codex restart settings are required before recording context',
    'pair-missing',
  );
}

function buildRestartSettingsFailure({
  error,
  presence,
  historySession,
  requestedStatusAtClick,
  coordinatedSendToken,
  tabId,
}: {
  error: any;
  presence: any;
  historySession: { sessionId: string | null };
  requestedStatusAtClick?: AgentPtyStatus;
  coordinatedSendToken?: number | null;
  tabId: string;
}): AgentRecordContextPreparation {
  const cascade = coordinatedSendToken
    ? cancelCoordinatedAgentSendFollowers(
        tabId,
        coordinatedSendToken,
        'history-context-settings-unavailable',
      )
    : null;
  return {
    historyContextResult: null,
    restartPerformed: false,
    restartSessionId: historySession.sessionId,
    complete: true,
    result: {
      success: false,
      accepted: false,
      submitted: false,
      pasteWritten: false,
      historyOnly: true,
      historyRecorded: false,
      modelTurnStarted: false,
      code: error?.code || 'codex_history_context_settings_required',
      reason: error?.reason || null,
      error: error?.message || String(error),
      requestedStatusAtSend: requestedStatusAtClick,
      effectiveStatusAtSend: presence.status,
      recordWithoutReply: true,
      restartPerformed: false,
      restartSessionId: historySession.sessionId,
      reopened: false,
      ...(cascade ? {
        cancelledFollowerHandoffIds: cascade.handoffIds || [],
        cascadeRestoreOwnerToken: coordinatedSendToken,
      } : {}),
    },
  };
}

export async function prepareAgentRecordContext({
  enabled,
  tabId,
  runtime,
  providerContract,
  sessionId,
  cwd,
  prompt,
  handoffId,
  source,
  historyRestartSettings,
  presentationSnapshot,
  coordinatedSendToken,
  requestedStatusAtClick,
  assertSendNotCancelled,
  onRestartPhase,
  onHistoryRecorded,
}: {
  enabled: boolean;
  tabId: string;
  runtime: HistoryAgentRuntime;
  providerContract: AgentSendProviderContract;
  sessionId?: string | null;
  cwd?: string;
  prompt: string;
  handoffId?: string;
  source?: string;
  historyRestartSettings?: AgentHistoryRestartSettings;
  presentationSnapshot?: AgentSendPromptOptions['presentationSnapshot'];
  coordinatedSendToken?: number | null;
  requestedStatusAtClick?: AgentPtyStatus;
  assertSendNotCancelled: () => void;
  onRestartPhase?: (phase: 'stopping' | 'starting') => void;
  onHistoryRecorded?: (result: any) => void | Promise<void>;
}): Promise<AgentRecordContextPreparation> {
  if (!enabled) {
    return {
      historyContextResult: null,
      restartPerformed: false,
      restartSessionId: sessionId,
      complete: false,
    };
  }

  let presence = await runtime.getPresence(tabId).catch((err: any) => {
    console.warn('[AgentScenario:record-context] presence failed before stop tool=' + runtime.toolType
      + ' tab=' + String(tabId).slice(-12) + ' ' + (err?.message || err));
    return null;
  });
  assertSendNotCancelled();
  if (!presence || presence.status === 'unknown') {
    throw new Error(runtime.label + ' status could not be verified before recording context');
  }
  if (presence.status === 'stopping') {
    throw new Error(runtime.label + ' is already stopping; wait before recording context');
  }
  if (presence.status === 'busy' || presence.status === 'starting') {
    throw new Error(runtime.label + ' must be idle before recording context');
  }

  const historySession = providerContract.resolveHistorySession(presence, sessionId);
  let effectiveHistoryRestartSettings:
    | AgentHistoryRestartSettings
    | CodexStopCapturedSettingsProof
    | undefined;
  if (presence.status !== 'active') {
    try {
      effectiveHistoryRestartSettings = resolveStoppedRecordContextRestartSettings({
        runtime,
        historySession,
        requested: historyRestartSettings,
      });
    } catch (error: any) {
      if (!error?.code) throw error;
      return buildRestartSettingsFailure({
        error,
        presence,
        historySession,
        requestedStatusAtClick,
        coordinatedSendToken,
        tabId,
      });
    }
  }
  let restartSessionId = historySession.sessionId;
  let restartPerformed = false;

  if (presence.status === 'active') {
    onRestartPhase?.('stopping');
    console.log('[AgentScenario:record-context] stop tool=' + runtime.toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' status=' + presence.status);
    const stopped = await runtime.stopProcess(tabId, {
      reason: 'record-history-context',
      captureCodexRestartSettings: runtime.toolType === 'codex',
    });
    assertSendNotCancelled();
    if (stopped?.success === false) {
      if (runtime.toolType === 'codex'
        && typeof stopped?.error === 'string'
        && stopped.error.startsWith('codex_history_context_settings_proof_')) {
        return buildRestartSettingsFailure({
          error: Object.assign(new Error(stopped.error), {
            code: 'codex_history_context_settings_required',
            reason: stopped.reason || stopped.guardReason || 'live-proof-unavailable',
          }),
          presence,
          historySession,
          requestedStatusAtClick,
          coordinatedSendToken,
          tabId,
        });
      }
      presence = await runtime.getPresence(tabId).catch(() => null);
      if (presence?.status !== 'inactive') {
        throw new Error(stopped?.error || runtime.label + ' could not stop before recording context');
      }
    }
    if (runtime.toolType === 'codex') {
      if (!isCodexStopCapturedSettingsProof(stopped?.restartSettingsProof)) {
        throw new Error('Codex stopped without an exact restart settings proof');
      }
      effectiveHistoryRestartSettings = stopped.restartSettingsProof;
    }
    restartPerformed = true;
  }

  onRestartPhase?.('starting');
  assertSendNotCancelled();
  const historyContextResult = await runtime.recordHistoryContext(tabId, prompt, {
    sessionId: restartSessionId,
    sessionAuthority: historySession.authority,
    cwd,
    handoffId,
    source,
    model: effectiveHistoryRestartSettings?.model,
    effort: effectiveHistoryRestartSettings?.effort,
    presentationSnapshot,
  });
  if (historyContextResult?.success === false && historyContextResult?.accepted !== true) {
    throw Object.assign(
      new Error(historyContextResult?.error || 'History context was not recorded'),
      { historyContextResult },
    );
  }

  restartSessionId = historyContextResult?.sessionId || null;
  if (!restartSessionId) {
    if (coordinatedSendToken) {
      cancelCoordinatedAgentSendFollowers(
        tabId,
        coordinatedSendToken,
        'history-context-session-unresolved',
        Date.now(),
        { cascadeRestore: false },
      );
    }
    return {
      historyContextResult,
      restartPerformed,
      restartSessionId: null,
      complete: true,
      result: {
        ...(historyContextResult || {}),
        requestedStatusAtSend: requestedStatusAtClick,
        effectiveStatusAtSend: 'inactive',
        recordWithoutReply: true,
        restartPerformed,
        restartSessionId: null,
        reopened: false,
      },
    };
  }

  const adopted = await providerContract.adoptHistorySession(tabId, restartSessionId);
  if (!adopted) {
    if (coordinatedSendToken) {
      cancelCoordinatedAgentSendFollowers(
        tabId,
        coordinatedSendToken,
        'history-context-session-not-adopted',
        Date.now(),
        { cascadeRestore: false },
      );
    }
    return {
      historyContextResult,
      restartPerformed,
      restartSessionId,
      complete: true,
      result: {
        ...historyContextResult,
        success: true,
        requestedStatusAtSend: requestedStatusAtClick,
        effectiveStatusAtSend: 'inactive',
        recordWithoutReply: true,
        restartPerformed,
        restartSessionId,
        reopened: false,
        reopenWarning: runtime.label + ' history was recorded, but the tab could not adopt the new session',
      },
    };
  }

  if (historyContextResult?.historyRecorded === true) {
    await onHistoryRecorded?.(historyContextResult);
  }

  return {
    historyContextResult,
    restartPerformed,
    restartSessionId,
    complete: false,
  };
}
